# HAPI 架构整改落盘计划（基于 Haruka 四维审计与 `0aafa1e8` 实测）

- **制定日期**：2026-11-09
- **基准工作树与分支**：`/data1/home/zhouy1/software/hapi/fork-worktrees/answer-in-grid`（分支 `hapi-answer-in-grid` @ `0aafa1e8`）
- **主工作区基准**：`/data1/home/zhouy1/software/hapi/fork`（分支 `main` @ `c82066b0`，尚未合入 `hapi-answer-in-grid` 的 35 个重构提交 `d9869230..0aafa1e8`）
- **前置关联文档**：
  - `docs/superpowers/specs/2026-11-05-web-frontend-rearchitecture-design.md`
  - `docs/superpowers/plans/2026-11-08-web-streaming-and-entity-store-plan.md`

- **执行状态**：**已完成（2026-11-10）** —— Phase 1 至 Phase 4 全部落地并通过 `bun typecheck`、`bun run gen:fixtures` 与全量 Vitest / Bun 测试门禁。
---

## 0. 背景、问题定性与分支收敛门禁（Phase 0）

在 `hapi-answer-in-grid`（`0aafa1e8`）完成的 35 个提交中，前端已初步引入 `SessionEntityStore`（`web/src/chat/store/sessionEntityStore.ts`）、按 `timelineIndex` 渲染的 `StoreThreadMessagesById`（`web/src/components/AssistantChat/HappyThread.tsx:107-131`）以及 SQLite `stream_live` / `sessions.lifecycle_state` 字段（`hub/src/store/messages.ts:13-33`、`hub/src/store/sessions.ts:17-37`）。

然而对照 Haruka 提出的四项核心架构原则逐行核查 `0aafa1e8` 源码后，当前实现仍停留在**「在旧日志派生架构与 `@assistant-ui/react` 全量消息树外围套了一层 Entity Store 与缓存补丁」**的中间态，存在四处结构性缺陷：

| 审计维度 | Haruka 核心要求 | `0aafa1e8` 现存根因（精确代码位置） | 整改目标阶段 |
| --- | --- | --- | --- |
| **维度 D：协议内部事件与数据库生命周期规划** | HAPI 经过一层 SQLite 数据库，无法直接透传底层 harness 的瞬态截止 tag；必须在协议与 SQLite 层规划完整的轮次/工具生命周期事件，严禁前端靠扫描后续日志猜测结项。 | 1. `hub/src/socket/handlers/cli/sessionHandlers.ts:221-242` 用 `if (!liveSnapshot)` 包裹了 `syncEngine.emitSessionUpdated`，导致流式分块（`liveSnapshot === true`）触发 `'streaming-answer'` 跃迁时**只写 SQLite 不推 SSE**。<br>2. `hub/src/sync/sessionCache.ts:420-423, 487-506`（`handleSessionAlive`）、`652-661`（`handleSessionEnd`）、`671-680`（`expireInactive`）仅在内存中重置 `activeTurnId = null` / `lifecycleState = 'idle'`，**未调用 `this.store.sessions.setSessionTurnLifecycle` 落盘 SQLite，也未放入 `SessionPatch` 广播**。<br>3. 工具调用与中断缺乏 SQLite 权威截止落盘，`web/src/chat/reducerTimeline.ts:536-548, 768, 1016-1022` 仍靠 `completeOrphanedRunningTools` 扫描后续消息猜测工具完成。 | **Phase 1** |
| **维度 A：列表仅拿 `id + type` 分发 vs. 组件内部独立订阅** | 滚动列表只持有稳定 `id + type` 并分发给具体 View；内部状态变化由叶子组件各自订阅，严禁把内部流式状态耦合进列表与顶层运行时。 | 1. `web/src/lib/assistant-runtime.ts:577-581` 在 `useHappyRuntime` 中订阅了全局 `entityStore.subscribe`（`this.storeListeners`），每次流式分块到达均触发（`sessionEntityStore.ts:1435-1446`）。<br>2. `HappyThreadMessageCache.reconcile`（`assistant-runtime.ts:485-542, 651`）以 `TurnEntitySnapshot` 引用为缓存键，流式每个 token 都会重建当前 `ThreadMessage` 并向 `useExternalStoreRuntime` 返回新 `this.messages` 数组（`lines 689-714`）。<br>3. `TurnBlock.tsx:150-163` 同时消费 `useOptionalSessionTurnLayout` 与 6 个 `useAuiState` 选择器；`TurnLayoutBlock`（`assistant-runtime-blocks.ts:768-777`）仍内嵌 `projectionInput` / `projectionResult`。 | **Phase 2** |
| **维度 B：按组件设计事件驱动源 vs. 从日志派生 + Diff 补丁** | 为每个组件设计事件驱动的精确数据源，而非从扁平日志全量或前缀派生后再靠结构等价函数打补丁。 | 1. `SessionEntityStore.reconcileInput`（`sessionEntityStore.ts:789-1215`）仍以 `message-window-store.ts` 的 `DecryptedMessage[]` 全量窗口数组为输入，依赖 `SettledPrefixCache`（`lines 356-564`）截断重算；一旦尾部消息引用前缀 ID（`tailMessageReferencesPrefix`），即退化为 $O(N)$ 全量重跑。<br>2. `buildSessionStatusData`（`sessionEntityStore.ts:1149-1155`）在每次 `reconcileInput` 时执行 `[...stableBlocks]` 与 `[...stableNormalizedMessages]` 浅拷贝。<br>3. `ModelRefusalToastConsumer`（`sessionChatHelpers.tsx:490-510`）订阅全局 `entityStore.subscribe` 并在每次流式 tick 遍历 `normalizedMessages`。 | **Phase 3** |
| **维度 C：统一分页/滚动状态机 vs. DOM 高度差与定时器补偿** | 分页与滚动必须由单一状态机协调，严禁拆分在多个模块中靠测量 DOM 高度差或硬编码 `setTimeout` 擦屁股。 | 1. 分页状态分裂在 `message-window-store.ts`、`sessionEntityStore.ts` 与 `useThreadScrollAndHistoryController.ts:138-188, 285-424` 三处，顶部翻页靠 `useLayoutEffect` 测量 `scrollHeight` 差值（`threadScrollHelpers.ts:163-173`），初始定位靠 `ResizeObserver` + `settle.timers`（`requestAnimationFrame` + `setTimeout`）。<br>2. `TurnExecutionRail.tsx:256-288`（`820ms` 定时器）与 `TimelineStepRows.tsx:304-320`（`980ms` 定时器）在 `useLayoutEffect` 中靠硬编码 `window.setTimeout` 驱动步骤交接与圆环闭合。 | **Phase 4** |

### 分支收敛门禁（Repo Hygiene Gate）
1. 所有 Phase 1–4 改动在 `/data1/home/zhouy1/software/hapi/fork-worktrees/answer-in-grid`（`hapi-answer-in-grid` 分支，基线 `0aafa1e8`）实施并通过全套门禁验证后，方可合入 `/data1/home/zhouy1/software/hapi/fork` 的 `main` 分支（`c82066b0`）。
2. 任何涉及 `web/src/chat/**`、`web/src/lib/message-window-store.ts` 或 `web/src/lib/sessionPatch.ts` 的改动，必须执行 `bun run gen:fixtures` 并通过 `shared/fixtures/**` 一致性校验，确保 iOS（`HapiProtocol`）与 Android（`:core:protocol`）规范流水线零退化。

---

## 1. Phase 1：协议内部事件与 Hub SQLite 生命周期闭环（解决维度 D）

### 1.1 设计不变量
1. **SQLite 与内存缓存状态强一致**：`sessions.lifecycle_state` 与 `sessions.active_turn_id` 的每一次跃迁（无论由 CLI `message`、CLI `session-alive`、用户中断/steer、`session-end` 还是 30s 心跳超时触发）必须**原子写入 SQLite 并通过 `session-updated` SSE 增量推送**。
2. **三条截止向量（Cutoff Vectors）全覆盖**：
   - **正常结项**：CLI 发送 `turn-end` / `result` / `task_complete` / `session-ready`；
   - **用户中断 / Steer 抢占截止**：用户触发 `abort` 或新消息抢占当前轮次；
   - **CLI 断连 / Runner 崩溃异常截止**：Socket 断开、`handleSessionEnd` 或 `expireInactive` 触发时，正在运行的轮次与 `stream_live = 1` 消息必须立即在 SQLite 中收口为终态。
3. **前端零猜测原则**：新协议产出的消息与工具调用均携带权威生命周期事件；`completeOrphanedRunningTools` 仅对缺少生命周期标记的历史旧数据进行兜底，并记录遥测计数。

### 1.2 精确修改文件与步骤

#### Step 1.1：修复 `sessionHandlers.ts` 流式期间吞掉 `lifecycleState` SSE 广播的缺陷
- **目标文件**：`hub/src/socket/handlers/cli/sessionHandlers.ts:206-243`
- **现状问题**：第 221 行 `if (!liveSnapshot)` 将 `syncEngine.emitSessionUpdated` 完全包裹。当 CLI 发送流式文本分块（`liveSnapshot === true`）使 `deriveSessionLifecycleFromAgentMessage` 返回 `nextLifecycle = 'streaming-answer'` 时，第 212 行更新了 SQLite，但在线 Web 客户端收不到 `session-updated` 事件。
- **修改方案**：
  - **单调性与活跃轮次护栏（防止迟到 `liveSnapshot` 复活已结项轮次）**：仅当 `session.thinking === true` 且消息所属轮次与 `session.activeTurnId` 匹配（或开启新活跃轮次）时，才允许 `liveSnapshot === true` 将 `lifecycleState` 推进至 `'running-tool'` / `'streaming-answer'`；若当前轮次已被 `turn-end` 或 `session-alive(thinking=false)` 置为 `'idle'`，迟到的 `liveSnapshot` 分块严禁将 `lifecycleState` 从 `'idle'` 重新拉回 `'streaming-answer'`。
  - 记录跃迁前状态：`const prevLifecycleState = session.lifecycleState`、`const prevActiveTurnId = session.activeTurnId`。
  - 计算 `const lifecycleTransitioned = nextLifecycle !== null && (nextLifecycle !== prevLifecycleState || session.activeTurnId !== prevActiveTurnId)`。
  - 将广播条件拆分为：
    1. 当 `!liveSnapshot` 时，广播完整 `SessionPatch`（含 `updatedAt`、`lastMessagePreview`、`seq`、`thinking`、`activeTurnId`、`lifecycleState`）；
    2. 当 `liveSnapshot && lifecycleTransitioned` 时，立即调用 `syncEngine.emitSessionUpdated(sessionId, { thinking: session.thinking, activeTurnStartedAt: session.activeTurnStartedAt, activeTurnId: session.activeTurnId ?? null, lifecycleState: session.lifecycleState })`，既避免每个流式 token 广播 `lastMessagePreview`，又保证 `'thinking' -> 'streaming-answer'` 等状态跃迁实时到达前端。

#### Step 1.2：补齐 `sessionCache.ts` 三处生命周期重置的 SQLite 落盘与 `SessionPatch` 广播
- **目标文件**：`hub/src/sync/sessionCache.ts:419-424, 487-506, 647-662, 668-683`
- **现状问题**：
  1. `handleSessionAlive`（`lines 419-423`）：当 `wasThinking && !session.thinking` 时，仅修改了内存 `session.activeTurnId = null` 和 `session.lifecycleState = 'idle'`，既未调用 `this.store.sessions.setSessionTurnLifecycle`，也未放入 `lines 492-504` 的 `SessionPatch`。
  2. `handleSessionEnd`（`lines 647-662`）：仅修改内存 `activeTurnId = null`、`lifecycleState = 'idle'`，未写 SQLite，且 `lines 657-661` 的 `SessionPatch` 漏掉了 `activeTurnId: null, lifecycleState: 'idle'`。
  3. `expireInactive`（`lines 668-683`）：30 秒超时失活时完全未重置 `activeTurnId` 与 `lifecycleState`。
- **修改方案**：
  - 在 `SessionCache` 新增私有辅助方法 `resetTurnLifecycleToIdle(session: CachedSession): boolean`：
    - 若 `session.activeTurnId !== null || session.lifecycleState !== 'idle'`，将其置为 `null` / `'idle'`，调用 `this.store.sessions.setSessionTurnLifecycle(session.id, { activeTurnId: null, lifecycleState: 'idle' }, session.namespace, { touchUpdatedAt: false })`。
  - 在 `handleSessionAlive`（`wasThinking && !session.thinking`）、`handleSessionEnd`、`expireInactive` 三处统一调用 `resetTurnLifecycleToIdle(session)`，并在发出的 `SessionPatch` 中显式携带 `activeTurnId: session.activeTurnId ?? null` 与 `lifecycleState: session.lifecycleState ?? 'idle'`。

#### Step 1.3：在 SQLite 层实现流式消息与未结项工具的原子截止收口
- **目标文件**：
  - `hub/src/store/messages.ts:154-275`
  - `hub/src/socket/handlers/cli/sessionHandlers.ts:285-350, 520-585`
  - `cli/src/claude/utils/sdkToLogConverter.ts`、`cli/src/codex/codexRemoteLauncher.ts`、`cli/src/omp/OmpRpcEventAdapter.ts`
- **修改方案**：
  1. 在 `hub/src/store/messages.ts` 新增 `finalizeOpenLiveStreamsForSession(sessionId: string, reason: 'turn-end' | 'abort' | 'disconnect'): MessageRow[]`：
     - 在单个 SQLite 事务中查询该会话所有 `stream_live = 1` 的消息行，将其 `stream_live` 更新为 `0`（若为异常中断/断连，在 `content.meta` 中写入 `cutoffReason: reason`），并返回收口后的行以便 Hub 推送最终 `message-received` 快照。
  2. 在 `handleSessionEnd`、Socket `disconnect` 处理分支以及用户 `abort` / `turn-aborted` 处理路径中调用 `finalizeOpenLiveStreamsForSession`，并在 CLI 侧确保工具中断或异常退出时发射显式的 `tool-call-end` / `turn-aborted` 记录。
  3. **严格门控而非盲目删除 `completeOrphanedRunningTools`**（`web/src/chat/reducerTimeline.ts:536-548, 768, 1016-1022`）：
     - **严禁对当前活跃轮次执行推断**：当轮次处于活跃运行态（`turnId === session.activeTurnId && session.thinking === true`）时，绝不因后续兄弟消息到达而调用 `completeOrphanedRunningTools` 猜测工具完成；
     - **保留历史已关闭轮次兜底**：仅对**已关闭的历史轮次**（已有后续用户轮次、已收到 `turn-end` / `cutoffReason`、或 `session.thinking === false` 且非 `activeTurnId`）中仍遗留未闭合的旧数据库历史工具记录，兜底收敛为 `canceled` / `interrupted` 终态，防止旧 SQLite 会话出现永久 Spinner。

### 1.3 Phase 1 验证门禁（Verification Gate）
- **单测验证**：在 `hub/src/sync/sessionCache.test.ts` 与 `hub/src/socket/handlers/cli/sessionHandlers.test.ts` 中验证：
  1. `liveSnapshot === true` 期间发生 `'thinking' -> 'streaming-answer'` 跃迁时，`session-updated` SSE 被立即触发 1 次；后续同状态流式 chunk 不重复触发 `session-updated`。
  2. 流式输出中途触发 CLI `session-end`、用户 `abort` 或 `expireInactive` 后，直接从 SQLite 重新加载会话（模拟浏览器 `F5` 冷刷新），`sessions.lifecycle_state` 为 `'idle'`、`active_turn_id` 为 `null`、所有 `stream_live` 均为 `0`，且前端渲染终态时 `completeOrphanedRunningTools` 触发次数为 `0`。

---

## 2. Phase 2：彻底解耦 AUI ExternalRuntime 与 Turn 布局的流式耦合（解决维度 A）

### 2.1 设计不变量
1. **顶层列表严格只读 `id + type`**：滚动容器消息列表仅依赖 `TimelineEntryDescriptor`（`entryId`、`kind: 'user' | 'assistant-turn' | 'system'`、`turnId`），流式正文 delta、思考流 delta、工具输入/输出流式更新、Todo/Plan 内容变化**严禁触发顶层列表或运行时 Provider 重渲染**。
2. **叶子组件自包含订阅**：每个块组件通过 `useSessionBlockEntity(store, blockId)` 独立订阅自身内容；Turn 头部/状态栏通过 `useSessionTurnHeader(store, turnId)` 独立订阅轮次级汇总状态；`TurnLayoutSnapshot` 仅包含结构骨架（`blockId`、`kind`、`phase`），不含可变业务载荷。

### 2.2 架构演进路径对比与决策

针对 `@assistant-ui/react`（AUI）在 `HappyThread.tsx` 中的角色，存在两条演进路径：

| 方案 | 核心机制 | 优点 | 风险与代价 |
| --- | --- | --- | --- |
| **路径 2A（保守演进：冻结 AUI 骨架消息）** | 保留 `ThreadPrimitive.Unstable_MessageById`，但在 `entityStore` 模式下，`HappyThreadMessageCache` 仅生成固定结构的骨架 `ThreadMessage`（`id`、`role`、`createdAt`、`status: 'running' \| 'complete'`，`content` 固定为空或单占位符），不再将 `turn.blocks` 展开进 `ThreadMessage.content`。 | 改动范围集中在 `assistant-runtime.ts` 与 `TurnBlock.tsx`，兼容依赖 `MessagePrimitive` 上下文的既有结构。 | 需替换 `ActionBarPrimitive.Copy`（因其默认复制 `MessagePrimitive` 的文本 part），改为从 `entityStore.getTurnCopyText(turnId)` 按需读取。 |
| **路径 2B（彻底收口：消息列表直连 EntityStore，AUI 仅管 Composer）** | `StoreThreadMessagesById`（`HappyThread.tsx:107-131`）直接按 `entry.kind` 渲染 `<StoreUserMessage>` / `<StoreAssistantTurn>` / `<StoreSystemMessage>`，完全绕过 `ThreadPrimitive.Unstable_MessageById` 与 `HappyThreadMessageCache`。`AssistantRuntimeProvider` 仅向 `HappyComposer` 提供发送/取消/附件能力。 | 彻底消除 `HappyThreadMessageCache` 双重状态树映射与 `useAuiState` 在消息节点中的所有调用，最纯粹地实现 Haruka 的 `id + type` 列表分发模型。 | 需检查 `HappyThread.tsx` 中是否仍有子组件隐式调用 `useMessage()` / `MessagePrimitive`。 |

**执行决策**：将 **路径 2A 作为必达基线**、**路径 2B 作为同阶段优先收口目标**。无论采用 2A 还是 2B，`TurnBlock.tsx` 与 `AssistantMessage.tsx` 中的 `useAuiState` 均必须清零，且流式期间 `useHappyRuntime` 不得因块内容更新而重算。

### 2.3 精确修改文件与步骤

#### Step 2.1：切断 `useHappyRuntime` 对全局 `entityStore.subscribe` 的高频监听
- **目标文件**：
  - `web/src/chat/store/sessionEntityStore.ts:138-215, 1412-1450`
  - `web/src/lib/assistant-runtime.ts:568-735`
- **现状问题**：`useHappyRuntime`（`assistant-runtime.ts:577-581`）调用了 `entityStore.subscribe(listener)`，而 `notifyListeners()`（`sessionEntityStore.ts:1435-1446`）只要 `changedEntityIds.length > 0` 就会通知 `this.storeListeners`。
- **修改方案**：
  1. 在 `SessionEntityStore` 新增 `subscribeRuntimeTopology(listener: () => void): () => void` 与 `getRuntimeTopologyVersion(): number`：仅当 `timelineChanged`（新增/删除/重排线程条目）或**活跃轮次的运行状态（`isRunning` / `lifecycleState`）发生变化**时递增并触发。
  2. 将 `useHappyRuntime`（`assistant-runtime.ts:577-581`）改为订阅 `entityStore.subscribeRuntimeTopology`，使其在流式文本/思考/工具输出分块期间**零触发**。
  3. 若保留 `HappyThreadMessageCache.reconcile`（路径 2A），在 `entityStore` 模式下以 `(entryId, turnStatus, createdAt)` 构造轻量级骨架 `ThreadMessageLike`，不再读取 `turn.blocks` 拼接 `TextMessagePart`；若采用路径 2B，则在 `StoreThreadMessagesById`（`HappyThread.tsx:107-131`）中直接按 `entry.kind` 分发至 `<UserMessage entryId={entry.entryId} />`、`<TurnBlock turnId={entry.turnId} />`、`<SystemMessage entryId={entry.entryId} />`。

#### Step 2.2：移除 `TurnBlock.tsx` 与 `AssistantMessage.tsx` 中的 `useAuiState` 选择器
- **目标文件**：
  - `web/src/components/AssistantChat/messages/TurnBlock.tsx:148-225`
  - `web/src/components/AssistantChat/messages/AssistantMessage.tsx:135-185`
  - `web/src/hooks/useSessionEntityStore.ts`
- **现状问题**：`TurnBlock.tsx:150-163` 调用了 6 个 `useAuiState` 选择器（`messageId`、`isLast`、`isRunning`、`hasCopied`、`isHovering`、`hasTextContent`）。
- **修改方案**：
  1. 在 `SessionEntityStore` 与 `useSessionEntityStore.ts` 中提供 `useSessionTurnHeader(store, turnId)`，返回稳定快照 `{ turnId, isLastTurn, isRunning, requiresAction, hasCopyableText, invokedAt, durationMs, usage, model, roundSummary, turnCount }`（仅在这些轮次级汇总字段变化时通知，彻底替代 `assistant-runtime.ts:524-529` 的 `ThreadMessage.metadata.custom` 注入）。
  2. 将 `TurnBlock.tsx` 的复制按钮从 `ActionBarPrimitive.Copy` 替换为直接调用 `navigator.clipboard.writeText(entityStore.getTurnCopyableText(turnId))` 并管理本地 `hasCopied` 状态；将悬停状态改为 CSS `group-hover` 或组件局部 `onPointerEnter`/`onPointerLeave`。
  3. 删除 `TurnBlock.tsx:150-163` 中的全部 6 个 `useAuiState` 调用。

#### Step 2.3：剥离 `TurnLayoutBlock` 中的 `projectionInput` / `projectionResult`
- **目标文件**：
  - `web/src/lib/assistant-runtime-blocks.ts:147-170, 755-795`
  - `web/src/components/AssistantChat/messages/TurnExecutionRail.tsx`
- **现状问题**：`describeLayoutBlock`（`assistant-runtime-blocks.ts:768-777`）将 Todo/Plan/Reasoning 工具的 `projectionInput: block.tool.input` 和 `projectionResult: block.tool.result` 塞入了 `TurnLayoutBlock`，导致 Todo/Plan 工具每次更新都会改变 `TurnLayoutSnapshot`，触发整个 `TurnBlock` 重排。
- **修改方案**：
  - 从 `TurnLayoutBlock` 接口（`lines 147-156`）和 `describeLayoutBlock`（`lines 768-777`）中移除 `projectionInput` 与 `projectionResult`。
  - Todo/Plan 卡片与执行轨道直接订阅 `useSessionTodoSnapshot(store)` 或对应工具块的 `useSessionBlockEntity(store, blockId)`。

### 2.4 Phase 2 验证门禁（Verification Gate）
- **性能与渲染隔离验证**（`e2e/streaming-isolation.spec.ts` + Vitest 单测）：
  - 在单个轮次内连续注入 100 个流式文本分块、10 次工具输入/输出更新和 3 次 Todo 变更：
    1. `useHappyRuntime` 重建 `messages` 数组的次数 $\le 2$（仅轮次开始与轮次结束）；
    2. `HappyThread`、`SessionRuntimeController`、`StoreThreadMessagesById` 重渲染次数为 `0`；
    3. 当块拓扑（块数量与类型）未变时，`TurnBlock` 重渲染次数为 `0`，仅目标文本叶子或目标工具步骤叶子组件重渲染。

---

## 3. Phase 3：事件驱动的增量实体入库与索引化更新（解决维度 B）

### 3.1 设计不变量
1. **消除全量窗口数组重扫与浅拷贝**：`message-window-store` 向 `SessionEntityStore` 发送显式的增量窗口操作事件（`MessageWindowOperation`），`SessionEntityStore` 维护直接实体查找索引（`entityIdByStreamId`、`entityIdByToolCallId`、`entityIdByMessageId`），流式更新与工具结果回填按 $O(1)$ 索引定位目标实体，不再走 `tailMessageReferencesPrefix` 全量回退重算。
2. **单一规范算法与 Fixture 100% 兼容**：增量折叠状态机与 `web/scripts/fixtures/pipeline.ts` 共享同一套单步消息归约核（`applyNormalizedMessageStep`），确保 `bun run gen:fixtures` 产出的 `shared/fixtures/**` 与 iOS/Android 协议测试完全一致。

### 3.2 精确修改文件与步骤

#### Step 3.1：在 `message-window-store.ts` 中产出结构化 `MessageWindowOperation` 事件
- **目标文件**：`web/src/lib/message-window-store.ts:520-820, 850-1000`
- **修改方案**：
  - 定义判别联合类型 `MessageWindowOperation`：
    - `{ type: 'reset-window'; messages: readonly DecryptedMessage[]; hasMoreOlder: boolean }`（初次加载或断线重连全量替换）
    - `{ type: 'append-tail'; messages: readonly DecryptedMessage[] }`（新消息到达尾部）
    - `{ type: 'upsert-live-stream'; message: DecryptedMessage; streamKey: string }`（流式分块原地更新）
    - `{ type: 'finalize-live-stream'; message: DecryptedMessage; streamKey: string }`（流式分块收口）
    - `{ type: 'prepend-older'; messages: readonly DecryptedMessage[]; hasMoreOlder: boolean; anchorMessageId: string | null }`（向上翻页插入旧消息）
    - `{ type: 'reconcile-optimistic'; clientId: string; confirmedMessage: DecryptedMessage }`（乐观发送确认替换）
  - `message-window-store` 在每次窗口变更时记录递增 `operationSeq` 与对应的 `MessageWindowOperation`，供 `SessionEntityStoreIngestionBridge` 精确消费。

#### Step 3.2：将 `SessionEntityStore` 升级为带二级索引与已结项检查点的增量状态机
- **目标文件**：
  - `web/src/chat/store/sessionEntityStore.ts:356-564, 789-1215, 1225-1404`
  - `web/src/chat/reducer.ts`、`web/src/chat/reducerTimeline.ts`、`web/src/chat/reducerTools.ts`
- **现状问题**：
  - `SettledPrefixCache`（`lines 356-564`）依赖 `tailMessageReferencesPrefix` 扫描前缀 ID 集合；一旦迟到的工具结果、权限变更或流式 chunk 命中前缀 ID，整条缓存失效并重跑全部历史消息。
  - `buildSessionStatusData`（`lines 1149-1155`）每次调用均执行 `[...stableBlocks]` 与 `[...stableNormalizedMessages]` 全量数组拷贝。
- **修改方案**：
  1. **维护二级查找索引**：在 `SessionEntityStore` 内维护：
     - `blockIdByStreamId: Map<string, string>`
     - `blockIdByToolCallId: Map<string, { turnId: string; blockId: string }>`
     - `blockIdByMessageId: Map<string, string>`
  2. **O(1) 原地流式与工具更新**：
     - 当收到 `upsert-live-stream` 且 `blockIdByStreamId.has(streamKey)` 时，直接更新对应 `AgentTextBlock` 或 `AgentReasoningBlock` 实体的文本内容，仅触发 `this.entityListeners.get(blockId)`（若非空状态未变，连 `layout:${turnId}` 都不触发），耗时严格为 $O(1)$。
     - 当收到 `tool-call-result` 或 `agentState.completedRequests` 权限更新且 `blockIdByToolCallId.has(toolCallId)` 时，直接按索引定位对应的 `ToolCallBlock` 更新其 `result` / `state` / `permission`，仅通知该工具块及所属 Turn 的状态头，无需重跑前缀消息。
  3. **消除全量数组浅拷贝**：移除 `buildSessionStatusData`（`lines 1149-1155`）中的 `[...stableBlocks]` 与 `[...stableNormalizedMessages]` 拷贝，直接复用不可变 `ReadonlyArray` 引用或按最新轮次增量计算 `sessionStatus`。

#### Step 3.3：将 `ModelRefusalToastConsumer` 改为精确选择器订阅
- **目标文件**：
  - `web/src/components/sessionChatHelpers.tsx:480-520`
  - `web/src/chat/store/sessionEntityStore.ts`
- **现状问题**：`ModelRefusalToastConsumer`（`lines 490-510`）通过 `entityStore.subscribe` 在每次流式分块时遍历全量 `normalizedMessages` 查找 `isModelRefusalEvent`。
- **修改方案**：
  - 在 `SessionEntityStore` 入库新消息时同步更新 `latestRefusalEvent: { id: string; message: NormalizedMessage } | null`。
  - `ModelRefusalToastConsumer` 通过 `useSyncExternalStore` 仅选择 `store.getSnapshot().latestRefusalEvent`，流式期间零遍历、零重跑。

### 3.3 Phase 3 验证门禁（Verification Gate）
- **复杂度与基准测试验证**（`web/src/chat/store/sessionEntityStore.test.ts`）：
  1. 在包含 1,000 条历史消息的会话中，向当前活跃轮次连续推送 100 个 `upsert-live-stream` 分块或向更早的消息回填 1 个 `tool-call-result`：`normalizeDecryptedMessage` 与 `reduceChatBlocks` 对历史前缀消息的调用次数严格为 `0`。
  2. 执行 `bun run gen:fixtures` 与 `bun run test`，`shared/fixtures/**` 零非预期差异。

---

## 4. Phase 4：统一分页/滚动锚点状态机与无定时器 UI 过渡（解决维度 C）

### 4.1 设计不变量
1. **单一滚动与翻页协调器**：顶部历史加载与视口锚点恢复由单一状态机（`ThreadScrollStateMachine`）驱动，在 `prepend-older` 提交的同一个 `useLayoutEffect` 帧内基于锚点元素的 `getBoundingClientRect().top` 差值一次性补偿 `scrollTop`，彻底移除 `scrollHeight` 猜测与多定时器轮询（`settle.timers`）。
2. **禁止用 `setTimeout` 驱动功能或视觉状态交接**：执行轨道指示器（`TurnExecutionRail`）与步骤行圆环闭合（`TimelineStepRows`）全部改为由 Store 实体状态 + 纯声明式 CSS Animation/Transition 驱动；即使在后台标签页、`display: none` 折叠态或 `prefers-reduced-motion: reduce` 下也绝不卡死状态。

### 4.2 精确修改文件与步骤

#### Step 4.1：重构 `useThreadScrollAndHistoryController.ts` 为单通元素锚点状态机
- **目标文件**：
  - `web/src/components/AssistantChat/useThreadScrollAndHistoryController.ts:138-188, 285-424`
  - `web/src/components/AssistantChat/threadScrollHelpers.ts:140-185`
- **现状问题**：
  - 顶部翻页前记录 `pending.scrollHeight`（`line 183`），翻页后在 `useLayoutEffect`（`lines 389-424`）通过 `resolvePrependedScrollTop` 计算 `viewport.scrollHeight - pending.scrollHeight`；当顶部之外的流式块或折叠块高度同时变化时，计算出的 `scrollTop` 发生跳动。
  - 初次进入会话时使用 `InitialScrollSettleState.timers`（`lines 138-168, 285-336`）挂载多个 `setTimeout` + `requestAnimationFrame` 反复强制滚底。
- **修改方案**：
  1. **构建显式滚动状态机 `ThreadScrollPhase`**：
     - `'initial-anchor'`：首次挂载，在首个非空 `timelineIndex` 渲染的 `useLayoutEffect` 中同步置底，并仅通过单个 `ResizeObserver`（监听 `contentRef` 在初始未发生用户上滚前的尺寸增长）保持贴底；一旦用户主动上滚（`wheel` / `touchmove` / `pointerdown`）或首屏稳定即切换至 `'following-tail'` 或 `'user-browsing'`，删除全部 `settle.timers`。
     - `'prepending-history'`：触发 `fetchPreviousPage` 时，记录当前视口内第一条可见消息 DOM 节点的 `[data-thread-entry-id]` 及其相对于 `viewport.getBoundingClientRect().top` 的偏移量 `anchorOffsetTop`。
  2. **单通 `useLayoutEffect` 锚点恢复与原生 `overflow-anchor` 互斥保护**：
     - 在滚动视口容器（`viewport`）由 JS 状态机接管历史翻页锚点补偿期间，显式设置 CSS `overflow-anchor: none`，防止浏览器原生 Scroll Anchoring 与 JS `scrollTop` 补偿叠加导致 $2\times$ 跳动。
     - 当 `prepend-older` 导致 `timelineVersion` 更新时，在 `useLayoutEffect` 中直接查找 `[data-thread-entry-id="${anchorEntryId}"]`，计算 `const delta = anchorEl.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchorOffsetTop`，同步执行 `viewport.scrollTop += delta`。若锚点元素因极端情况不存在，才回退至 `scrollHeight` 差值。

#### Step 4.2：移除 `TurnExecutionRail.tsx` 的 `820ms` 定时器与 `TimelineStepRows.tsx` 的 `980ms` 定时器
- **目标文件**：
  - `web/src/components/AssistantChat/messages/TurnExecutionRail.tsx:245-295`
  - `web/src/components/AssistantChat/messages/TimelineStepRows.tsx:295-335`
  - `web/src/styles/turn-timeline.css`（或对应样式表）
- **现状问题**：
  - `TurnExecutionRail.tsx:256-288` 在 `useLayoutEffect` 中使用 `window.setTimeout(..., 820)` 控制 `handoffTargetRowId` 指示器交接。
  - `TimelineStepRows.tsx:304-320` 在 `useLayoutEffect` 中使用 `window.setTimeout(..., 980)` 控制 `isCompletionMorphing`（运行态圆环闭合为完成勾选态）。
- **修改方案**：
  1. **`TimelineStepRows.tsx` 无定时器声明式圆环闭合**：
     - 移除 `isCompletionMorphing` state 与 `980ms` `window.setTimeout`。
     - 记录前一次状态 `prevWasRunningRef`；当步骤从 `running` 跃迁为 `completed` 时，在 DOM 节点上设置声明式属性 `data-step-transition="just-completed"`。
     - 通过 CSS `@keyframes stepRingClose`（`980ms` `forwards`）纯样式完成圆环收口与勾选渐显；动画结束后最终帧与静态 `completed` 视觉完全一致，因此**无需依赖 JS `setTimeout` 或可能不触发的 `onAnimationEnd` 来切换 React state**（在后台标签页、折叠隐藏或 `prefers-reduced-motion: reduce` 下均天然幂等且零残留）。
  2. **`TurnExecutionRail.tsx` 无定时器轨道指示器平滑位移**：
     - 移除 `handoffTargetRowId` state 与 `820ms` `window.setTimeout`。
     - 轨道活动指示器直接绑定当前活跃行 `activeRunningRowId` 计算出的 `translateY` 偏移量，通过 CSS `transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1), opacity 240ms ease` 实现跨行平滑滑动与完成淡出，彻底消除 JS 定时器状态驻留。

### 4.3 Phase 4 验证门禁（Verification Gate）
- **代码静态与运行时双重门禁**：
  1. `web/src/components/AssistantChat/messages/` 与 `useThreadScrollAndHistoryController.ts` 中用于 UI 状态交接与滚动稳定的 `setTimeout` 数量降为 `0`。
  2. Playwright 回归（`e2e/thread-scroll-anchors.spec.ts`、`e2e/turn-timeline-slots.spec.ts`）：在底端流式高频输出的同时触发顶部向上翻页加载历史消息，视口锚点消息像素偏移 $|\Delta y| \le 1\text{px}$；折叠/展开执行轨道及后台切换标签页时，工具步骤状态图标无卡死在半闭合态的情况。

---

## 5. 实施顺序、依赖关系与总体验收矩阵

```
Phase 1 (Hub/CLI SQLite 生命周期与截止收口)
   │
   ├──► Phase 2 (剥离 AUI 流式重算 & TurnLayout 纯骨架化)
   │       │
   │       └──► Phase 4 (统一滚动锚点状态机 & 移除 820ms/980ms 定时器)
   │
   └──► Phase 3 (MessageWindowOperation 增量入库 & 二级索引 O(1) 实体更新)
```

- **并行度设计**：
  - **Phase 1**（`hub/`、`cli/`、`shared/`）与 **Phase 2**（`web/src/lib/assistant-runtime*.ts`、`web/src/components/AssistantChat/messages/`）文件边界完全正交，可由独立工作树并行推进；
  - **Phase 3** 聚焦 `web/src/lib/message-window-store.ts` 与 `web/src/chat/store/sessionEntityStore.ts`；
  - **Phase 4** 在 Phase 2 稳定 Turn 布局快照后收口 `useThreadScrollAndHistoryController.ts`、`TurnExecutionRail.tsx` 与 `TimelineStepRows.tsx`。

### 总体验收命令清单
在 `/data1/home/zhouy1/software/hapi/fork-worktrees/answer-in-grid` 根目录下依次执行并通过：

```bash
# 1. 全量严格类型检查
bun typecheck

# 2. 重新生成并校验跨端黄金 Fixtures（确保 iOS / Android 协议零破坏）
bun run gen:fixtures
git diff --exit-code shared/fixtures/

# 3. 全工作区单元与集成测试（cli + hub + web + shared）
bun run test

# 4. 浏览器端到端回归（含流式隔离、滚动锚点、槽位与焦点契约）
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

---

## 6. 落地执行与验证记录（2026-11-10）

| 阶段 | 核心落地文件 | 实测验证结果 |
| --- | --- | --- |
| **Phase 1：Hub SQLite 生命周期与活跃轮次工具保护** | `hub/src/store/messages.ts`、`hub/src/store/messageStore.ts`、`hub/src/store/sessions.ts`、`hub/src/sync/sessionCache.ts`、`hub/src/sync/syncEngine.ts`、`hub/src/socket/handlers/cli/sessionHandlers.ts`、`web/src/chat/normalize.ts`、`web/src/chat/reducerTimeline.ts`、`web/src/chat/reducer.ts` | 1. `finalizeLiveStreamsForSession` 在 SQLite 事务中同时将 `stream_live = 0` 与 JSON `live: false` 原子落盘，并在 `handleSessionAlive`（idle cutoff）、`handleSessionEnd`、`abortSession`、`expireInactive` 与轮次抢占时持久化 `lifecycleState` / `activeTurnId`。<br>2. `reducerTimeline.ts` 基于 `sessionThinking` 与 `activeTurnId` 门控 `completeOrphanedRunningTools`，活跃轮次流式期间不再误杀长耗时工具。<br>3. `bun test hub/src/store/messages.test.ts hub/src/sync/aliveEvents.test.ts`（52 tests passed）；`web` 归一化与归约测试（133 tests passed）。 |
| **Phase 2：AUI Runtime 与 TurnBlock 流式解耦** | `web/src/lib/assistant-runtime.ts`、`web/src/lib/assistant-runtime-blocks.ts`、`web/src/chat/store/sessionEntityStore.ts`、`web/src/hooks/useSessionEntityStore.ts`、`web/src/components/AssistantChat/messages/TurnBlock.tsx`、`TurnTodoSection.tsx`、`TimelineTurnBlock.tsx`、`MessageTimestamp.tsx`、`ShareTurnButton.tsx`、`MessageActions.tsx`、`UserMessage.tsx`、`SystemMessage.tsx`、`AssistantMessage.tsx`、`HappyThread.tsx` | 1. 新增 `subscribeRuntimeTopology` / `getRuntimeTopologyVersion` 与 `useSessionTurnHeader`；`useHappyRuntime` 仅在线程拓扑或轮次运行态跃迁时触发。<br>2. `TurnBlock.tsx`、`AssistantMessage.tsx`、`UserMessage.tsx`、`SystemMessage.tsx`、`MessageActions.tsx`、`MessageTimestamp.tsx`、`ShareTurnButton.tsx` 清零 `useAuiState`；`CanonicalTurnLayout` 剥离 Todo 业务载荷，改由 `TurnTodoSection` 按 `todoCandidateEntityIds` 独立订阅。<br>3. `assistant-runtime.real.test.tsx` 等 6 个核心套件 113 tests passed，所有文件行数满足 `architecture-boundaries.test.ts`。 |
| **Phase 3：增量窗口操作与二级索引 $O(1)$ 入库** | `web/src/lib/message-window-store.ts`、`web/src/chat/store/sessionEntityStore.ts`、`web/src/chat/sessionStatus.ts`、`web/src/chat/reducer.ts`、`web/src/chat/reconcile.ts`、`web/src/components/sessionChatHelpers.tsx` | 1. `message-window-store.ts` 发出 `MessageWindowOperation`（`reset`、`append-tail`、`upsert-stream`、`finalize-stream`、`prepend-older`、`reconcile-optimistic`）。<br>2. `SessionEntityStore` 从全量归约切片构建 `SettledPrefixCache`（含 `DisjointOverlayMap` 零拷贝叠加、`applyPrefixToolResultMessage` 原地工具结果回填与 `absorbedTailMessages` 幂等去重集），并通过 `changedEntityIdsHint` 实现 $O(1)$ 实体监听派发。<br>3. `ModelRefusalToastConsumer` 改用 `useSessionLatestRefusalEvent` 精确订阅；`buildSessionStatusData` 移除全量浅拷贝。<br>4. 1,000 条历史消息 + 100 次流式分块 + 1 次跨前缀工具回填基准测试：前缀 `normalizeDecryptedMessage` 复跑次数严格为 `0`。 |
| **Phase 4：确定性滚动锚点状态机与纯 CSS 过渡** | `web/src/components/AssistantChat/useThreadScrollAndHistoryController.ts`、`web/src/components/AssistantChat/HappyThread.tsx`、`web/src/components/AssistantChat/messages/TimelineTurnBlock.tsx`、`web/src/styles/turn-timeline.css` | 1. `useThreadScrollAndHistoryController.ts` 引入 `ThreadScrollPhase` 状态机、`ResizeObserver` 首屏贴底与 `overflow-anchor: none` + `[data-thread-entry-id]` 同步 `getBoundingClientRect().top` 差值补偿，清零 `settle.timers`。<br>2. `TimelineTurnBlock.tsx` 与 `turn-timeline.css` 移除 `820ms` / `980ms` JS `setTimeout`，改用 `data-step-transition="just-completed"`、`@keyframes stepRingClose` 与轨道 CSS `transition`。<br>3. `useThreadScrollAndHistoryController.test.tsx`、`HappyThread*.test.tsx`、`TimelineTurnBlock.test.tsx` 等 90 tests passed。 |
| **全工作区门禁** | `shared/fixtures/**`、`cli`、`hub`、`web`、`shared`、`fork-features` | 1. `bun run gen:fixtures` 成功生成 48 chat + 12 sse + 12 pagination 黄金 fixtures。<br>2. `bun typecheck` 零错误通过。<br>3. `web`（333 files / 3,389 tests）、`hub`、`shared`（336 tests）、`fork-features`（178 tests）全绿通过。 |
