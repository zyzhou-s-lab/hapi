# 验收后改进执行方案（2026-11-16）

依据：`2026-11-16-session-switch-performance-remediation-plan.md` 第 9 节与 `../evidence/2026-11-16-session-switch-acceptance.json`。用户授权“方案落盘，然后执行”；不授权 stage、commit、push、正式部署、服务重启、账号／会话创建或修改 CORS。

## 1. 已知事实与边界

- 当前 Vite dev／Chromium149 的 40 次暖切换：最长连续任务 A184／B159ms，100ms 门槛失败。首次正确尾部 rAF 观察不是精确 Paint、commit 或严格下界；150ms 正确目标 painted／interactive 仍未验收。
- 历史 React／persist profile 仅提供候选，不代表当前成本分布。entry-count admission 不是 CPU 预算，巨大单 entry 仍可能阻塞。
- 实施前退出缺口：scope／lifetime／Query admission 已实现，但凭据移除后 reload 不等于 UI 退出闭环；当时 `clearAuth` 无 UI 消费者，URL token 可重新触发认证。当前实施与验证结果见第 6 节，Telegram 保持独立语义。
- Mac 所测生产字体已通过，不重开。30 会话、第二账号／独立 Hub、serving Hub 不可变身份各自缺前提，分项阻断，不扩展调查。
- 保留用户已有脏改动、keyed chat、正文、草稿、订阅隔离、outline／历史定位、尾部跟随与同账号暖缓存。禁止池化／keep-alive／TTL／raw LRU／缩减 turns／裁正文／以 GET 阻塞有效缓存。

## 2. 性能小批次

1. 复用 A/B 与既有 5174，只做有界当前诊断，覆盖真实切换、tail 应用与后续 persist；RAM-only CPU／React 栈聚合，无真实消息正文、截图、录像或落盘 trace。历史数据不混为对照。
2. 按当前证据选择最小改动：重复 render／layout、巨大 entry 内部构造、或确定未变持久化字段的重复写入。不能凭旧比例选修复。
3. 持久化若命中，优先在已有字段变更点标脏，保留 owner／generation／epoch、pagehide／reload／退出正确性；不先 stringify／深比较去重，不把 timer 延后当修复。单快照仍超限则如实保留失败，不预承诺存储架构迁移。
4. 若有界诊断无明确可执行归因，停止盲改并记录具体未知项，不扩展场景矩阵。

## 3. 真实退出小批次

- Settings 中接入现有 `clearAuth` 与 scope／Query 边界，不另建认证层。
- mounted App 退出立即撤销身份并隐藏旧正文；迟到 GET／SSE／认证刷新不能恢复身份。
- 明确消费／移除当前 URL token，退出后 reload 不自动重入。保留同账号正常 refresh 暖缓存。
- Telegram 自动认证独立处理，不顺带改变其语义。
- 保留必要行为回归；实际独立浏览器使用表单登录、UI退出、reload验证，不使用自动认证 init script。

## 4. 验收方法与停止条件

- 150ms：冻结起点、正确目标、呈现／无副作用交互终点和误差，先做一次能力预检；不可证则保留未验收，不用 rAF／Event Timing／React commit 替代，不扩展测量工具链。
- 相关类型检查、回归及真实路径 smoke 后，每候选版本执行一批 40 次暖切换（各方向20，nearest-rank）；固定环境／数据、profilers off，≥2s after application，并确认相关 admission／待写任务完成，不把工作推到观察窗口外。全窗口检查错误正文／skeleton。
- 100ms 最长连续任务与 150ms painted／interactive 分别判定。失败后针对性修复才能启动新批次，禁止抽样挑通过结果。
- 修改 `web/src/chat/**`、`message-window-store.ts` 或 `sessionPatch.ts` 时运行 `bun run gen:fixtures`，不手改 fixtures；不提交。窗口改动覆盖 outline／展开／历史／锚点／窄屏；auth 改动覆盖 mounted logout／late auth／reload。
- 30 会话必须先有至少30个可实际导航的既有会话及固定观察标准；不足立即停止，不启动轮转／静置／heap归因，不创建会话凑数。
- 跨账号／独立 Hub：须真实第二账号、独立后端及正常安全策略下的访问路径；缺项停止，不关闭浏览器安全或全局放宽 CORS。
- Hub 身份：须 operator 的实例→不可变 digest→revision 只读证据；没有则保留未核验，不追 Web SHA／新接口／部署。

## 5. 交付

实现与必要回归、credential-free 元数据、README／fork ledger 更新；保留历史失败记录。本方案实施结果追加于下节，所有未观察事实不得标为通过。自有浏览器与临时工具收尾，既有 Vite／forwarder／SOCKS／Hub 不改动。

## 6. 首次执行记录

### 已实现：浏览器 Settings 退出

- Settings 顶部新增中英文“退出登录／Log out”，通过 `AppContext.logout` 调用既有 `clearAuth`；Telegram 自动认证不暴露此入口。沿用既有 auth lifetime、scope／Query admission，无第二套认证或缓存层。
- 当前 Hub 的 access token／password JWT 被清除；其他 Hub 凭据保留。URL token 在浏览器认证前消费，退出时再次移除；保留 pathname、其他参数、hash 与 history state。
- token／password 表单使用 layout-effect attachment lease：卸载或 Hub 改变后，迟到成功／失败不得重新发布凭据。正常同账号刷新及暖缓存语义不变。
- 父级审阅精确 auth／Settings diff；保留同文件内既有其他功能改动，未修改 source-control、窗口算法或持久化逻辑。

### 已运行的验证

```sh
bun run --cwd web test src/App.logout.test.tsx src/hooks/useAuthSource.test.tsx src/hooks/useAuth.test.tsx src/hooks/useAuth.scope.test.tsx src/fork-features/multi-user/LoginPrompt.test.tsx src/lib/message-window-scope.test.tsx
```

- **通过：6 文件／22 测试，Vitest 1.86s（命令 wall 2.37s）**。mounted App／真实 Settings 组件的 JSDOM 回归覆盖退出后旧正文消失、Query/raw window 清空、迟到 refresh 不恢复身份、重挂载保持退出与重新表单登录；另覆盖 URL token／其他 Hub 凭据、退役 token/password 表单、Telegram、scope 与同账号刷新暖缓存。
- 委派实现另报告 7 文件／24 测试通过；父级不将其与上述独立定向结果相加。
- **当时类型检查失败，未标通过**：委派运行 `bun run --cwd web typecheck` 报 `src/fork-features/source-control/GitDraftEditor.test.tsx:16` TS2739，`{}` 缺少 `Pre`／`Code`。当时该范围外脏文件未修改；不据此断言错误原本已存在。后续当前工作树的父级通过结果见第 7 节，不回写为当时通过。
- 本轮仅修改 auth／App／Settings／locale 与相关测试，不触发 chat／message-window-store／sessionPatch 的 fixture 再生成规则；历史 fixtures 证据不冒作本轮运行。

### 阻塞与未验收

- **性能当前诊断阻塞**：独立 Chromium149、1280×800、正常安全策略，现有私有 helper 凭据经 5174 真实 token 表单两次返回 401；同一凭据直接请求 `127.0.0.1:3006/api/auth` 返回 200/JWT，且确认预览请求使用相同凭据。0 个有效性能样本；原因未确定，不归咎 token。停止进程／端口／代理调查，不改服务或配置。
- 因无当前有效归因，本轮不修改性能代码，不启动 40 次候选验收；旧结果 **100ms 失败、150ms painted／interactive 未验收** 保留。
- **首次收尾时真实 Hub 浏览器 UI 退出→reload→relogin 未验证**。上述 mounted JSDOM 回归不是实机浏览器／真实后端端到端证明；当时未签完整认证链路通过。用户后续要求“验证，继续修改”后的限定浏览器验证见第 7 节。
- 第二账号／独立 Hub、30 个既有可导航会话及 serving Hub 不可变身份仍缺前提；不重开调查。Mac 字体已通过的限定范围不变。
- 自有诊断浏览器已关闭；无真实消息正文、截图、录像或 trace 留存。未 stage／commit／push／部署／重启，既有 Vite／forwarder／SOCKS／Hub 未修改。

## 7. 后续验证（2026-11-16）

### 当前类型契约与定向回归

- 当前 `GitDraftEditor` 已使用 `Pick<SyntaxHighlighterProps, 'code'>`，测试按 `code={code}` 调用。此轮检查前该契约已存在；不冒称由本轮修改，不覆盖同文件的其他 source-control 工作。
- 父级 `bun run --cwd web typecheck` **通过，wall 18.01s**；当前没有上述 TS2739。此结果限 Web 当前工作树，不代表 root／native／全脏树验证。

```sh
bun run --cwd web test src/fork-features/source-control/GitDraftEditor.test.tsx src/App.logout.test.tsx src/hooks/useAuthSource.test.tsx src/hooks/useAuth.test.tsx src/hooks/useAuth.scope.test.tsx src/fork-features/multi-user/LoginPrompt.test.tsx src/lib/message-window-scope.test.tsx
```

- **7 文件／29 测试通过，Vitest 2.01s**；包含 editor 行为及先前 mounted logout/auth/scope 回归。本轮未发现需要新增 runtime 修复的问题，未为类型检查补造 `Pre`／`Code`。

### 真实 Hub 浏览器退出闭环

- 入口为自有临时 Vite `http://127.0.0.1:5186`，仅进程环境指定 `VITE_HUB_PROXY=http://127.0.0.1:3006`，使用既有 Hub；未修改配置或现有 5174／Hub／forwarder／SOCKS。Chromium **149.0.7827.55**，1280×800，默认 Web 安全策略，service workers blocked，无 auth init script，无录像／截图／trace。
- 通过私有 helper 读取既有 token，在真实 API-token 表单登录，读取既有会话；不创建账号／会话、不发送消息／审批／删除。两次表单提交及认证生命周期共观察到 4 个 `/api/auth` 响应，均为 **200**。
- 结果记录时间 `2026-11-16T13:38:51.227Z`。仅保留下表计数／布尔值，无 token、JWT、账号标识或真实消息正文。

| 阶段 | Chat anchors | 已物化 entries | Raw storage keys | Scope owner 存在 | 当前凭据 keys | 登录输入框 |
|---|---:|---:|---:|---|---:|---:|
| 已登录并显示正文 | 9 | 3 | 1 | 是 | 1 | 0 |
| 点击 Settings Log out | 0 | 0 | 0 | 否 | 0 | 1 |
| Reload 后 | 0 | 0 | 0 | 否 | 0 | 1 |
| 再次表单登录并打开原会话 | 9 | 3 | 1 | 是 | 1 | 0 |

- 退出按钮真实可见且在 viewport 内；退出后等待 raw keys／owner 清空。Reload 后登录表单可见，观察到的自动认证请求数 **0**；重新登录后正文再次可见。四个阶段 URL 均无 `token` 参数；本轮未额外注入 URL token，URL 消费／其他 Hub 凭据／迟到 refresh 的受控边界仍由定向回归覆盖。
- 重新登录保留 `/settings` 路由，通过实际 Back 按钮返回列表再打开原会话；第一次错误等待 Settings 页的会话侧栏超时，不作为产品认证失败或额外样本。
- **限定通过**：真实 Settings 退出 → reload 保持退出 → 普通 token 表单重新登录及正文恢复。浏览器直接观察 DOM／storage；不冒作真实浏览器中的 Query 全对象、受控迟到 refresh／GET／SSE、跨账号或独立 Hub 的完整证明。
- 写保护阻止 **112 次 `POST /api/visibility`**，未放开其他 API 写入；page exceptions **0**，console error events **261**（未逐条归因，不能宣称控制台无错误）。此轮不是正常 visibility／通知语义或 PWA 验收，也不将 guard 产生的限制改成服务配置修复。
- 自有浏览器已断开；自有 5186 Vite 已 SIGTERM 停止（exit 143）。未留临时测试脚本、截图、录像或 trace；未 stage／commit／push／部署或重启现有服务。历史 warm／acceptance JSON 未改写。
- 此验证不复验 5174 的认证差异，不产生性能样本。既有 **100ms 失败、150ms painted／interactive 未验收**，以及 30 会话／第二账号／独立 Hub／serving Hub 不可变身份的外部条件均不变。
