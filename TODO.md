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

## 进行中

### Agent 重启竞争修复 (`fix/agent-restart-race` 分支)

**问题**：onEvict (socket 层) 和 child.on('exit') (进程层) 同时触发 auto-restart，竞争产生重复 CC 进程，导致消息被回复两次。

**修复**：
- onEvict 只杀进程（killForRestart），不直接重启
- child.on('exit') 是唯一重启入口
- stop() 设 stoppedManually 标记，用户主动停止不重启
- 退避机制：5min 内连续崩溃 5 次后放弃重启，延迟递增 5s/10s/15s/20s/25s

**状态**：已实现，待验证后合版

---

## 待讨论 / 待规划

### 1. Hub 层定时任务调度

**背景**：CC 的 CronCreate 是进程内调度器，CC 重启后定时任务全丢。用户通过微信设的定时任务（如「每天 11:35 重启雪球服务」）无法在 agent 重启后幸存。

**方案（方案 B：Hub 自己调度）**：
- Hub 内置调度器，定时任务存 SQLite（与消息持久化共用）
- 新增 MCP 工具 `cron_create` / `cron_list` / `cron_delete`
- 到点时 hub 给目标 agent 发 channel notification，CC 当普通消息处理
- 如果 agent 离线，消息进离线队列（依赖 #1 消息持久化）

**核心抽象**：定时任务 = 在指定时间给指定 agent 发一条消息

**依赖**：#1 消息持久化 + SQLite

**来源**：2026-03-26 zombie-spoke 修复后讨论

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

## 其他备忘

（已合并到 #4 权限管理体系）
