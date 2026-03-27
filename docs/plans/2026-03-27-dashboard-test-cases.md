# Dashboard 改版 — 完整测试用例

## 一、侧栏导航

### 1.1 对话 section
- [ ] TC-S01: 侧栏显示"对话" section 标题 + agent 数量
- [ ] TC-S02: 展开后显示所有注册的 agent（5 个）
- [ ] TC-S03: connected agent 显示绿色状态灯 + 发光效果
- [ ] TC-S04: stopped agent 显示灰色状态灯
- [ ] TC-S05: 点击 agent 名字 → 右侧切到消息流 + 选中高亮
- [ ] TC-S06: 点击不同 agent → 消息流切换到对应 agent
- [ ] TC-S07: 折叠 ▶ 按钮 → agent 列表收起
- [ ] TC-S08: 再次点击 → agent 列表展开

### 1.2 Channels section
- [ ] TC-S09: 侧栏显示"Channels" section 标题 + channel 数量
- [ ] TC-S10: 展开后显示所有 channel + 状态灯
- [ ] TC-S11: connected channel 绿灯
- [ ] TC-S12: disconnected channel 灰灯
- [ ] TC-S13: "新增频道" 链接可见
- [ ] TC-S14: 折叠/展开正常
- [ ] TC-S15: 点击 channel → 切到 Channels 管理页

### 1.3 页面切换
- [ ] TC-S16: 点击"对话"标题 → 右侧显示消息流页面
- [ ] TC-S17: 点击"Channels"标题 → 右侧显示 Channels 管理页
- [ ] TC-S18: 当前 section 标题高亮（accent 色）
- [ ] TC-S19: 切换页面后侧栏折叠状态保持不变

## 二、Channels 管理页

### 2.1 Channel 卡片
- [ ] TC-C01: 每个 channel 显示为独立卡片
- [ ] TC-C02: 卡片显示：频道类型（微信）、频道名称、状态灯+文字
- [ ] TC-C03: connected 状态 → 显示"检查连接"+"断开"按钮
- [ ] TC-C04: disconnected 状态 → 显示"检查连接"+"删除"按钮
- [ ] TC-C05: expired 状态 → 显示红色警告 banner + "检查连接"+"删除"按钮

### 2.2 检查连接
- [ ] TC-C06: 点击"检查连接" → 按钮变"检查中..."
- [ ] TC-C07: 返回后显示 (probe: connected) 或 (probe: disconnected)
- [ ] TC-C08: 连续点击不会重复请求（disabled 状态）

### 2.3 断开连接
- [ ] TC-C09: 点击"断开" → channel 状态变为 disconnected
- [ ] TC-C10: 断开后按钮变为"删除"
- [ ] TC-C11: 侧栏 channel 状态灯变灰
- [ ] TC-C12: Footer channel 状态灯变红

### 2.4 删除 channel
- [ ] TC-C13: 点击"删除" → 卡片从列表消失
- [ ] TC-C14: 侧栏 channel 数量 -1，该 channel 从列表移除
- [ ] TC-C15: Footer 该 channel 状态灯消失
- [ ] TC-C16: 重启 hub 后，删除的 channel 不再出现（持久化验证）
- [ ] TC-C17: 删除最后一个 channel → 不应该删除（或有确认提示）

### 2.5 新增 channel
- [ ] TC-C18: 点击"新增频道" → 弹出新增对话框（模态弹窗，不是 inline）
- [ ] TC-C19: 对话框包含：频道类型下拉、授权账号名输入框、取消/创建按钮
- [ ] TC-C20: 频道类型下拉默认"微信"，Telegram 为 disabled
- [ ] TC-C21: 账号名为空时"创建"按钮 disabled
- [ ] TC-C22: 输入账号名 → "创建"按钮 enabled
- [ ] TC-C23: 点击"创建" → 提示需要在终端扫码（当前无 QR 码展示能力）
- [ ] TC-C24: 创建成功 → 新 channel 出现在卡片列表和侧栏
- [ ] TC-C25: 创建重复 ID → 显示 409 错误
- [ ] TC-C26: 点击"取消" → 对话框关闭
- [ ] TC-C27: 新增对话框不应与 channel 列表同时显示（互斥或弹窗遮罩）

## 三、消息流改版

### 3.1 消息气泡 — channel header
- [ ] TC-M01: 新入站消息显示 header：channelId | userId（截取后 8 位）
- [ ] TC-M02: 出站消息（agent 回复）不显示 header
- [ ] TC-M03: permission_request / permission_verdict 不显示 header
- [ ] TC-M04: 历史消息（无 channelId）不显示 header（预期行为）
- [ ] TC-M05: 同一用户连续入站消息 → 只有首条显示 header，后续省略
- [ ] TC-M06: 不同用户交替 → 每次换人都显示 header
- [ ] TC-M07: 同一用户但不同 channel → 每次换 channel 都显示 header

### 3.2 昵称编辑
- [ ] TC-M08: hover 消息 header → 铅笔图标 ✏️ 出现
- [ ] TC-M09: 不 hover → 铅笔图标隐藏
- [ ] TC-M10: 点击铅笔 → header 变成 inline input
- [ ] TC-M11: 输入昵称 → 按 Enter → 保存
- [ ] TC-M12: 保存后该用户的**所有**消息 header 立即更新为新昵称
- [ ] TC-M13: 按 Esc → 取消编辑，恢复原显示
- [ ] TC-M14: input 失焦 → 取消编辑
- [ ] TC-M15: 保存后刷新页面 → 昵称仍然保持（持久化验证）
- [ ] TC-M16: 保存后 API 返回成功（PATCH /api/nicknames 200）
- [ ] TC-M17: 编辑已有昵称 → input 预填当前昵称

### 3.3 Channel 筛选
- [ ] TC-M18: tab 栏显示 channel 筛选下拉，默认"全部频道"
- [ ] TC-M19: 下拉列表包含所有注册的 channel
- [ ] TC-M20: 选择某 channel → 消息流只显示该 channel 的消息
- [ ] TC-M21: 历史消息（无 channelId）在选了 channel 后被过滤掉
- [ ] TC-M22: 切回"全部频道" → 所有消息恢复显示
- [ ] TC-M23: 新增/删除 channel 后 → 下拉列表更新

## 四、TopBar

- [ ] TC-T01: 显示 cc2im logo + 运行时间
- [ ] TC-T02: 显示 Context In / Generated / Today / TPD 指标
- [ ] TC-T03: 指标数值随时间更新（token 消耗变化）
- [ ] TC-T04: hub 断连时 logo 圆点变红

## 五、Footer

- [ ] TC-F01: 显示版本号 cc2im v0.1.0
- [ ] TC-F02: 显示 USAGE bar（CURRENT + WEEK）
- [ ] TC-F03: 每个 channel 显示状态灯（绿=connected，红=其他）
- [ ] TC-F04: ws 连接状态显示
- [ ] TC-F05: channel 断开后 → 对应灯变红
- [ ] TC-F06: channel 删除后 → 对应灯消失

## 六、服务端 API

### 6.1 GET /api/channels
- [ ] TC-A01: 返回 channel 列表 JSON 数组
- [ ] TC-A02: 每个 channel 包含 id, type, label, status
- [ ] TC-A03: 无 channel 时返回空数组

### 6.2 POST /api/channels
- [ ] TC-A04: 请求 body {type, accountName} → 201 + channel 对象
- [ ] TC-A05: 缺少 type 或 accountName → 400
- [ ] TC-A06: 重复 channelId → 409
- [ ] TC-A07: 创建后 channels.json 包含新 channel

### 6.3 DELETE /api/channels/:id
- [ ] TC-A08: 存在的 channel → 200 {ok: true}
- [ ] TC-A09: 不存在的 channel → 404
- [ ] TC-A10: 删除后 channels.json 不包含该 channel

### 6.4 POST /api/channels/:id/probe
- [ ] TC-A11: 存在的 channel → 200 {id, status}
- [ ] TC-A12: 不存在的 channel → 404

### 6.5 POST /api/channels/:id/disconnect
- [ ] TC-A13: connected channel → 200 {id, status: "disconnected"}
- [ ] TC-A14: 不存在的 channel → 404

### 6.6 GET /api/nicknames
- [ ] TC-A15: 返回 nicknames 数组 [{channelId, userId, nickname}]
- [ ] TC-A16: 无昵称时返回空数组

### 6.7 PATCH /api/nicknames/:channelId/:userId
- [ ] TC-A17: 请求 body {nickname} → 200 {ok: true}
- [ ] TC-A18: 缺少 nickname → 400
- [ ] TC-A19: 更新已有昵称 → 覆盖旧值
- [ ] TC-A20: GET /api/nicknames 返回更新后的值

### 6.8 WebSocket snapshot
- [ ] TC-A21: 连接后收到 snapshot 包含 agents, channels, nicknames
- [ ] TC-A22: channels 包含所有注册 channel 的 id/type/label/status
- [ ] TC-A23: nicknames 包含所有已设置的昵称

### 6.9 HubEventData
- [ ] TC-A24: message_in 事件包含 channelId + channelType
- [ ] TC-A25: message_out 事件包含 channelId
- [ ] TC-A26: channel_status 事件正确广播

## 七、数据持久化

- [ ] TC-P01: channels.json — 新增 channel 后文件更新
- [ ] TC-P02: channels.json — 删除 channel 后文件更新
- [ ] TC-P03: channels.json — 重启后 channel 列表恢复
- [ ] TC-P04: nicknames 表 — 设置昵称后 SQLite 中有记录
- [ ] TC-P05: nicknames 表 — 重启后昵称保持
- [ ] TC-P06: messages 表 — 新消息包含 channel_id 列
- [ ] TC-P07: 无 channels.json 时 — 默认创建 weixin channel（向后兼容）

## 八、兼容性回归

- [ ] TC-R01: 微信消息收发正常（发消息→agent 回复→微信收到）
- [ ] TC-R02: @mention 路由正常（@geo xxx → geo agent）
- [ ] TC-R03: 权限审批正常
- [ ] TC-R04: 媒体收发正常（图片/文件）
- [ ] TC-R05: Typing indicator + 10s ack 正常
- [ ] TC-R06: Agent 离线 → 消息排队 → 上线重放
- [ ] TC-R07: 日志页正常显示
- [ ] TC-R08: TypeScript 编译无报错
- [ ] TC-R09: Vite 构建无报错

## 九、边界/异常

- [ ] TC-E01: 刷新页面 → 状态恢复（agent/channel/nicknames）
- [ ] TC-E02: hub 重启 → dashboard 自动重连
- [ ] TC-E03: 同时打开多个 dashboard 页签 → 状态同步
- [ ] TC-E04: 快速连续点击操作按钮 → 不产生重复请求
- [ ] TC-E05: 网络断开 → footer 显示 ws reconnecting
