# cc2im 迭代 TODO

## 待讨论 / 待规划

### 1. 消息持久化 + 离线投递

**背景**：对比 NanoClaw（用 SQLite 存所有消息，agent 重连后能看到历史），cc2im 目前 spoke 断连时消息直接丢弃。

**痛点**：
- spoke 断连期间的消息永久丢失，用户不知情
- zombie-spoke 自动重启场景下，重启期间（~5s）的消息也会丢

**方案方向**：
- Hub 加一层轻量消息队列（SQLite 即可）
- spoke 重连后投递积压消息
- 可选：消息 TTL，超时自动清理

**来源**：2026-03-25 对比 NanoClaw 讨论

---

### 2. Web 面板 + 媒体处理插件化

**背景**：NanoClaw 的 "skills over features" 哲学——核心极小，新功能以插件/skill 形式扩展，不膨胀核心代码。

**现状**：cc2im 3.5K 行已经很精简，但 web 监控（~640 行）、media 处理（82 行）等模块都在核心里。

**方案方向**：
- 保持核心只做 hub-spoke 通信 + 消息路由
- web 监控、media 处理等作为可选插件加载
- 降低核心复杂度，方便后续独立迭代各模块

**来源**：2026-03-25 对比 NanoClaw 讨论

---

### 3. Dashboard 渲染媒体文件

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

### 4. Dashboard 增加等值美金成本指标 + 用量限额

**背景**：dashboard 已有按天的 token 统计，可以计算等值 API 成本。同时订阅用户有 5h 滚动 + 7d 滚动两个用量限额窗口。

**定价基准**（Claude Opus 4.6, per 1M tokens, 2026-03-26）：
- Input: $5 / Output: $25 / Cache read: $0.50 / Cache write: $6.25

**等值成本展示**：
- 当日等值成本 + 30 天均值
- 注明「等值 API 成本，非实际账单」（用户是订阅制）
- 底部显示定价基准版本，方便核对

**用量限额展示**：
- 5h 用量占比 + 预计恢复时间
- 7d 用量占比 + 预计恢复时间
- 数据来源：CC 响应的 rate-limit header 或 `claude usage --json`，具体路径实现时验证

**定价更新机制**：
- 插件内 pricing.json 存储单价，版本化
- 低频定期 check 官网定价页面是否变更（如每天一次）

**来源**：2026-03-25 讨论 + 2026-03-26 补充

---

### 5. Hub 层定时任务调度

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

## 其他备忘

### 权限粒度细化

**现状**：always-allow 粒度只到 tool name（如 `Bash`），一旦 always 就等于全部自动批准。

**方向**：支持参数模式匹配（如只允许特定目录的 Bash 命令）。

**来源**：2026-03-25 对比 NanoClaw 讨论
