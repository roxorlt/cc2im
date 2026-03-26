# Fix Zombie Spoke Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 消灭 zombie spoke — CC 退出后 spoke 必须在有限时间内自动退出，不留孤儿进程；hub 清理 zombie 后自动重启 autoStart agent，恢复服务。

**Architecture:** Hub-side 主动清理 + Spoke-side 改进自检 + 自动恢复。Hub 掌握 spoke PID，心跳超时后直接 kill 进程并自动重启；spoke 端补全 MCP transport close 检测链。两层防线，任一层生效即可。

**Tech Stack:** Node.js (net, child_process), MCP SDK (@modelcontextprotocol/sdk)

---

## 背景

commit `66ad679` 已实现心跳 + PPID 轮询作为 zombie spoke 防护。但实测仍出现 zombie：
- 7:12PM 启动的 spoke 进程（2 个：tsx+node），CC 退出后 spoke 没跟着退
- 9:13PM 又启动了新 spoke，旧的仍存活 → 4 个 spoke 进程
- Hub 把微信消息转发给了旧 spoke → 用户收不到回复

当前心跳超时（45s）只把 spoke 从注册表踢掉（`socket.destroy()`），但 **不杀 OS 进程**，也 **不自动重启 agent**。踢掉后如果 autoStart agent 没重启，就会出现 0 个 spoke 的状态 —— 用户发消息只能收到"Agent 不在线"。

---

## 根因分析

### 进程链

```
Hub (agent-manager)
  → caffeinate -i expect start.exp
    → claude --dangerously-load-development-channels server:cc2im
      → tsx src/spoke/index.ts --agent-id brain   ← 这就是 spoke 进程
```

CC 通过 `.mcp.json` 中的 command 直接启动 spoke（tsx 或 node），spoke 的 stdin/stdout 通过 pipe 与 CC 通信。

### 为什么现有检测失效

| 检测方法 | 代码位置 | 失效原因 |
|---------|---------|---------|
| `process.stdin.on('end')` | `spoke/index.ts:84` | MCP SDK 的 `StdioServerTransport` 注册了 `'data'` 和 `'error'` listener，但 **不监听 `'end'`**。stdin EOF 发生时 transport 不感知也不触发 close。而 spoke 自己的 `'end'` listener 理论上应触发，但实测不触发 —— 可能与 transport 内部状态管理或 Node.js stream 边界条件有关 |
| `process.ppid !== originalPpid` | `spoke/index.ts:92-100` | 检查 ppid 是否**变化**。但 CC 启动 spoke 可能经过中间进程（tsx 的父进程可能是 shell 或 npx），spoke 的直接父进程不是 CC。当 CC 退出时，中间进程可能仍存活，ppid 不变 |
| heartbeat 超时 | `socket-server.ts:127-141` | Hub 超时后执行 `socket.destroy()` + 从注册表移除。但 **只断了 socket 连接，没有 kill 进程**。spoke OS 进程继续存活。踢掉后也**不会自动重启 agent** |

### 关键洞察

1. Hub 心跳超时机制已经能正确**发现** zombie spoke，但缺少最后一步：**杀掉进程**。Hub 不知道 spoke 的 PID，所以无法 kill
2. `startAutoAgents()` 只在 hub 启动时运行一次。zombie 被踢后不会自动重启 → 服务中断直到手动干预

---

## 修复方案

### 第一层：Hub-side 主动 kill + 自动重启（主防线）

**原理**：spoke 注册时上报 PID → hub 记录 → 心跳超时时 SIGTERM 该 PID → 自动重启 autoStart agent

**改动文件**：
- `src/shared/types.ts` — `SpokeToHubRegister` 加 `pid` 字段
- `src/hub/socket-server.ts` — 记录 PID，超时时 kill + 回调通知
- `src/spoke/socket-client.ts` — 注册消息加 `pid: process.pid`
- `src/hub/index.ts` — 订阅 eviction 回调，触发 agent-manager 重启

### 第二层：Spoke-side 改进自检（辅助防线）

**原理**：补上 MCP transport close 检测链 + 改进 PPID 检查

**改动文件**：
- `src/spoke/index.ts` — 3 处改进：
  1. `server.onclose` 回调 → 检测 MCP 连接断开
  2. stdin `'close'` 事件（比 `'end'` 更可靠，pipe 断裂时一定触发）
  3. PPID 检查改为 `process.ppid === 1`（reparented to launchd = 父进程已死）

---

## 任务列表

### Task 1: types — 注册消息加 PID 字段

**Files:**
- Modify: `src/shared/types.ts:75-78` (`SpokeToHubRegister`)

**改动**：
```typescript
export interface SpokeToHubRegister {
  type: 'register'
  agentId: string
  pid?: number  // spoke 进程 PID，用于 hub-side kill
}
```

**验证**：`npx tsc --noEmit`

---

### Task 2: spoke — 注册时发送 PID

**Files:**
- Modify: `src/spoke/socket-client.ts:38`

**改动**：注册帧加上 pid

```typescript
// socket-client.ts doConnect() 中
socket.write(encodeFrame({ type: 'register', agentId: this.agentId, pid: process.pid }))
```

**验证**：`npx tsc --noEmit`

---

### Task 3: hub socket-server — 记录 spoke PID，超时时 kill 进程 + 回调

**Files:**
- Modify: `src/hub/socket-server.ts`

**改动要点**：

1. `ConnectedSpoke` interface 加 `pid?: number`：
```typescript
interface ConnectedSpoke {
  agentId: string
  socket: Socket
  pid?: number
}
```

2. 构造函数加 `onEvict` 回调（通知外部 zombie 被踢，用于触发重启）：
```typescript
private onEvict?: (agentId: string) => void

constructor(
  onMessage: (agentId: string, msg: SpokeToHub) => void,
  onEvict?: (agentId: string) => void,
) {
  this.onMessage = onMessage
  this.onEvict = onEvict
}
```

3. 注册处理中记录 PID：
```typescript
// frame.type === 'register' 分支内
this.spokes.set(agentId!, { agentId: agentId!, socket, pid: frame.pid })
```

4. 心跳超时处理中加 kill + 回调：
```typescript
// 现有的 evict 逻辑中，destroy socket 后加
if (spoke.pid) {
  try {
    process.kill(spoke.pid, 'SIGTERM')
    console.log(`[hub] Sent SIGTERM to zombie spoke "${agentId}" (pid ${spoke.pid})`)
  } catch {
    // Process already dead — that's fine
  }
}
// 通知外部（hub/index.ts）可以重启
this.onEvict?.(agentId)
```

**验证**：`npx tsc --noEmit`

---

### Task 4: spoke — 补全 close 检测链

**Files:**
- Modify: `src/spoke/index.ts:82-100`

**改动要点**：

1. 抽取退出逻辑为公共函数：
```typescript
let exiting = false
function gracefulExit(reason: string) {
  if (exiting) return
  exiting = true
  console.log(`[spoke:${agentId}] ${reason}, exiting`)
  socketClient.disconnect()
  process.exit(0)
}
```

2. 保留 stdin `'end'` + 新增 `'close'`：
```typescript
process.stdin.on('end', () => gracefulExit('CC disconnected (stdin EOF)'))
process.stdin.on('close', () => gracefulExit('CC disconnected (stdin close)'))
process.stdin.resume()
```

3. MCP server onclose 回调：
```typescript
server.onclose = () => gracefulExit('MCP transport closed')
```

4. 改进 PPID 检查 — 直接检查是否被 reparent 到 launchd (PID 1)：
```typescript
const ppidCheck = setInterval(() => {
  if (process.ppid === 1) {
    clearInterval(ppidCheck)
    gracefulExit(`Parent process gone (ppid became 1)`)
  }
}, 3000)
```

**验证**：`npx tsc --noEmit`

---

### Task 5: hub — zombie 踢掉后自动重启 autoStart agent

**Files:**
- Modify: `src/hub/index.ts`

**改动要点**：

1. 创建 `HubSocketServer` 时传入 `onEvict` 回调：

```typescript
socketServer = new HubSocketServer(
  async (agentId: string, msg: SpokeToHub) => { /* 现有 onMessage 逻辑不变 */ },
  // onEvict: zombie 被踢后尝试重启
  (agentId: string) => {
    const agentConfig = agentManager.getConfig().agents[agentId]
    if (agentConfig?.autoStart && agentManager.isManaged(agentId)) {
      console.log(`[hub] Auto-restarting evicted agent "${agentId}"`)
      // 延迟几秒再重启，给旧进程时间退出
      setTimeout(() => {
        const result = agentManager.start(agentId)
        if (!result.success) {
          console.log(`[hub] Failed to restart "${agentId}": ${result.error}`)
        }
      }, 5000)
    }
  },
)
```

**关键设计决策**：
- 只重启 `autoStart: true` 且由 hub 管理（`isManaged`）的 agent
- 手动启动的外部 agent 不自动重启（用户自己管理）
- 延迟 5s 重启，给 SIGTERM 后的旧进程和 CC 子进程树时间清理

**验证**：`npx tsc --noEmit`

---

### Task 6: 集成测试

**测试环境准备**：
```bash
# 1. 停止当前服务
npx tsx src/cli.ts uninstall

# 2. 重新安装并启动
npx tsx src/cli.ts install
sleep 5

# 3. 确认 hub + spoke 正常
ps aux | grep 'spoke/index' | grep -v grep
tail -5 ~/.cc2im/hub.log
```

**Zombie 复现与验证**：

> 核心验证：手动 kill CC 进程，观察 spoke 是否在规定时间内退出。

```bash
# 记录 spoke PID
SPOKE_PID=$(ps aux | grep 'spoke/index.*--agent-id brain' | grep -v grep | head -1 | awk '{print $2}')
echo "Spoke PID: $SPOKE_PID"

# 记录 CC (claude) PID — spoke 的父进程
SPOKE_PPID=$(ps -o ppid= -p $SPOKE_PID | tr -d ' ')
echo "Spoke parent (CC) PID: $SPOKE_PPID"

# Kill CC 来模拟 CC 退出
kill $SPOKE_PPID

# 等待 10 秒，检查 spoke 是否退出
sleep 10
ps -p $SPOKE_PID > /dev/null 2>&1 && echo "FAIL: spoke still alive" || echo "PASS: spoke exited"
```

**Heartbeat kill 验证**（测试 hub-side 主防线）：

```bash
# 用 SIGSTOP 冻结 spoke（模拟它卡死不发心跳）
kill -STOP $SPOKE_PID

# 等待 60 秒（45s 超时 + 15s 检查间隔 buffer）
sleep 60
ps -p $SPOKE_PID > /dev/null 2>&1 && echo "FAIL: zombie survived" || echo "PASS: hub killed zombie"

# 查看 hub 日志确认 kill 记录
grep -i 'sigterm.*zombie\|kill.*spoke' ~/.cc2im/hub.log | tail -5
```

**自动重启验证**（验收 #5）：

```bash
# 接上一步 heartbeat kill 验证，zombie 被踢后 hub 应自动重启
# 等待 15 秒（5s 延迟重启 + 10s 启动时间）
sleep 15
ps aux | grep 'spoke/index' | grep -v grep | wc -l
# 期望：2（新的一组 tsx+node）

# 查看 hub 日志确认重启记录
grep -i 'auto-restart\|Auto-started' ~/.cc2im/hub.log | tail -5
```

**微信消息验证**（验收 #6）：

```bash
# 自动重启后从微信发一条消息，确认收到回复
# 手动验证
```

---

## 验收标准

| # | 标准 | 验证方式 |
|---|------|---------|
| 1 | CC 正常退出后，spoke 在 **10 秒内**自行退出 | Kill CC 进程 → 10s 后检查 spoke PID |
| 2 | CC 异常退出（SIGKILL）后，spoke 在 **10 秒内**退出 | `kill -9 CC_PID` → 10s 后检查 |
| 3 | Spoke 卡死不发心跳时，hub 在 **60 秒内** kill 掉它 | `kill -STOP spoke` → 60s 后检查 |
| 4 | Hub kill zombie 后日志有 SIGTERM 记录 | `grep SIGTERM hub.log` |
| 5 | Zombie 被踢后 autoStart agent **自动重启** | 验收 #3 后等 15s，检查新 spoke 进程是否出现 |
| 6 | 自动重启后微信消息收发正常 | 从微信发消息，确认收到回复 |
| 7 | `npx tsc --noEmit` 无报错 | 编译检查 |
| 8 | 不存在进程泄漏（ps 中无多余 spoke 进程） | `ps aux \| grep spoke` 计数 |

---

## 风险与注意事项

- **不影响正常运行的 spoke**：心跳 15s 发一次，超时 45s，正常运行的 spoke 不会被误杀
- **PID 复用**：理论上 OS 可能复用已死进程的 PID。但心跳超时只有 45s，PID 在这个窗口内被复用给无关进程的概率极低。即使发生，SIGTERM 对无关进程的影响有限（不是 SIGKILL）
- **开发测试冲突**：改动需要重启 hub，会中断微信消息服务。建议在非高峰时段操作，整个部署 < 1 分钟
