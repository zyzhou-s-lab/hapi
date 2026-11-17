# 会话切换首屏性能整改方案

- 日期：2026-11-16。
- 对象：`hapi-answer-in-grid`，工作树 `fork-worktrees/answer-in-grid`；录屏入口 `http://10.202.2.224:5174`。
- 状态：待实施提案。本次只新增本文，不修改运行代码、原始消息、Hub 配置或部署状态。
- 目标：补齐“离开会话后重新进入”的性能路径，而不是继续仅优化组件驻留期间的增量更新。

## 1. 证据与未验证项

录屏 `Snapzy_Recording_2026-11-16_10-58-26.mp4` 共解码 820 帧，按实际 PTS 读取。8.400s 切换 URL、8.500s 正文清空、9.700s 目标正文变化；13.017s 切换 URL、13.050s 清空、14.550s 目标正文变化。两段空白／加载窗口约 1.2s、1.5s；URL 时间不是点击时间，不据此拆分 CPU／网络占比。

现场在同一入口重复 A→B→A→B，不清缓存。A 为 `00628dc6-6a7f-4d59-98d4-8bf6872d1628`，B 为 `44463dcc-0fb3-4a00-8f7d-2c2d3d8d8d97`。以下为相对真实 pointerdown 的暖切换数据：

| 指标 | A | B |
| --- | ---: | ---: |
| 缓存原始消息条数 | 325 | 317 |
| 切换附近连续 Long Task | 416ms | 362ms |
| 目标正文进入 rAF 的 DOM 检查点 | +419.4ms | +363.0ms |
| 消息请求开始 | +315.1ms | +245.6ms |
| 消息响应 firstByte | +509.7ms | +526.0ms |
| 消息响应体接收完成 | +939.3ms | +874.0ms |
| encodedBodySize | 643,039 bytes | 621,880 bytes |
| decodedBodySize | 2,568,360 bytes | 4,059,990 bytes |

结论：暖切换存在独立于本次消息响应等待的前端主线程成本；缓存正文在该响应首字节之前已进入 DOM。网络与 CPU 时间重叠，不能相加。rAF 检查点不是精确首绘，Long Task 不是调用栈。

现场为 Linux Chromium、1280×800、Vite 开发模式，不等同于原 Mac 浏览器。真实 API 链路是 Vite → 本机 3006 转发器 → SOCKS5 → 远端 Hub，不是旧 3016 Hub。录屏历史提交和远端运行版本尚未锁定。冷 B 响应体完成时点的完整输出未保留，不采用 `+799ms`，也不拿早期 rAF 近似值做冷加载阶段归因。

**尚未验证：**同步归约、React 挂载、Markdown、样式／布局／测量分别占多少 CPU；远端是否运行已有分页字节预算代码；单个大轮次是否触发预算例外。不得将 Toast、字体或某个 reducer 写成已证实根因。

## 2. 与已有整改的关系

本文补充端到端暖切换，不重写此前的消息语义或分页协议。

| 已有文档／实现 | 本次缺口 | 处理方式 |
| --- | --- | --- |
| [11-10 Loading 性能与生命周期方案](2026-11-10-loading-performance-and-lifecycle-correction-plan.md) | 已覆盖数据应用、增量归约、首次挂载等问题；不能据文档存在认定暖切换已验收。 | 复用其身份、依赖闭包、不可变快照规则，只补会话间生命周期。 |
| [11-12 分页与 runtime bypass 方案](2026-11-12-pagination-stuck-loading-and-runtime-bypass-plan.md) | 已提出 8 turns、字节预算、agent-run 压缩和屏外占位；当前远端响应仍有数 MB。 | 先核验运行版本和预算例外，不再机械降低 turn 数，不重复实现压缩。 |
| [11-13 性能测试规范](../specs/2026-11-13-chat-performance-benchmark-spec.md) | 主流程是冷打开、上滚补页、稳态采集，没有连续暖切换阶段。 | 在原规范增补暖切换场景和正确性门禁，不建立第二套性能平台。 |

当前代码已确认的边界：

- `web/src/components/SessionChat.tsx:23–26`：`SessionChatInner` 按 `sessionId` 设置 `key`。
- `web/src/components/sessionChatHelpers.tsx:435–454`：新实例创建 `SessionEntityStore`，render 内同步 `reconcileInput()`；延迟通知不等于延迟计算。
- `web/src/chat/store/sessionEntityStore.ts:694–715`：规范化 WeakMap、归约前缀／timeline 缓存属于 Store 实例。
- `web/src/components/sessionChatHelpers.tsx:457–489`：当前 ingestion bridge 订阅 Query 与消息窗口，卸载时取消订阅。
- `web/src/components/AssistantChat/HappyThread.tsx`：高度和屏外条目集合属于当前实例，首挂后测量，再计算屏外占位。
- `web/src/lib/message-window-store.ts:1338–1423`：原始窗口保留，但激活仍进入 tail sync／latest 刷新。

**[INFERENCE] 推荐排查顺序：**新建派生 Store 的重复计算 → 首挂组件与测量 → 后台刷新后的二次应用。P0 的调用栈决定各改动包是否必要，不预先宣称占比。

## 3. 设计边界

1. 保留 `SessionChatInner key={sessionId}`，继续隔离草稿、composer/runtime、scratchlist、视图状态和订阅；不以删 key 换速度。
2. 复用原始消息窗口、`SessionEntityStore`、现有归约器和现有虚拟化。禁止第二套简化 reducer、隐藏聊天 DOM 的无限 keep-alive、通用插件／调度框架。
3. 新增生命周期策略放在 fork-owned 的 `web/src/fork-features/session-switch-cache/`；现有 pipeline、会话激活和线程渲染保留最小接入点。模块内只缓存现有 Store／测量成果，不复制消息语义。
4. 框架状态缓存与消息正确性分开：草稿、权限、工具结果、乐观确认、取消、rewind、分享、复制、大纲、历史补页不能遗漏或串会话。
5. 缓存失效必须可解释，回退调用现有完整路径；不静默复用不匹配的窗口，也不以旧会话正文假装新会话已就绪。
6. 不先改 TTL、延迟对账、引入 Worker 或设计新 REST 协议。只有 trace／远端核验支持时才另行扩大改动范围。

## 4. 改动包与执行顺序

### P0：建立暖切换调用栈基线

目标是确定连续长任务的构成，不继续重复录屏扫描或浏览 React 私有 Fiber。

- 固定 A/B 数据快照、提交及未提交补丁标识、前端构建模式、Hub 版本、代理路径、浏览器、视口、字体就绪和展开状态。
- 在现有浏览器性能工具中记录实际输入、选中反馈、请求开始／首字节／完成、目标正文 DOM、渲染帧、loading 分支和主线程栈。DOM 与 Paint 分列；没有 Paint 证据时标注不可用。
- 临时计时覆盖 `reconcileInput()` 的有效计算、React commit、初次高度测量，以及 latest 响应应用。计时不得序列化全部消息，不输出消息正文或凭据；不建设常驻遥测系统。
- 先各打开 A、B 一次，再连续 20 轮 A→B→A，得到 40 次暖切换。冷打开单列；试次不能每次新建 Browser Context。
- 再覆盖缓存淘汰后的进入、后台收到消息后的返回、快速 A→B→C。归约工作与真实可见结果同时记录。

**出口：**有可归属调用栈的阶段表；不能只交 Long Task 数量。若 Store 计算不是主要成本，不实施 P1 的缓存扩展，直接处理 trace 指向的挂载／布局路径；性能验收标准不因此缩减。

### P1：复用派生结果，保留 UI 会话隔离

适用条件：P0 证明重复建立派生 Store 是有意义的切换成本。

**推荐方案：有界保留已有 `SessionEntityStore`，不保留整个 React 子树。** 初始容量为当前活跃会话加最近两个非活跃会话，容量是拟定值，不是已验证的内存结论。

可变 Store 复用必须先满足下述提交与订阅协议；若现有契约无法安全支持，优先评估不可变派生快照复用，不直接池化可变实例。P1 不是 P0 后的默认步骤，首挂测量占主导时可以只执行 P2。

#### 所有权与激活

- 缓存 owner 归属于当前 Hub／认证上下文；键为 `scope + sessionId`。scope 使用现有认证主体与上下文 generation，不保存 token／JWT，不以 sessionId 单独做全局键。
- 正常单活跃场景最多 3 份 Store；有有效消费者的 Store 不得被 LRU 驱逐。出现多个有效消费者时保护在用实例，回收非活跃项，不强行释放在用对象。
- 非活跃 Store 仅保留派生快照与算法缓存，不保留 Query／消息窗口订阅、DOM、ResizeObserver、定时器或用户事件订阅。保留的原始消息引用计入内容规模预算；后台消息仍走既有原始窗口入口，不为每个缓存项另开后台归约。
- cache hit 不能直接等于 ready：激活时对齐当前客户端已有的一致窗口、epoch、窗口操作连续性、session metadata／agentState、thinking 和显示偏好，完成本地对齐即可展示，不等待本次 GET；本次请求继续后台对账。跨 epoch 不拼接旧派生结果。使用已有版本／引用／generation，禁止每次 render 对消息做 `JSON.stringify`。
- 输入完全一致时直接复用；只有 metadata／显示偏好变化时走已有对应更新；消息操作连续时用原增量能力；epoch 变化、窗口重置或操作断档时明确走原完整重放。
- WeakMap 命中依赖对象身份，不能由保留 Store 推定省掉计算。分别测量未变输入、后台追加、响应重建对象／窗口替换的规范化与归约工作；激活对齐若抵消收益，不启用该缓存。不能仅凭消息 ID 判定内容未变。
- 对保留中的 Store，激活准备与失效对齐放在明确的激活生命周期中，React render 只读取稳定快照；不得在 render 中修改一个其他消费者可见的共享 Store，也不得从 render 通知订阅者。
- 新建且尚未发布的实例可以私有初始化；未提交／取消的渲染不得把该实例变成长期缓存项。`deferNotifications` 不可用作共享 Store 并发安全的替代品。
- 激活 generation 与 scope 同时校验。快速切换、旧请求完成、StrictMode 重挂不能把迟到结果附到当前会话或错误认证上下文；清理旧订阅必须先于新实例接管。
- 每个缓存键只有一个有效写入租约；旧 Bridge／请求回调必须校验租约代次。读取快照与接回订阅采用“订阅后重读版本并对齐”的交接协议，防止漏更；未提交 render 不得发布或污染缓存。验收覆盖 StrictMode、被放弃的 render 和快速 A→B→A。

#### 失效与释放

| 事件 | 行为 |
| --- | --- |
| 正常 A→B→A，A 输入未变 | 复用 A 的派生 Store，重新挂载 UI／runtime 并接回唯一 ingestion bridge。 |
| A 非活跃期间窗口更新 | 返回时先对齐；不能将旧权限／运行状态作为最新状态发布。 |
| epoch／窗口重置、rewind、移除消息 | 根据现有操作语义重建或修正派生快照及高度信息；删除实体不可残留。 |
| Hub／账号切换、退出登录、清理会话数据 | 整个旧 scope 同步失效，取消相应激活；不能等 LRU 自然回收。 |
| 删除会话 | 驱逐该会话的 Store 与测量项，迟到请求不得复活缓存。 |
| LRU 淘汰 | 取消引用并清除对应测量缓存；再次进入允许现有冷建路径，不影响原始消息。 |

复用前审计 Store 持有的回调、QueryClient、偏好和外部资源。缓存容量不能证明堆内存有界：同一实例可能持有巨型派生树，必须通过保留路径检查确认释放。不要为测容量新增每帧的序列化／深拷贝。

除会话数量外，必须设置保留内容／派生实体规模预算；阈值根据 P0 样本与 retained heap 固定并写入基准，未定值前不得启用缓存。单个实例超预算时只服务活跃消费者，离开后不保留；不得从 REST 解压字节推算派生堆占用。

| 缓存 | 身份与责任边界 | 失效／释放 |
| --- | --- | --- |
| 原始窗口 module Map | 既有 `message-window-store` 所有；不是新增派生缓存 | 沿用现有窗口与认证生命周期；实现前核对 scope 清理，不能由新 LRU 代替。 |
| 派生 Store／快照 | 新 owner，`scope + sessionId`，独占写入租约 | scope、删除、epoch／操作连续性和规模预算按本节处理。 |
| 高度预测 | P2 所有，scope／session／entry／布局签名；可独立于 P1 启用 | 内容或布局变化纠偏，scope／会话删除时释放，单独限制条目数。 |

**出口：**未变化的暖返回不重复做整窗规范化／归约；后台变化可正确追平；Store 缓存没有引入跨账号、跨会话、幽灵订阅或历史通知重放。若 P1 单独达到最终门槛，P2 只处理仍被 trace 证实的残余，不进行无收益重写。

### P2：让现有虚拟化覆盖首挂

适用条件：P0／P1 后的 trace 仍显示首挂组件或布局测量是主要剩余成本。

- 继续使用 `HappyThread` 当前条目、锚点与高度占位，不换一套虚拟列表库。
- 保留有界的每会话高度结果；P1 未执行时独立提供最小测量缓存，不为此引入 Store 池。键必须包括 scope、session、entry 稳定 ID、内容／布局版本、主聊天栏宽度、字体度量与相关展开状态。仅以 entryId 或浏览器窗口宽度判定有效不够。
- 使用有效高度与当前入口意图，在首次挂载前决定初始范围：尾部进入挂载尾部可见区和既有 overscan；返回历史位置或大纲跳转则围绕目标锚点挂载。不能总先跳到底再拉回。
- 高度始终是预测，不是定位真值；缓存未命中也须在首次 render 选择有界尾部／目标范围，不能等全挂后再裁剪。字体、异步图片、高亮、侧栏宽度、内容和展开变化继续实测纠偏并保持锚点，不截断内容。
- 大纲／搜索跳转采用“解析目标 → 估计定位 → 挂载目标附近 → 测量纠偏”的流程；历史页尚未到达时沿用现有补页与取消语义，快速切换取消旧定位，不能为精确定位挂载沿途全部条目。
- 补页、流式高度变化、用户主动向上滚动与初始 pinning 必须保持原有正确性。占位保留稳定锚点；复制／分享读取完整消息数据，不能从当前挂载 DOM 截取正文。
- 外层窗口化不能解决单个巨型 turn 内部的挂载成本。只有 trace 证实后，再在现有 execution rail／工具折叠边界做按需挂载；与同目录 `2026-11-16-execution-rail-information-hierarchy-plan.md` 协调，不重复改信息层级或重写 Markdown。

**出口：**有效缓存暖返回不先全挂再裁剪；挂载范围受可见区／overscan约束。巨型单条目、字体失效、历史定位和补页仍完整可用；不能用 DOM 数量下降单独宣布通过。

### P3：核验大响应来源，保留尾部对账

这条工作线不作为暖首屏优化的替代。

1. 对真实远端 Hub 记录运行版本，并核对旧方案中的字节预算、agent-run 快照压缩是否进入当前 REST 路径。工作树代码存在不等于远端已部署。
2. 对 A/B 只记录页行数、encoded／decoded 字节、最大行规模和轮次边界，不导出正文。区分旧 Hub、压缩路径未执行、单轮次／单行超大等情况。
3. 若只是运行版本不一致，报告为部署前置条件；本方案不授权发布、重启生产 Hub 或启用工作流。
4. 若已有实现仍突破预期，先修既有预算／压缩的执行路径和边界测试。`8 turns` 不作体积保证，`1MiB` 不作为未核验的硬 SLA；不能为达字节目标静默丢弃轮次内容或终态。
5. 暖返回继续立即展示版本一致的缓存正文，刷新作为独立后台状态。非空缓存不能仅因 refetch 进入整屏骨架；确实缺失或失效时允许诚实的 loading。
6. 保留当前 tail sync、SSE reconnect、in-flight 去重和 generation 保护。不添加无新鲜度证明的 TTL 跳过策略，不用关闭请求来美化首屏数字。

**出口：**每个大响应有实际版本／数据形态解释；已有正确性不变。若需要新的截断／懒取协议，单独评审并取得范围批准，不能塞入本次前端缓存改动。

## 5. 预计文件边界

下表为实施目标，不表示这些文件已经修改，也不要求无条件创建每个模块。

| 位置 | 计划职责 |
| --- | --- |
| `web/src/fork-features/session-switch-cache/` | P1/P2 所需的有界派生 Store、scope 生命周期及测量缓存；不承载新的 reducer。 |
| `web/src/components/sessionChatHelpers.tsx` | 接入缓存所有权与激活对齐，维持单一 ingestion bridge；移除被替代的每次新建路径，不保留双轨开关。 |
| `web/src/components/SessionChat.tsx`、现有认证／Hub 生命周期入口 | 保留 key；必要的 scope 传递、失效和消费者释放。认证入口实施前沿现有 provider 定位，不另建认证系统。 |
| `web/src/chat/store/sessionEntityStore.ts` | 仅在需要时补齐复用／释放所需的最小生命周期能力；保持既有快照和归约语义。 |
| `web/src/components/AssistantChat/HappyThread.tsx`、现有滚动控制器 | P2 的首挂窗口、测量复用和锚点定位；不顺带重排聊天 UI。 |
| `web/src/lib/message-window-store.ts`、`hooks/queries/useMessages.ts` | 仅在 P0/P3 证据需要时接入原有版本／失效和后台刷新状态，不预先改变分页协议。 |
| 现有 `e2e/`、`web/e2e/` 中实际适用的测试项目 | 沿既有发现规则扩展真实会话切换 smoke／回归，不创建第三套浏览器入口。 |
| 11-13 benchmark spec、`web/README.md`、fork ownership／trunk-patches 清单 | 实施后补暖切换口径、实际缓存合同和最小主干接入理由。 |

## 6. 验证与验收

### 6.1 性能门槛

以下是**拟定验收目标，不是已达到结果或线上 SLA**。先固定相同环境复测当前代码，再比较同条件改动；开发与生产构建分列，Mac 原浏览器至少做一次实机复核。

- A/B 数据和显示条件固定，各打开一次后执行 20 轮 A→B→A，共 40 次暖切换，保留原始值；P50／P95 使用升序样本的 nearest-rank，不能只展示最好一次。另测 A/B/C/D 淘汰重入与巨型单 turn，不混入该场景分位数。
- 有效缓存、输入未变场景：pointerdown 到正确会话的目标可见区实际绘制且可交互 P95 ≤150ms；DOM 提交、rAF 和 Paint 分列。此目标不要求远端新数据在 150ms 内到达；只有 DOM 采样时不能宣布通过可见首帧门槛。
- 首屏与响应应用分别测量。切换相关最长连续主线程任务 ≤100ms，覆盖首次展示及随后响应应用；观测至少延续到首屏绘制后 2s，并覆盖本次响应应用后 2s。记录二次长任务与交互反馈，不得把重计算后移到首屏之后就宣布通过。
- 无数据变化的暖切换不整屏闪骨架，不展示错会话正文；真正冷建／失效不要求零 loading。
- 后台有变化、缓存淘汰后的进入、冷开、历史补页分别报告，不混入未变化暖切换分位数。已有冷开／补页／持续流基准不得出现超出重复运行噪声的回退。
- 访问 10、30 个不同会话并做堆保留路径检查：正常单活跃下派生 Store 至多 3 份，非活跃订阅为 0，无遗留 DOM／observer；区分已有原始窗口缓存和新派生缓存的占用，不能把前者的增长归给后者或反过来。
- 若目标未达，保留失败和 trace，继续处理已定位成本；不能自行放宽阈值或删掉慢会话。

### 6.2 功能与并发门禁

- A/B 不同草稿、scratchlist、队列、工具展开、权限请求和滚动位置各自正确；发送／审批只作用于当前会话。
- A 非活跃时发生 SSE 更新、工具终态、乐观确认、移除／rewind；返回后结果与原完整归约一致，无旧实体残留。
- epoch 重置、消息窗口裁剪／replace、操作断档、SSE 断连重连、请求失败及重试均能恢复；不因缓存阻止原恢复路径。
- A→B→C 快速切换、迟到响应、StrictMode、卸载后再进入：无重复订阅、通知、写入或错误 scope。
- Hub／账号切换、退出、删除会话后不能看到旧正文或复活旧缓存。
- 历史补页、上滚取消 pinning、大纲／搜索跳转、字体加载、侧栏宽度变化及窄屏仍保持锚点与完整内容。
- 通知去重与历史事件静默不变，保留中的派生 Store 不得导致历史拒绝／系统事件再次弹 Toast。

永久测试只覆盖以上消费者可见的边界和转换；不测内部 Map 命名、转发调用次数或源码字符串。性能采样优先复用现有浏览器基准，临时探针不进入运行代码。

### 6.3 工程检查与执行顺序

1. P0 固定基线和调用栈；据结果选执行包，保留所有最终验收项。
2. 按 P0 定位选择最小改动包：Store 重建占主导才执行 P1；首挂占主导可直接执行 P2。每包单独验证收益、隔离和内存代价，只有剩余瓶颈需要时才叠加另一包。
3. P3 单独记录远端版本和负载；协议或部署变化不与前端缓存收益混算。
4. 运行相关 Vitest 和真实浏览器 smoke，执行仓库 `bun typecheck`；提交前按仓库流程执行完整测试与 pre-push review。
5. 改动 `web/src/chat/**`、`message-window-store.ts` 或 `sessionPatch.ts` 时运行 `bun run gen:fixtures`，保留生成差异；不得手改 `shared/fixtures/**`。相关生成结果按原流程触发原生一致性检查。
6. 验证通过后更新现有 README／benchmark／ownership 文档，移除被替代路径与临时探针，不留兼容别名和双实现。

真实数据只读；需要发送、审批、rewind 等动作时使用隔离测试会话／快照。不得把测试 runner 接到生产 Hub，任何测试 runner 用完立即停止。本方案不执行提交、发布或生产部署。

## 7. 2026-11-16 执行记录与未通过门禁

**已实施 P2；未宣布完整性能验收通过。** P0 有限调用栈中 `reconcileInput` 约 6–7ms，主要可归属成本为 React 首挂／JSX 构建，故未实施 P1 Store 池。原先“全部挂载、测量后再隐藏历史”的路径已替换为先分支占位、再按可见区渐进挂载。没有移除 `SessionChatInner key={sessionId}`，没有修改 REST 分页、尾部刷新或订阅所有权。

实际边界：`web/src/fork-features/thread-windowing/useThreadEntryWindow.ts` 持有当前 Store 实例本地高度 Map；未知高度 300px、overscan 600px；≤3 项全部首挂，否则仅最后两项首挂；每帧最多补两项普通条目。`HappyThread.tsx` 在构造历史组件之前选择稳定 ID 占位；滚动控制器显式 materialize 目录目标，并在会话／导航失效时拒绝旧定位。测量变化保留 tail-follow 或可见锚点偏移；宽度变化使历史估高失效。目录目标在等待挂载期间被移除会完成取消；该回归先观察到 2s 超时，修复后通过。

验证记录：

| 项目 | 实际结果 |
| --- | --- |
| 相关 Vitest | HappyThread 59、滚动控制器 22、SessionChatIsolation 3、SystemMessage 2，共 86 通过 |
| 类型检查 | 全工作区 cli／web／hub／relay 通过；最终 controller／夹具变更后 web 再次通过 |
| `bun run --cwd web build` | 通过；存在字体相对 URL 未在构建期解析的警告，未据此声称生产字体运行时已验证 |
| 浏览器锚点／分享／目录／412×915 窄屏 | `thread-scroll-anchors.spec.ts` 两例通过 |
| 侧栏滚动隔离 | `session-scroll.spec.ts` 七例通过 |
| 迟到消息请求 | 延迟 B 请求，A→B→A 后释放，最终 A 路由／尾部一致且仅一聊天线程 |
| 历史分页 | 夹具改为 canonical turns:8 与 Store-backed HappyThread，删除已不存在的行数上限断言。随后暴露快速 tail sync 先结束、invalidated 补页后结算的 re-arm 竞态；完成后显式 coverage 重查，定向回归由失败到通过。最终 history 12／锚点 2／侧栏 7，共 21 例全部通过 |
| fixture 生成 | 本 P2 包未改 `web/src/chat/**`、`message-window-store.ts` 或 `sessionPatch.ts`，不触发新的原生 fixture 生成；不手改 shared fixtures |

关闭 profiler 后 40 次真实暖切换原始元数据、方向统计、三个同条件 GC 轮次见 [benchmark 实测段](../specs/2026-11-13-chat-performance-benchmark-spec.md#六暖切换首挂窗口实测2026-11-16) 与 [JSON 证据](../evidence/2026-11-16-session-switch-warm.json)。A/B DOM P95 为 194.1／146.0ms，随后的 rAF P95 为 298.6／299.7ms；DOM／rAF 均不能替代 Paint／交互。两方向仍有 >100ms 任务，**150ms Paint／交互与 100ms 连续任务目标未通过，不放宽阈值**。外层窗口不能限制巨型单条目的内部渲染成本，不能未经证据改写并行中的 execution rail。

同一组 10 个会话重复三轮后 DOM／监听器计数稳定，JS 堆仍增长；未取得保留路径或 30 个不同会话证据，不作无泄漏结论。本包不保留非活跃 Store，因此原拟“三份派生 Store LRU”合同未启用。账号／Hub 切换、真实退出、删除会话、后台 SSE／rewind／乐观确认、字体加载及 Mac 实机／生产构建性能门禁尚未完整覆盖；认证 init-script 重新登录使清 storage 退出尝试无效，已排除。P3 远端 Hub 版本和大响应来源仍未核验，不能用本地代码证明已部署预算生效。

下一步仅处理剩余已定位成本及上述未通过门禁，不重扫录屏、不继续扩展一次性探针、不引入 Store 缓存／TTL／新分页协议。本次不提交、不发布、不重启 Hub，不启动生产测试 runner。

收尾：独立性能浏览器／CDP 已关闭；自建 Playwright 临时配置、结果目录、重复采样 JSON 和展示 HTML 已移入 Trash，长期元数据保留于上述 evidence 文件。向同一执行 mentor 发出的 debrief 连续两次因 `Pi transport closed during status reset` 未能运行；未取得新的复盘结论，不记为最终复核通过，未重启服务或更换 provider 绕过失败。

## 8. 续轮验证（2026-11-16）

### 局部侧栏优化

`SessionItem` 使用默认浅比较 `memo`；router 的选择回调使用 `useCallback([navigate])`。保留 `lastSeenVersion`、完整回调依赖、context、内部菜单状态和外部订阅更新；没有自定义比较器、render-phase ref 写入或跨会话 Store。不可据此假定只重渲染两行。

侧栏三文件 88 例通过，新增 consumer 回归覆盖 immutable 标题／选中状态更新、最新选择 handler、`beforeSelect` 顺序和旧 handler 不调用。回归使用现有行的 Enter 键激活合同，不为合成 `click` 改写生产输入语义。一次同环境暖 A 的改后 profile 未采到 `SessionItem` 栈；此前该栈 inclusive 26.381ms。采样未出现不等于零成本，单次差异不构成净节省或 P95 证据；不再扩展 CPU profile 调查。

### 保留路径与隔离

独立检查访问 23 个会话并卸载聊天后，发现 23 个 raw-window 由 `GC root → module context → states Map` 保留，property-reachable 数据约 87MB；这不是 exclusive retained size。卸载后高度 Map 为 0，1 个 `SessionEntityStore` 经 `Query → closure/context` 保留；未观察到每访问一次便新增一个派生 Store 的池。不能据此声称 Store 立即释放、30 会话或长期稳态通过。

后台 final、乐观 ACK、取消、rewind、删除的隔离 smoke：B 未混入 A，返回 A 的消息／blocks／timeline／outline 与全量重建一致；相关既有七文件 170 例通过。另一个 consumer 负向场景确认真实缺陷：旧 scope 写入后卸载、清 QueryClient，再以新 scope 的同 sessionId 挂载且 GET pending，仍能读到旧消息。仅清 QueryClient 不足以隔离模块 RAM／sessionStorage；该证据不冒充完整真实账号／Hub／退出 UI 链路。

修复复用 `${baseUrl}|${user.id}` 身份，以 `MessageWindowScopeProvider` 的 layout-effect admission boundary 在新消费者挂载前切换 RAM／sessionStorage owner 并清 Query cache；render 不写共享 Store。同 scope 的普通 ApiClient 重建／token refresh 不清暖缓存；初始 pending auth 不销毁匹配 owner 的刷新恢复数据，已认证 scope 离开或退出则退休旧缓存。独立 lifetime 阻止旧 tail／history、SSE、queued reconciliation、send／cancel／retry 和旧 controls 回写，包括 A→B→A 与 StrictMode detach/remount；未引入 LRU、TTL 或派生 Store 池。

scope 定向八文件 168 例通过；`bun run gen:fixtures` 成功生成 48 chat、12 SSE、12 pagination 和 modes catalog，tracked fixtures 无差异。子任务曾报告六处 Web 类型诊断；父任务修正新增侧栏测试的 nullable metadata spread 后，最新 `bun run --cwd web typecheck` 通过（18.32s），侧栏定向用例 1/1 通过；不将其它并发诊断的消失归为本次修复。

额外运行一次独立 Chromium 合成页面 smoke，使用真实 scope provider／useMessages／QueryClient，禁止所有 `/api/**` 请求：账号 B 的同 sessionId 在 GET pending 时为空，释放已退休的 A tail 不回填，旧 Query 数据清除，同 scope 换 client 保留 B 暖窗口，退出后 RAM 展示和持久化 owner／窗口均清除；browserErrors 为空。该 smoke 不是完整真实 Hub／账号／登录退出 UI 验收。浏览器已关闭、临时页面已删除；没有新增服务或连接 Hub。

### 生产字体、Mac 与远端响应

此前 build 成功不代表字体可用：未改写的 dist CSS 仍引用不存在的相对文件；Source Serif 与 KaTeX 请求 404，Linux 实际使用 Caladea／Liberation Serif，Mac 使用 Iowan Old Style／Times。字体运行时门禁由“未核验”改为“已确认失败”，不能压制警告或用计算 font-family 当作字体已加载。

修复仅改 `web/postcss.config.cjs`：`'@tailwindcss/postcss': { optimize: false }`，保留 imported declaration 的源位置供 Vite 重写 URL；最终 CSS 仍由 Vite 压缩。未移动 imports／cascade layers，未复制字体或改写 KaTeX 覆盖规则。一次 production build 产出字体，71 个本地字体引用均有文件；原始 dist-only 浏览器加载 Source Serif normal／italic、KaTeX Main／Math／Size2 五个请求全部 HTTP 200、FontFace loaded，CDP 显示实际 webfont。行内数学 16.64px、分式 14.144px、长公式容器内横向滚动及响应式 utility 保持。修复后运行时证据仅覆盖 Linux Chromium，未复跑 Mac 字体验收。

实际 Mac arm64 独立 Chrome 147.0.7727.56、1365×900，使用本地 production dist 和既有远端 API，四次真实切换的点击前→观察到渲染上界为 1777／1397／245／496ms，最长任务为 82／228／61／110ms；各会话尾部 hash 一致，始终一份聊天线程。上界包含自动化／CDP 调度，不是纯 click-to-paint 或正式 P95；110ms 暖任务仍超过 100ms。

远端 Web `/changelog.json` 自报 `v0.29.0-fork.55`／`c82066b0006bb37584ef3be890cb338080d3a66d`，asset 为 `index-BdH6VHoW.js`；`/health` 仅返回 protocolVersion 1，无 Hub SHA。四份 `turns=8` 页中三份内容总量超过 1MiB，单行均低于预算，已排除单行超大保留例外；gzip 返回有效。旧 Hub 或预算路径未执行仅为推断，不能以 Web SHA 证明 Hub 版本，也未部署本地分支关闭差距。

本轮继续保留 150ms painted/interactive P95、100ms 最长任务门槛，尚未通过。生产字体 Linux 运行时、scope 定向回归与合成浏览器边界验证已通过；真实账号／Hub 登录退出全链路、修复后 Mac 字体、30 会话／长期内存稳态仍未验收，不以局部 memo 或正确性修复替代整体性能结论。

## 9. 剩余门禁复验（2026-11-16）

用户重新要求验收后，仅运行指定剩余检查；未扩展优化、部署或修改服务。第 7／8 节保留历史结果，本节不与旧轮样本合并。当前 40 次原始时间元数据与定义见 `../evidence/2026-11-16-session-switch-acceptance.json`；不含凭据、消息正文、截图、录像或 trace。

### 暖切换：仍不可签收

Linux Chromium 149.0.7827.55、Vite dev 5174、1280×800，无 profiler／trace，各方向 20 次真实指针切换。目标检查包含 route、尾部 ID／文本 hash、非 placeholder、聊天 viewport 相交；统计采用 nearest-rank。

| 毫秒 | A | B |
|---|---:|---:|
| 首次 rAF 检查观察到正确尾部 P50／P95／max | 169.3／181.7／187.4 | 113.0／122.7／134.5 |
| Event Timing 交互下一次呈现 P95 | 208 | 152 |
| 观察窗口内最长任务 P95／max | 179／184 | 154／159 |

100ms 连续任务门槛明确失败。150ms painted／interactive 门槛不签收：Event Timing P95 超过 150ms，但它不证明该呈现已包含正确异步目标；rAF 目标就绪观察也不是精确 DOM commit、Paint 或其严格下界。未获得正确目标 Paint／可交互时间，不将 B 的 122.7ms 当作达标。

每次在目标就绪及实际加载 Store 的 tail-sync true→false 后均继续观察至少 2100ms；两方向最短响应应用后观察为 2101.7／2102.4ms。该通知包含网络与通知等待，不是纯响应 CPU。Event Timing threshold 为 16ms，40 份均有记录。就绪前采样未见空白／错误尾部，0 page errors；就绪后不再逐帧检查内容，不能宣称全观察窗口无瞬态错误。首次探针误导入另一份未带 timestamp 的 Vite 模块，未产生有效样本，已排除；未再次归因或优化。

### 真实认证边界：局部通过，全链路未完成

无自动认证 init script 的独立浏览器通过实际 token 表单登录，`POST /api/auth` 返回 200。移除该浏览器凭据并实际重载后，聊天条目为 0、raw 持久化窗口由 1 变 0、owner 为 null；这是 credential-removal／reload smoke，不是 mounted UI logout。

Settings 未找到退出操作，`clearAuth` 在 `web/src` 没有消费者。真实 Hub selector 可切至 `http://127.0.0.1:3006`，但登录被 CORS 阻断：响应缺少 `Access-Control-Allow-Origin`，请求 `net::ERR_FAILED`，界面显示 `Failed to fetch`，旧聊天为 0。该地址仍是同一个后端，不是独立 Hub；未建立第二真实账号凭据。因此跨账号／独立 Hub／UI 退出链路保持未验收，不把传输失败当作 token 拒绝或隔离通过。

### Mac 字体：所测生产资产字形通过

实际 macOS 15.6（24G84）Chrome 147.0.7727.56，独立临时 headless profile，直接使用既有 rebuilt dist 的 CSS／字体，无 rebuild 或 node_modules fallback。CDP platform-fonts 确认 Source Serif normal／italic 各 24 字形、KaTeX Main 14 字形、Math italic 3 字形均使用对应 custom webfont：65／65、fallback 0，4 份 WOFF2 均 HTTP 200，无字体请求失败、page／console errors。

所测 `/assets/index-C02zZCKk.css` 为 169318 bytes，SHA-256 `f41130bb131140337a7e254903a89cb9c47ad5819457862c2e6fffcfa9a07f45`。通过范围是 production selectors／assets 的字形 fixture，不是完整 Mac UI、所有字形或 Mac 性能验收。已关闭自有 Mac Chrome、CDP 与 SSH tunnel，临时资料移入 Trash。

### Serving Hub 身份：仍缺运行时证据

既有 3006 转发的 `/health` 为 200／protocolVersion 1，根入口为 200，但没有 build revision／identity header。监听 PID、SOCKS、Web fork.55／c82066b0 均不证明 serving Hub 的不可变身份；现有 SSH 配置没有目标运行环境入口，local PATH 无 km。缺少将 `100.64.170.85:3006` 的运行进程／容器绑定到不可变 executable／image digest 及 build revision 的只读访问或元数据，保持未核验；未部署、重启或修改 CORS。

### 内存：完成 20 会话有限观察，不满足 30 会话／长期门槛

同一 mounted App 中实际导航的 sidebar 集合为 20 个不同会话，每轮 21 次导航并回到同一 control，共 3 轮；观察到列表会话 ID 共 22 个，不足 30。0 次 document reload，所有轮次尾部均已挂载。以下每点均先静置、再执行两次 GC；轮间静置约 2000ms，末次静置 300001ms，实际有效测量区间 438535ms。不能把等待／探针准备时间算成长期观察，也不能把 20 会话结果签为 30 会话通过。

| 采样点 | used JS heap bytes | MiB | DOM nodes | listeners | derived Store／inactive |
|---|---:|---:|---:|---:|---:|
| baseline | 59627076 | 56.86 | 2821 | 1022 | 1／0 |
| round 1 | 172420996 | 164.43 | 2896 | 1028 | 1／0 |
| round 2 | 171821164 | 163.86 | 2896 | 1028 | 1／0 |
| round 3 | 173548920 | 165.51 | 2896 | 1028 | 1／0 |
| post-round idle | 172317752 | 164.34 | 2896 | 1028 | 1／0 |

各点均为 2 documents、1 viewport、9 entry anchors／3 rendered entries；所枚举 inactive derived Store 及其订阅均为 0。轮 1 之后未观察到 DOM／listener／derived Store 累积，不证明无限期稳态或无泄漏。最终 RAM-only snapshot 计数为 22 raw-state objects、1 derived Store、80 Query、151 QueryObserver；这些类型不可互换，也未计算 exclusive retained bytes。live observer targets 均 connected 只排除本次观察到的 detached target，不独立证明全部非活跃会话 observer／callback 为 0；额外 Query 所有权检查失败，保留为缺证，不继续扩展归因。

该内存浏览器页面为 5174，认证 helper 指向 3006；因跨域 fetch 失败，独立内存浏览器关闭了 CORS 限制，因此只作内存观察，不能作真实认证／跨 Hub 边界证明。有效运行拦截了 676 次 `POST /api/visibility`，不是正常可见性写入链路验收。已尝试默认侧栏、活动日期控件及缺失 ID 搜索，API 列出 22 个 ID、可导航侧栏仅 20 个，其中一个缺失 ID 搜索为 0；未创建会话／账号补数。静置等待 300001ms，含双 GC／终点采样为 301650ms。自有浏览器与 context 已关闭，CDP detached，snapshot 已从内存丢弃；没有保存 heap／消息内容、截图、视频或 trace，没有源代码修改或新增脚本。

本轮仅增加本节与 credential-free 原始元数据。100ms 明确失败，150ms 不签收；Mac 所测生产字体通过，真实认证全链路、30 会话／长期内存、serving Hub 不可变身份仍缺证。既有 Vite／forwarder／SOCKS／Hub 未改动，无 staging、commit 或正式部署。
