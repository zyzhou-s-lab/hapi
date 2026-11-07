# HAPI 流式性能、实体订阅与生命周期改动计划

**日期：**2026-11-08  
**状态：**计划已落盘，阶段一至阶段四均待实施。本文不代表代码、协议、数据库或生产部署已经变更。  
**开发分支：**`hapi-answer-in-grid`；工作树为 `/data1/home/zhouy1/software/hapi/fork-worktrees/answer-in-grid`。  
**依据：**[前端原理解读会话](/sessions/d67a7c03-e713-45f4-9671-3adaac97e70e)，重点为 `seq=7025`、`seq=7139`、`seq=7446` 的诊断，以及本会话随后讨论的四阶段改动顺序。  
**前序方案：**[Web 前端重构 V3.2](../specs/2026-11-05-web-frontend-rearchitecture-design.md)。

## 1. 目标与前序成果

本计划处理发送上屏延迟、流式更新成本和消息生命周期归属。前序重构已经完成组件拆分、Context 拆分、Todo 投影、视觉原语统一，以及带局部错误隔离的 `TURN_SLOTS` / `COMPOSER_DOCK_SLOTS`。这些成果继续使用，不重新实现一套卡片或插件框架。

はるか提出的四项要求是本轮的架构验收依据：

1. 列表、分页、子视图和状态同步需要明确各自的职责，不能只把旧逻辑搬进新文件。
2. 列表只消费有序的 `id + type`；工具、正文、Todo 等子视图按实体 ID 订阅自身数据。
3. 会话标题、模型设置、任务状态和消息实体分别订阅；一个会话快照变化不能驱动整棵聊天树重新计算。
4. CLI、Hub 持久化、SSE 与 Web 之间需要明确消息和运行生命周期，避免前端依靠位置或文本签名猜测状态。

会话中的“只完成约 25%”“0ms 上屏”“60fps”等表述不作为已测结果。验收需要提供相同数据规模和运行环境下的测量、浏览器交互记录及失败场景结果。

## 2. 沙箱边界与实施范围

所有开发与验证均在以下隔离环境内完成。

| 对象 | 本计划使用的环境 | 执行约束 |
| --- | --- | --- |
| 代码 | `fork-worktrees/answer-in-grid`，分支 `hapi-answer-in-grid` | 本轮落盘只新增本文；后续实施仍使用该工作树。 |
| Web | `0.0.0.0:5184` | Vite 使用 `--strictPort`，API 代理固定指向沙箱 Hub。 |
| Hub | `127.0.0.1:3106` | Hub 改动只重启沙箱进程。 |
| 状态目录 | `HAPI_HOME=/tmp/hapi-dev-rearch` | 隔离配置、日志和 Runner 状态文件。 |
| 数据库 | `DB_PATH=/tmp/hapi-dev-rearch/hapi.db` | 数据迁移和重连恢复只使用沙箱数据。 |
| CLI / Runner | 该工作树运行或构建出的 CLI | 同时显式设置 `HAPI_HOME`、`HAPI_API_URL=http://127.0.0.1:3106` 和沙箱 `CLI_API_TOKEN`。 |
| Mac 预览 | `http://100.123.160.102:5184/` 或 `http://10.202.2.224:5184/` | 使用独立浏览器 Origin；是否在线需在实施时检查。 |
| Playwright | `http://127.0.0.1:5184` | 复用沙箱 Vite，记录真实点击视频；测试 Runner 用完立即停止。 |

实施者不得将测试 Runner 连接到生产 Hub，不得使用默认 `~/.hapi` 运行沙箱进程，不得替换正式 CLI、重启正式 Runner，或改动 `hapi.237575.xyz`。合并、发布、部署属于后续操作，不由本文落盘触发。

纯 Web 改动通过 Vite 预览验证；CLI 采集改动需要沙箱 CLI 会话；Hub 和数据库生命周期改动需要沙箱 Hub。后两类不能只靠前端 Fixture 声称验收通过。

## 3. 审计发现与待确认边界

以下是源会话提供的定位入口，行号属于当时审计快照。实施时按符号读取当前代码，不按旧行号机械替换。

| 问题 | 审计定位入口 | 需要证明的行为 |
| --- | --- | --- |
| 乐观消息在 Runner 消费前被分流到队列 | `useSendMessage.ts` 的 `createOptimisticMessage`；`lib/messages.ts` 的 `isQueuedForInvocation`；`useSessionChatPipeline` 的可见消息过滤 | 空闲立即发送与显式排队具有不同的显示状态；上屏不依赖 Runner 消费确认。 |
| 消费确认和发送状态更新叠加通知等待 | `lib/message-window-store.ts` 的 `markMessagesConsumed` / `updateMessageStatus` | 这些状态更新及时通知，同时保持消息顺序、去重和失败恢复。 |
| Markdown 平滑参数未传到实际渲染器 | `components/assistant-ui/markdown-text.tsx` 的 `MarkdownText` | 参数透传后，文本正确性、终态收敛和主线程开销均满足验收。 |
| 流式期间反复全窗口持久化 | `lib/message-window-store.ts` 的 `PERSIST_THROTTLE_MS` / 持久化调度 | 每次 token 更新不再触发历史窗口的同步序列化；刷新后可从 Hub 恢复。 |
| 流式通知仍触发全窗口派生计算 | `useSessionChatPipeline`；`lib/assistant-runtime.ts` 的消息转换与运行状态对账 | 单实体内容变化不重跑全部历史消息的归约和呈现。 |
| 不同 Agent 的输出采集粒度不同 | `OmpRpcEventAdapter.scheduleSnapshot`；Codex 的 `agent_message_delta` 分支；Claude SDK query 配置 | 分别确认实际可用的增量事件、稳定消息 ID、终态事件与去重行为。 |
| 滚动与分页仍依赖旧控制器 | `useThreadScrollAndHistoryController.ts`、`threadScrollHelpers.ts` | 状态所有权和锚点恢复可以独立于消息内容更新工作。 |
| 生命周期仍有前端推断 | `assistant-runtime.ts` 的 `runningHandoff`；`turnBlockModel.ts` 的正文分区 | 运行归属和阶段来源明确；无法从 Harness 观察到的语义不能伪造。 |

## 4. 实施顺序与不变量

按阶段一 → 阶段二 → 阶段三 → 阶段四实施。阶段一拆成 Web 和 CLI 两个可独立验证的提交或 PR，避免将前端改善与采集端改善混在一起判断。阶段二设计前先确定实体 ID、版本与失效规则；若发现现有协议无法提供必要信息，应先完成对应协议前置项，再切换消费者。

前序 V3.2 为组件拆分设定了“不改核心归约、协议和滚动算法”的范围。本文的阶段三、阶段四明确提出后续扩大范围；阶段二若修改核心归约也进入该范围。实施者必须同步更新相应契约测试与文档，不能一边修改这些行为，一边声称仍满足旧方案的零改动限制。

以下用户可见契约继续保留：

- `.happy-thread-messages > [id]` 的直接子节点锚点、`MessagePrimitive.Root` 与 `@assistant-ui/react` 的消息消费入口保持有效；列表改造不增加把用户和助手消息包成一组的外层 DOM。
- 用户消息从乐观状态转为服务端确认时保持显示身份，不能重复、重挂载或跳到上一回合中间。
- 工具权限与问题控件仍归属具体工具行；回合级 Todo 与正式回答保持已有插槽位置。
- 会话切换继续由会话 ID 重置局部状态，异步回包不能写入已切走会话的视图。
- CSS 继续遵守现有 `@layer` 约束，保留流光、Spinner、完成项删除线和现有卡片样式。
- 修改 `web/src/chat/**`、`message-window-store.ts` 或 `sessionPatch.ts` 后，按仓库要求运行 `bun run gen:fixtures`；跨端输出发生变化时同步处理 iOS / Android 一致性。

## 5. 阶段一：发送上屏与流式热路径

### 5.1 空闲发送立即进入主聊天列表

**目标模块：**`web/src/hooks/mutations/useSendMessage.ts`、`web/src/lib/messages.ts`、`web/src/lib/message-window-store.ts`、`web/src/components/SessionChat.tsx`、`useSessionChatPipeline` 所在模块，以及 `QueuedMessagesBar.tsx`。

- [ ] 区分立即发送、运行中排队、显式排队与定时发送的显示语义。字段和判断应复用当前实际契约，不把 `invokedAt === null` 单独等同于“必须从聊天列表隐藏”。
- [ ] 空闲立即发送的乐观消息进入主列表，同时显示发送状态。UI 不得伪造 `invokedAt`，也不得把“已上屏”显示为“Runner 已消费”。
- [ ] 保持 `localId` 与服务端消息 ID 的对应关系，覆盖 HTTP 确认与 SSE 回显任意先后顺序。
- [ ] 对 `markMessagesConsumed`、`updateMessageStatus` 使用适合离散状态变更的及时通知，验证不会重排或重复插入消息。
- [ ] 覆盖发送失败、重试、忙闲状态竞争，以及上一回合运行期间连续发送第二个问题。

**验收：**人为延迟沙箱发送确认或 Runner 消费确认时，空闲发送的用户气泡已可见；显式排队消息仍保留队列行为；确认后原气泡不重挂载、不重复，上一回合回答始终归属上一回合。记录发送操作到气泡首帧可见的延迟，不承诺未经测量的“0ms”。

### 5.2 Markdown 平滑渲染与持久化调度

**目标模块：**`web/src/components/assistant-ui/markdown-text.tsx`、`web/src/lib/message-window-store.ts`。

- [ ] 将 `MarkdownText` 的 `smooth` 参数传到实际支持该能力的渲染器，并核对依赖版本和已有关闭原因。是否默认启用由浏览器正确性与性能结果决定。
- [ ] 验证未闭合代码围栏、表格、公式、路径链接、长回复和最终快照；最后一个字符与终态内容必须一致，并保留减少动画的无障碍行为。
- [ ] 流式期间合并或推迟窗口持久化，消除 token 路径上的整窗同步 `JSON.stringify`。流式结束时提交最新状态，页面隐藏或会话切换时尽力刷新缓存。
- [ ] 缓存不能作为唯一恢复来源；关闭标签页、重载或浏览器未执行卸载回调后，应从 Hub 获取最新数据。
- [ ] 评估将可合并的流式通知按动画帧调度；终态、失败与交互请求及时刷新。后台标签页中 `requestAnimationFrame` 暂停不能导致终态丢失。

**验收：**在相同历史窗口和相同流式输入下对比 Performance Trace；token 路径不再周期性序列化整个窗口。浏览器能完成输入、滚动和工具展开操作，刷新后恢复正文及工具终态。平滑动画不能掩盖上游未提供增量事件的问题。

### 5.3 CLI 增量采集与终态收敛

**目标模块：**`cli/src/omp/rpc/OmpRpcEventAdapter.ts`、`cli/src/codex/codexRemoteLauncher.ts`、`cli/src/codex/utils/appServerEventConverter.ts`、`cli/src/claude/sdk/query.ts` 及实际事件消费端。

- [ ] OMP：先测现有 `scheduleSnapshot` 的 75ms 节流对发送频率、Hub 写入与浏览器负载的影响；30ms 是候选试验值，不未经测量直接定为默认值。
- [ ] Codex：接入实际提供的文本 delta，保持同一输出块的稳定 ID、累计快照和终态归并；避免增量与完成事件生成两份助手回答。
- [ ] Claude：确认 SDK 是否提供 partial message、如何区分中间事件与完成消息，再接入现有传输；不能只开启选项而忽略消费端。
- [ ] 所有采集器在完成、取消、错误和连接结束时刷新已接收内容，并清理定时器；工具输入增量与工具结果也需要保持各自身份。

**验收：**分别用沙箱 OMP、Codex、Claude 会话观察支持的增量路径；将最终文本与 Agent 完成事件对齐，覆盖取消后保留已生成内容、无重复消息和无悬挂运行状态。无法运行的 Agent 明确记录缺失前提，不以其他 Agent 的录像替代验证。

## 6. 阶段二：实体 Store 与列表、子视图解耦

### 6.1 状态所有权与实体契约

**候选新增边界：**`web/src/chat/store/sessionEntityStore.ts` 及实体订阅 Hook。名称以实施时的现有约定为准，不引入重型状态框架。

| 数据边界 | 内容 | 通知条件 |
| --- | --- | --- |
| 会话标题 / 连接状态 | 标题、在线及活动状态 | 相关字段发生变化。 |
| Composer 配置 | 模型、思考等级、权限模式 | 配置字段发生变化。 |
| 会话 Todo | 当前任务投影 | Todo 的可见内容或状态发生变化。 |
| Timeline 索引 | 有序 `ReadonlyArray<{ id, type }>` | 插入、删除、重排或类型变化。 |
| Turn 结构 | 子回合和内容块 ID，以及必要的运行摘要 | 子项结构或摘要语义发生变化。 |
| Block / Tool 实体 | 一段正文、一个工具或其他独立渲染实体 | 对应实体的数据版本发生变化。 |

- [ ] 明确 `sessionId`、消息 ID、Turn ID、Block ID 与 ToolCall ID 的对应关系；作用域必须防止跨会话 ID 冲突。
- [ ] `useSyncExternalStore` 的快照使用稳定引用。内部 Map 可以更新，但不能原地修改已返回给 React 的实体快照。
- [ ] Store 只有一个写入入口，分页、实时事件和恢复数据都经过统一合并；不保留两套长期竞争的数据真理源。
- [ ] 定义过期事件、重复事件、迟到工具结果、历史编辑、删除、回退及会话切换的失效规则。已完成历史默认复用，但仍能被合法修订。

### 6.2 增量计算与消费者迁移

**目标模块：**`useSessionChatPipeline`、`web/src/lib/assistant-runtime.ts`、`HappyThread.tsx`、`TurnBlock.tsx`、`TimelineTurnBlock.tsx`、`TimelineStepRows.tsx`、现有 Slot Registry 与 Context 消费者。

- [ ] 将高频更新限制在受影响的活跃实体或回合。新页加载、历史修订等结构性操作可进行明确范围的重建，不能每个 token 都全窗归约。
- [ ] 在切换期间，以现有完整归约结果验证增量结果的语义一致性；切换完成后删除失去消费者的重复管线。
- [ ] 列表只订阅 Timeline 索引；正文、工具、Todo 按实体 ID 订阅。现有声明式插槽继续承担布局和错误隔离。
- [ ] 接通 `@assistant-ui/react` 的实际运行时入口，避免只新增一个未被主消息列表消费的 Store。
- [ ] 将标题、模型设置、Todo 与按需查询迁移到实际消费者。仅在消费者不需要数据时取消其订阅，不能破坏已有提及或设置功能。
- [ ] 在迁移全部内部调用方并验证后，删除过时深比较、全窗树对账和防刷新缓存；不以“所有 memo 都必须删除”为目标。

**验收：**向既有正文块持续追加文本时，Timeline 索引引用不变，列表订阅不通知，历史回合和不相关工具行不重渲染；工具完成只通知相应实体及确有语义变化的摘要。新增工具或消息时，结构消费者正确更新。额外覆盖分页接入、迟到结果、删除和跨会话隔离，并对比增量投影与既有管线结果。

## 7. 阶段三：分页与滚动状态机

**目标模块：**`useThreadScrollAndHistoryController.ts`、`threadScrollHelpers.ts`、`useThreadViewportEvents.ts`、`HappyThread.tsx` 及历史分页数据入口。

- [ ] 以稳定的列表结构变化驱动 append / prepend / remove，逐步移除 `messagesVersion` / `appliedMessagesVersion`、`historyVersion` / `appliedHistoryVersion` 的重复对账。
- [ ] 显式定义底部跟随、用户自由阅读、翻页锚点恢复三个基础状态，并记录进入、退出、取消和会话切换规则。
- [ ] 分页前记录可见节点 ID 与像素偏移；数据合并并完成布局后恢复。不能只观察首尾 ID 而忽略节点内容尺寸变化。
- [ ] 对图片、代码块、字体和异步工具内容导致的后续高度变化保留必要的布局观测；内容不更新列表索引，也仍可能改变滚动高度。
- [ ] 覆盖首次定位、快速连续翻页、重复页、半截回合补齐、大纲跳转、嵌套滚动容器、移动端视口变化及长图分享。
- [ ] 迁移后删除被替代的状态、定时器和恢复分支，更新对应契约测试。代码减少是结果，不以压缩 50% 行数作为正确性验收。

**验收：**向上加载历史后，同一可见锚点位置在已定义的布局稳定点保持；用户上滚阅读期间流式不抢回底部；回到底部后恢复跟随。连续翻页不重复、不丢项，分享长图和大纲跳转继续正常。真实浏览器记录锚点坐标与视频，不以 jsdom 几何结果替代。

## 8. 阶段四：协议与生命周期收口

**目标范围：**CLI Agent 适配器、`shared/src/types.ts` / `schemas.ts` / 实际传输类型、`hub/src/sync/`、Hub 消息持久化及迁移、Web 消费端、客户端契约文档与原生端协议实现。

### 8.1 先定义可观察事件，再扩展字段

- [ ] 盘点每个 Harness 实际提供的开始、输出块、工具、结束、取消、错误和压缩事件，区分观察事实与前端推断。
- [ ] 分别定义用户消息交付、运行状态与输出阶段，不能用一个 `status` 同时表示“消息已入库”“Runner 已消费”和“回合已完成”。
- [ ] 候选契约包括稳定 `turnId` / `blockId`、运行终态，以及有依据的输出阶段。`execution` / `final_answer` 只能在来源支持时赋值；没有阶段信号的 Agent 需要明确记录能力边界。
- [ ] 定义事件序号、实体版本、幂等键和终态规则。断线回放、重复投递与旧快照不能覆盖新状态。

### 8.2 持久化、恢复与 Web 切换

- [ ] Hub 将生命周期归属与消息内容按明确事务边界持久化，确保刷新或重连后仍能恢复运行归属；生命周期不能只存在于瞬时 SSE。
- [ ] 明确增量与快照的关系、恢复起点和序号缺口处理。若采用 `block-delta`，必须定义如何从 Hub 的快照或持久事件恢复，不能仅凭追加文本猜缺失内容。
- [ ] 写出数据库版本迁移和历史记录归属策略。旧记录无法确定的阶段不得伪装为已观察事实。
- [ ] 全部生产消费者切到新契约后，删除可被显式生命周期替代的 `runningHandoff` 和位置推断。若仍有缺失信号，保留有说明的限制，不能提前删除正确性依赖。
- [ ] 同步更新 REST / SSE / 消息客户端契约、Golden Fixtures、iOS 与 Android 消费逻辑；不留下两套长期并行的协议别名。

**验收：**真实沙箱会话经过 Hub 重启或 SSE 断线恢复后，用户消息、工具、正文仍归属同一回合；完成、取消、错误与压缩后续运行有明确结果。重复与乱序事件不会重复正文或逆转终态。跨端一致性检查通过；无法本地执行的原生工具链检查由 CI 提供结果后再宣告完成。

## 9. PR 切分与完成门槛

| 交付单元 | 范围 | 依赖与完成证据 |
| --- | --- | --- |
| P0-Web | 发送上屏、通知与持久化调度、Markdown 参数 | 沙箱主应用发送路径、失败和排队场景、流式 Trace、真实点击录像。 |
| P0-CLI | OMP / Codex / Claude 增量与终态 | 每种受影响 Agent 的沙箱实跑、终态文本和取消验证；节流频率由测量决定。 |
| P1-Store | 实体索引、增量投影、独立订阅及消费者迁移 | 实体身份已定义；隔离通知、投影一致性、历史修订与会话切换验证。 |
| P2-Scroll | 分页、锚点和滚动状态迁移 | P1 的结构索引稳定；真实浏览器完成连续翻页、流式阅读、尺寸变化和分享场景。 |
| P3-Lifecycle | CLI → Hub / DB → SSE → 全部客户端 | 完成事件能力盘点、迁移与跨端契约；沙箱重启恢复和幂等验证。 |

每个交付单元在删旧实现前迁移全部调用方，并更新对应文档。涉及协议的前置项可以提前实施，但不能只为保持表格顺序让 Web 先依赖不存在的字段。

## 10. 验证命令与证据要求

以下命令用于后续实施验收；本文落盘不等于这些检查已经执行。所有命令从仓库根目录运行，单独执行。

```bash
bun typecheck
```

```bash
bun run test
```

涉及仓库指定的聊天管线或消息状态文件时生成并审查 fixtures，禁止手改生成文件：

```bash
bun run gen:fixtures
```

保留既有六组浏览器回归，在实现时确认 Playwright 已开启录像，并复用 `5184` 沙箱预览：

```bash
CI= PLAYWRIGHT_WEB_PORT=5184 \
PLAYWRIGHT_CHROME_PATH=/data1/home/zhouy1/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome \
bunx playwright test \
  e2e/css-layer-and-focus.spec.ts \
  e2e/turn-timeline-slots.spec.ts \
  e2e/feature-isolation.spec.ts \
  e2e/streaming-isolation.spec.ts \
  e2e/composer-flavor-settings.spec.ts \
  e2e/thread-scroll-anchors.spec.ts
```

既有 Fixture 套件继续防守样式、槽位、错误隔离、模型设置和锚点契约；新增改动还需要对应的真实行为场景：

| 场景 | 必需证据 |
| --- | --- |
| 空闲发送与忙时排队 | 真实 Composer 操作，延迟确认下的 DOM 身份和可见状态，失败重试结果。 |
| 流式性能 | 固定历史规模、输出大小和输入频率，前后 Trace、通知及渲染计数；终态文本一致。 |
| 实体隔离 | 单实体更新与结构更新分开观测，覆盖工具、Todo、正文及其他会话更新。 |
| 滚动分页 | 鼠标或触控等效滚动、锚点几何、延迟尺寸变化、连续翻页与录像。 |
| 生命周期恢复 | 沙箱 CLI + Hub 实跑，断线 / 重启、重复事件及终态恢复结果。 |
| 视觉回归 | 真实计算样式与几何，覆盖输入框焦点、流光、Spinner、Todo 删除线及卡片布局。 |

新增永久测试只覆盖可能影响消费者的状态转换、身份、顺序、幂等、边界和错误恢复，不新增锁定源码文本、行数或内部转发形式的测试。浏览器录像证明交互，性能结论另附测量数据，二者不能相互替代。
