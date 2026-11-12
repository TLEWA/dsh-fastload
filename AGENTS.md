# AGENTS.md

本仓库是一个 DSH 插件。开工前先读仓库的 `README.md`；通用流程与检查项看中心仓的
[PROCESS.md](https://github.com/TLEWA/dsh-plugin-ci/blob/v1/PROCESS.md) 与
[docs/gates.md](https://github.com/TLEWA/dsh-plugin-ci/blob/v1/docs/gates.md)。本文件只强调
本类仓库最容易出错的点。

## 插件的硬性约束

- `package.json` 必须有顶层 `engines.dsh`；写在 `dsh.engines.dsh` 会被忽略。
- `dsh.manifestVersion` 必须是 1，`dsh.bundle.patch` 必须指向真实存在的
  `cordis.patch.yml`。
- `cordis.patch.yml` 里 `insert[].name` 必须等于包名；`id` 是用户可见的短名，不要随意改。
- `dsh.client.inject` 只允许 `@deepseek-ai/*`；本仓库没有客户端依赖，保持 `[]`。
- 本仓库没有构建步骤：`index.js`、`client.js`、`src/**` 都是直接运行的源码。不要新增
  build 步骤，也不要把 `client.js` 改成打包产物或生成物。
- 发布必须走 tag + `release.yml`；本机 `npm publish` 由 `prepublishOnly` 拦截，不要绕过。

## 本仓库专属

`dsh-fastload` 缩小长会话**首次**打开时的历史页，但不改变尾部可见内容。宿主端
`index.js` 包装 `sessionController.follow`；Web 端 `client.js` 在首屏过短时点一次内置
“加载更早”。

### 宿主端不变量

- 只处理没有 `beforeSeq` / `throughSeq` 的初始页；“加载更早”、跳转和 live 更新必须原样通过。
- 显式更小的初始页必须尊重，除非 `DSH_FASTLOAD_FORCE=1`；stock 的 500 才是改写目标。
- `maxMessages` 是硬上限，`minTurns` 是目标而不是硬下限；一个 turn 自身超过上限时允许在
  turn 内切。
- 字节裁剪只能在 `turn/start` 处切；至少保留最新 `minTurns` 个完整 turn；软预算为
  `maxBytes * 0.97`，受保护 turn 超过软预算但不超过 `hardCapBytes` 时保留，超过硬上限则整页不动。
- 裁剪后必须设置 `hasMore: true`；不要删除历史，只缩小首屏。
- 包装必须幂等：`__dshFastload` 防重复；插件禁用时 `follow` 完全不变。
- 空闲预热（`DSH_FASTLOAD_IDLE_CACHE_REFRESH`，默认关闭）只能用只读
  `follow({ activate: false })`：不激活 Agent、不写 session store、不改原始日志；刷新请求
  必须带内部标记，绕开页缓存读取且不计命中；真实收益未测量时不得写进文档当作事实。
- 预热构建前后都要校验 `sessionPersistence.stat` 的 revision 与缓存 key，不一致就丢弃，
  不得把旧页写到新 revision；同一 session 去重、全局并发 1，Agent 运行或 Host 事件循环
  延迟时推迟；卸载/禁用时必须清 timer、监听并 abort 在飞构建。
- 延后真实 follow（`DSH_FASTLOAD_DEFER_LIVE_BUILD`，默认开启；`=0` 关闭）只能在缓存确实
  命中、初始页、`activate !== true`、无进行中的流式 attempt 且 Agent 已知空闲时生效；无法
  判断状态一律不延后。0.2.2-rc.1 的真实点击带 `activate=true`，因此点击路径实际不生效，
  只覆盖 `activate:false` 的被动请求（预热/恢复），最多 16 ms。
  同 session 新请求、abort、Agent 转忙、卸载都必须取消未执行的延后；延后出错回退原时序，
  且绝不能让 opening 协议出现第二个 snapshot。`DSH_FASTLOAD_DEFER_LIVE_BUILD=0` 时时序、
  字节、日志必须与阶段 3 一致；`timing` 诊断只在 `DSH_FASTLOAD_DEBUG=1` 下采集。
- 配置非法值必须回退到默认值；`maxBytes` 大于 0 时有 64 KiB 下限。

### 客户端不变量

- 只补齐一次：每个挂载的 transcript 最多自动翻一页，不能变成通用自动分页。
- 必须点 transcript 自己的 “Load older” 按钮，不要直接调用 `session.loadOlder()`；前者会走
  `ChatNavigation.loadEarlier()` 的视口锚点补偿。
- 只在 `scrollHeight <= clientHeight + 16` 时补齐；已可滚动就跳过，最新内容已经在底部。
- 只处理拥有 `data-slot="conversation.chat.flow"` 的 transcript；跳过
  `data-step-process-content` 的 reasoning/tool-step 内嵌节点。
- 保持现有节奏常量：首轮 900ms、重试 700ms、最多 8 次、输入空闲 1500ms；用
  `data-fastload-autoloaded` 去重；卸载时必须清理 interval、timer 和事件监听。
- 客户端只在 web 平台加载；不要引入 DOM 虚拟化或缓存，这些是明确不做的范围。
- 诊断层默认关闭：只有 `localStorage['dsh-fastload.diagnostics'] === '1'` 或
  `window.__DSH_FASTLOAD_DIAGNOSTICS__ === true` 时才遍历 Fiber、做深度
  conversation/assembler/Builder 快照、保留日志数组、包装 `console.error`、挂载
  `window.__DSH_FASTLOAD__`、注册仅诊断用的 timer；原型 patch 还要同时打开
  `dsh-fastload.debug`。诊断代码不得拆成第二个文件（每个包只加载一个 `client.js`），
  用函数边界与同一个 disposer 隔离；关闭与开启两种状态下都必须清理干净。
- 启动预热默认关闭且与悬停开关极性相反：仅
  `localStorage['dsh-fastload.restore-prewarm'] === '1'` 或
  `window.__DSH_FASTLOAD_RESTORE_PREWARM__ === true` 时运行。必须先从
  `ctx.get('uiWorkspace').selection` 拿到取消信号，拿不到就跳过，不得裸跑；
  取消时只 abort 本插件 restore 来源的 `AbortController`，不得触碰原生 follow 流；
  不写 `dsh.sessions.current`，也不向正式 Session Store 写预热快照。

### 私有接口与能力检测（阶段 8）

- 本插件只使用 DSH 的插件面（`ctx.inject` / `ctx.get` / `ctx.on` / `ctx.effect` /
  `ctx.remote`）和实测存在的服务形状。所有私有访问必须在调用点做 `typeof` 能力检测；
  缺失、抛错或未知枚举值一律走保守分支，不得把异常抛给宿主，也不得因为“看起来像”就
  启用侵入优化。当前实测基线是 DSH 0.2.2-rc.1（`bench/.tools/dsh022`）。
- `sessionController.follow`：注入后检查 `sc && typeof sc.follow === 'function'`；
  缺失时只写 `state.error`，不安装包装。安装前用 `target.__dshFastload` 防重复；
  dispose 只在 `target.follow === wrapped` 时还原自己的描述符，否则说明已被别的插件
  再包装，停用并原样透传。
- `sessionPersistence.stat`：页缓存、空闲刷新和延后构建共同依赖它的 revision。
  只有 `c.get('sessionPersistence')` 且 `typeof stat === 'function'` 时才创建页缓存；
  缺失或抛错就跳过缓存并继续 live，不影响 follow 原路径。
- `agents` 服务：`c.get('agents')`（或 `ctx.agents`）是可选的；`get(sessionId)`
  返回 `undefined`/`null` 表示没有 Agent（idle）；服务缺失、`get` 抛错、`agent.status`
  不是 `running`/`idle` 一律记为 `unknown`。只有确证 `idle` 才允许延后真实构建。
- `session/event`、`agent/status`、`session/disposed`：优先 `ctx.on`，其次 `c.on`；
  拿不到事件 API 就关闭空闲预热并写入 `state.idleRefresh.disabledReason`。每个监听器的
  off 函数必须保存，并在 dispose 时调用。
- follow 请求形状（`activate`、`assistantStream`、`beforeSeq`/`throughSeq`、`signal`）：
  只依据已观测字段判断，缺字段按“不满足优化前提”处理；不得假设未观测字段存在。
- Web 端 `ctx.get('uiWorkspace')`：`mainReference.sessionId` 与
  `selection.subscribe` / `selection.getSnapshot` 都是可选的。启动预热在任一缺失、
  订阅失败或等不到选择信号时跳过，不得裸跑。
- Web 端 `ctx.remote.session.follow`：悬停与启动预热都先经 `remoteSession()` 检测；
  缺失时记 `prewarm.error='remote.session.follow is unavailable'`，不发起请求。
- `localStorage` 读取统一包 try/catch（隐私模式或禁用存储），失败按默认值；只写诊断/
  调试偏好，不写 `dsh.sessions.current`。
- 页缓存 `lookup` / `store` / `flush`：`lookup` 为 null、revision 不匹配、zstd 解码失败、
  `store` 抛错都按 miss 处理并继续 live；`flush` 注册在 `c.effect`/`ctx.effect` 的
  disposer 中，异常吞掉但可在 debug 下记录。key 必须包含 revision、页窗口和裁剪配置，
  未知 key 版本直接 miss。
- 未知 DSH 版本不猜测私有结构，一律退化为 stock 行为；新增私有依赖前先补
  `test/plugin.test.js` 的能力缺失用例。

### 测试与文档

- `npm test` 使用 `node --test`；行为改动必须同时补 `test/plugin.test.js`、`test/trim.test.js`
  或 `test/package.test.js`。不要依赖手工 CDP 代替可自动化的纯逻辑测试。
- `README.md` 是中文主文档，`README.en.md` 是英文；`CHANGELOG.md`/`CHANGELOG.en.md` 也成对维护；每次行为变更两种语言都要写。
- `files` 会发布 `src/**` 与 `docs/**`，不要把测试、临时日志或本地 `.dsh-meow` 带进包。

## 每次改动

1. 从最新 main 开 `feat/` 或 `fix/` 分支。
2. 改代码、测试、双语文档与 CHANGELOG（同一个 PR）。
3. 本地跑 gate，全绿再 push；不要复制 gate 脚本，CI 会通过 `.ci` 运行中心仓的版本。

```bash
npx --yes --package=github:TLEWA/dsh-plugin-ci#v1 dsh-ci-gate
npm test
```

4. 开 PR 并按模板勾选；`ci / ci-ok` 通过后由维护者合并。改 CI、AGENTS 或 PR 模板必须加
   `ci-change`；`human-approved` 只能由人加，模型不得自行添加。

## 发布

只由维护者打 tag 触发 `release.yml`。模型不得执行 `npm publish`、不得改版本号（除非在
`release/` 分支上且被明确要求）。

<!-- dsh-review-policy:v1:start -->
## Code Review Rules

- 用中文报告可证明的严重缺陷，写清触发条件、实际影响和最小相关代码位置；避免风格建议及重复 CI 已完成的机械检查。未返回审阅结果不表示通过。
- 检查宿主兼容性与用户数据边界：插件不得意外改变非目标请求、消息、配置或持久化数据；判断影响时遵守本仓明确记录的兼容例外。
- 检查异常、取消、卸载与重复初始化路径：钩子、监听器和共享状态应正确清理；失败回退不得造成重复执行、数据丢失或泄漏敏感信息。
- 审阅只发表意见。不得自动修复、添加人工批准标签、合并、改版本或发布；保留现有 CI 与人工批准流程。
<!-- dsh-review-policy:v1:end -->

### 本仓审阅重点

- 只裁剪初始历史页，保留尾部与分页语义，绝不删除历史；客户端每次挂载最多自动补一页并正确清理计时器。
