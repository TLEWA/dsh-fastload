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
