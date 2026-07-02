# Pre-Merge Test Cases — spoke 身份闸门（CC2IM_AGENT）

Branch: `fix/spoke-agent-env-guard` vs `main`

背景事故：`~/brain/.mcp.json` 被 `~/brain/**` 下的任意 Claude 会话继承，一个 ruiping 目录的会话
spawn 出 `--agent-id brain` 的 spoke 并顶掉 hub 托管的 brain；微信消息被投递给该会话
（它没有 channel 参数，消息进不了对话），用户只看到「正在输入」无回复。

## A. 闸门行为（spoke）
- **A1** 无 `CC2IM_AGENT` 启动 spoke → 日志出现 "observer mode, NOT registering"，hub 无该 agentId 注册。P0
- **A2** 观察者模式下 MCP server 正常起、宿主 CC 不受影响（进程存活、不 crash）。P0
- **A3** `CC2IM_AGENT=1`（hub spawn 注入）→ spoke 正常注册。P0（随重启验证）

## B. 注入路径
- **B1** agent-manager spawn 注入 env → 重启后 7/7 connected 且 claude.pid 属 hub 托管栈。P0
- **B2** `handoffCommand()` 以 `CC2IM_AGENT=1 claude ` 开头（单测）。P0
- **B3** CLI 前台 `agent start` 注入 env（代码走查，与 B1 同代码路径 spawn env）。P2

## C. 事故场景复原（真机）
- **C1** hub 重启后，ruiping 会话（pid 33442）重启的新 spoke 走新代码 → 观察者模式，不再抢 brain；
  hub.log 不再出现针对 brain 的 "Replacing stale connection" 抖动。P0
- **C2** brain 端到端能回话：通过 dashboard web channel 发测试消息 → brain 回复。P0

## D. 回归
- **D1** `npm test` 全过。P0
- **D2** `tsc` 干净。P0
- **D3** 重启后微信 channel connected。P1

## Results (2026-07-02)

| Case | Result | Evidence |
|------|--------|----------|
| A1 | ✅ | 无 env 启动 spoke：日志 "CC2IM_AGENT not set — observer mode, NOT registering"，hub.log 零注册 |
| A2 | ✅ | 观察者模式下 MCP server 正常起；stdin EOF 时干净退出（宿主 CC 生命周期语义不变） |
| A3/B1 | ✅ | kickstart 后 7/7 connected —— env 经 caffeinate→expect→claude→spoke 全链传递（否则全是观察者连不上） |
| B1 归属 | ✅ | brain spoke 父进程 = hub 托管的 claude（server:cc2im --continue），身份回归 |
| B2 | ✅ | 单测：handoffCommand 以 `CC2IM_AGENT=1 claude ` 开头 |
| C1 | ✅ | 重启后 brain 身份抖动 0 次（当天历史累计 99 次）；肇事 ruiping 会话已被用户关闭，拦截行为由 A1 隔离验证 |
| C2 | ✅ | dashboard `/api/chat` → brain 41s 后回复「身份闸门验证OK」（outbound 入库 10:31:34Z） |
| D1 | ✅ | `npm test` 209/209 |
| D2 | ✅ | `tsc` 干净 |
| D3 | ✅ | 微信A status: connected |

无新发现 bug。备注：旧版接力命令开出的终端（无 env）在 spoke 重启后会降级为观察者 —— 属预期，重新点一次接力即可。
