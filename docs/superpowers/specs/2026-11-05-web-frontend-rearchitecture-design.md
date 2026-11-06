# HAPI Web 前端架构与组件边界重构方案（V3.2：多项目调研后的边界、订阅与验证修订）

**Date:** 2026-11-05；**Updated:** 2026-11-06  
**Status:** V3.2 Specification；本次只更新方案，尚未开始 PR 1–PR 5 实现、提交或部署。V3.1 三方评审属于历史记录，不代表 V3.2 已通过实现验收。  
**Repo:** HAPI fork（`web/src/`）

---
本版保留 V3.1 的五个 PR、回合内三槽位、跨端协议不变量、独立端口沙箱和 Playwright 点击/几何测试。新增内容来自《开源远程多机 Agent 面板与自定义组件项目调研》：本方案采纳局部状态所有权、宿主控制的呈现契约和功能级故障恢复，不引入第三方插件加载器，不把内联 Todo 改成独立看板，也不接入 MCP Apps 或 AG-UI。外部项目的示例和文档不是性能实测，后续性能结论必须由 HAPI 的同场景测量支持。

文中旧审计行号和文件规模是 V3.1 调研快照；实现时以符号及当前源码为准。V3.2 已重新核对 Context、回合分区和轨道测量的相关实现，具体纠正见 §5.4、§5.6；不能按历史行号机械实施。


## 1. 背景与核心问题诊断

过去两周内，`web/src/` 密集出现了 15+ 个表面症状各异、实则同源的缺陷（连续提问吞首轮回答、工具流式状态卡在 `thinking` 后瞬间跳已完成、Todo 卡片重复渲染或掉入左侧折叠竖线轨道、已完成 Todo 跨回合幽灵继承、表格管道符破损、输入框聚焦黑框、滚动跳动等）。

经对 `web/src/` 核心代码及最近 52 个提交的系统性审计，并对照 `yetone/magpie` 的微内核/槽位隔离架构，问题的根源并非局部逻辑疏漏，而是**前端组件树层级倒置、上帝组件（God Components）职责失控、状态投影与工具渲染规则四处分叉、缺乏编译期/测试期架构边界守卫、以及全局未分层 CSS 污染**五大结构性债台：

### 1.1 组件包裹关系与业务领域层级完全反置（Inversion of Hierarchy）

在真实的 Agent 会话领域模型中，一个 **Turn（回合）** 由平级的三部分组成：
1. **用户提问（User Prompt）**
2. **执行过程（Execution Process：Thinking / Tool Calls / Subagents）**
3. **回合级状态卡片与最终正式回答（Turn Todo Card + Final Assistant Answer）**

但在当前前端实现中，渲染包裹关系被彻底颠倒：
- `web/src/components/AssistantChat/messages/AssistantMessage.tsx:184, 271-278`：一旦 `hasTurnActivity(parts)` 为真，就把 `TurnBlock` 塞进 `@assistant-ui/react` 的 `MessagePrimitive.Parts` 的 `ToolGroup` 插槽；
- `web/src/components/AssistantChat/messages/TurnBlock.tsx:369`：在 `ToolGroup` 内部开启 `<TurnPartScopeContext.Provider value={true}>`，导致外层原本负责渲染正文的 `TextPart`（`AssistantMessage.tsx:76`）、`ReasoningPart`（`86`）和 `ToolCallPart`（`103`）全部静默返回 `null`；
- `web/src/components/AssistantChat/messages/TurnBlock.tsx:330` 与 `TimelineTurnBlock.tsx:1469, 1765`：`TimelineTurnBlockView` 反客为主，通过 `useMessage()` 劫持整条消息的全部 `content`，再通过 `renderTrailingText` 回调把**正式回答正文（Final Answer）当成「工具折叠块内部的尾巴」**渲染出来。

**直接后果**：
- **正式回答沦为折叠工具块的附属品**：在 `web/src/components/AssistantChat/messages/turnBlockModel.ts:446-476, 501-512` 中，`partitionTurn` 仅靠位置启发式（判断某段 `text` 后面是否还有 `isSubRoundStep`）来决定 `row.trailing = true/false`。一旦连续追问、后台自动 Compaction 或多轮工具输出被合并进同一个 `AssistantMessage`，第一轮的正式回答后面出现了第二轮的工具步骤，第一轮回答立即被判定为 `trailing = false`（中间推理噪音），在回合结束自动折叠时被吞进折叠轨道里消失。
- **全宽状态卡片与左侧缩进轨道混居**：Todo 任务卡片（`TimelineTodoChecklistCard`）本质是回合级看板，却在数据模型上被当成普通 `ToolCallBlock` 塞进 `pinnedRows`。这导致展开态下轨道内与轨道外同时出现两份 Todo 卡片（`TimelineTurnBlock.tsx:969` 与 `1567`），而在折叠态下若不做显式 Key 剥离就会掉进带 `border-l` 竖线的 `turn-collapsed-pinned-rail` 轨道里。

### 1.2 四个 2,000～2,600+ 行的「上帝组件（God Components）」

| 文件路径 | 当前行数 | 混杂职责与架构痛点 |
| :--- | :---: | :--- |
| `web/src/components/SessionChat.tsx` | **2,429** | 同时承担：顶部 518 行辅助函数与 `ScratchlistDrawerHost`/`AbortRestoreConsumer`（`1-518` 行）、9 种 Agent Flavor（`claude` / `codex` / `gemini` / `opencode` / `cursor` / `omp` / `pi` / `grok` / `copilot`）的模型/推理档位查询与级联更新（`871-1222`、`1525-1736` 行）、语音助手全局 Store 同步桥接（`1223-1313` 行）、聊天块归约缓存（`1325-1524` 行）、以及向 `HappyComposer` 拼装透传 57 个扁平 Props（`2183-2410` 行）。 |
| `web/src/components/AssistantChat/HappyComposer.tsx` | **2,611** | 接收 **57 个扁平 Props**（`284-405` 行），内部包含 **50+ 个 `useState`/`useRef`/`useEffect`**，并在 `1782-2365` 行用单个依赖项多达 60 个的 `overlays` `useMemo` 硬编码了 10 种设置弹层（Permission / Collaboration / CopilotAgent / CcSwitch / Model / CursorVariant / ReasoningEffort / Effort / FastMode / ResumeModel），与输入框编辑态高度耦合。 |
| `web/src/components/AssistantChat/HappyThread.tsx` | **2,505** | 将嵌套可滚动容器检测纯函数（`41-355` 行）、25+ 个滚动锚定与分页恢复 refs、顶部半截回合自动补页（`585-672` 行）、大纲跳转（`533-544` 行）、消息气泡渲染、以及 DOM 克隆导出分享长图（`2218-2377` 行）全部耦合在同一文件中。 |
| `web/src/components/AssistantChat/messages/TimelineTurnBlock.tsx` | **2,034** | 将折叠头状态机、左侧时间轴轨道（含 `ResizeObserver` SVG 连线计算，`1325-1460` 行）、行级 Level-2 Preview 组件（`699-1142` 行）、子代理展开树、内联 Diff 视图、权限审批框、Todo 进度卡片、正式回答容器、以及 **400 行仅被 `/demo/turn-timeline` 使用的 `DockedTodoProgressBar` / `DockedQuestionWizard` / `SubmittedQuestionSummaryBubble`（`1634-2034` 行）** 全部塞在一个文件里。 |

### 1.3 状态投影与工具呈现规则四处分叉

1. **同一个 Todo 状态在前端存在多处独立解析、合并与消费代码**：
   - `web/src/components/ToolCard/checklist.tsx:20-320`（`parseChecklistEntries` / `parseOmpTodoDocument` / `collectOmpTodoTurnContext` / `scopeChecklistItemsByOmpPhaseId` / `extractTodoChecklist` / `extractUpdatePlanChecklist`）
   - `web/src/components/AssistantChat/messages/TimelineTurnBlock.tsx:532-588`（`extractToolChecklistItems` 含 `block.tool.result == null` 时的同回合乐观增量合并）
   - `web/src/chat/sessionStatus.ts:38,44,182` 与 `web/src/components/SessionStatusPanel.tsx:59-66`（直接消费 `TodoItem[]` 的 `task.content`，未走 OMP Phase 裁剪与 `blocked` 状态映射）
   - `web/src/fork-features/task-panel/TodoPanel.tsx:18-24` 与 `web/src/components/SessionChat.tsx:1671-1677`（分别计算 `inProgress` 与 `activeTodoText`）
2. **工具卡片的渲染槽位（Slot）与置顶策略（Pin Policy）散落在 4 个文件**：
   - 新增或修改一种特殊工具（如 `todo`、`AskUserQuestion`、子代理 `task`）的折叠置顶和槽位归属时，必须同时修改 `toolNameAliases.ts`、`turnBlockModel.ts:138-167`（`isPinned`）、`turnBlockModel.ts:515-529`（`supersededTodoKeys`）与 `TimelineTurnBlock.tsx:1502-1519`。

### 1.4 死代码/Demo 耦合制造单测假象 + 未分层 CSS 压制 Tailwind v4 工具类

1. **两处非主流程代码混居核心消息组件**：
   - `web/src/components/AssistantChat/messages/TurnBlock.tsx:64-326` 的传统版 `TurnBlockView`：由于 `TurnBlock`（`371-387` 行）硬编码了 `variant="timeline"`，生产会话 100% 走 `TimelineTurnBlockView`，`TurnBlockView` 仅被 `/demo/turn-timeline` 对照列（`TurnTimelineDemo.tsx:1154-1160`）和旧测试 `TurnBlock.test.tsx` / `TurnBlock.markdown.test.tsx` 引用；
   - `web/src/components/AssistantChat/messages/TimelineTurnBlock.tsx:1634-2034` 的 `DockedTodoProgressBar`、`DockedQuestionWizard`、`SubmittedQuestionSummaryBubble`：生产会话底部挂载的是 `TodoPanel.tsx`，这 3 个组件仅被 `TurnTimelineDemo.tsx`（在 `App.tsx:36,420-421` 和 `web/e2e-fixtures/turn-timeline-demo.tsx:5` 挂载）与 `TimelineTurnBlock.test.tsx:149-213` 引用，却占据了 `TimelineTurnBlock.tsx` 尾部 400 行。
2. **`web/src/index.css` 存在 1,017 行未分层（Unlayered）全局 CSS 与第三方 KaTeX 级联隐患**：
   - 全文件 1,174 行中，除 `72-146` 行（`@layer base`）和 `906-912` 行（`@layer components`）外，`148-904` 行与 `914-1174` 行（含 `.aui-md`、`.markdown-content`、`.aui-md-pre`、`.aui-md-codeblock`、`.hapi-MermaidDiagram-*`、`.turn-collapsible-shell`、`.composer-floating-*`、`.assistant-ui-composer-input`）全部未包裹 `@layer`；
   - 同时 `web/src/index.css:2` 的 `@import "katex/dist/katex.min.css";` 也是未分层导入。在 Tailwind CSS v4 级联规范下，**未分层样式优先级无条件高于任何 `@layer`（含 `@layer components` 与 `@layer utilities`）**。

---

## 2. 架构红线与不可破坏的生产不变量（Invariants）

重构必须严格遵守以下 **6 条铁律**，确保零回归：

1. **严禁改动跨端协议与 Golden Fixtures 核心管线**：
   - `web/scripts/fixtures/pipeline.ts:14-28` 调用的 `web/src/chat/normalize.ts` → `web/src/chat/reducer.ts` → `web/src/chat/reconcile.ts` → `web/src/chat/presentation.ts`（以及 `types.ts`、`tracer.ts`）是 Web、iOS（SwiftUI `HapiProtocol`）与 Android（Kotlin `:core:protocol`）三端共用的 Golden Fixtures 真理源。
   - **边界规则**：`shared/fixtures/**` 必须保持零 diff；前端视图派生投影统一放置在独立的子目录 `web/src/chat/projections/todoProjection.ts` 及旁路视图模块 `web/src/chat/sessionStatus.ts` 中（注：若解耦 `web/src/chat/presentation.ts:2` 对 `@/fork-features/omp-product/eventPresentation` 的导入，必须保证 `presentation.ts` 的运行输出与 Golden Fixtures 100% 字节级一致）。
2. **严禁破坏 `.happy-thread-messages > [id]` 的扁平兄弟 DOM 结构**：
   - `web/src/components/AssistantChat/HappyThread.tsx:362` 定义了 `const MESSAGE_ANCHOR_SELECTOR = '.happy-thread-messages > [id]'`；
   - 向上翻页锚点补偿（`captureScrollAnchor` / `restoreScrollAnchor`，`HappyThread.tsx:448-511`）、顶部半截回合自动补页（`isTopTurnHeadlessAssistant`，`HappyThread.tsx:585-591`）、大纲跳转（`locateOutlineTargetMessage`，`HappyThread.tsx:533-544`）、全选快捷键（`applyGlobalSelectAll` 查询 `.happy-thread-messages`，`SessionChat.tsx:287`）、以及分享长图 DOM 采集（`handleShareTurn` 通过 `previousElementSibling` / `nextElementSibling` 扫描 `data-hapi-message-role`，`HappyThread.tsx:2316-2377`）全部依赖 `HappyUserMessage` 与 `HappyAssistantMessage` 作为 `.happy-thread-messages` 的直接扁平子元素。
   - 因此，**不在 `HappyThread` 外层包 `<TurnItem>` 父节点**，而是在 `HappyAssistantMessage` 内部将「执行轨道」、「Todo 卡片」与「正式回答」解耦为平级兄弟容器。
3. **工具级审批框（`PermissionFooter` / `AskUserQuestionFooter`）在展开态下必须保留在具体工具行下方**：
   - 当回合包含多个工具调用且用户展开轨道查看详情时，审批框挂在对应的 `TimelineToolStepRow`（`TimelineTurnBlock.tsx:926-1025`）下才能明确指示当前审批的是哪条命令或哪个文件；折叠态下它们作为 `collapsedPinnedRailRows` 展示在固定槽位。唯有 **Todo 任务卡片（`TimelineTodoChecklistCard`）** 属于回合级全局状态，无论展开还是折叠都必须彻底移出轨道。
4. **保留 `HappyThread.tsx` 现有滚动状态机算法与阈值**：
   - 仅将 `HappyThread.tsx` 顶部的纯函数（`nestedScroll.ts`）和尾部的长图分享 Hook（`useShareTurnCapture.ts`）抽离成独立文件，不改动滚动锁、底部吸附与分页补偿的时序逻辑。
5. **保留 `SessionChat` 的 `key={props.session.id}` 原子重置边界**：
   - `SessionChat.tsx:626-628` 通过 `<SessionChatInner key={props.session.id} {...props} />` 保证切换会话时所有内部状态（Scratchlist 模式、草稿缓存、Runtime）在首帧渲染前原子重置；抽离出的所有子 Hook 与子组件必须保持在该 `key` 作用域内。
6. **保持用户可见契约与必要的公共入口，内部调用方必须迁移到新边界**：
   - 拆分不得破坏生产路由、Demo、Fixture 和分享/审批等现有消费者。实现者必须盘点具名导出和实际引用，迁移所有仓库内部调用方，删除失去消费者的实现和重导出，不以固定导出数量作为验收标准。`HappyChatProvider` 的公共输入仍使用实际的 `HappyChatContextValue`；高频路径必须迁移到细粒度 Hook（`HappyChatStaticContext`、`HappyChatTodosContext`、`HappyChatSessionStateContext`、`HappyChatHistoryContext`），不能在增加细粒度 Context 后仍让消息树统一订阅全量桥接 Hook（§5.4）。

---

## 3. 吸收 `yetone/magpie` 的五项架构升级与对抗评审修正

结合 `SteadyReviewerV3`、`DivergentReviewerV3` 与 `SystemsReviewerV3` 的三方对抗评审，本方案在吸收 `yetone/magpie` 五项核心机制的同时，针对 React 流式状态机与 TypeScript 强类型特性进行了精准调校：

### 3.1 采纳并修正的五项架构机制

1. **强类型 `FlavorComposerControls` 控制器 + 共享设置行原语 + 特异交互插槽（借鉴 `magpie` `Agent.Fields[]`，拒绝弱类型动态表单解释器）**：
   - **吸取的精髓**：将 `SessionChat.tsx` 中横跨 9 种 Flavor（`claude`、`codex`、`gemini`、`opencode`、`cursor`、`omp`、`pi`、`grok`、`copilot`）的模型/思考档位状态与级联更新（如切换模型后自动回滚不支持的 `reasoningEffort` / `effort`）内聚到 `useSessionFlavorModelController.ts`，消除向 `HappyComposer` 传递 30+ 个散装模型 Props 的耦合。
   - **对抗评审修正（回应 `SteadyReviewerV3` #8-11 & `DivergentReviewerV3` §1.1）**：不把 9 种 Flavor 强行塞进擦除类型的单一扁平 `FlavorControlField<any>` 解释器，而是完整保留四类特异交互契约：
     1. **Claude**：保留底部自定义模型文本输入框（`customModelInput`）及非活跃会话切换模型自动开启 `resumeWithSessionModel`（`HappyComposer.tsx:1500-1514, 1954-1988`）；
     2. **OMP**：保留模型面板顶部的 `<OmpModelRefreshRow />`（`data-testid="omp-refresh-models"`，且当 `modelOptions.length === 0 && Boolean(onRefreshModels)` 时仍允许打开面板重试，`HappyComposer.tsx:1679, 1844-1852`）及 `Cmd/Ctrl+M` 服务端模型轮换（`onCycleModel`）；
     3. **Cursor**：保留两阶段原地变体下钻状态机（点击多变体基座模型进入二级变体列表并渲染 `data-testid="cursor-variant-back"`，不提前关闭弹窗，`HappyComposer.tsx:1525-1564, 1991-2056`）；
     4. **Pi**：使用稳定的字符串 `key: "${provider}/${modelId}"` 判定选中态（避免 `{ provider, modelId }` 每次渲染新引用导致 `===` 失效），保留切换模型自动修正失效 `effort`（`HappyComposer.tsx:1108-1119`），并保留 Pi 在 `threadIsRunning` 期间仍允许切换模型/思考等级的特例（`#1442`，`HappyComposer.tsx:1719-1722`）。
2. **简洁纯函数 `toolPresentationManifest.ts`（单一工具槽位与置顶分类器）**：
   - **吸取的精髓**：将散落在 `turnBlockModel.ts` 与 `TimelineTurnBlock.tsx` 中的特殊工具槽位与置顶策略收口到单一纯函数 `classifyToolPresentation(block, context)`。
   - **对抗评审修正（回应 `DivergentReviewerV3` §1.2 & §2.2）**：只针对 3 类特殊工具家族（`todo`/`update_plan`、`permission`/`AskUserQuestion`、运行中 `subagent`）声明显式规则，其余 95% 工具统一走默认 `{ slot: 'rail', pinPolicy: 'never', interactiveFooter: 'none' }`；且 **Todo 卡片绝不发生跨槽位瞬移**——一旦回合存在有效或乐观合并的 Todo 快照，始终在 `<TurnTodoSection />` 稳定渲染；若某次 `todo` 调用报错（`state === 'error'`），报错行作为诊断步骤留在 `<TurnExecutionRail />` 内部，同时不卸载 `<TurnTodoSection />` 的已有看板。
3. **零额外 DOM 节点的 `<FeatureErrorBoundary>` 故障隔离（Slot Isolation）**：
   - **吸取的精髓**：借鉴 `magpie` 微内核 `kernel.js` 的 Slot `try/catch` 隔离墙，为 `<TurnExecutionRail />`、`<TurnTodoSection />`、`<TurnAnswerSection />` 及外围 `<TeamPanel />`、`<TodoPanel />` 提供局部异常捕获。
   - **对抗评审修正（回应 `SteadyReviewerV3` #5）**：`<FeatureErrorBoundary>` 在正常态必须直接返回 `this.props.children`（**零额外包装 `<div>`**），在轨道内部若对单行包裹则必须位于 `<div ref={el => rowElsRef.current[idx] = el}>` 内部，确保 `railRef` 与 `rowElsRef` 的 `getBoundingClientRect()` 坐标计算（驱动 `rail-step-spinner` / `rail-step-checkmark` 的 `translate3d(0, ${y}px, 0)`）及 `compareDocumentPosition` DOM 顺序断言 100% 不受影响。
4. **CSS `@layer components` + `katex.min.css layer(base)` + 受控 `:where()` 基线**：
   - **吸取的精髓**：将 `web/src/index.css` 中未分层的自定义组件样式迁入 `@layer components`，让 Tailwind v4 `@layer utilities` 原子类拥有确定性覆盖权。
   - **对抗评审修正（回应 `SteadyReviewerV3` #1-3）**：
     1. 将 `web/src/index.css:2` 的 `@import "katex/dist/katex.min.css";` 改为 `@import "katex/dist/katex.min.css" layer(base);`，防止未分层的第三方 KaTeX 样式反过来压制迁入 `@layer components` 的 `.aui-md` 公式微调规则（`index.css:644-670`）；
     2. 保持 `.composer-floating-*` 的视觉与交互行为；移除 `SessionChat.test.ts` 与 `HappyComposer.expandSelection.test.tsx` 中仅锁定 CSS 源码文本、选择器格式或首属性的断言，以 §8.4 的计算样式、键盘焦点和几何测试覆盖用户行为，不为旧正则保留偶然的源码排版；
     3. **严禁对状态属性与伪类选择器（如 `.turn-collapsible-shell[data-open="true"]`、`:not(...)`、`:hover`、`:focus-visible`）套用 `:where()` 降权**；`:where()` 仅用于 `.aui-md` / `.markdown-content` 下的基础标签排版重置；
     4. 显式豁免 `web/src/index.css:711-714`（覆盖 Shiki 行内 `style="background-color:..."`，1 处）和 `web/src/index.css:1131-1173`（`prefers-reduced-motion` 无障碍降级，8 处）共 9 处存量 `!important`。
5. **路径归一化静态架构边界单测（`architecture-boundaries.test.ts`）**：
   - **吸取的精髓**：借鉴 `magpie` 的 `TestPluginsImportOnlyCore`，通过 Vitest 静态扫描守卫分层纪律。
   - **对抗评审修正（回应 `SteadyReviewerV3` #12-14）**：
     1. 使用 `path.resolve` 将所有静态/动态 `import` 路径归一化为 `web/src/...` 相对路径后再断言，封堵 `../` 相对路径绕过；
     2. 在 CSS 检查器中将顶层 `:root` 与 `.dark` 主题变量块（`index.css:72-146`）统一归入 `@layer base`（或显式豁免），并允许 `@layer components` 内嵌套 `@media`；
     3. 针对 `web/src/components/` 下存量引用 `@/fork-features/` 的 7 个宿主桥接文件设立显式受控白名单（防止新增未授权耦合，同时不误伤合法宿主挂载点）。


### 3.2 多项目证据与采纳矩阵（V3.2）

本节复用 [调研会话](/sessions/c5082bbd-3fa0-4b73-919b-c4836d6f82c1) 的原始记录，而不是重新用项目宣传页推导实现结论。`[源码]` 表示已读到对应代码，不表示运行过；`[检索]` 只证明文件/符号存在；`[文档]` 表示项目声明或设计文档；`[INFERENCE]` 表示本方案的推断。Star 数、支持 Agent 的数量和项目热度不作为架构验收依据。

| 项目与可追溯证据 | 证据实际支持的机制与限制 | HAPI 决定 | PR 归属与验收 |
| :--- | :--- | :--- | :--- |
| [`stablyai/orca` 的 `hello-components/panel.tsx`](https://github.com/stablyai/orca/blob/692c81ca17d0e628665629c3c698a4c84619a832/examples/plugins/hello-components/src/panel.tsx)；调研原始读取 `entry/8f885142` | `[源码]` 示例使用 `atom`、`derived`、宿主 `Stack`/`Row`/`Input`，`setup(ctx)` 将事件订阅放入 `ctx.subscriptions`。它证明面板状态和宿主 UI 原语的接口形态，不证明整个 Orca 无 Context 广播、任意插件无 CSS 污染或高负载不卡顿。 | 采纳局部状态所有权、按需订阅、宿主统一控件与订阅清理；继续使用 React 和现有状态设施，不安装 atom 库、不复制 Orca SDK/Worker。 | PR 1 的样式边界、PR 3 的订阅与卸载契约、PR 4 的强类型设置行；用渲染计数、生命周期和真实控件交互验证。 |
| [`EvanZhang008/open-walnut` 的 App 注册表](https://github.com/EvanZhang008/open-walnut/blob/b63a965ead53aa5862b1f75c25a4266846ae5195/web/src/apps/registry.ts)、[`PluginAppPage`](https://github.com/EvanZhang008/open-walnut/blob/b63a965ead53aa5862b1f75c25a4266846ae5195/web/src/pages/PluginAppPage.tsx)、[`PluginAppFailure`](https://github.com/EvanZhang008/open-walnut/blob/b63a965ead53aa5862b1f75c25a4266846ae5195/web/src/components/settings/PluginAppFailure.tsx)；原始检索 `entry/7515e001` | `[检索]` 记录证明 App 注册、页面与失败呈现文件存在，尚不足以证明 `PluginAppFailure` 是完整 React ErrorBoundary，也未证明其状态更新不影响聊天树。`docs/plan/plugin-ai.md` 的独立 NDJSON/AbortSignal 接口属于 `[文档]`，其中部分能力仍标为计划。 | 借鉴显式挂载和局部失败呈现的职责边界；HAPI 自行定义并测试 ErrorBoundary 与资源清理契约，不将文件名当成已经验证的容错实现。 | PR 3 的故障注入与重试/换会话恢复测试；PR 4 的请求取消和迟到结果隔离。 |
| [`siteboon/claudecodeui`](https://github.com/siteboon/claudecodeui) 的 `src/modules/plugins/`、`server/modules/plugins/`；调研 `entry/5ba1f5bc` | `[检索/文档]` 前后端插件模块和独立 Tab 是扩展入口；这些证据没有覆盖聊天内部的渲染订阅、CSS 优先级和三槽位布局。 | 采纳“宿主负责组合、功能模块负责局部交互”的编译期依赖方向，不增加 Git 插件安装、Node RPC 插件后端或运行时注册中心。 | PR 1 的依赖方向守卫与 PR 3/4 的功能 Props 契约。 |
| [`happier-dev/happier`](https://github.com/happier-dev/happier)、[`getpaseo/paseo`](https://github.com/getpaseo/paseo)、[`devswha/ovis`](https://github.com/devswha/ovis) + [`herdrdev/herdr`](https://github.com/herdrdev/herdr)、[`23blocks-OS/ai-maestro`](https://github.com/23blocks-OS/ai-maestro) | `[文档]` 调研覆盖多机控制、内置工作区或看板形态，没有充分审计其状态订阅和回合内部 DOM。没有外部 UI 插件 API，不等于内部架构耦合或性能差。 | 仅保留多机产品形态参照；本次不迁移控制面、认证、协议和移动端，也不据此给这些项目判定架构优劣。 | 不增加实施项；§2 的既有资产与跨端边界保持不变。 |
| [`multica-ai/multica`](https://github.com/multica-ai/multica) | `[文档]` 调研描述独立 Kanban 与 Execution Log，不能据此断言其不存在任何内联任务卡；调研将许可列为附加限制的 Source-Available，未做本次法律核验。 | 仅参考独立视图的职责划分，不复制代码、不新增依赖，不将其作为已满足 HAPI 内联需求的替代品。 | 不增加实施项。 |
| [`MCP-UI-Org/mcp-ui`](https://github.com/MCP-UI-Org/mcp-ui)、[`modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps)、[`ag-ui-protocol/ag-ui`](https://github.com/ag-ui-protocol/ag-ui) + [`CopilotKit`](https://github.com/CopilotKit/CopilotKit) | `[文档]` MCP Apps/工具 UI 资源与 AG-UI 事件/共享状态提供不同层次的集成接口。AG-UI 本身不提供 iframe CSS 沙箱；工具资源元数据也不自动解决宿主的订阅与回合布局。 | 记录为独立的未来选题。本次不增加 `interactive_app` 槽位、`rendererKind`、协议元数据优先路由、iframe 或通用动态组件解释器。 | PR 3 的分类器仍只处理现有特殊工具；未来若有真实消费者，另立协议、安全与权限方案。 |

调研中独立 Pane/Tab 的做法说明“面板可与消息流分离”，不证明相关项目完全没有内联 Todo，也不证明它们从未出现吞回答或性能问题。HAPI 保留 `<TurnTodoSection />` 的原因是当前已确认的内联进度交互，而不是外部项目欠缺某项能力。底部 `TodoPanel` 展示会话当前进度，消息内 Todo 展示对应子回合快照；两者共享解析规则，但不得把实时 `session.todos` 广播成每个历史回合的新快照。

### 3.3 宿主、领域投影与功能槽位的执行边界

1. **领域投影层只处理数据**。`todoProjection.ts`、`toolPresentationManifest.ts` 与 `projectTurn()` 不访问 React Context、DOM、浏览器存储、API 客户端或动态插件注册表。Hub 的持久化 Todo 提取仍属于服务端边界；前端“唯一投影”不意味着让 Hub 导入 Web 组件或视图模块。
2. **宿主拥有路由、认证、会话身份和写操作能力**。`SessionChat`/`HappyThread` 的组合层把已投影数据和最小类型化动作传入功能组件；普通展示组件不得重新打开 SSE、遍历全局会话缓存或复制模型选择规则。工具审批与问答仍使用对应工具的现有权限流程，不能被通用面板按钮绕过。
3. **槽位拥有局部 UI 状态与清理责任**。折叠、预览、输入草稿留在对应槽位；Effect 必须清理 Observer、timer 和可取消请求。会话身份变化后，旧请求结果不得写入新会话。失败与恢复规则见 §5.7。
4. **统一数据不等于统一刷新频率**。TodoPanel、内联 Todo、状态摘要共用纯函数规则，但按各自作用域消费数据。回答文本追加不得仅因共享 Provider 新建对象而强制更新所有历史工具行；模型配置刷新不得使已完成回合重新分区。此项由 §8.5 的定向更新场景验收，而非通过更换前端框架宣称完成。
5. **本次是编译期模块化，不是第三方插件平台**。五个 PR 不改变 Hub+Runner 拓扑、多用户网关、`shared/fixtures/**`、科研探索工作台及移动端协议。引入运行时插件/远端 HTML 需要独立的信任、资源预算、权限与跨端契约，本方案不预设空接口。

---

## 4. 目标组件树与职责边界（V3.2 Target Architecture）

### 4.1 目标组件层级图

```
SessionChat (key={session.id}，保留全部 14 个具名导出 Facade)
 ├── SessionHeader
 ├── CursorMigrationBanner
 ├── SessionStatusPanel (消费 projections/todoProjection.ts)
 ├── FeatureErrorBoundary[name="team-panel"] (正常态零额外 DOM 节点)
 │    └── TeamPanel
 ├── AssistantRuntimeProvider
 │    ├── ShareSeedConsumer & AbortRestoreConsumer (抽离至 sessionChatHelpers.tsx)
 │    └── DragDropZone
 │         ├── AgentTerminalView
 │         ├── HappyThread (.happy-thread-messages 保持扁平兄弟 DOM 节点，保留 21 个具名导出)
 │         │    ├── HappyUserMessage (id="hapi-message-...", data-hapi-message-role="user")
 │         │    └── HappyAssistantMessage (id="hapi-message-...", data-hapi-message-role="assistant")
 │         │         └── TurnBlock (仅在需兜底时按需订阅 todos；调用 projectTurn(content) -> ProjectedSubturn[])
 │         │              └── SubturnView (key={subturn.firstBlockId}，内部严格切分为 3 个平级全宽兄弟槽位)
 │         │                   ├── 1. TurnExecutionRail (仅含折叠摘要头 + Thinking + 非 Todo 工具步骤 + 工具级 Permission/Ask)
 │         │                   ├── 2. TurnTodoSection (平级全宽容器：data-testid="turn-live-todo-cards"，唯一渲染 TimelineTodoChecklistCard)
 │         │                   └── 3. TurnAnswerSection (平级全宽容器：data-testid="turn-media-deliverables" + 正式 Markdown 回答正文)
 │         └── ComposerDock
 │              ├── ScratchlistMigrationBanner
 │              ├── FeatureErrorBoundary[name="todo-panel"]
 │              │    └── TodoPanel (与 TurnTodoSection、SessionStatusPanel、SessionChat.activeTodoText 共享 todoProjection.ts)
 │              ├── ScratchlistDrawerHost (抽离至 sessionChatHelpers.tsx)
 │              ├── QueuedMessagesBar
 │              └── HappyComposer (接收 flavorControls 分组对象，保留全部 6 个具名导出)
 │                   └── ComposerSettingsSheet (承接 10 类设置弹层，完整保留 Claude 自定义输入、OMP 刷新行、Cursor 二级下钻、Pi 复合键)
 └── SessionVoiceBridge (抽离原 1223-1313 行语音 Store 注册与事件同步)
```

### 4.2 新增与重构文件清单

```
web/src/
├── index.css                                                   # [Modify] katex 纳入 layer(base)，组件样式移入 @layer components（以计算样式验收替代源码正则断言）
├── __tests__/
│   └── architecture-boundaries.test.ts                         # [New] 路径归一化静态架构边界守卫测试
├── chat/
│   ├── projections/
│   │   ├── todoProjection.ts                                   # [New] 唯一的前端 Todo 归一化、乐观增量合并与 OMP Phase 过滤纯函数模块
│   │   └── todoProjection.test.ts                              # [New] 覆盖 Claude TodoWrite / OMP todo (含 result==null 乐观合并) / Codex update_plan
│   └── sessionStatus.ts                                        # [Modify] 接入 projections/todoProjection.ts
├── components/
│   ├── FeatureErrorBoundary.tsx                                # [New] 零额外 DOM 节点的轻量槽位级 React ErrorBoundary
│   ├── SessionStatusPanel.tsx                                  # [Modify] 接入 todoProjection.ts，修复 OMP Phase 过滤与 blocked 状态映射
│   ├── SessionChat.tsx                                         # [Modify] 抽离 9-Flavor 控制器、语音桥接与辅助组件，保留 14 个具名导出重导出
│   ├── ToolCard/
│   │   └── checklist.tsx                                       # [Modify] 内部委托给 todoProjection.ts，完整保留 extractTodoChecklist 等 5 个导出
│   └── AssistantChat/
│       ├── context.tsx                                         # [Modify] 按真实类型拆分静态/Todo/会话运行态/历史状态订阅；迁移高频消费者
│       ├── sessionChatHelpers.tsx                              # [New] 承接 SessionChat 原 1-518 行的纯函数与辅助 Consumer 组件
│       ├── useSessionVoiceBridge.ts                            # [New] 承接 SessionChat 原 1223-1313 行的语音助手同步逻辑
│       ├── HappyThread.tsx                                     # [Modify] 抽离 nestedScroll.ts 与 useShareTurnCapture.ts，保留 21 个具名导出
│       ├── nestedScroll.ts                                     # [New] 承接 HappyThread 原 41-355 行嵌套滚动检测纯函数
│       ├── useShareTurnCapture.ts                              # [New] 承接 HappyThread 原 2218-2377 行分享长图 DOM 采集与导出逻辑
│       ├── HappyThread.context.test.tsx                         # [New] 用消费侧行为验证定向更新与会话切换，不锁定 useMemo 源码
│       ├── HappyComposer.tsx                                   # [Modify] 接入 flavorControls 与 ComposerSettingsSheet，保留 6 个具名导出
│       ├── composer/
│       │   ├── types.ts                                        # [New] 定义强类型 FlavorComposerControls、特异交互插槽与设置面板 Props 契约
│       │   ├── useSessionFlavorModelController.ts              # [New] 收敛 SessionChat 原 871-1222 与 1525-1736 行的 9-Flavor 模型/档位计算与级联更新
│       │   └── ComposerSettingsSheet.tsx                       # [New] 承接 HappyComposer 原 1801-2278 行的设置弹层（含 Claude/OMP/Cursor/Pi 专属交互）
│       └── messages/
│           ├── toolPresentationManifest.ts                     # [New] 工具呈现分类纯函数（slot、pinPolicy、interactiveFooter）
│           ├── TurnDockedWidgets.tsx                           # [New] 承接 TimelineTurnBlock 原 1634-2034 行的 DockedTodoProgressBar / DockedQuestionWizard / SubmittedQuestionSummaryBubble（供 TurnTimelineDemo 使用）
│           ├── TimelineStepRows.tsx                            # [New] 承接 TimelineTurnBlock 原 699-1142 行的行级渲染与 Level-2 Preview 子组件
│           ├── TurnBlock.tsx                                   # [Modify] 清理经典版 TurnBlockView（保留 messageHasTurnActivity 与 MarkdownText）；按需订阅 todos
│           ├── turnBlockModel.ts                               # [Modify] 接入 toolPresentationManifest；实现稳定 key 的 projectTurn()
│           ├── TimelineTurnBlock.tsx                           # [Modify] 重构为 Subturn 三兄弟容器组装层，保留全部外部具名导出重导出
│           ├── TurnTimelineDemo.tsx                            # [Modify] 对齐 TurnBlock 与 TurnDockedWidgets 导出
│           ├── TurnExecutionRail.tsx                           # [New] 独立渲染折叠头、左侧竖线轨道（保持 railRef / rowElsRef 测量结构不变）
│           ├── TurnTodoSection.tsx                             # [New] 独立全宽渲染 TimelineTodoChecklistCard（data-testid="turn-live-todo-cards"）
│           └── TurnAnswerSection.tsx                           # [New] 独立全宽渲染交付媒体（data-testid="turn-media-deliverables"）与正式 Markdown 回答正文
web/e2e-fixtures/
├── turn-timeline-demo.html                                     # [Existing] 挂载 TurnTimelineDemo 的独立 E2E Fixture 页面
├── composer-flavor-settings-fixture.html                       # [New] 挂载 9-Flavor HappyComposer + ComposerSettingsSheet 的交互测试页
└── composer-flavor-settings-fixture.tsx                        # [New] 提供 Claude / OMP / Cursor / Pi 四类特异状态的确定性 Fixture Harness
e2e/
├── css-layer-and-focus.spec.ts                                 # [New] PR 1 真实 Chromium 点击聚焦、getComputedStyle(@layer / KaTeX / Shiki) 测试
├── turn-timeline-slots.spec.ts                                 # [New] PR 2 & 3 真实点击折叠/展开、三槽位 getBoundingClientRect() 几何与 Todo 独立测试
├── composer-flavor-settings.spec.ts                            # [New] PR 4 真实点击 9-Flavor 弹层（Cursor 下钻、OMP 刷新、Claude 自定义、Pi 运行中切换）
├── streaming-isolation.spec.ts                                 # [New] PR 3 定向流式更新、交互响应与性能基线回放
└── feature-isolation.spec.ts                                   # [New] PR 3 槽位故障注入与局部恢复
```

---

## 5. 核心模块详细接口与算法设计（经对抗评审修正）

### 5.1 统一 Todo 投影契约（`web/src/chat/projections/todoProjection.ts`）

回应 `SystemsReviewerV3` **C-01 / C-02 / C-03**：
1. `CanonicalTodoItem.id` **必须保持可选（`id?: string`）**，严禁为无 ID 的 OMP `*** Begin Todo` DSL 条目合成位置索引 ID，确保 `scopeChecklistItemsByOmpPhaseId`（`checklist.tsx:246` `if (!item.id) return items`）、无 ID 文本回退匹配（`(item.id && b.id === item.id) || b.text === item.text`）及 `checklist.test.tsx:48,63,80,109` 100% 兼容；
2. 完整保留 `TimelineTurnBlock.tsx:551-585` 在 `block.tool.result == null`（工具运行中）时的**同回合乐观增量合并契约**（基于 `previousToolCalls` 或 `fallbackTodos` 合并当前 `input` 解析出的增量指令）；
3. 在 `parseChecklistEntries` 中提取 `activeForm?: string`，供 `SessionChat.tsx:1671-1677`（`activeTodoText`）与 `TodoPanel.tsx` 统一消费；
4. 在 `web/src/components/ToolCard/checklist.tsx` 中保留 `extractTodoChecklist`、`extractUpdatePlanChecklist`、`collectOmpTodoTurnContext`、`OmpTodoTurnContext`、`ChecklistItem`、`ChecklistStatus` 的具名重导出，确保 `turnBlockModel.ts:326`、`knownTools.tsx:91,385`、`TodoWriteView.tsx:5`、`_results.tsx:961` 与 `checklist.test.tsx` 零破坏。

```ts
// web/src/chat/projections/todoProjection.ts
import type { ToolCallBlock } from '@/chat/types'
import type { TodoItem } from '@hapi/protocol/types'

export type CanonicalTodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

export interface CanonicalTodoItem {
    /** 保持可选：OMP DSL 文本命令无 id，依赖 text 匹配；Session 级 OMP Todo 带 "<phase>:<idx>" id */
    readonly id?: string
    readonly text: string
    readonly activeForm?: string
    readonly status: CanonicalTodoStatus
}

export interface OmpTodoTurnContext {
    readonly preExistingCompletedPhaseIds: ReadonlySet<string>
    readonly preExistingCompletedPhaseNames: ReadonlySet<string>
    readonly touchedPhaseIds: ReadonlySet<string>
    readonly touchedPhaseNames: ReadonlySet<string>
}

export interface CanonicalTodoSnapshot {
    readonly items: readonly CanonicalTodoItem[]
    readonly activeItem: CanonicalTodoItem | null
    readonly completedCount: number
    readonly totalCount: number
    readonly allDone: boolean
}

/**
 * 扫描当前回合内的 todo 工具调用，识别跨回合遗留的已完成 Phase 与本回合触达的 Phase
 */
export function collectOmpTodoTurnContext(
    calls: ReadonlyArray<{ readonly name?: string | null; readonly input?: unknown; readonly result?: unknown }>
): OmpTodoTurnContext

/**
 * 针对单个 ToolCallBlock（TodoWrite / todo / UpdatePlan）投影 Todo 快照：
 * 当 block.tool.result == null 时，自动基于同回合前序 Todo 调用或 fallbackTodos 执行乐观增量合并
 */
export function projectToolTodoSnapshot(params: {
    readonly block: ToolCallBlock
    readonly turnContext?: OmpTodoTurnContext
    readonly previousTodoBlocks?: readonly ToolCallBlock[]
    readonly fallbackTodos?: readonly TodoItem[] | null
}): CanonicalTodoSnapshot

/**
 * 针对 Session 级 TodoItem[]（用于 TodoPanel、SessionStatusPanel、SessionChat.activeTodoText）投影快照：
 * 自动执行 OMP Phase 作用域裁剪与 task.blocked -> 'blocked' 状态映射
 */
export function projectSessionTodoSnapshot(
    todos: readonly TodoItem[] | null | undefined
): CanonicalTodoSnapshot
```

### 5.2 工具呈现分类器（`web/src/components/AssistantChat/messages/toolPresentationManifest.ts`）

回应 `DivergentReviewerV3` §1.2 & §2.2：保持分类器精简直观，且保证 Todo 卡片不因单次报错而在轨道与看板间跳变：

```ts
// web/src/components/AssistantChat/messages/toolPresentationManifest.ts
import type { ToolCallBlock } from '@/chat/types'

export type ToolRenderSlot = 'rail' | 'turn-todo-section'
export type ToolPinPolicy = 'never' | 'while-running' | 'until-recovered' | 'until-resolved'
export type ToolInteractiveFooter = 'none' | 'permission' | 'ask-user-question'

export interface ToolPresentationRule {
    readonly slot: ToolRenderSlot
    readonly pinPolicy: ToolPinPolicy
    readonly interactiveFooter: ToolInteractiveFooter
}

/**
 * 规则：
 * 1. Todo / UpdatePlan 工具（且存在有效或可乐观合并的 ChecklistItem[]，且 tool.state !== 'error'）：
 *    -> { slot: 'turn-todo-section', pinPolicy: 'never', interactiveFooter: 'none' }
 * 2. Todo / UpdatePlan 工具（处于未恢复的 tool.state === 'error'）：
 *    -> { slot: 'rail', pinPolicy: 'until-recovered', interactiveFooter: 'none' }
 *    （注：此时平级 <TurnTodoSection /> 仍保留上一次有效 Todo 快照，避免看板卸载闪烁）
 * 3. AskUserQuestion / RequestUserInput 待回答：
 *    -> { slot: 'rail', pinPolicy: 'until-resolved', interactiveFooter: 'ask-user-question' }
 * 4. Permission 待审批：
 *    -> { slot: 'rail', pinPolicy: 'until-resolved', interactiveFooter: 'permission' }
 * 5. Subagent / Task 运行中：
 *    -> { slot: 'rail', pinPolicy: 'while-running', interactiveFooter: 'none' }
 * 6. 其余普通工具：
 *    -> { slot: 'rail', pinPolicy: 'never', interactiveFooter: 'none' }
 */
export function classifyToolPresentation(
    block: ToolCallBlock,
    context: { readonly hasValidTodoChecklist: boolean; readonly errorRecovered: boolean }
): ToolPresentationRule
```

### 5.3 稳定 Key 的子回合投影与三兄弟容器模型（`turnBlockModel.ts`）

回应 `DivergentReviewerV3` §2.1 & §2.3：
1. **禁止对流式前置过渡文本（Preamble Text）切分 Subturn**：
   - 模型在调用工具前输出的过渡文本（如 `"让我先检查目录结构："`，紧接着出现 `ToolCall`）属于当前执行轮次的中间说明，留在 `<TurnExecutionRail />` 内部渲染，**绝不触发 `ProjectedSubturn` 分裂**。
   - 仅当遇到**已闭合的结构性轮次边界**（① `ContextCompaction` 压缩块；② 同一 `AssistantMessage` 内前序回合已产出带 `roundSummary` / 完整交付结构的正式回答、随后因连续追问合流或后台恢复而开启新一轮工具调用）时，才闭合前序 `ProjectedSubturn`。
2. **使用首个内容块的稳定 ID 作为 `ProjectedSubturn.key`**：
   - `key` 取自该子回合首个 Row 的稳定 `key`（如 `subturn:${firstRowKey}`），而非数组下标 `index`，确保流式追加过程中用户手动点击折叠/展开的本地 `open` state 绝不因 Remount 而丢失。

```ts
// web/src/components/AssistantChat/messages/turnBlockModel.ts
export interface ProjectedSubturn {
    /** 锚定子回合首个块的稳定 ID（如 "subturn:block-1"），流式增长期间保持恒定 */
    readonly key: string
    /** 1. 轨道步骤：仅包含 Thinking、过程说明文本与 slot === 'rail' 的 Tool 步骤 */
    readonly railStepRows: readonly TurnDisplayStepRow[]
    /** 折叠态下保留在轨道内的行（仅限未恢复 Error、待审批 Permission、待回答 AskUserQuestion、运行中 Subagent） */
    readonly collapsedPinnedRailRows: readonly TurnDisplayStepRow[]
    /** 2. 平级全宽 Todo 卡片：当前子回合最新的有效/乐观合并 Todo 快照（若无则为 null） */
    readonly todoSnapshot: CanonicalTodoSnapshot | null
    /** 3. 平级全宽交付物与正式回答：渲染在轨道与 Todo 卡片下方，绝不被折叠隐藏 */
    readonly mediaRows: readonly (TurnImageRow | TurnFileRow)[]
    readonly answerRows: readonly TurnTextRow[]
}
```

### 5.4 按实际字段与更新频率拆分 `HappyChatContext`

V3.2 基线是 `web/src/components/AssistantChat/context.tsx:10-36` 与 `HappyThread.tsx:2356-2378`。当前类型包含 `sessionThinking`、`activeTurnStartedAt`、`terminalToolDisplayMode`、`onRetryMessage`、`onForkConversation`、`onRewindConversation` 和历史加载字段；并没有旧方案所列的 `modelMode`、`jumpToMessageId`、`viewMode` 等字段。实现不得补出不存在的旧 API，也不得按“18/17 个字段”等历史数量拆分。

采用以下类型化分组，各组使用 `Pick<HappyChatContextValue, ...>`，静态组使用排除其他三组字段后的 `Omit`，避免复制整份类型产生漂移：

| 分组 | 当前字段 | 订阅者与更新边界 |
| :--- | :--- | :--- |
| `HappyChatStaticContext` | `api`、`sessionId`、`metadata`、`terminalToolDisplayMode`、`showSessionSummaryInChat`、`disabled`，以及原类型中的动作回调 | 静态是相对文本 delta 而言，并非永不更新。只读取路径的消费者依赖 `metadata.path`；读取其他呈现字段的消费者必须保留这些依赖。 |
| `HappyChatTodosContext` | `todos` | 会话 TodoPanel 与需要当前回合兜底的子组件；不向所有历史回合广播。 |
| `HappyChatSessionStateContext` | `sessionThinking`、`activeTurnStartedAt` | 当前尾部回合判断。借助不条件调用 Hook 的尾部订阅子组件保留 `TurnBlock.tsx:348-356` 的活动回合判定。 |
| `HappyChatHistoryContext` | `historyActionPending`、`hasMoreMessages`、`isSyncingTail`、`isLoadingMoreMessages` | 历史操作与加载消费者；不能将分页状态藏在所谓静态对象中。 |

`HappyChatProvider` 仍接受现有完整 `value`，但必须按每组实际字段 `useMemo`，不能用整份 `value` 或 `props.session` 作各组共同依赖。`HappyThread` 的输入对象也需稳定化：一方面，`handleShareTurn`（`HappyThread.tsx:2287-2353`）虽已有 `useCallback`，但其依赖数组当前写了函数体并未读取的 `[props.session]`，导致每次 `session-updated`（修改 `thinking`、`todos`、`activeAt` 或 `updatedAt`）都会重建 `onShareTurn` 并使 `HappyChatStaticContext` 失效，因此 PR 3 必须将 `handleShareTurn` 的依赖收敛为 `[]`；另一方面，`metadata`（`SessionMetadataSummary | null`）应在 `SessionChat` / `HappyChatStaticContext` 中按实际字段值稳定化，使仅触碰 `thinking`、`todos` 或 `updatedAt` 的 SSE 事件不触发 `metadata` 引用抖动。当前未发现前序分析所称的 `toggleTurnViewVariant`，不为它创建修复项。

仓库内部的 `AssistantMessage`、`TurnBlock`、`TimelineTurnBlockView` 和工具行必须逐一迁移到所需的细粒度 Hook 或已投影 Props。全量 `useHappyChatContext` / `useOptionalHappyChatContext` 若仍有必要消费者，可以组合这些 Context 作为入口，但不能承诺其消费者具有细粒度隔离；没有消费者的桥接导出必须删除。对应测试和 Fixture 同步迁移，不能以“所有 mock 零修改”限制正确边界。

`TurnBlock.tsx:337-340` 的分区缓存 `partitionTurn(contentParts(content), ctx?.metadata ?? null)` 将 `metadata: SessionMetadataSummary | null` 传入 `getToolPresentation`（`turnBlockModel.ts:384-391`），而 `messageHasTurnActivity(s.message.content)`（`TurnBlock.tsx:390-392`）传入 `metadata = null` 又执行一次完整分区。由于两处 `metadata` 参数不同，PR 3 不使用 `WeakMap` 混用缓存，而是将 `messageHasTurnActivity(content)` 改为直接扫描 `content` 的 $O(k)$ 轻量谓词（与 `turnBlockModel.ts:428-452,531` 的 4 项活动条件严格等价：非空 `reasoning`、非空 `tool-group`、非 `CodexReasoning` 的 `tool-call`、或生成图片/文件），并在 `TurnBlock` 的 `useMemo` 中仅基于稳定化后的 `metadata` 执行一次 `partitionTurn`。截断回合的 `fallbackTodos` 与 `isLastMessage` 语义必须保留，不能因减少订阅而删除兜底卡片。

### 5.5 强类型 9-Flavor 模型控制器与 `<ComposerSettingsSheet />`（回应 `SteadyReviewerV3` #8-11 & `DivergentReviewerV3` §1.1）

将 `SessionChat.tsx:871-1222, 1525-1736, 2199-2391` 收敛为 `useSessionFlavorModelController.ts`，向 `HappyComposer` 传递单一强类型分组对象 `flavorControls: FlavorComposerControls`，同时显式建模 4 项特异能力：

```ts
// web/src/components/AssistantChat/composer/types.ts
export interface FlavorOptionItem<T = string | null> {
    /** 稳定唯一键（如 Pi 使用 "${provider}/${modelId}"），严禁对复合对象直接使用 === 比较 */
    readonly key: string
    readonly value: T
    readonly label: string
    readonly description?: string
    readonly group?: string
    readonly isSelected: boolean
    /** 支持 Cursor 双阶段原地变体下钻（点击父项进入二级列表，不关闭弹窗） */
    readonly drillDownVariants?: readonly FlavorOptionItem<string | null>[]
}

export interface ClaudeCustomModelInputConfig {
    readonly draft: string
    readonly placeholder: string
    readonly onDraftChange: (value: string) => void
    readonly onSubmit: () => void
}

export interface OmpModelRefreshConfig {
    readonly refreshing: boolean
    readonly error: string | null
    readonly empty: boolean
    readonly disabled: boolean
    readonly onRefresh: () => void
}

export interface FlavorComposerControls {
    readonly agentFlavor: string | null
    readonly configurationControlsDisabled: boolean
    /** Pi 在 threadIsRunning 期间仍为 false（允许运行中切换模型/思考等级，#1442） */
    readonly modelEffortControlsDisabled: boolean
    readonly modelValueLabel: string | null
    readonly effortValueLabel: string | null
    readonly onCycleModel?: () => void
    readonly ompRefreshConfig?: OmpModelRefreshConfig | null
    readonly claudeCustomModelInput?: ClaudeCustomModelInputConfig | null
    // 各设置域选项与回调由 useSessionFlavorModelController 统一计算并提供给 ComposerSettingsSheet
}
```

### 5.6 流式性能的已知事实、修正与有界治理

本方案区分“源码存在重复或同步工作”与“已测量的耗时瓶颈”。目前未运行可比较的 HAPI/Orca/Magpie 性能基准，不能据此承诺无卡顿、固定帧率或若干毫秒收益。

| 当前证据 | V3.2 决定 | 必须保留的行为 |
| :--- | :--- | :--- |
| `HappyThread.tsx:2356-2378` 每次渲染构造 Provider 对象；`context.tsx:41-45` 直接广播该值 | PR 3 执行 §5.4 的分组、稳定输入与消费者迁移。稳定 Context 不保证父树永不重新渲染，必须用实际消费侧计数和 Profiler 区分两类更新。 | 回调使用最新会话身份；会话切换仍由 `key={session.id}` 原子重置。 |
| `TurnBlock.tsx:337-340,390-392` 同一路径存在分区与活动检测重复；`toolRows` 继续把 `metadata` 传给 `getToolPresentation` | PR 3 将 `messageHasTurnActivity` 改为直接扫描 `content` 的 $O(k)$ 轻量谓词（不分配 `contentParts`、不调 `partitionTurn`），并按字段值稳定化 `metadata`，保持 `partitionTurn` 签名与 `SessionMetadataSummary | null` 完整传入。 | 工具标题/路径变化仍更新，权限、子代理和无活动文本的检测结果保持一致。 |
| `message-window-store.ts:172-191,221-228` 在定时持久化中同步执行完整窗口 `JSON.stringify` 与 `sessionStorage.setItem` | PR 3 回放先记录存储写入次数与耗时；若它形成热点，仅针对**纯实时流式分片**（`getLiveMessageStreamId(msg.content) !== null`）有界合并待写快照，并注册 `pagehide` / `visibilitychange` 调 `flushPersistedStates()`；普通/终态消息（`getLiveMessageStreamId === null`）与乐观用户消息保持现有 200ms `PERSIST_THROTTLE_MS` 调度。 | 非流式写入（含 `message-window-store.test.ts:1002,1029,2115` 真实 timer 断言）、刷新后的历史恢复、`finalizedStreamIds`、防止旧 live 快照复活、clear/delete 不被迟到 timer 写回、会话隔离都必须保持。Hub 仍是消息真理源；持久化不是跨端协议变更。 |
| `TimelineTurnBlock.tsx:1437-1461` 的测量 Effect **已经**只依赖 `[open, stepRows.length, showFrontierSlot]`，并观察 `railRef` 的 ResizeObserver | 删除前序“把 summaryText/answerText 改成布尔值”的错误修复项。PR 3 只检查拆分后是否仍保持轨道相对测量、行内容展开和字体/宽度变化可触发正确更新，不机械删除必要同步测量。 | Spinner 交接动画、工具行中心对齐与用户展开预览保持正确；滚动算法和阈值不变。 |

整窗排序/归约、Markdown/KaTeX 重解析与滚动读写仍是待测候选，不在本次五 PR 中未经测量就改写 reducer、引入增量 Markdown AST、Worker 或消息虚拟化。基线若显示这些候选主导耗时，记录 trace 与复现参数并另立性能实现方案；不能把本次组件拆分宣称为已经消除全部卡顿。

### 5.7 槽位故障与资源生命周期契约

`FeatureErrorBoundary` 是 React 渲染/生命周期错误隔离，不是安全沙箱，不捕获事件处理器或异步 Promise 的所有错误。网络、审批和模型 RPC 失败仍由原有请求错误状态处理，不得用 ErrorBoundary 吞掉失败并显示成功。

- **隔离单位**：Rail、Todo、Answer 和外围功能面板分别隔离。纯投影发生在槽位边界之外时，必须有消息级故障边界保护会话列表与 Composer；不能声称内层 ErrorBoundary 能捕获其父组件的投影异常。共享投影整体失败时不承诺还原未产出的回答槽位，但必须保留已独立渲染的其他消息及输入操作。
- **失败呈现**：失败槽位显示明确的功能名称、失败状态和显式重试入口；已有其他槽位不卸载、不改 key。权限/问答的权威状态不变，不能用“预览降级”代替完成审批。错误日志不得复制 token、完整 transcript 或任意工具输出。
- **恢复**：手动重试或切换到新的 `sessionId`/稳定子回合 key 时重置；不能按每个 streaming chunk 清空错误并自动重试。正常态直接返回 children，保留原 DOM 测量层级。
- **资源结束**：关闭面板或切换会话后断开其 Observer、timer 与专属可取消请求，不关闭共享 SSE/Runtime。旧请求完成时必须校验会话身份，禁止把结果写进新会话。
- **验证**：故意使 Todo 或单个工具预览的渲染抛错，真实浏览器中检查 Answer、Composer 和另一槽位仍可操作；显式重试和换会话可以恢复。测试只豁免本次预期注入的错误，其余 `pageerror`/`console.error` 必须为零。


---

## 6. 五阶段正交 PR 实施计划（Step-by-Step Implementation Plan）

每个 PR 均保持独立可编译、测试全绿、可单独合并发布。

---

### PR 1：CSS `@layer` + `katex layer(base)` 收口与静态架构边界测试框架

**目标**：解决未分层 CSS 压制 Tailwind v4 工具类的问题，建立编译期依赖边界。KaTeX、Shiki、焦点和布局由真实浏览器行为验收，不保留仅为旧源码正则服务的样式排版。

**涉及文件**：
- Modify: `web/src/index.css`
- Modify: `web/src/components/AssistantChat/messages/TimelineTurnBlock.tsx`
- Create: `web/src/__tests__/architecture-boundaries.test.ts`
- Create: `e2e/css-layer-and-focus.spec.ts`
- Test: `web/src/components/SessionChat.test.ts`
- Test: `web/src/components/AssistantChat/HappyComposer.expandSelection.test.tsx`
**执行步骤**：
- [ ] **Step 1.1**：将 `web/src/index.css:2` 的 `@import "katex/dist/katex.min.css";` 改为 `@import "katex/dist/katex.min.css" layer(base);`；将 `index.css:93-146` 的 `.dark` 变量块归入 `@layer base`。
- [ ] **Step 1.2**：将 `web/src/index.css:148-904` 与 `914-1174` 中除 `@keyframes`、`@property` 外的组件选择器整体迁入 `@layer components { ... }`：
  - 保持 `.composer-floating-*` 的用户可见效果，删除只匹配 CSS 源码格式的测试；以 §8.4 的点击、键盘焦点与计算样式断言覆盖相同行为；
  - **严禁**对 `.turn-collapsible-shell[data-open="true"]` 等状态修饰符套用 `:where()`；仅对 `.aui-md` / `.markdown-content` 下的基础排版标签使用 `:where()`；
  - 保留 `index.css:711-714`（Shiki inline background 覆盖）与 `1131-1173`（`prefers-reduced-motion`）共 9 处存量 `!important`。
- [ ] **Step 1.3**：检查 `TimelineTurnBlock.tsx:1469` 与 `1765` 的回答正文包裹层，移除 `<MarkdownRenderer>` 外层多余的 `whitespace-pre-wrap`。
- [ ] **Step 1.4**：新建 `architecture-boundaries.test.ts`，以语法解析加 `path.resolve` 检查真实导入方向与 CSS 层边界，避免用源码子串/实现函数名锁死重构；为纯领域投影禁止 React、DOM、API/存储与功能 UI 依赖。既有宿主桥接点显式列出，新增豁免必须说明消费者与原因。
- [ ] **Step 1.5**：编写 `e2e/css-layer-and-focus.spec.ts`，运行 `bun typecheck`、`bun run test` 及 `PLAYWRIGHT_WEB_PORT=5184 bunx playwright test e2e/css-layer-and-focus.spec.ts`，在真实 Chromium 中验证点击输入框 `getComputedStyle(el).outlineStyle === 'none'`、普通按钮 `:focus-visible` 轮廓、KaTeX 公式字号与 Shiki 代码块透明背景。

---

### PR 2：收敛唯一 Todo 投影层 `projections/todoProjection.ts` + 剥离非主流程 Demo/死代码组件

**目标**：建立前端唯一的 Todo 数据归一化与乐观合并模块 `web/src/chat/projections/todoProjection.ts`（覆盖全部 10 个直接与间接消费文件），将 `TimelineTurnBlock.tsx:1634-2034` 的 Docked Demo 组件拆入 `TurnDockedWidgets.tsx`，清理 `TurnBlock.tsx:64-326` 的经典版 `TurnBlockView` 并同步更新 `TurnTimelineDemo.tsx` 与单测。

**涉及文件**：
- Create: `web/src/chat/projections/todoProjection.ts`
- Create: `web/src/chat/projections/todoProjection.test.ts`
- Modify: `web/src/components/ToolCard/checklist.tsx`
- Modify: `web/src/components/ToolCard/checklist.test.tsx`
- Modify: `web/src/chat/sessionStatus.ts`
- Modify: `web/src/chat/sessionStatus.test.ts`
- Modify: `web/src/components/SessionStatusPanel.tsx`
- Modify: `web/src/fork-features/task-panel/TodoPanel.tsx`
- Modify: `web/src/components/SessionChat.tsx` (`activeTodoText` 接入 `projectSessionTodoSnapshot`)
- Create: `web/src/components/AssistantChat/messages/TurnDockedWidgets.tsx`
- Modify: `web/src/components/AssistantChat/messages/TurnBlock.tsx`
- Modify: `web/src/components/AssistantChat/messages/TurnBlock.test.tsx`
- Modify: `web/src/components/AssistantChat/messages/TurnBlock.markdown.test.tsx`
- Modify: `web/src/components/AssistantChat/messages/TimelineTurnBlock.tsx`
- Modify: `web/src/components/AssistantChat/messages/TimelineTurnBlock.test.tsx`
- Modify: `web/src/components/AssistantChat/messages/TurnTimelineDemo.tsx`
- Modify: `web/src/__tests__/architecture-boundaries.test.ts`

**执行步骤**：
- [ ] **Step 2.1**：创建 `web/src/chat/projections/todoProjection.ts`，保持 `CanonicalTodoItem.id?: string` 可选，实现 `collectOmpTodoTurnContext`、`projectToolTodoSnapshot`（含 `block.tool.result == null` 时的同回合乐观增量合并）与 `projectSessionTodoSnapshot`（含 `activeForm` 提取、OMP Phase 过滤与 `blocked` 状态映射），编写 `todoProjection.test.ts`。
- [ ] **Step 2.2**：重构 `checklist.tsx`（内部委托给 `todoProjection.ts`，保留 `extractTodoChecklist`、`extractUpdatePlanChecklist`、`collectOmpTodoTurnContext`、`OmpTodoTurnContext`、`ChecklistItem`、`ChecklistStatus` 全部具名导出）、`TimelineTurnBlock.tsx`、`sessionStatus.ts`、`SessionStatusPanel.tsx`、`TodoPanel.tsx` 与 `SessionChat.tsx:1671-1677`。
- [ ] **Step 2.3**：将 `TimelineTurnBlock.tsx:1634-2034` 的 `DockedTodoProgressBar`、`DockedQuestionWizard`、`SubmittedQuestionSummaryBubble` 迁入 `TurnDockedWidgets.tsx`，并在 `TimelineTurnBlock.tsx` 中保留 `export { ... } from './TurnDockedWidgets'` 以兼容 `TurnTimelineDemo.tsx` 与 `TimelineTurnBlock.test.tsx:149-213`。
- [ ] **Step 2.4**：移除 `TurnBlock.tsx:64-326` 的经典版 `TurnBlockView`（保留 `TurnBlock.tsx:31-61` 的 `messageHasTurnActivity` 与 `MarkdownText`，清理 `TurnBlock.tsx:1-25` 中随之闲置的 unused imports），同步更新 `TurnTimelineDemo.tsx:1154-1160`、`TurnBlock.test.tsx` 与 `TurnBlock.markdown.test.tsx`。
- [ ] **Step 2.5**：在 `architecture-boundaries.test.ts` 中锁定 `todoProjection.ts` 为唯一的 Todo 状态解析入口，运行 `bun typecheck` 与 `bun run test`。

---

### PR 3：`toolPresentationManifest` + `TimelineTurnBlock` 三兄弟槽位拆分（`Rail` / `Todo` / `Answer`）+ `<FeatureErrorBoundary>` + `HappyChatContext` 动静分离

**目标**：引入 `toolPresentationManifest.ts` 与零额外 DOM 节点的 `<FeatureErrorBoundary>`，将每个子回合拆分为平级的 `<TurnExecutionRail />`、`<TurnTodoSection />`、`<TurnAnswerSection />`，抽离 `TimelineStepRows.tsx`，并在 `context.tsx` 中按 §5.4 拆分为 `HappyChatStaticContext`、`HappyChatTodosContext`、`HappyChatSessionStateContext` 与 `HappyChatHistoryContext` 四组细粒度 Context。

**涉及文件**：
- Create: `web/src/components/FeatureErrorBoundary.tsx`
- Create: `web/src/components/AssistantChat/messages/toolPresentationManifest.ts`
- Create: `web/src/components/AssistantChat/messages/TimelineStepRows.tsx`
- Create: `web/src/components/AssistantChat/messages/TurnExecutionRail.tsx`
- Create: `web/src/components/AssistantChat/messages/TurnTodoSection.tsx`
- Create: `web/src/components/AssistantChat/messages/TurnAnswerSection.tsx`
- Modify: `web/src/components/AssistantChat/context.tsx`
- Modify: `web/src/components/AssistantChat/messages/turnBlockModel.ts`
- Modify: `web/src/components/AssistantChat/messages/turnBlockModel.test.ts`
- Modify: `web/src/components/AssistantChat/messages/TimelineTurnBlock.tsx`
- Modify: `web/src/components/AssistantChat/messages/TimelineTurnBlock.test.tsx`
- Modify: `web/src/components/AssistantChat/messages/TurnBlock.tsx`
- Create: `e2e/turn-timeline-slots.spec.ts`
- Modify: `web/src/components/AssistantChat/HappyThread.tsx`（Provider 输入与真实回调依赖）
- Modify: `web/src/components/AssistantChat/messages/AssistantMessage.tsx`（细粒度订阅与轻量活动检测）
- Modify: `web/src/components/AssistantChat/messages/TimelineStepRows.tsx` 及其他实际 Context 消费者
- Conditional Modify: `web/src/lib/message-window-store.ts` 与 `.test.ts`（仅在回放证实持久化热点后，保留状态恢复契约）
- Create: `web/src/components/AssistantChat/HappyThread.context.test.tsx`
- Create: `e2e/streaming-isolation.spec.ts`、`e2e/feature-isolation.spec.ts` 及对应确定性回放 Harness
**执行步骤**：
- [ ] **Step 3.1**：新建 `toolPresentationManifest.ts` 实现 `classifyToolPresentation()`；在 `turnBlockModel.ts` 中实现稳定 `key`（锚定首个块 ID）的 `projectTurn()`，仅在已闭合的结构性轮次边界（`ContextCompaction` 或多轮合并边界）切分 `ProjectedSubturn`，前置过渡文本留在轨道内。
- [ ] **Step 3.2**：新建零额外包装节点的 `FeatureErrorBoundary.tsx`、行级渲染组件 `TimelineStepRows.tsx`（承接原 `699-1142` 行），以及三个平级全宽子组件：`TurnExecutionRail.tsx`（保持 `railRef` 与 `rowElsRef` 的 DOM 测量层级不变）、`TurnTodoSection.tsx`（`data-testid="turn-live-todo-cards"`）、`TurnAnswerSection.tsx`（`data-testid="turn-media-deliverables"` + 正式回答正文）。在 `TimelineTurnBlock.tsx` 中保留全部 7 个核心具名导出重导出。
- [ ] **Step 3.3**：按 §5.4 实际类型拆分四组 Context，稳定 Provider 分组值，迁移所有高频内部消费者；保留尾部活动判定与截断回合 Todo 兜底。消除重复分区，按真实呈现读取提取 metadata 依赖。同步更新消费者测试、Demo 与 Fixture。
- [ ] **Step 3.4**：落实 §5.7 的消息/槽位错误边界、显式恢复与资源清理，编写故障注入测试；不实现运行时插件系统、远端 UI 协议或预留没有消费者的 renderer 注册接口。
- [ ] **Step 3.5**：运行 §8.5 的定向流式回放和基线记录，验证文本、Todo、会话运行态与分页各自的订阅边界；若存储是热点，按 §5.6 有界合并持久化并覆盖终态、清除和恢复边界。不得修改跨端 reducer 输出或现有滚动状态机。
- [ ] **Step 3.6**：编写 `turn-timeline-slots.spec.ts`、`streaming-isolation.spec.ts` 与 `feature-isolation.spec.ts`，运行 `bun typecheck`、`bun run test`、`bun run gen:fixtures`（要求 fixtures 零差异），及独立端口下的对应 Playwright 用例和 `reasoning-sticky.spec.ts`。验证三槽位全宽、前序回答保留、Spinner 对齐、局部失败与恢复；测量结论必须记录输入规模和 trace，不能以测试全绿代替性能证据。

---

### PR 4：9-Flavor 模型控制器与 `SessionChat` / `HappyComposer` 解耦瘦身

**目标**：将 9 种 Agent Flavor 的模型/档位选择器收敛为 `useSessionFlavorModelController.ts` 与 `<ComposerSettingsSheet />`（完整保留 Claude/OMP/Cursor/Pi 四类特异交互），抽离 `sessionChatHelpers.tsx` 与 `useSessionVoiceBridge.ts`，并保持 `SessionChat.tsx`（14 个导出）与 `HappyComposer.tsx`（6 个导出）的 Facade 兼容。

**涉及文件**：
- Create: `web/src/components/AssistantChat/composer/types.ts`
- Create: `web/src/components/AssistantChat/composer/useSessionFlavorModelController.ts`
- Create: `web/src/components/AssistantChat/composer/ComposerSettingsSheet.tsx`
- Create: `web/src/components/AssistantChat/sessionChatHelpers.tsx`
- Create: `web/src/components/AssistantChat/useSessionVoiceBridge.ts`
- Modify: `web/src/components/SessionChat.tsx`
- Modify: `web/src/components/AssistantChat/HappyComposer.tsx`
- Create: `web/e2e-fixtures/composer-flavor-settings-fixture.html`
- Create: `web/e2e-fixtures/composer-flavor-settings-fixture.tsx`
- Create: `e2e/composer-flavor-settings.spec.ts`
**执行步骤**：
- [ ] **Step 4.1**：创建 `web/src/components/AssistantChat/composer/types.ts` 与 `useSessionFlavorModelController.ts`，内聚 9 种 Flavor 的模型/档位计算与级联回滚逻辑（含 Claude 非活跃会话自动开启 `resumeWithSessionModel`、Pi 切换模型自动修正失效 `effort` 与运行中不锁死模型按钮 `#1442`、OMP `onCycleModel`）。
- [ ] **Step 4.2**：创建 `ComposerSettingsSheet.tsx`，承接 `HappyComposer.tsx:1801-2278` 的设置弹层，完整保留 Claude 自定义模型输入框、OMP `<OmpModelRefreshRow />`（含空列表可打开重试）、Cursor 原地二级变体下钻（`data-testid="cursor-variant-back"`）与 Pi 复合主键选中态。
- [ ] **Step 4.3**：创建 `sessionChatHelpers.tsx`（承接 `SessionChat.tsx:1-518`，并在 `SessionChat.tsx` 中 `export { ... }` 重导出全部 14 个外部被引用符号）和 `useSessionVoiceBridge.ts`（承接 `SessionChat.tsx:1223-1313`）。
- [ ] **Step 4.4**：在 `HappyComposer.tsx` 中保留 `HappyComposer`、`type ComposerSendError`、`resolveVisibleModelEffortSelectedValue`、`composerParkSnapshotUnchanged`、`getComposerEscapeAction`、`type TextInputState`、`useRichComposerBridge` 全部具名导出；编写 `composer-flavor-settings-fixture` 与 `e2e/composer-flavor-settings.spec.ts`，运行 `bun typecheck`、`bun run test` 及 `PLAYWRIGHT_WEB_PORT=5184 bunx playwright test e2e/composer-flavor-settings.spec.ts e2e/composer-copy.spec.ts`。

---

### PR 5：`HappyThread` 模块化拆分（抽离嵌套滚动纯函数与分享长图 Hook）

**目标**：在不改变 `.happy-thread-messages > [id]` 扁平 DOM 结构与滚动锚定算法的前提下，抽离 `nestedScroll.ts` 与 `useShareTurnCapture.ts`，并在 `HappyThread.tsx` 中保留全部 21 个外部被引用具名导出。

**涉及文件**：
- Create: `web/src/components/AssistantChat/nestedScroll.ts`
- Create: `web/src/components/AssistantChat/useShareTurnCapture.ts`
- Modify: `web/src/components/AssistantChat/HappyThread.tsx`
- Test: `web/src/components/AssistantChat/HappyThread.test.tsx`
- Test: `web/src/components/AssistantChat/HappyThread.scrollLock.test.ts`

**执行步骤**：
- [ ] **Step 5.1**：将 `HappyThread.tsx:41-355` 的嵌套滚动检测纯函数抽离至 `web/src/components/AssistantChat/nestedScroll.ts`，在 `HappyThread.tsx` 中保留全部 21 个具名导出的 `re-export`（兼容 `HappyThread.test.tsx`、`HappyThread.pagination.test.tsx`、`HappyThread.mobile-scroll.test.tsx` 与 `web/e2e-fixtures/history-load-fixture.tsx`）。
- [ ] **Step 5.2**：将 `HappyThread.tsx:2218-2377` 的长图分享 DOM 采集、离屏克隆、Canvas 渲染与文件下载逻辑抽离至 `web/src/components/AssistantChat/useShareTurnCapture.ts`。
- [ ] **Step 5.3**：运行完整验证套件：`bun typecheck`、`bun run test`、`bun run gen:fixtures`（确认 `shared/fixtures/` 零 diff），以及 `PLAYWRIGHT_WEB_PORT=5184 bunx playwright test e2e/history-load.spec.ts e2e/session-scroll.spec.ts e2e/share-turn.spec.ts e2e/reasoning-sticky.spec.ts e2e/composer-copy.spec.ts`。

---

## 7. 三方对抗性评审台账（Adversarial Review Ledger: V3 -> V3.1）

| 评审方 | 编号与级别 | 发现的 V3 缺陷与真实代码证据 | V3.1 采纳的修正措施 |
| :--- | :--- | :--- | :--- |
| **SteadyReviewerV3** (`discuss:steady`) | **S-01 (Blocker)** | `SessionChat.test.ts:114-127` 与 `HappyComposer.expandSelection.test.tsx:183-188` 通过 `readFileSync('src/index.css')` 正则匹配 `.composer-floating-*` 选择器文本；改写 `:where()` 会直接挂单测。 | 保持 `.composer-floating-*` 选择器签名与首属性格式原样不变，仅整体缩进放入 `@layer components`。 |
| **SteadyReviewerV3** (`discuss:steady`) | **S-02 (Blocker)** | `index.css:2` 的 `@import "katex/dist/katex.min.css"` 未分层，把 `.aui-md` 迁入 `@layer components` 会导致 KaTeX 默认样式反超；一刀切禁 `!important` 会破坏 `index.css:711-714` 的 Shiki 行内透明背景。 | 将 KaTeX 导入改为 `@import "katex/dist/katex.min.css" layer(base);`，并显式豁免 Shiki（1 处）与 `prefers-reduced-motion`（8 处）共 9 处存量 `!important`。 |
| **SteadyReviewerV3** (`discuss:steady`) | **S-03 (Major)** | `TimelineTurnBlock.tsx:1272-1290` 依赖 `railRef` 与 `rowElsRef[idx].getBoundingClientRect()` 计算 Spinner 的 `translate3d(0, ${y}px, 0)`；若 `<FeatureErrorBoundary>` 增加外层 `<div>` 会破坏测量与位置断言。 | `<FeatureErrorBoundary>` 正常态直接返回 `children`（零额外 DOM 节点），且位于 `rowElsRef` 容器内部。 |
| **SteadyReviewerV3** & **DivergentReviewerV3** | **S-04 / D-01 (Blocker)** | 扁平 `FlavorControlField` 擦除了 Claude 自定义模型输入框（`HappyComposer.tsx:1954-1988`）、OMP `<OmpModelRefreshRow />`（`1844-1852`）、Cursor 二级变体原地 Drill-down（`1991-2056`）及 Pi `{ provider, modelId }` 复合主键与运行中不锁死特例（`1719-1722`）。 | 放弃弱类型动态表单解释器，改为强类型 `FlavorComposerControls` + 显式特异交互配置（`claudeCustomModelInput`, `ompRefreshConfig`, `drillDownVariants`, 稳定字符串 `key`）。 |
| **DivergentReviewerV3** (`discuss:divergent`) | **D-02 (Blocker)** | 流式阶段对工具前过渡文本（Preamble Text）切分 `ProjectedSubturn` 会导致轨道碎片化，且用数组下标作 `key` 会导致流式追加时 Remount 丢失用户手动展开/折叠状态（`TimelineTurnBlock.tsx:1159`）。 | 仅在已闭合的结构性边界（`ContextCompaction` 或多轮合并边界）切分 `ProjectedSubturn`，前置过渡文本留在轨道内；`ProjectedSubturn.key` 锚定首个块的稳定 ID。 |
| **DivergentReviewerV3** (`discuss:divergent`) | **D-03 (Major)** | 若同回合第二次 `todo` 调用报错时将 Todo 卡片从 `<TurnTodoSection />` 移回 `<TurnExecutionRail />`，会导致看板闪烁与高度跳变。 | `<TurnTodoSection />` 始终稳定展示最近一次有效/乐观合并的 Todo 快照；报错的 `todo` 调用仅在轨道内展示错误诊断行，不卸载顶部/平级看板。 |
| **SystemsReviewerV3** (`task:mid`) | **C-01 (P0)** | `todoProjection.ts` 漏掉了 `TimelineTurnBlock.tsx:551-585` 在 `block.tool.result == null` 时的同回合乐观增量合并契约。 | 在 `projectToolTodoSnapshot` 中显式支持 `previousTodoBlocks` 与 `fallbackTodos` 乐观增量合并。 |
| **SystemsReviewerV3** (`task:mid`) | **C-02 (P0)** | `CanonicalTodoItem.id: string` 设为必填会破坏无 ID 的 OMP DSL 解析、破坏 `scopeChecklistItemsByOmpPhaseId`（`checklist.tsx:246`）与无 ID 文本匹配（`TimelineTurnBlock.tsx:567,574`），并挂掉 `checklist.test.tsx:48,63,80,109`。 | 将 `CanonicalTodoItem.id` 修正为可选字段 `id?: string`，并在 `checklist.tsx` 保留全部兼容重导出。 |
| **SystemsReviewerV3** (`task:mid`) | **C-03 (P0)** | 遗漏了 `SessionStatusPanel.tsx:61-65`、`SessionChat.tsx:1671-1677` (`activeTodoText`) 及 `checklist.tsx` 的其余 4 个调用方（`turnBlockModel.ts:326`、`knownTools.tsx`、`TodoWriteView.tsx`、`_results.tsx`）。 | 将 `SessionStatusPanel.tsx` 与 `SessionChat.tsx:1671-1677` 纳入 PR 2，并在 `checklist.tsx` 保留全部 5 个具名导出。 |
| **SystemsReviewerV3** (`task:mid`) | **C-04 (P0)** | 直接删除 `TurnBlockView` 与 `Docked*` 组件会打断生产路由挂载的 `TurnTimelineDemo.tsx`（`App.tsx:36,420-421`、`e2e-fixtures/turn-timeline-demo.tsx:5`）、`TurnBlock.test.tsx` 与 `TurnBlock.markdown.test.tsx`。 | 将 `Docked*` 组件拆入独立的 `TurnDockedWidgets.tsx`（保留重导出），并在 PR 2 中同步更新 `TurnTimelineDemo.tsx`、`TurnBlock.test.tsx`、`TurnBlock.markdown.test.tsx` 与 `TimelineTurnBlock.test.tsx`。 |
| **SystemsReviewerV3** (`task:mid`) | **C-05 / C-06 / C-07 (P0/P1)** | `TurnBlock.tsx:329,355` 实际消费 `context.tsx` 的 `useOptionalHappyChatContext()` 并读取 `todos` 作为截断回合的 `fallbackTodos`；全仓有 28 个文件依赖 `context.tsx`；四大文件有 48 个外部被引用具名导出。 | 在 `context.tsx` 内部拆分 `HappyChatStaticContext`（补齐 `modelMode` 与 `jumpToMessageId`）与 `HappyChatTodosContext`，保留 `HappyChatProvider` 与四大文件全部具名导出的 Facade 兼容。 |

### 7.1 V3.2 对调研结论与旧方案的纠偏记录

| 旧结论或建议 | V3.2 处理与决定依据 |
| :--- | :--- |
| “Orca 的 atom 证明无全树更新/不会卡；PluginAppFailure 文件证明完整 ErrorBoundary” | 降为 §3.2 的源码示例与检索证据；性能和故障恢复必须在 HAPI 实测。 |
| “其他项目均没有内联 Todo，因此不会吞回答；HAPI 三槽位是唯一路径” | 不作穷尽判断。三槽位是保留当前产品交互的一项选择；外置面板是不同产品取舍，而不是错误设计。 |
| “Context 固定有 18 个字段，含 modelMode/jumpToMessageId；拆两组即可让所有消费者不改” | 以当前 `context.tsx` 为准拆分四组，并迁移实际消费者；不通过未使用的字段/兼容层维持错误接口。 |
| “轨道测量依赖 summaryText/answerText；handleShareTurn 没有 useCallback” | 当前代码与两项判断相反，删除相应修复项，见 §5.6。 |
| “静态测试要求原选择器排版/具名导出数量永远不变” | 实现时删除偶然源码格式断言，迁移内部调用方；保留用户行为与必要公共入口，见 §2、PR 1。历史 V3.1 台账保留为当时评审记录，不覆盖本版决定。 |
| “现在为 MCP Apps/AG-UI 增加任意元数据槽位优先路由” | 不采纳。工具元数据不是可信的布局/审批授权；没有实际消费者时不增加协议或抽象。 |


---

## 8. 独立端口与沙箱隔离开发测试方案（Zero-Disruption Dev & Verification Workflow）

为确保在 `hapi-answer-in-grid` 分支推进 PR 1 → PR 5 期间**绝对不干扰正在运行的 HAPI 服务与本机 Runner**，必须对端口、状态目录、SQLite 数据库、Runner 锁与浏览器 Origin 实施全链路物理隔离。

### 8.1 直接运行 `bun run dev` 的四类冲突风险（代码与实测证据）

1. **默认端口碰撞与错误反向代理**：
   - 本机 `c1` 上默认端口 `127.0.0.1:3006`（`pid=576967`）与 `0.0.0.0:5173`（`pid=1123545`）均已被占用（`ss -ltnp` 实测），且 `playwright.config.ts:3` 占用 `5179`；
   - `web/vite.config.ts:124,136-143` 默认将 `/api` 与 `/socket.io` 代理至 `VITE_HUB_PROXY || 'http://127.0.0.1:3006'`；`hub/src/configuration.ts:16` 默认监听 `HAPI_LISTEN_PORT=3006`。若不显式指定独立端口与 `--strictPort`，Vite 会静默漂移端口并把 API 请求错误转发到 `127.0.0.1:3006` 上的既有进程。
2. **`~/.hapi/settings.json` 与 `~/.hapi/hapi.db` 状态污染**：
   - `hub/src/configuration.ts:177-196` 默认使用 `HAPI_HOME=~/.hapi` 与 `DB_PATH=~/.hapi/hapi.db`，且 `loadServerSettings(dataDir)`（`hub/src/configuration.ts:5-6,192-196`）会将首次从环境变量读取到的配置自动持久化写回 `{HAPI_HOME}/settings.json`。若不覆盖 `HAPI_HOME`，开发态 Hub 会直接读写甚至覆盖本机生产 Runner 依赖的 `~/.hapi/settings.json` 与 `~/.hapi/hapi.db`。
3. **Runner 守护进程锁抢占与误连生产 Hub**：
   - `cli/src/configuration.ts:84,93,98-99` 默认读取 `~/.hapi/runner.state.json` 与 `runner.state.json.lock`。若在未隔离 `HAPI_HOME` 与 `HAPI_API_URL` 的情况下启动测试 Runner，会冲掉本机正在运行的 Runner 锁或误连生产 Hub（违反 `AGENTS.md` 铁律：`Never connect a test runner to the production hub`）。
4. **浏览器同源存储与 PWA Service Worker 串扰**：
   - `web/vite.config.ts:247-250` 开启了 `VitePWA` 的 `devOptions: { enabled: true, type: 'module' }`。`localStorage`（如 `hapi_access_token::<origin>`、Todo 面板折叠状态、FUE 引导状态）与 Service Worker 均按 `<scheme>://<host>:<port>`（Origin）隔离。固定使用专属端口 `5184` 并在 Playwright 中开启 `serviceWorkers: 'block'`，可彻底杜绝缓存串扰。

### 8.2 生产/默认环境 vs. 架构重构开发沙箱隔离参数对照表

| 配置项 / 环境变量 | 生产 / 本机默认环境（严禁触碰） | 重构分支专属开发沙箱（完全隔离） | 隔离作用与代码位置 |
| :--- | :--- | :--- | :--- |
| `HAPI_HOME` | `~/.hapi` | `/tmp/hapi-dev-rearch` | 隔离 `settings.json`、JWT Secret、VAPID Keys、`logs/` 与 `runner.state.json.lock`（`hub/src/configuration.ts:177`、`cli/src/configuration.ts:58`） |
| `DB_PATH` | `~/.hapi/hapi.db` | `/tmp/hapi-dev-rearch/hapi.db` | 隔离 SQLite 会话与消息表，支持 Fixture 脚本随时 `--reset` 重建（`hub/src/configuration.ts:187`） |
| `HAPI_LISTEN_HOST` | `127.0.0.1` | `127.0.0.1` | 仅绑定本地回环网卡，不向公网暴露测试端口（`hub/src/configuration.ts:15`） |
| `HAPI_LISTEN_PORT` | `3006`（已被占用） | `3106` | 独立沙箱 Hub 端口，避开 `3006` 冲突（`hub/src/configuration.ts:16`） |
| `CLI_API_TOKEN` | `~/.hapi/settings.json` 真实 Token | `hapi-dev-rearch-token` | 沙箱专用测试 Token，不读取或暴露真实凭证（`hub/src/configuration.ts:9`） |
| `TELEGRAM_NOTIFICATION` | `true` | `false` | 禁用 Telegram 告警推送（`hub/src/configuration.ts:11`） |
| `SERVERCHAN_NOTIFICATION` | `true` | `false` | 禁用 Server酱告警推送（`hub/src/configuration.ts:13`） |
| `HAPI_IOS_PUSH` | `relay` | `off` | 禁用 iOS APNs/Relay 推送连接（`hub/src/configuration.ts:25`） |
| `VITE_HUB_PROXY` | `http://127.0.0.1:3006` | `http://127.0.0.1:3106` | 将 Vite `/api` 与 `/socket.io` 代理指向沙箱 Hub `3106`（`web/vite.config.ts:124,136-143`） |
| Vite `--host 0.0.0.0 --port 5184 --strictPort` | `5173`（已被占用） | `0.0.0.0:5184`（强制 `--strictPort`） | 独立前端开发与 **Mac 浏览器常驻实时预览端口**，避开 `5173`（已占用）与 `5179`（Playwright 默认），支持 Tailscale（`100.123.160.102:5184`）与局域网（`10.202.2.224:5184`）随时点开预览，禁止端口自动漂移 |

### 8.3 Mac 浏览器常驻实时预览规约与三级递进测试工作流（防 Compact 遗忘铁律）

#### 核心规约：PR 1 → PR 5 全程保持 `0.0.0.0:5184`（Vite）+ `127.0.0.1:3106`（沙箱 Hub）常驻预览

为确保操作员在 Mac（`joeys-macbook-pro`）浏览器上**随时点开即可预览当前开发分支的实时界面**，即使后续对话发生 Context Compaction，所有执行回合也必须遵守以下常驻预览规约：

1. **Mac 浏览器免隧道直连地址（`Vite` 必须以 `--host 0.0.0.0 --port 5184 --strictPort` 启动）**：
   - **Tailscale 直连（推荐，跨网段随时可用）**：
     - 时间线、轨道与 Todo 交互预览页：`http://100.123.160.102:5184/demo/turn-timeline`
     - 完整沙箱 Web 应用（连接 `3106` 沙箱 Hub 与预置测试会话）：`http://100.123.160.102:5184/`
     - E2E 独立 Fixture 页：`http://100.123.160.102:5184/e2e-fixtures/turn-timeline-demo.html`、`http://100.123.160.102:5184/e2e-fixtures/scratchlist-fixture.html`
   - **局域网 IP 直连**：
     - `http://10.202.2.224:5184/demo/turn-timeline`
     - `http://10.202.2.224:5184/`
2. **Playwright 自动测试与 Mac 实时预览无冲突复用（`reuseExistingServer`）**：
   - `playwright.config.ts:46` 已配置 `reuseExistingServer: !process.env.CI`；当 `0.0.0.0:5184` 常驻运行时，执行 `PLAYWRIGHT_WEB_PORT=5184 bunx playwright test` 会直接复用正在运行的 `5184` Vite 实例执行真实 Chromium 点击、几何与样式断言，**测试结束后不会关闭 `5184` 服务**，Mac 浏览器标签页零断连且实时享受 Vite HMR 热更新。
3. **进程生命周期区分（常驻预览 Web/Hub vs. 即用即毁测试 Runner）**：
   - **保持常驻**：在 PR 1 → PR 5 开发与验收期间，沙箱 Hub（`127.0.0.1:3106`，数据目录 `/tmp/hapi-dev-rearch`）与开发分支 Vite（`0.0.0.0:5184`）保持后台常驻运行，**严禁在单次测试后将其误杀**；每次新回合或 Context Compact 恢复后，先检查 `:5184` 与 `:3106` 是否在线，若不在线立即按下方常驻命令拉起。
   - **即用即毁**：仅当 Tier 3 启动了 `cli` 测试 Runner 进程时，才受 `AGENTS.md`（`Any runner started for testing must be killed in place immediately after the test`）约束，必须在测试结束瞬间立即 `kill` 测试 Runner。

#### Tier 1 & Tier 2：启动/恢复 Mac 常驻预览服务（沙箱 Hub `127.0.0.1:3106` + Vite `0.0.0.0:5184`）

支持 **PR 1（CSS `@layer` 与聚焦框）**、**PR 2（`TurnDockedWidgets` / `SessionStatusPanel` / `TodoPanel`）**、**PR 3（`<TurnExecutionRail />` / `<TurnTodoSection />` / `<TurnAnswerSection />` 三槽位布局与 Spinner 坐标验证）**、**PR 4（9-Flavor 模型控制器与 `<ComposerSettingsSheet />`）**、**PR 5（`HappyThread` 滚动锚点与分享长图导出）** 的 Mac 随时预览与 Playwright 点击测试。

在 `c1` 上后台持久运行 `127.0.0.1:3106` 沙箱 Hub 与 `0.0.0.0:5184` Vite（供 Mac 浏览器随时点开访问、同时供 Playwright 自动复用）：

```bash
export HAPI_DEV_HOME="/tmp/hapi-dev-rearch"
export HAPI_DEV_TOKEN="hapi-dev-rearch-token"
export HAPI_DEV_HUB_PORT=3106
export HAPI_DEV_WEB_PORT=5184
mkdir -p "$HAPI_DEV_HOME"

# 1. 初始化/重置独立的沙箱 SQLite 数据库并灌入预置测试会话（含回放消息与 Todo 数据）
bun scripts/dev/seed-codex-web-fixture.ts --db "$HAPI_DEV_HOME/hapi.db" --reset

# 2. 启动完全隔离的沙箱 Hub（仅绑定 127.0.0.1:3106，由 5184 Vite 反向代理，禁用一切外部通知）
CLI_API_TOKEN="$HAPI_DEV_TOKEN" \
HAPI_HOME="$HAPI_DEV_HOME" \
DB_PATH="$HAPI_DEV_HOME/hapi.db" \
HAPI_LISTEN_HOST=127.0.0.1 \
HAPI_LISTEN_PORT="$HAPI_DEV_HUB_PORT" \
TELEGRAM_NOTIFICATION=false \
SERVERCHAN_NOTIFICATION=false \
HAPI_IOS_PUSH=off \
bun run dev:hub > "$HAPI_DEV_HOME/hub.log" 2>&1

# 3. 启动独立端口 Vite（绑定 0.0.0.0:5184 供 Mac 浏览器通过 Tailscale/局域网随时访问，API 代理指向 127.0.0.1:3106）
VITE_HUB_PROXY="http://127.0.0.1:${HAPI_DEV_HUB_PORT}" \
bun --cwd web vite --host 0.0.0.0 --port "$HAPI_DEV_WEB_PORT" --strictPort > "$HAPI_DEV_HOME/web.log" 2>&1
```

若仅需执行一次性无人值守全栈快照自检（不保留常驻进程），可复用仓库既有的 `scripts/dev/self-test-codex-web-env.sh`：

```bash
HAPI_DEV_HOME=/tmp/hapi-dev-rearch \
HAPI_DEV_TOKEN=hapi-dev-rearch-token \
HAPI_DEV_HUB_PORT=3106 \
HAPI_DEV_WEB_PORT=5184 \
ARTIFACT_DIR=/tmp/hapi-dev-rearch-artifacts \
bash scripts/dev/self-test-codex-web-env.sh
```

#### Tier 3（按需）：单次实时 Agent 会话接入沙箱 Hub（严禁触碰生产 Hub 与默认 `~/.hapi`）

当需要验证实时流式事件（如流式 `TurnTodoSection` 乐观合并或 OMP 模型列表刷新 RPC）时：
1. **必须同时显式传入 `HAPI_HOME=/tmp/hapi-dev-rearch`、`HAPI_API_URL=http://127.0.0.1:3106` 与 `CLI_API_TOKEN=hapi-dev-rearch-token`**，使 CLI 进程将日志与 `runner.state.json.lock` 写入 `/tmp/hapi-dev-rearch`，与 `~/.hapi` 下的真实 Runner 100% 隔离；
2. 严格执行 `AGENTS.md` 规定：**任何为测试启动的 Runner 必须在测试结束瞬间立即就地 `kill`，绝不残留后台测试 Runner，且绝不连接生产 Hub（`hapi.237575.xyz`）**。

### 8.4 对标 `yetone/magpie` 的 Playwright 真实浏览器点击、几何与计算样式测试矩阵（Playwright Click & Geometry E2E Suite）

#### 8.4.1 之前方案的缺口与为什么必须引入 Magpie 式 Playwright 点击测试

在 V3.1 补充本节之前，验证环节主要依赖 **Vitest + jsdom 单测** 与 **`read-hapi-web.mjs` 静态文本快照**。但对照 `yetone/magpie` 的前端验证体系，jsdom 存在三个根本盲区：
1. **jsdom 不计算真实 CSS `@layer` 级联优先级**：无法验证 `@import "katex/dist/katex.min.css" layer(base)`、`@layer components` 与 Tailwind v4 `@layer utilities` 在真实 Chromium 渲染引擎下的 `getComputedStyle()` 结果（如输入框聚焦黑框、Shiki 背景色、KaTeX 行高）；
2. **jsdom 的 `getBoundingClientRect()` 恒返回全 `0`**：无法在真实像素布局下验证 `<TurnTodoSection />` 是否真正脱离左侧轨道缩进并占满全宽、折叠轨道后前序子回合回答是否保持非零可视高度、以及流式 `.rail-step-spinner` 的 `translate3d(0, ${y}px, 0)` 是否与目标步骤行垂直居中对齐；
3. **静态快照不触发多步交互状态机**：Cursor 二级变体原地 Drill-down（点击父项不关弹窗 → 点击返回 → 点击子变体）、OMP 空模型列表点击打开并点击刷新、轨道步骤行点击展开 Level-2 详情与子代理树，必须通过 Playwright 真实鼠标点击（`locator.click()` / `page.mouse.click(x, y)`）与键盘事件（`page.keyboard.press()`）驱动。

#### 8.4.2 复用仓库既有 `playwright.config.ts` 独立端口 Fixture 架构

仓库根目录 `playwright.config.ts:3,40-49` 已原生内置与 `magpie` 相同的轻量级 E2E Fixture 架构：
- 通过环境变量 `PLAYWRIGHT_WEB_PORT=5184` 指定独立端口，Playwright 的 `webServer` 会自动拉起 `bun run --cwd web dev -- --port 5184 --strictPort`（仅挂载 `/e2e-fixtures/*.html`，无需连接生产 Hub，也不会触碰 `127.0.0.1:3006`、`0.0.0.0:5173` 或 `~/.hapi/`）；
- 已内置 `chromium` 的 `--no-sandbox` 启动参数（适配 Linux `c1` 环境），并存有 18 个存量 Spec（`e2e/*.spec.ts`）与 `web/e2e-fixtures/turn-timeline-demo.html`。

#### 8.4.3 四大 Playwright 真实点击与几何/样式测试套件（绑定 PR 1 → PR 5）

| 测试套件文件 | 绑定阶段 | 挂载目标页面 | 真实鼠标点击 / 键盘动作（Playwright Actions） | 真实浏览器断言（`getComputedStyle` / `getBoundingClientRect` / DOM 状态） |
| :--- | :---: | :--- | :--- | :--- |
| `e2e/css-layer-and-focus.spec.ts` (**新增**) | **PR 1** | `/e2e-fixtures/composer-copy-fixture.html` & `/e2e-fixtures/turn-timeline-demo.html` | 1. `locator('[data-testid="rich-composer-input"]').click()` 点击聚焦输入框<br>2. `page.keyboard.press('Tab')` 切换焦点至工具栏普通按钮 | 1. 断言输入框 `getComputedStyle(el).outlineStyle === 'none'` 或 `outlineWidth === '0px'`（零黑框回归）<br>2. 断言普通按钮 `:focus-visible` 保留非零轮廓<br>3. 断言 `.katex` 公式与 `.aui-md-codeblock pre`（`backgroundColor === 'rgba(0, 0, 0, 0)'`）在 `@layer components` 下样式正常<br>4. 全程 `pageerror` 与 `console.error` 计数为 `0` |
| `e2e/turn-timeline-slots.spec.ts` (**新增**) | **PR 2 & PR 3** | `/e2e-fixtures/turn-timeline-demo.html` | 1. 点击 `.turn-collapsible-shell` 顶部摘要栏切换折叠/展开<br>2. 点击 `TimelineTodoChecklistCard` 标题栏折叠/展开任务清单<br>3. 展开轨道后依次点击工具步骤行（打开 Level-2 Preview）、点击 `Task` 子代理聚合行展开子步骤树、点击 `Permission` / `AskUserQuestion` 操作按钮<br>4. 在多轮合并/Compaction 卡片上点击折叠第二轮工具轨道 | 1. **DOM 物理隔离**：展开与折叠态下，`rail.contains(todoCard) === false` 且 `collapsedRail.contains(todoCard) === false`，同一子回合内 `[data-testid="turn-live-todo-cards"]` 数量恒为 `1`<br>2. **全宽几何边界**：`Math.abs(todoCard.getBoundingClientRect().left - answerSection.getBoundingClientRect().left) <= 1`（证明 Todo 卡片未被轨道左缩进挤压）<br>3. **前序回答防吞噬**：折叠第二轮轨道后，第一轮正式回答文本 `toBeVisible()` 且 `boundingBox().height > 0`<br>4. **Spinner 坐标对齐**：流式卡片中 `.rail-step-spinner` 与当前 running 行中心纵坐标误差 `<= 2px` |
| `e2e/composer-flavor-settings.spec.ts` (**新增**) + `composer-flavor-settings-fixture.html` (**新增**) | **PR 4** | `/e2e-fixtures/composer-flavor-settings-fixture.html` | 1. **Cursor**：点击模型按钮打开弹层 → 点击多变体基座模型 → 点击 `[data-testid="cursor-variant-back"]` 返回 → 再次点击基座模型并点击子变体<br>2. **OMP**：在空模型列表态点击模型按钮 → 点击 `[data-testid="omp-refresh-models"]`<br>3. **Claude**：点击模型按钮 → 点击底部自定义模型输入框，键入 `claude-custom-sonnet` 并回车提交<br>4. **Pi**：在 `threadIsRunning=true` 状态下点击模型按钮 → 点击不支持当前 `effort` 的模型项 | 1. **Cursor**：点击父模型后弹层保持打开并渲染二级变体列表与返回按钮；选中子变体后弹层关闭且底部模型 Pill 文本更新<br>2. **OMP**：空列表时模型按钮仍可点击打开，点击刷新后展示新加载的模型项<br>3. **Claude**：自定义模型提交后更新选中态，且非活跃会话自动开启 `resumeWithSessionModel`<br>4. **Pi**：运行中模型按钮不被禁用（`#1442`），以 `${provider}/${modelId}` 精确高亮选中项，并在切换模型后自动重置失效 `effort` |
| 存量 5 个核心交互 Spec：<br>`e2e/reasoning-sticky.spec.ts`<br>`e2e/history-load.spec.ts`<br>`e2e/session-scroll.spec.ts`<br>`e2e/share-turn.spec.ts`<br>`e2e/composer-copy.spec.ts` | **PR 5** | 各自对应的 `/e2e-fixtures/*.html` | 1. 真实鼠标坐标点击 `page.mouse.click(x, y)` 折叠黏性 Reasoning 块与 `Show all (40 lines)`<br>2. 滚动触发向上翻页补页与锚点恢复<br>3. 点击分享回合按钮触发 DOM 克隆导出<br>4. `Ctrl+A` / `Ctrl+C` 跨消息复制与拖拽选区复制 | 1. `.happy-thread-messages > [id]` 扁平兄弟锚点在向上翻页后 `scrollTop` 零跳动<br>2. 嵌套滚动容器 `data-hapi-nested-scroll` 与外层视口滚动互不抢锁<br>3. 分享长图采集完整包含 User 与 Assistant 回合节点 |

#### 8.4.4 独立端口一键执行命令

```bash
# 在独立端口 5184 运行新增的三大重构点击契约测试 + 存量五大交互回归测试（全程不触碰 3006 / 5173 / ~/.hapi）：
PLAYWRIGHT_WEB_PORT=5184 bunx playwright test \
  e2e/css-layer-and-focus.spec.ts \
  e2e/turn-timeline-slots.spec.ts \
  e2e/composer-flavor-settings.spec.ts \
  e2e/reasoning-sticky.spec.ts \
  e2e/history-load.spec.ts \
  e2e/session-scroll.spec.ts \
  e2e/share-turn.spec.ts \
  e2e/composer-copy.spec.ts
```

### 8.5 定向流式回放、故障注入与性能证据（V3.2）

测试复用 `PLAYWRIGHT_WEB_PORT=5184` 的纯前端 Harness 和生产组件；外部请求全部拦截或由确定性 Fixture 提供，禁止连接生产 Hub。Harness 只负责输入事件与可观测计数，不复制生产的分区、Todo 解析或恢复逻辑。

| 回放/操作 | 消费者可见断言 | 证据与边界 |
| :--- | :--- | :--- |
| 固定 400/800 条历史消息，仅向尾部文本消息追加分片；其间点击历史工具预览、选择文本并输入草稿 | 尾部持续增长，预览和输入可响应；历史 Todo/工具行不因全量 Context 对象广播而重复更新。真实新工具、权限或模型变化仍正确更新。 | 固定事件顺序、文本字节数、分片速率、浏览器/视口和构建模式；记录 Profiler 消费者更新数、Performance trace、长任务与交互延迟。未采集这些数据前不填写改善数值。 |
| 仅变更 session.todos；再分别切换运行态、历史加载状态、工具呈现所用 metadata 字段 | TodoPanel 与当前回合兜底更新，已完成历史 Todo 保持对应快照；运行态/分页按各自订阅者更新；相关 metadata 仍反映到工具标题/路径。 | 用真实 Provider 和消费者测试，不以读取源码中是否有 useMemo/WeakMap 作为证明。 |
| 同一 live stream 被终态替代，随后插入迟到 live；切换会话、清除窗口后推进 timer 并刷新恢复 | 终态不回退，旧会话待写任务不污染新会话，已清除缓存不复活，刷新后可从 Hub/现有缓存流程恢复。 | 若 PR 3 改变持久化调度，必须补充这些状态转移回归测试；未改调度时沿用既有测试，不新增无意义的存储次数锁定。 |
| 在 Todo 槽位或某个工具预览注入已知渲染异常，点击重试，再切换会话 | 其他独立槽位、已渲染回答、消息列表与 Composer 可继续操作；错误只在明确动作后重置；旧请求不写入新会话。 | `feature-isolation.spec.ts` 仅允许本次已知注入错误，其余浏览器错误仍失败。 |
| 在固定宽度与窄屏下展开多行工具输出、改变字体/窗口尺寸、持续追加回答 | Spinner 仍与 running 行中心对齐，Todo 与回答左边界一致；文本增长不吞前序回答，不改变滚动锁/分页补偿语义。 | 复用 §8.4 几何断言与既有滚动测试；不删除已经正确的 Observer 或必要布局测量来换取低计数。 |

性能比较必须使用同一构建模式、数据集和操作序列，预热后重复回放并报告各次分布，不比较开发模式与生产构建的绝对数。自动化首要门禁是状态、隔离和交互语义；耗时阈值只有在固定运行环境的基线建立后才可设定，不能用未经测量的 FPS 数字作为完成条件。

```bash
PLAYWRIGHT_WEB_PORT=5184 bunx playwright test \
  e2e/streaming-isolation.spec.ts \
  e2e/feature-isolation.spec.ts
```


---

## 9. 验收清单（Acceptance Criteria）

- [ ] `bun typecheck` 零报错通过
- [ ] `bun run test`（cli + hub + web + shared，含新增的 `architecture-boundaries.test.ts`）全量通过
- [ ] `PLAYWRIGHT_WEB_PORT=5184 bunx playwright test`（含新增的 `css-layer-and-focus.spec.ts`、`turn-timeline-slots.spec.ts`、`composer-flavor-settings.spec.ts`、`streaming-isolation.spec.ts`、`feature-isolation.spec.ts` 及存量交互回归套件）在真实 Chromium 中全绿通过；除 `feature-isolation.spec.ts` 显式注入的预期故障用例外，全程零 `pageerror` / `console.error`
- [ ] `git diff shared/fixtures/` 为空（跨端协议 100% 兼容）
- [ ] 独立端口沙箱与 **Mac 浏览器常驻实时预览**验证（`HAPI_DEV_HUB_PORT=3106`、`HAPI_DEV_WEB_PORT=5184` 绑定 `0.0.0.0:5184`、`HAPI_DEV_HOME=/tmp/hapi-dev-rearch`）全链路通过：Mac 可随时通过 `http://100.123.160.102:5184/demo/turn-timeline`（Tailscale）或 `http://10.202.2.224:5184/demo/turn-timeline`（局域网）点开预览，Playwright 通过 `reuseExistingServer` 复用 `5184` 而不中断预览，且 `127.0.0.1:3006`、`0.0.0.0:5173` 与 `~/.hapi/` 零改动、零中断
- [ ] `katex.min.css` 归入 `layer(base)`，组件样式归入 `@layer components`；真实浏览器验证输入框/普通按钮焦点、KaTeX 与 Shiki。仅锁定 CSS 源码排版的旧断言已删除，不换一种排版重新锁定。
- [ ] `web/src/chat/projections/todoProjection.ts` 成为前端唯一的 Todo 归一化入口，支持 `result == null` 乐观增量合并、可选 `id?: string`、OMP Phase 过滤与 `blocked` 状态映射
- [ ] 展开态与折叠态下，`TimelineTodoChecklistCard` 均只渲染在平级的 `<TurnTodoSection />` 中（不掉入左侧竖线轨道，也不在轨道内外重复出现两次，真实浏览器 `getBoundingClientRect().left` 与回答区对齐），且截断回合的 `fallbackTodos` 兜底卡片正常工作
- [ ] 连续发送多条消息或发生自动 Compaction 时，前序子回合的正式回答始终保留在 `<TurnAnswerSection />` 中，绝不被折叠进后续工具轨道
- [ ] `<TurnExecutionRail />`、`<TurnTodoSection />`、`<TurnAnswerSection />` 与外围扩展面板均具备零额外 DOM 节点的 `<FeatureErrorBoundary>` 故障隔离，轨道 Spinner `translate3d` 像素偏移与 DOM 顺序断言 100% 通过
- [ ] §3.2 中每项外部机制明确标注源码、检索、文档或推断，不以插件目录、原子状态示例或 Star 数替代性能/容错证据；五个 PR 不新增运行时插件加载、第三方状态库或 MCP Apps/AG-UI 协议。
- [ ] Context 分组以真实 `HappyChatContextValue` 为准；文本、Todo、运行态、分页与 metadata 定向更新通过 §8.5 消费者测试，内部高频调用方不继续依赖全量 Hook。
- [ ] 局部故障、手动重试、换会话重置、Observer/timer 清理与迟到异步结果隔离通过测试；共享 SSE 不因局部面板卸载而中断。
- [ ] PR 3 的性能回放记录输入规模、构建模式、消费者更新数与 trace；报告只声称已测量的收益。若修改持久化调度，终态优先、防缓存复活与跨会话隔离回归通过。
- [ ] 文档修订阶段只修改本方案文件并交付修订版；源码、测试、Fixture、提交和部署均须等待后续明确的实施指令。上述实现验收项不得因方案写完而标记完成。
