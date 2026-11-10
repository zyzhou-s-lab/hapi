# Loading 性能与生命周期正确性整改方案

- 日期：2026-11-10。
- 对象：`hapi-answer-in-grid` 当前工作树，包括基于 `0aafa1e8` 的既有未提交整改；路径为 `fork-worktrees/answer-in-grid`。
- 状态：设计提案，未实施。本文不表示任何代码修复、数据库迁移或性能目标已经通过。
- 相关文档：`2026-11-08-web-streaming-and-entity-store-plan.md`、`2026-11-09-haruka-architecture-remediation-plan.md`。后者的历史执行记录予以保留；其中“全部完成”“O(1) 入库”等声明不能作为本文所列缺口的验收证据。

## 1. 因果结论与范围

本次 Loading 的直接成本不能归因于 Codex `turn_id` 未接通或迟到旧轮次最终快照抢占新轮次。测量对象是 OMP 会话，采样时回放已停止，Hub 为 `thinking=false / idle`；加载期间没有执行这两种事件路径。修复它们可以纠正轮次归属和终态，不能据此承诺消除 Loading。

| 已发现问题 | 与本次 Loading 的关系 | 本方案的处理方式 |
| --- | --- | --- |
| Codex 生产者发送 `turn_id`，共享读取器只认 `turnId` | 独立的接入正确性问题；不是 OMP 静态加载的直接原因。 | 工作线 C1 修复生产者与消费者契约。 |
| 旧轮次 final 抢占新轮次、结束后旧流重新进入运行态 | 独立的生命周期问题；在发生时可能引发错误状态及额外更新，但此次加载没有观察到这些事件。 | 工作线 C2 修复持久顺序和截止规则。 |
| SQLite 收口其他消息但未发布这些消息的最终快照 | 在线窗口与数据库暂时不同步；后续 tail sync 可以修复，不等于此次首屏耗时。 | 工作线 C3 完成终态发布。 |
| 分页锚点误判、初始 coverage 缺少唤醒 | 影响跳动和何时请求历史，不能解释全部 JSON、归约和挂载耗时。 | 单独的滚动正确性变更，不与性能收益混算。 |
| 大页、每次 prepend 后全窗口归约、首次构造大量步骤节点 | 此次已有直接测量证据的性能来源。 | 工作线 P 处理；保留正常 Loading，不隐藏等待。 |

当前分页通过 `isHumanTurnStart` 按已消费的人类用户消息识别边界，而不是读取原生 `turnId`：`shared/src/turnBoundary.ts:56-66`、`hub/src/sync/messageService.ts:314-376`。当前列表把相邻助手内容合为线程条目：`web/src/lib/assistant-runtime-blocks.ts:55-89`。因此，单独对齐 Codex 轮次字段并不会自动减少当前分页扫描、传输体积或前端节点数量。

本次交付只制定方案，不修改运行代码、原始会话、生产 Hub、沙箱数据或渲染参数。用户问题中的“如果是”并未由证据成立；以下性能措施是针对实测主因的独立优化建议，不表示用户已批准新一轮重写。两条工作线分别验收，正确性修复不是性能修复的替代证据。

## 2. 已测基线与必须保留的不变量

### 2.1 基线

基线来自正常 `/sessions/:id` 页面，数据为主仓库工作会话的只读快照，共 7,740 条消息、66,228,718 字节导出消息 JSON。最后一个原始用户轮次为 5,381 条；后续压测附加的两个正文记录不计入这份原始规模。

以下计时来自 Linux Chromium、Vite 开发模式，不是 Mac 计时，不应直接用来规定线上 SLA。

| 场景 | 实测 |
| --- | --- |
| 干净进入页面 | latest 响应 2,000 条；窗口保留 1,024 条；加载提示约 1.47 秒。 |
| 初次响应读取和 JSON 解析 | `Response.json()` 约 254ms，包含读取等待，不等同于纯 JSON CPU 时间。 |
| 首次数据应用及展示 | 观察到 722ms 主线程长任务；没有将其全部归为 React 或 reducer。 |
| 一次 Load earlier 操作 | 连续取得 2,000、2,000、963 条。 |
| 三页网络传输 | 约 391、331、322ms；传输体积约 2.00、1.80、1.12 MiB，解码后约 19.22、16.79、8.07 MiB。 |
| 三次历史归约 | `reconcileInput` 的实际非空计算约 303、307、839ms，均为 `full`；对应窗口 2,420、4,420、5,383 条。 |
| 最后稳定窗口 | 12 个顶层条目、504 个工具步骤；空闲两秒无新 Store 应用、无主线程长任务。 |

网络、响应读取、归约和长任务存在包含或重叠关系，不能把上表毫秒数直接相加。数据已证明“补页后仍有全窗口工作”，尚未给出每个 React 子组件的独立耗时。

### 2.2 保留项

1. 列表继续只消费稳定 `id + role/kind`；内容更新不得重新挂载不相关消息。
2. 已返回给 React 的实体快照不可原地修改。内部索引允许变化，外部订阅只能看不可变快照。
3. 乐观用户消息确认后保留显示身份；工具、子代理、权限、Todo、分享、复制、大纲和 rewind 的内容不能因优化遗漏。
4. 初次解析新数据至少需要与输入体积相关的工作。本文不承诺冷启动严格 O(1)，也不把“没有 Loading”当成正确性要求。
5. 7,740 条数据库记录不等于同一帧显示 7,740 个完整卡片。传输量、窗口量、归约块数、DOM 数量须分别记录。
6. `content-visibility` 不是虚拟列表，且当前末尾六个条目免除该裁剪；不能以它证明节点挂载成本已经消失。

## 3. 工作线 P：缩小数据应用和首次挂载成本

### P0：固定比较条件与阶段边界

目标是解释并减少实际工作，不是缩短 Loading 动画。

- 固定同一快照、相同页面路径、浏览器、构建模式、初始缓存状态、窗口规模和工具展开状态。冷打开、同页返回、历史补页、持续流更新分开比较。
- 延续本次临时浏览器测量：记录请求及响应体积、读取/解析结束、窗口操作、Store 投影、React 提交、Loading 结束、滚动锚点恢复。计时探针不留在生产代码。
- 单独记录 `full` 与受影响范围的归约次数，不能用“组件没有重渲染”代替“没有计算”。
- 用户当前的顺滑阅读观察保留为事实。新验收需明确测试时是否真的有持续消息进入。

验收：修改前后使用同一数据和条件；报告绝对值及差值，明确开发构建开销。没有测量就不填写提升百分比或“零延迟”。

### P1：让窗口操作成为实体更新入口，而不只是缓存有效性提示

目标文件：

- `web/src/lib/message-window-store.ts`
- `web/src/components/sessionChatHelpers.tsx`
- `web/src/chat/store/sessionEntityStore.ts`
- `web/src/chat/reducer.ts`、`reducerTimeline.ts`、`reducerTools.ts`、`tracer.ts`、`reconcile.ts`
- `web/src/lib/assistant-runtime-blocks.ts`

当前 `windowOperation` 只参与前缀可复用判断；正文更新仍归约活动尾部，prepend 则进入全量分支。关键位置为 `sessionEntityStore.ts:489-502、1186-1305、1342-1389`。

#### P1.1 操作和身份

统一采用现有 `MessageWindowOperation.kind` 命名，不再引入另一套 `type/reset/upsert` 别名。补齐实际消费者需要的信息，而不是仅记录操作名称。

| 操作 | 必须携带的信息 | 应处理的范围 |
| --- | --- | --- |
| `replace-window` | 替换窗口、epoch、原因、操作序号 | 冷加载或明确失效时允许完整重建。 |
| `append-tail` | 新增或替换行及其消息/stream 身份 | 新输入和其依赖实体。 |
| `upsert-live-stream` | 稳定 stream 身份、新快照、被替换的数据库消息身份 | 对应输出实体；只有结构、阶段或状态真正变化时更新布局/头部。 |
| `prepend-history` | 新页、边界游标、historyVersion、操作序号 | 新页以及因补全上下文而变化的依赖范围。 |
| 移除/rewind/乐观确认 | 删除身份或确认映射、当前 generation | 被删除或替换的实体及其索引。 |

Hub 会为同一 stream 的新快照产生新数据库消息行并删除旧行；前端不能只按数据库消息 ID 定位流式实体。消息 ID、stream ID、toolCall ID、前端显示 ID 必须分别保留对应关系。

操作合并必须保留“多个实体都变了”的事实。序号或 generation 不连续时执行一次明确的窗口重建；不能静默漏掉操作，也不能每次 session metadata 变化都重建消息窗口。

#### P1.2 复用现有归约算法，先证明安全重放范围

第一步保留 `reduceChatBlocks` 及 fixture 管线作为语义基准，先对已证明安全的输出段复用结果。不把通用单步 reducer 框架列为缩短此次 Loading 的先决工程。

现有算法包含前后文相关的多次扫描：stream 最终快照替换、`collectTitleChanges`、`traceMessages` 的工具/parent 映射、sidechain 分组、注入 UUID、最后的 error/compaction/dedupe folds。工具权限、usage、goal、ready 也可能使旧输出变化。依赖索引和检查点必须包含这些事实，不能只以 REST 页或用户轮次切段。

实施先从现有 Store 已有的 message/stream/tool 关系扩展，只建立马上用于定位受影响输出的索引。正文同流替换在已确认不改变结构和其他语义字段时，替换对应实体；工具结果和权限变化只更新其关联输出。无法证明局部等价时，调用现有完整算法重放完整受影响后缀，必要时显式重建窗口。

达到计算预算不能丢弃剩余依赖，只能调整调度或使用完整回退。不得另外复制一套“简化快 reducer”。若未来逐步提取可复用的状态内核，完整方式和增量方式必须调用同一语义实现；这项抽取应由差分测试和实测收益驱动，而非先创建 `applyMessageStep` 外壳。

验收同时记录每种操作的实际重放范围和回退原因。只在真实覆盖了依赖闭包后，才允许宣布某类操作不再重算历史。

#### P1.3 prepend 不能只优化尾部

本次最明显的耗时来自 prepend 后重算 2,420、4,420、5,383 条窗口，因此这是必测路径。

- 新页只规范化一次，并保留不可变页面段；不要为每个 tick 拼接所有历史数组。
- 记录归约检查点和边界依赖。旧页补入后，重建新页以及依赖其上下文的既有输出。
- 只有经过依赖分析的边界才可作为检查点。人类轮次或 REST 页边界本身不保证封闭，因为工具结果、权限、sidechain、标题和 compaction 可以跨页。
- 如果补入页改变此前的归属，按依赖索引找到最早受影响检查点，重放到状态重新收敛的位置；保留其他实体引用、布局引用和展开状态。
- 合法的历史编辑、删除、epoch 重置等可以显式完整重建。若常见 prepend 仍反复退化为全窗口重建，就不能宣布这项完成。

现有 `SettledPrefixCache` 只在替代路径迁移全部调用者并验证后删除；不新增叠在它外面的第二层持久缓存。

验收：同一输入以完整方式和分批 append/upsert/prepend/移除方式运行，语义投影一致；纯正文内容更新不重归约未变历史；常见 prepend 不重复规范化未变行，重放范围可解释且小于整个已加载窗口。计算仍与实际输入及依赖范围有关，不承诺任意事件严格常数成本。

### P2：减少关闭执行轨道的首次子树构造

目标文件：`TurnExecutionRail.tsx`、`TimelineStepRows.tsx`、`TimelineTurnBlock.tsx`、`TurnBlock.tsx`、分享捕获代码。

工具正文已经采用 `open || hasOpened` 懒挂载（`TimelineStepRows.tsx:636-643`），不要重复实现这项优化。仍需处理的是 `TurnExecutionRail.tsx:275-381` 在整条轨道关闭时仍构造所有 `stepRows` 子节点。

- 关闭的历史轨道只挂载标题、汇总、必须持续显示的权限/问题及 pinned 内容，不挂载完整步骤列表。
- 回合和工具展开状态按稳定 ID 存在条件子树之外；开关轨道不能丢失用户已展开工具的状态。
- 正文、复制和大纲仍从 Store 按需读取，不依赖隐藏 DOM 充当数据存储。
- 分享现有内容时若依赖完整 DOM，使用独立的离屏捕获树按需挂载、等待实际布局完成并在捕获后卸载；不能为了节省首屏节点而分享空图或缺失工具。
- 活跃工具、权限请求和问题控件不能因轨道关闭被卸载到不可操作。长列表虚拟化不列为本阶段默认依赖。

验收：关闭轨道的已挂载步骤节点显著减少；打开后内容与原实现一致；重复打开保留状态；复制、分享、大纲、权限流程和滚动锚点正常。真实浏览器观察首挂及首次展开的长任务，而非只比较源码行数。

### P3：按剩余瓶颈决定是否调整分页或线程

P1/P2 不会消除读取新内容的线性成本。若相同数据下，P0 仍显示大响应读取/解析或单次不可中断计算主导 Loading，再单独推进以下候选；不能预先把它们都列为必做。

1. **页体积预算候选**：当前“20 轮、最多扫描 2,000 行”对超长工具输出仍可能返回约 20MiB 解码内容。候选 API 增加明确的行/字节预算及“轮次尚未补齐”信息，必须保持复合游标、queued pinned 行、epoch 和历史可达性。需要同步 shared schema、Hub、Web、iOS/Android 和客户端契约，不暗改现有 `limit + turns` 含义。
2. **连续补页交互候选**：一次 Load earlier 当前可以为可见边界连续取多页。是否改成逐页展示及显式继续加载，是行为变更，不是删除循环就结束。只有能保留 split-turn 展示、工具关联、viewport coverage、锚点和全部历史可达时才采用。实施前确认该交互，不以“只取一小页”冒充同规模优化。
3. **Worker 候选**：若不可避免的解析/归约仍占用主线程，再把同一语义内核移入会话级 Worker。使用 session generation 丢弃切换后的旧结果；避免 raw JSON、规范化数据和完整投影长期重复驻留，比较传输/复制与内存开销。Worker 不减少网络量，也不能解决错误事件归属。

无论选择哪项，Loading 应继续表示真实的请求、应用和锚点就绪状态。禁止提前隐藏 Loading、丢弃数据、关闭平滑参数或缩小测试数据来制造收益。

## 4. 工作线 C：独立完成事件身份与生命周期正确性

### C1：在 CLI 适配边界统一轮次身份

目标文件：`cli/src/codex/codexRemoteLauncher.ts`、`codexLocalLauncher.ts`、`utils/codexEventConverter.ts`、`cli/src/api/apiSession.ts`、`shared/src/messages.ts`、`web/src/chat/normalize.ts`、`normalizeAgent.ts`、相关 schemas、迁移和原生消费者。

- HAPI 持久信封统一采用 `meta.turnId`；REST/SSE 交付统一采用已有顶层 `DecryptedMessage.turnId`，归一化优先消费这个交付字段。原生 `data.turn_id` 留作 Harness 原始载荷，不再作为第二套运行控制字段。
- CLI sender 增加明确的 HAPI 消息上下文参数，由适配器提供已确认的 turn/invocation/scope。remote 从原生事件上下文传入；local 必须把 converter action 上的 `turnId` 传给 dispatcher，不能只在通用 sender 中改一个 snake_case 名称。
- `ApiSession` 将上下文写入信封 `meta`；共享 extractor 读规范信封；Hub 同步写入索引列及顶层 delivery；Web 与 iOS/Android 通过 delivery 字段保留该身份。父线程、子代理和历史回放 scope 分开，带有 turnId 的 child/usage/内容消息并不因此取得激活权限。
- 历史数据只迁移已存原生字段能够确定的归属，同时更新规范信封及 DB 索引列。仅回填列但不迁移 delivery/normalization 不算完成；缺失信号保持 unknown，不能从相邻文本或可变消息序号造出真实 start。
- 全部消费者迁移和历史回填完成后移除运行层的双拼写解析；原始 provider 载荷可保留原拼写作为数据。无原生身份的来源使用明确的本地 invocation 身份，并注明它不是原生 turn ID。

验收必须覆盖 remote 和 local 的实际载荷、历史回放及 child 路由，经 ApiSession、真实 Hub handler、SQLite、SSE 和 Web/native；不能只手写 camelCase 输入。C1 与 C2/C3 同批切换，避免仅接通 turnId 后扩大现有错误生命周期规则的适用范围。

### C2：用稳定轮次记录取代可变消息序号的顺序判断

当前问题：`messages.ts:62-71` 的 stream 替换会删除原始消息行；`sessions.ts:733-737` 又用这些行的 `MIN(seq)` 比较轮次新旧，故迟到旧 final 可能变成“最新轮次”。

拟引入最小持久轮次记录，记录会话内的轮次身份、不可变启动顺序、当前状态和截止事实。具体存储可以为独立 turn 表；不把整段 raw 消息 JSON 当成轮次顺序索引。启动顺序由受认可的 turn-start/本地调用开始分配，而不是由任意迟到正文首次到达重新分配。

| 输入 | 允许的状态变化 | 禁止的副作用 |
| --- | --- | --- |
| 已确认新 invocation/turn-start | 创建新运行记录并取得 active 身份。 | 不按任意旧 stream 的到达时间开启新运行。 |
| 当前轮次正文/工具更新 | 更新该轮次实体和有依据的阶段。 | 不因一个正文 stream final 就认定所有工具/整轮结束。 |
| 旧轮次迟到 final/result | 修正旧轮次自己的内容；必要时保持其终态。 | 不取得 active 身份，不结束新轮次。 |
| 重复 start/end/final | 幂等读取或修正允许的内容。 | 不分配新启动顺序，不逆转截止。 |
| abort/明确 turn-end/session-end/失活截止 | 持久化截止，并收口其实际拥有的 open streams。 | 不跨轮次收口仍有效的新运行。 |
| 已截止轮次的未知 stream live | 丢弃或作为该旧轮次的非运行历史补充，策略须统一。 | 不重新打开运行状态。 |

“正文块 final”“轮次 terminal”“会话离线”不是同一概念。必须先建立各 Harness 的实际事件能力表：Codex 的 task/turn terminal、Claude 的 result、OMP 的 agent_end 或等效实际信号分别经适配器转换。若来源允许同一原生 turn ID 恢复执行，新增显式 invocation/generation 区分，不能永远封死原生 ID，也不能让普通正文充当恢复授权。

当前已核实的接入约束如下，实施时不能将它们省略成一个通用“结束事件”：

| 入口 | 当前可见事实 | 方案约束 |
| --- | --- | --- |
| `ApiSession.sendAgentMessage` | `apiSession.ts:1089-1134` 原样包装 body，不转换 `turn_id`。 | 在明确的 HAPI 适配边界完成一次规范化。 |
| `ApiSession.sendSessionEvent` | `apiSession.ts:1137-1178` 目前没有带轮次身份的开始/结束类型；`ready` 属于可丢弃队列类别。 | 不能把新增生命周期记录伪装成已存在的可靠通路。新增规范生命周期类型须携带 invocation/turn 身份、幂等 event ID 和来源证据，并走 lossless 入队及已提交后重试/确认规则；重复重放由 Hub 幂等处理。 |
| OMP | `OmpRpcEventAdapter.ts:613-646` 的 `agent_start` 触发运行开始，`agent_end` 触发结束；`turn_end` 目前只刷新内容边界。无原生 ID 时使用进程局部 `omp-turn-N`。 | 区分外层 invocation 与内层轮次；进程重启不能仅靠局部计数区分运行，需附加 source instance/invocation 身份。 |
| Codex | `codexRemoteLauncher.ts:2954-2964、3179-3225` 存在带 ID 或匿名 task start；接受 terminal 前会核对 turn/thread 上下文，失败可进入同 conversation 重试。普通 `agent_message` final 不执行这些 terminal 状态变化。 | 规范事件来自验证后的 start/terminal 分支，保留 attempt 与用户 invocation 的区别；不能绕过过滤直接把 raw terminal 或正文 final 当成整项工作结束。 |
| Claude | `sdkToLogConverter.ts:414-470、602-637` 以 `parent_tool_use_id` 或主 scope 管理流；`result` 转成 `turn_duration`，未保留完整 terminal outcome，也没有确定的原生 turnId。 | launcher 的 result 子类型、取消和恢复映射仍是实施前置门禁；不能把 SDK uuid/num_turns 当成原生轮次身份。 |

新增规范生命周期记录只承载适配器已观察到的事实；Hub 自己的 abort/失活截止注明为 Hub 判定，不冒充原生 Harness terminal。来源暂未提供身份的记录可以完成内容展示，但不能凭到达时间获得新轮次的激活权限。

已有数据迁移只回填可证明的 turn identity/order；无法确定时标记历史未知。不在启动时扫描全部历史并宣称恢复出了原始生命周期。会话 clone/fork/rewind/merge 和删除同步处理新记录，保持 namespace/session 隔离。

验收至少包含：t1 live → t2 start/live → 迟到 t1 final 后 active 仍为 t2；t2 的流保持 live；截止后的 t1 未见 stream 不复活；重启后结果一致；合法显式恢复能建立新 generation。内容正确性与激活权限分别断言。

### C3：终态事务结果必须发布给在线消费者

目标文件：`hub/src/store/messages.ts`、`messageStore.ts`、`sessions.ts`、`hub/src/sync/sessionCache.ts`、`syncEngine.ts`、`sessionHandlers.ts`、`web/src/hooks/useSSE.ts`。

- 将需要原子化的轮次状态和所属 stream 收口放进同一 Store 事务；返回受影响的最终消息行及最终会话状态。
- 事务成功后更新内存缓存，并用现有 `message-received` 发布每条改变的消息快照，再发布相应 `session-updated`。失败时不发布半完成状态。
- 收口前必须核实轮次 ownership；不能先收口旧/新流再判断生命周期更新是否允许。当前 `(turn_id = ? OR turn_id IS NULL)` 必须收窄：定向截止旧轮次只作用于已归属的行，无身份行不能猜作该轮次；真正 session-wide abort/end 另走会话截止。
- 在线窗口优先使用现有精确消息发布，不额外用每个 token 或每次完成的全局 SSE invalidation 替代。现有 `sessionCache` 已有发布最终消息行的模式，消息 handler 应复用而不是丢弃收口返回值。
- 保留现有 `finalizeOpenLiveStreamsForSession` 的 epoch bump 和重连 reset 语义：旧位置的消息被原地改成 settled 时，`after` 游标看不到这次修订，仍需靠 epoch mismatch 恢复。即使游标坐标未改变，也不能删掉这项保护。只有另行实现持久 revision/catch-up 合同后，才讨论减少 reset。

验收：单个 answer content-final 只结束其正文流，后续工具仍可继续；收到真正 turn terminal/cutoff 后，所有归属该运行且应截止的行在数据库和在线窗口均为 settled。旧 A 的截止不影响新 B 或无法归属的新行；在线一致不依赖刷新，断线期间错过原地修订仍能通过 epoch/tail sync 恢复。

### C4：工具终态推断与滚动恢复分别收口

本阶段不把已有兜底全部删除，也不另建滚动框架。权威结果与几何事实优先；无法证明的推断保留显式来源。

#### C4.1 工具结果不能由 ready、peer 或后续正文冒充

目标文件：`web/src/chat/reducerTimeline.ts`、`reducerTools.ts`、`types.ts`，以及生成 `context.sessionThinking`、`context.activeTurnId` 的调用者。

当前 `completeOrphanedRunningTools` 直接把可协调的 running 工具改成 `completed`（`reducerTimeline.ts:341-356`）。三个调用点会触发它：`ready`（`:547-550`）、非 steered 用户消息（`:781-783`），以及 `wait` 完成后对其他 running 工具的处理（`:359-371`）。新工具出现时，活跃 wait 还能把明确的 `in_progress` 改成 `completed`（`:1050-1058`）。`isActiveTurnBlock` 在没有 `activeTurnId` 时把所有块视为活动块（`:333-338`），因此身份缺口会扩大误收口范围。

当前展示状态只有 `pending | running | completed | error`（`types.ts:238`），输入状态里的 failed/cancelled 也会映射成 `error`（`reducerTools.ts:54-59`）。因此本阶段不新增 `interrupted` 或 `unknown` 状态。cutoff 不能标成成功：

| 输入 | 处理 | 禁止结果 |
| --- | --- | --- |
| 明确 tool result/terminal | 继续映射为 `completed` 或 `error`。 | 不由相邻事件改写该结果。 |
| invocation/session cutoff，且工具已证明归属该 invocation、当前仍为 `pending/running`、没有权威 result | 映射为现有 `error`，metadata 记录 `completionSource: 'invocation-cutoff'`。 | 不覆盖已有 `completed` 或原生 `error`，也不把 cutoff 标成成功。 |
| 无归属、异步 Task 或无法证明 ownership 的工具 | 保持原状态，并记录 `completionSource: 'unresolved'`。 | 不因 idle、ready 或下一条消息猜测成功或失败。 |
| `ready`、非 steered 用户消息、后续正文、peer/wait 完成 | 只保留事件本身，不调用成功收口。 | 不把明确 `in_progress` 改成 `completed`。 |
| 已证明的 Harness 专属规则 | 仅覆盖合同明确点名的工具、状态和调用点。 | 不把 wait 特例推广到全部工具或三个边界。 |

历史缺失信号保持可展示，但 metadata 必须标明来源；不在启动时扫描全部历史并伪造 terminal。`wait → bash` 探针只证明前端规则改写了明确 `in_progress`，不证明所有缺少 result 的历史工具都是错误。

验收：权威 result 保持原成功/失败；owned cutoff 的可见状态为 `error` 且 metadata 为 `invocation-cutoff`；无归属工具状态不变。`ready`、非 steered 用户消息、后续正文、peer 和 wait 都不再把明确 `in_progress` 改成 `completed`。若保留某个 Harness 特例，测试必须点名工具、调用点和合同证据。

#### C4.2 首锚点只补偿真实向上插入

目标文件：`threadScrollHelpers.ts`、`useThreadScrollAndHistoryController.ts`、`useThreadViewportEvents.ts`、`TurnExecutionRail.tsx`，以及 `HappyThread.test.tsx` 的锚点回归。

当前 `restoreScrollAnchor` 对首锚点任何高度增长都做补偿（`threadScrollHelpers.ts:537-545`）。底部增长探针要求 scrollTop 保持 100；`HappyThread.test.tsx:526-604` 同时要求两类合法前插仍得到 800 或 900。`resolveThreadScrollMode` 在 `pendingRestore` 非空时始终返回 `pagination-restore`（`threadScrollHelpers.ts:183-185`），所以不能靠 mode 判断用户是否已回到底部。轨道行目前只有会随前插变化的 `data-rail-row-index`（`TurnExecutionRail.tsx:304-309`），不能直接当稳定子块身份。

实施先给每个可见 rail/step 根节点写现有稳定 `block.id` 或 row key 到 `data-block-id`。捕获锚点时记录：

- `anchorTopOffset`、`anchorHeight`；
- 锚点内第一个可见子块的 `childId` 和 `childTopOffset`；
- 没有可见子块时，`childId = null`，只记录锚点盒，不发明身份。

一次 restore 的补偿量只计算如下，并只应用一次：

```text
anchorDelta = currentAnchorTopOffset - capturedAnchorTopOffset
childDelta = child exists ? currentChildTopOffset - capturedChildTopOffset : 0
upwardDelta = max(0, anchorDelta) + max(0, childDelta)
bottomGrowth = max(0, currentAnchorHeight - capturedAnchorHeight - upwardDelta)
scrollTop += upwardDelta
```

`bottomGrowth` 不参与 scrollTop。此公式覆盖：

| 场景 | 结果 |
| --- | --- |
| 外部前插 200 且内部前插 600 | `anchorDelta=200`、`childDelta=600`，scrollTop 增加 800。 |
| 锚点 top 不变、内部前插 900 | `childDelta=900`，scrollTop 增加 900。 |
| 只有底部增长 250 | 两个 delta 为 0，scrollTop 保持 100。 |
| 内部前插与尾部增长同时发生 | 只加子块下移量，不加 bottomGrowth。 |
| 无稳定子块且仅底部变高 | `childDelta=0`，不补偿。 |

`HappyThread.test.tsx:526-604` 的现有 DOM 没有子块，实施时必须补上稳定 `data-block-id` 和几何，不能让旧测试因缺少子块而得到 0。后续 pinned restore 继续受 `consumedPrepend` 约束，不重复添加同一 `upwardDelta`。

pending restore 尚未完成时，即使用户滚回底部，`resolveThreadScrollMode` 仍是 `pagination-restore`。因此跳过旧锚点恢复的判据是底层事实 `autoScrollEnabled && atBottom`，不是 mode 或 phase。满足该判据时，本次布局不调用 `restoreScrollAnchor`，清除对应 pending restore，并由现有 `useThreadScrollAndHistoryController.ts:852-858` follow 分支负责贴底。runId 取消、锚点消失或 session 切换同样只清除旧 restore，不额外写 scrollTop。

真实浏览器里 capture 与 restore 之间的并发流式时序此前未重现。自动化测试锁定上表；浏览器只验证已观察到的分页和尾部增长组合。



#### C4.3 settling 到期后主动重检 coverage

目标文件：`useThreadScrollAndHistoryController.ts` 与其 hook 测试。`threadScrollHelpers.ts:64` 已有 `coverageCheckTimer`，但当前初始路径没有使用它。

`useThreadScrollAndHistoryController.ts:334-336` 记录 1800ms deadline；`:710-723` 与 `:767-772` 在 settling 期间跳过 coverage。`:736-782` 的 ResizeObserver 只有尺寸变化才检查。jsdom hook 探针已观察到：内容高 300、视口高 500、`hasMore=true` 时，1900ms 后请求数仍为 0，直到额外 resize 才变为 1。

实施沿用当前 controller、history loader、backoff 和 `requestOlderRef('coverage')`：

1. 开始 INITIAL_PINNING 时只注册一个与 deadline 对齐的可取消 timer，并保存 generation/sessionId。
2. timer 到期后先确认 generation、session 和当前 phase 仍匹配，再调用现有 `isInitialScrollSettling()` 完成 phase 收敛，并按当前 viewport 重新判断 `needsViewportCoverage()`。
3. 只有当前仍有未满足需求、没有 pending restore、loader 未处于 loading/backoff/awaiting-render 时，才发一次 coverage 请求。
4. 用户上滚取消跟随、session 切换、组件卸载或新 settling 开始时，必须取消旧 timer；旧回调不能恢复 tail follow，也不能绕过 `autoPaused`、失败退避和 runId 检查。
5. 不新增多级 timer，不把 `INITIAL_SCROLL_SETTLE_DELAYS_MS` 解释成已经存在的到期唤醒。ResizeObserver 与滚动检查继续服务真实尺寸变化。

验收使用 fake timer 和可控 viewport：短内容首屏在 deadline 后无 resize、无 scroll 也会产生恰好一次 coverage 请求；deadline 前为 0。向上 wheel 取消、session 切换和卸载都不产生迟到请求。已有内容的正常首屏仍保持底部跟随，不因该唤醒强制加载或跳离底部。


## 5. 实施顺序与交付边界

| 交付批次 | 内容 | 完成条件 |
| --- | --- | --- |
| 0 | 固定 P0 基线及 Harness 事件能力表。 | 测量可比较；事件来源、缺失信号和历史策略明确。 |
| 1A | C1 字段接通、C2 稳定顺序和截止、C3 精确终态发布。 | 已复现的身份/跨轮次/在线终态错误全部由真实链路回归覆盖。 |
| 1B | P2 关闭轨道子树挂载优化。 | 状态和分享等能力保留，首挂成本有实测下降。可独立于 1A 验证。 |
| 2 | P1 操作驱动、安全输出段复用、prepend 依赖范围重放和消费者迁移。 | 与完整算法语义一致；常见操作减少未变窗口工作，回退范围和成本如实记录。通用内核抽取不是前置要求。 |
| 3 | C4.1 工具状态、C4.2 锚点几何、C4.3 coverage 到期重检。 | 三类行为回归独立通过；不宣称减少 Loading，也不以删除 timer 或 DOM 测量为验收。 |
| 条件批次 | P3 页预算、连续补页交互或 Worker。 | 前述变更后仍有对应瓶颈，且行为/API变更范围获得确认。 |

C1-C3 优先是因为它们可能显示错误结果，不是因为它们被证明能直接缩短首屏。P1/P2 的性能收益必须独立测量。切换消费者后删除不再使用的旧管线、别名和缓存；不把长期双轨当最终状态。

## 6. 验证矩阵与门禁

### 6.1 行为与语义

- 生产者真实载荷：Codex remote/local live/final、历史回放、child 路由和验证后的 turn terminal；OMP/Claude 各自实际支持的开始、结束、取消路径。
- 消息合并：同 stream 换数据库行 ID、重复页、重叠页、迟到结果、权限变化、乐观确认、删除和 rewind。
- 分批归约：相同输入的冷加载、逐条追加、快照替换、旧页前插及 session 切换，最终投影一致；权限、sidechain、goal、usage、title、compaction 跨边界分别覆盖。既有 fixtures 不包含全部 Web phase/timing/goal 字段，仍需消费者行为回归，不能只用黄金投影相等代替。
- 生命周期：旧 final 不抢新轮次、截止不复活、未知归属行不被旧轮误收口、content-final 后可继续工具、历史回放不激活运行、在线终态一致及断线恢复、合法显式恢复。
- UI：初次挂载、展开/收起状态、工具大输出、复制、分享、outline、嵌套滚动及流式期间分页。

永久测试只覆盖这些消费者可见的身份、内容、边界和状态变化。不新增锁源码文本、文件行数、转发次数或“没有抛异常即通过”的测试。

### 6.2 性能

分别报告冷打开、补一页、一次用户操作连续补页、长历史静态阅读、20Hz 合成流和多工具/多块更新。使用同一快照，在 Linux 可重复采样后由真实 Mac 入口观察；不把 Linux 数字冒充 Mac SLA。

P1 验收同时报告更新范围、处理行数、复制范围和耗时；只证明前缀 normalize 次数为零，不足以证明没有前缀数组复制。P2 同时报告挂载节点、首次展开成本与功能正确性。任何性能改动都不能使稳定 ID、实体订阅隔离或工具终态退化。

### 6.3 仓库与跨端

实施完成后按改动范围执行 `bun typecheck`、相应单测、真实沙箱 smoke 和浏览器流程；聊天管线变化执行 `bun run gen:fixtures` 并审阅差异。新协议/分页字段更新 `docs/api/client-contract/{messages,sse,pagination}.md`、shared schema、iOS/Android 消费者和 conformance 检查。不能将旧文档中的测试通过数字当本次实施证明。

本方案不包含 merge、tag、发布、CD 或生产数据库操作。实现仅在隔离工作树和沙箱进行；性能验证数据与运行身份分离，不向原工作会话投递测试消息。

## 7. 原审计缺口覆盖矩阵

以下五项是 2026-11-10 原架构审计“仍然不符合或存在缺口的部分”的完整清单。

| 原审计项 | 已证实问题 | 方案落点 | 当前状态 |
| --- | --- | --- | --- |
| 1. [P1] Codex 轮次身份契约未接通 | `turn_id` 提取为 null，不更新 active turn。 | C1；与 C2/C3 同批切换。 | 已实施并回归验证。 |
| 2. [P1] 旧 final 抢占并提前结束新轮次 | active 从 t2 变回 t1，t2 live 被收口；结束后旧流可复活。 | C2 的稳定顺序、ownership 与截止规则。 | 已实施并回归验证。 |
| 3. [P1] 数据库终态未完整发布 | 数据库两条 settled，在线窗口仍留一条 live。 | C3 的事务返回值与逐条 `message-received`。 | 已实施并回归验证。 |
| 4. [P2] 锚点误补偿与 coverage 无到期唤醒 | 底部增长使 scrollTop 100→350；1900ms 后请求数仍为 0。 | C4.2、C4.3。 | 已实施并回归验证。 |
| 5. [P2] 活动尾部仍全量归一化、归约和拼接 | 单块更新仍向 `normalizeMessageList` 传入 200 条尾部。 | P1.1–P1.3。 | 已实施并回归验证。 |

原审计已经判定为符合要求的列表身份、叶子订阅和内容更新隔离继续保留，不在本方案中重写。P2 的关闭轨道挂载优化是针对本次 Loading 测量新增的性能项，不属于原审计的五项缺口。

Claude 的 result、取消和恢复映射仍是 C1/C2 的实施前置门禁，因为当前转换器没有完整 terminal outcome 或确定原生 turnId。这是证据边界，不是第六个已复现缺陷。
