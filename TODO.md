# cc2im 迭代 TODO

## 已完成

- ~~Zombie spoke 修复~~ — hub-side SIGTERM + spoke 多重退出检测 + 自动重启 (2026-03-26)
- ~~插件架构重构~~ — 核心 185 行 + weixin/web-monitor/persistence 三个插件 (2026-03-26)
- ~~成本 + 用量指标~~ — 等值 API 成本、5h/7d 用量占比、pricing.json (2026-03-26)
- ~~v1 frontend 清理~~ — 删除 517 行旧代码 (2026-03-26)
- ~~消息持久化 + 离线投递~~ — SQLite WAL + deliver:before/after 事件 + agent:online 重放 + context token 持久化 (2026-03-26)
- ~~Dashboard 日志增强~~ — 时间戳提取、error/warn 颜色编码、滚动行为优化 (2026-03-26)
- ~~Dashboard 媒体渲染~~ — /media/ 路由 + 前端 img/video/file 预览 + detectExt 修复 (2026-03-27)
- ~~微信媒体发送~~ — CC agent 通过 weixin_send_file MCP 工具发图片/文件到微信 (2026-03-27)
- ~~Typing indicator + 延迟确认~~ — 10s 无回复自动发"收到，正在处理..." (2026-03-27)
- ~~Channel 抽象层~~ — Cc2imChannel 接口 + WeixinChannel + ChannelManager 插件 + channel-aware 路由 (2026-03-27)
- ~~Dashboard 改版~~ — 折叠式侧栏导航 + Channel 管理页 + 消息 channel/昵称标注 + 昵称编辑 + channel 筛选 + channel CRUD API + channels.json 持久化 (2026-03-27)
- ~~Agent 重启竞争修复~~ — onEvict 只杀进程，child.on('exit') 唯一重启入口，stoppedManually 标记，退避机制 5min/5次放弃 (2026-03-27)
- ~~测试框架 + 自动化~~ — vitest 102 个测试（单元+集成），PostToolUse/PreToolUse hooks 自动跑测试，git pre-commit hook（tsc + tests），pre-merge-testing 提醒 (2026-03-28)
- ~~CLAUDE.md 架构文档~~ — 项目架构、消息流、目录结构、插件事件、设计决策，供跨会话上下文对齐 (2026-03-28)
- ~~Code review 6 项修复~~ — 媒体路径安全 resolve+startsWith、web-api 测试改用真实代码、AgentManager 38 个测试、hook 去硬编码、tsc 类型检查 (2026-03-28)
- ~~Dashboard QR 扫码~~ — /api/channels/login API + QrLoginOverlay 前端组件 + WebSocket 状态推送，Dashboard 内完成扫码授权 (2026-03-27)

## 待讨论 / 待规划

### 1. 定时任务投递目标（deliverTo）

**背景**：当前 cron 消息只发给 agent，不指定回复目标。agent 收到后不知道该回复到哪个 channel 的哪个用户。

**调研结论**（2026-03-27）：
- **OpenClaw**：显式 `delivery.mode/channel/to` 三字段，但不支持单任务多目标（需创建多个 job），默认 "last channel" 容易发错
- **NanoClaw**：隐式 `chat_jid` 绑定来源群组，简单但不灵活
- 两者都不支持单任务多目标投递

**cc2im 方案**：
- CronJob 新增 `deliverTo?: Array<{ channelId: string; userId: string }>` 字段
- **不填** → 消息只发到 agent，不指定回复目标（agent 自行决定）
- **填了** → cron 触发时消息 meta 带 deliverTo 列表，agent 可逐个回复
- GUI 表单：channel 下拉（多选，从已连接 channels 选）+ user 下拉（多选，显示昵称），两者均非必填

**改动点**：
- `types.ts` — CronJob 增 deliverTo 字段
- `db.ts` — 存为 JSON 字符串
- `scheduler.ts` — fire() 时在消息 meta 中带 deliverTo
- `server.ts` + GUI 表单 — channel/user 多选组件

**来源**：2026-03-27 cron GUI 测试讨论

---

### 2. macOS 桌面小组件

**背景**：将 cc2im 关键状态暴露为 macOS Widget，无需打开浏览器即可一瞥 agent 状态、用量、消息概览。

**可能方向**：
- SwiftUI WidgetKit 原生小组件
- 数据源：hub HTTP API（`/api/agents`、`/api/usage`、`/api/stats`）
- 尺寸：small（agent 在线状态）、medium（+ 用量条）、large（+ 最近消息摘要）

**待讨论**：技术选型、刷新频率、是否需要独立 Xcode 项目

---

### 3. 权限管理体系

**背景**：多用户场景下需要细粒度权限控制。

**三个维度**：

1. **用户权限（User → Agent）**
   - 管理员（你）：完整权限，所有 permission 请求都发给管理员审批
   - 普通用户（家人等）：受限权限，不能指定工作目录、某些 skill 不开放
   - 需要用户角色体系：admin / member / guest

2. **Agent 权限（Agent → Tools）**
   - 现有 always-allow 粒度只到 tool name（如 `Bash`），过于粗放
   - 需要参数模式匹配（如只允许特定目录的 Bash 命令）
   - 不同 agent 可以有不同的 tool 白名单

3. **Channel → Agent 访问控制**
   - 某些 agent 只对管理员 channel 开放
   - 家人的 channel 只能访问指定 agent

**待调研**：OpenClaw 和 NanoClaw 的权限模型实现

**来源**：2026-03-27 多用户场景讨论 + 2026-03-25 NanoClaw 对比

---

### ~~4. Agent Session 恢复~~ ✅

- 已实现：agent-manager 启动 CC 时传 `--continue`，自动恢复当前 cwd 最近的 session（无历史则降级为新 session）(2026-04-01)

### 5. Cron 可观测性（Bad Case: xlist-scraper 静默失败）

**Bad Case**：cron 触发 scrapeList，Chrome 打开了，但 DB 没新数据。持续数小时无人知晓。cc2im 只记了 "delivered"，不知道执行成功还是失败。

**需要做的**：
1. 记录任务执行结果（成功/失败/耗时）到 SQLite
2. 持久化 cron 执行日志（触发时间、agent、状态、错误摘要）
3. 连续 N 次失败时推送微信告警

**来源**：`/Users/roxor/brain/30-projects/xlist-scraper/docs/cc2im-cron-observability.md` (2026-04-01)

---

### 6. Cron 独立进程执行（不占用 agent 会话）

**背景**：CC 单线程，cron 任务（如 xlist-scraper）占用 brain 会话数分钟，期间所有用户消息排队。

**核心思路**：cron 触发时不发消息给 agent，而是 Hub 开一个临时 CC CLI 进程（`claude -p "执行任务..." --print`），跑完拿到结果后杀掉。

**好处**：
- Agent 永远空闲等用户消息，回复秒达
- Cron 跑多久都不阻塞任何人
- 天然并行——多个 cron 各自独立进程
- 拿到 exit code + stdout，顺便解决 TODO #5 的可观测性

**改动点**：
- `cron-scheduler` 插件：触发时 spawn `claude -p "{message}" --print` 而非 deliverToAgent
- 收集 stdout/stderr + exit code 写入 SQLite cron_runs 表
- 失败时推送微信告警

**降级方案**：如果 cron 任务需要 agent 的长对话上下文（如"继续上次的分析"），仍走 deliverToAgent 路径。两种模式可通过 cron job 配置切换。

**来源**：2026-04-01 多 channel 测试 + 用户提出的"临时进程"思路

---

## 其他备忘

（已合并到 #4 权限管理体系）
