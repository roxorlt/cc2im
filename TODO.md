# cc2im 迭代 TODO

## 已完成

- ~~Zombie spoke 修复~~ — hub-side SIGTERM + spoke 多重退出检测 + 自动重启 (2026-03-26)
- ~~插件架构重构~~ — 核心 185 行 + weixin/web-monitor/persistence 三个插件 (2026-03-26)
- ~~成本 + 用量指标~~ — 等值 API 成本、5h/7d 用量占比、pricing.json (2026-03-26)
- ~~v1 frontend 清理~~ — 删除 517 行旧代码 (2026-03-26)
- ~~消息持久化 + 离线投递~~ — SQLite WAL + deliver:before/after 事件 + agent:online 重放 + context token 持久化 (2026-03-26)
- ~~Dashboard 日志增强~~ — 时间戳提取、error/warn 颜色编码、滚动行为优化 (2026-03-26)

## 待讨论 / 待规划

### 1. Dashboard 渲染媒体文件

**背景**：目前 dashboard 对图片/视频/语音消息只显示纯文本路径（如 `(image 已下载到 /path)`），没有富媒体预览。

**现状**：
- hub 的 media.ts 已实现完整的下载 + AES 解密 + 格式检测（jpg/png/gif/webp）
- 文件存在 `~/.cc2im/media/`，24h 自动清理
- 但 web server 没有提供 `/media/` 静态文件路由
- 前端没有根据 msgType 做富媒体渲染

**改动点**：
- web server 加 `/media/` 静态文件路由
- 前端根据 msgType 渲染 `<img>` / `<video>` / 音频播放器
- 语音消息同时展示转文字结果

**来源**：2026-03-25 讨论

---

### 2. Hub 层定时任务调度

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

### 3. macOS 桌面小组件

**背景**：将 cc2im 关键状态暴露为 macOS Widget，无需打开浏览器即可一瞥 agent 状态、用量、消息概览。

**可能方向**：
- SwiftUI WidgetKit 原生小组件
- 数据源：hub HTTP API（`/api/agents`、`/api/usage`、`/api/stats`）
- 尺寸：small（agent 在线状态）、medium（+ 用量条）、large（+ 最近消息摘要）

**待讨论**：技术选型、刷新频率、是否需要独立 Xcode 项目

---

## 其他备忘

### 权限粒度细化

**现状**：always-allow 粒度只到 tool name（如 `Bash`），一旦 always 就等于全部自动批准。

**方向**：支持参数模式匹配（如只允许特定目录的 Bash 命令）。

**来源**：2026-03-25 对比 NanoClaw 讨论
