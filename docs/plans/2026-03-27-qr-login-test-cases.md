# QR Login GUI — 测试用例

## 变更范围

| 层 | 新增文件 | 修改文件 |
|----|---------|---------|
| 后端 | `src/plugins/weixin/qr-login.ts` | `src/shared/plugin.ts`, `src/hub/hub-context.ts`, `src/plugins/channel-manager/index.ts`, `src/plugins/web-monitor/server.ts` |
| 前端 | `components/QrLoginOverlay.tsx` | `hooks/useWebSocket.ts`, `components/ChannelsPage.tsx`, `App.tsx`, `components/Sidebar.tsx` |
| 删除 | — | `src/plugins/cron-scheduler/*`, `ScheduledTasksPage.tsx`, cron 相关 types/API |

---

## A. 后端 API 测试

### A1. POST /api/channels/:id/login — 正常流程
- **操作**: `curl -X POST http://127.0.0.1:3721/api/channels/weixin/login`
- **预期**: 200, 返回 `{ "qrUrl": "https://..." }`
- **验证**: qrUrl 是有效的 iLink 图片 URL

### A2. POST /api/channels/:id/login — 无 hub context
- **操作**: hub 未启动时调用 login
- **预期**: 503, `{"error":"no hub context"}`

### A3. POST /api/channels/:id/login — 重复调用
- **操作**: 连续调用两次 login 同一 channelId
- **预期**: 第二次调用取消第一次的轮询，开始新的轮询。不应有两个并发轮询。

### A4. POST /api/channels/:id/login — QR 超时安全网
- **操作**: 调用 login 后不扫码，等待超过 10 分钟
- **预期**: 轮询自动停止，WebSocket 广播 `expired` 状态

### A5. WebSocket qr_status 广播 — pending
- **操作**: 调用 login 后，观察 WebSocket 消息
- **预期**: 收到 `{ type: "qr_status", channelId: "...", status: "pending", qrUrl: "..." }`

### A6. WebSocket qr_status 广播 — scanned
- **操作**: 用微信扫码（不确认）
- **预期**: WebSocket 广播 `status: "scanned"`

### A7. WebSocket qr_status 广播 — confirmed + credential save
- **操作**: 扫码并在微信中确认授权
- **预期**:
  1. WebSocket 广播 `status: "confirmed"`
  2. `~/.weixin-bot/credentials.json` 已更新（检查时间戳）
  3. channel 自动 reconnect（status 变为 connected）

### A8. WebSocket qr_status 广播 — expired
- **操作**: 等待 QR 过期（iLink 约 5 分钟）
- **预期**: WebSocket 广播 `status: "expired"`，轮询停止

### A9. reconnectChannel 方法
- **操作**: channel connected 状态下调用 reconnectChannel
- **预期**:
  1. channel 先 disconnect
  2. 再 connect（读取新凭证）
  3. 最终回到 connected 状态

### A10. reconnectChannel — channel 不存在
- **操作**: 对不存在的 channelId 调用 reconnectChannel
- **预期**: 打印 warn 日志，不崩溃

### A11. channel:add 不自动连接
- **操作**: POST /api/channels 创建新频道
- **预期**:
  1. channel 创建成功，出现在 channel 列表
  2. status 为 `disconnected`（不是 connecting/connected）
  3. 不会有 connect 报错（因为没有调用 connect）

### A12. DELETE /api/channels/:id — 不误匹配 /login
- **操作**: `curl -X POST .../api/channels/weixin/login`
- **预期**: 不会被 DELETE handler 拦截（返回 200 而非 404/405）

### A13. iLink API 网络错误
- **操作**: 断网状态下调用 login
- **预期**: 500, `{"error":"..."}`，不崩溃

### A14. iLink API 返回不完整数据
- **操作**: 模拟 iLink 返回无 qrcode 字段
- **预期**: 500, `{"error":"iLink 返回的 QR 数据不完整"}`

---

## B. 前端 UI 测试

### B1. 新增频道 → QR 弹窗流程
- **操作**:
  1. 点击侧栏「+ 新增频道」
  2. 选择微信，输入账号名
  3. 点击「创建」
- **预期**:
  1. AddChannelDialog 关闭
  2. QrLoginOverlay 弹出，显示二维码图片
  3. 状态文字: "请用微信扫描二维码"

### B2. QR 弹窗 — 状态文字变化
- **预期**:
  - pending: "请用微信扫描二维码"（dim 颜色）
  - scanned: "已扫码，请在微信中确认授权..."（amber 颜色 + 脉冲圆点）
  - confirmed: "授权成功，正在连接..."（green 颜色 + ✓）
  - expired: "二维码已过期"（red 颜色）

### B3. QR 弹窗 — confirmed 自动关闭
- **操作**: QR confirmed 状态
- **预期**: 2 秒后弹窗自动关闭

### B4. QR 弹窗 — expired 显示重试按钮
- **操作**: QR expired 状态
- **预期**:
  1. 显示「重新获取」按钮
  2. QR 码图片变为 30% 透明度
  3. 点击「重新获取」触发新的 login 请求

### B5. QR 弹窗 — 取消关闭
- **操作**:
  1. QR pending 状态下点击「取消」按钮
  2. 或点击弹窗外部背景
- **预期**: 弹窗关闭，后台轮询继续（不影响后端）

### B6. QR 弹窗 — 内部点击不关闭
- **操作**: 点击 QR 码图片或状态文字
- **预期**: 弹窗不关闭（stopPropagation）

### B7. ChannelCard — expired 状态显示重新登录按钮
- **操作**: channel status 为 expired
- **预期**: ChannelCard 显示「重新登录」按钮（accent 颜色）

### B8. ChannelCard — 重新登录触发 QR
- **操作**: 点击 expired channel 的「重新登录」按钮
- **预期**: QR 弹窗弹出，开始扫码流程

### B9. ChannelCard — connected 状态无登录按钮
- **操作**: channel status 为 connected
- **预期**: 不显示「重新登录」按钮

### B10. ChannelCard — disconnected 状态无登录按钮
- **操作**: channel status 为 disconnected
- **预期**: 不显示「重新登录」按钮（只有 expired 时显示）

### B11. AddChannelDialog — 创建失败
- **操作**: 创建已存在的 channelId（重复名称）
- **预期**:
  1. 显示错误信息
  2. 不触发 QR 登录
  3. 弹窗保持打开

### B12. AddChannelDialog — 空账号名
- **操作**: 不输入账号名直接点创建
- **预期**: 按钮禁用，不发送请求

### B13. AddChannelDialog — Enter 快捷键
- **操作**: 输入账号名后按 Enter
- **预期**: 等同点击「创建」按钮

### B14. AddChannelDialog — 旧的"去终端扫码"提示已移除
- **操作**: 创建频道
- **预期**: 不再显示"频道已创建。请在运行 hub 的终端中完成微信扫码登录。"

---

## C. WebSocket 前端集成测试

### C1. qr_status 事件正确触发 QR 弹窗
- **操作**: 后端广播 qr_status 事件
- **预期**: 前端 qrLogin state 更新，QrLoginOverlay 显示

### C2. 多次 qr_status 更新 UI
- **操作**: 依次收到 pending → scanned → confirmed
- **预期**: 弹窗状态文字依次更新

### C3. 关闭 QR 弹窗清除 state
- **操作**: 点击取消关闭弹窗
- **预期**: qrLogin state 被设为 null，弹窗消失

### C4. snapshot 不包含 cron 数据（删除验证）
- **操作**: 连接 WebSocket，检查 snapshot 消息
- **预期**: snapshot 不含 `cronJobs` 字段

---

## D. 删除功能回归测试（cron-scheduler 移除）

### D1. Sidebar 无 Tasks section
- **操作**: 查看侧栏
- **预期**: 只有"对话"和"Channels"两个 section，无"任务"

### D2. /api/cron-jobs 端点已移除
- **操作**: `curl http://127.0.0.1:3721/api/cron-jobs`
- **预期**: 404（不再是 200）

### D3. Page type 只有 chat 和 channels
- **操作**: 浏览 Dashboard
- **预期**: 只能切换到 chat 和 channels 页面，无 tasks 页面

### D4. TypeScript 编译无 cron 引用
- **操作**: `npx tsc --noEmit`
- **预期**: 零报错，无 cron-scheduler 相关未解析引用

---

## E. 不回退测试（existing functionality）

### E1. 消息收发正常
- **操作**: 微信发消息 → agent 回复
- **预期**: Dashboard 消息流实时显示收发消息

### E2. Channel filter 正常
- **操作**: tab 栏选择 channel 过滤
- **预期**: 消息流只显示选中 channel 消息

### E3. 昵称编辑正常
- **操作**: hover 消息 header → 点击编辑 → 输入昵称 → 回车
- **预期**: 昵称更新并持久化

### E4. Agent 切换正常
- **操作**: 侧栏点击不同 agent
- **预期**: 消息流切换到该 agent

### E5. 日志页正常
- **操作**: 切换到日志 tab
- **预期**: 日志实时显示

### E6. Channel 断开正常
- **操作**: connected channel 点击「断开」
- **预期**: channel 变为 disconnected

### E7. Channel 删除正常
- **操作**: disconnected channel 点击「删除」
- **预期**: channel 从列表移除

### E8. Channel 检查连接正常
- **操作**: 点击「检查连接」
- **预期**: 显示当前状态

### E9. Footer 状态灯正常
- **操作**: 查看底部 footer
- **预期**: channel 状态灯和 ws 状态正常显示

### E10. Vite build 通过
- **操作**: `npx vite build`
- **预期**: 编译成功

---

## F. 补充覆盖（交叉审查发现的遗漏）

### F1. QR 弹窗只在 Channels 页面渲染
- **操作**: 创建频道触发 QR 登录后，切换到 chat 页面
- **预期**: QR 弹窗消失。切回 channels 页面后弹窗重现（如果 qrLogin state 仍在）
- **关注点**: 这可能是 UX 问题 — 用户切页面后 QR 流程变不可见

### F2. handleTriggerLogin 服务端返回错误
- **操作**: 对不存在的 channelId 触发 login
- **预期**: console.error 记录，不弹出 QR 弹窗（无 qr_status 事件），界面不崩溃

### F3. channel:reconnect — disconnect 异常后仍尝试 connect
- **操作**: channel 异常状态下 reconnect
- **预期**: disconnect 报错被 warn log，connect 仍被调用

### F4. QR confirmed 自动关闭前手动点击关闭
- **操作**: confirmed 状态 2 秒 timer 触发前，用户点「完成」
- **预期**: 弹窗关闭，无 React state-update-on-unmounted 警告（useEffect cleanup 正确执行）

### F5. cron-scheduler 文件已物理删除
- **操作**: `ls src/plugins/cron-scheduler/`
- **预期**: 目录不存在

### F6. QR 登录不干扰已有 channel 消息流
- **操作**: connected channel 正在收发消息，同时触发另一个 channel 的 QR 登录
- **预期**: 消息流不中断，QR poll 与消息处理互不干扰

---

## 测试优先级

| 级别 | 用例范围 | 说明 |
|------|---------|------|
| P0 — 必须 | A1, A5, A7, A11, B1, B2, B3, B7, B8, B14, D1, D4, E1, E10, F1, F5 | 核心流程 + 删除验证 |
| P1 — 重要 | A2, A3, A6, A8, A9, A12, B4, B5, B11, C1, C2, D2, E2-E9, F2, F4, F6 | 边界条件 + 回归 |
| P2 — 可选 | A4, A10, A13, A14, B6, B9, B10, B12, B13, C3, C4, D3, F3 | 次要路径 |
