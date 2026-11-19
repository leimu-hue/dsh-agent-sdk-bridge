# 对话框模型选择器不刷新 / 额度与模型不同步 问题结论

- 事件时间：2026-11-19 13:31 前后（UTC+08:00）
- 现象：在「设置 → Qoder 国际版」点「重试 / 刷新」后，设置页能读到新额度与新模型，
  但对话输入框的模型选择器里选不到新模型，必须重启 DSH；并且额度先出现、模型晚一段时间才出现。
- 涉及对象：`dsh-agent-sdk-bridge`（本仓库，profile 以 `link:` 方式安装）

---

## 一、结论摘要

1. **选择器不刷新是插件的缺陷**：GUI 的模型目录是「每个 Host generation 加载一次」的缓存，
   只有收到 Host 的 `llm/adapters-updated` 或 `llm/models-updated` 才会重载。插件此前从未发出过
   `llm/models-updated`；重启时 `registerAdapter()` 重新注册路由，才会产生 `llm/adapters-updated`，
   于是「重启就好了」。
2. **额度与模型不同步是设置页的缺陷**：额度（`GET /usage`）与模型目录（`GET /models`）是两个路由，
   页面上也是两个互不相干的刷新按钮；模型列表的「刷新」甚至没有加载态（`busy` 只由配置写入使用），
   所以点了没反应、几秒后列表才变，而额度卡片几乎立刻更新。

---

## 二、证据

### 2.1 GUI 只认两种「变化」通知

`@deepseek-ai/dsh-client-ui-model-selection/src/client/service.ts`：

```ts
ctx.remote.$on('llm/adapters-updated', () => { this.catalog.refresh() })
ctx.remote.$on('llm/models-updated',    () => { this.catalog.refresh() })
ctx.remote.$on('settings/document-updated',   () => { this.catalog.refresh() })
ctx.remote.$on('credentials/record-updated',  () => { this.catalog.refresh() })
```

`catalog.ts` 的 `load()` 在 `status === 'ready'` 时直接返回缓存，不重新向 Host 要目录；
也就是说**没有事件就永远不会重读**，仅凭打开选择器不会触发刷新。

`@deepseek-ai/dsh-api-session-controller/src/catalog.ts` 的 `buildModelCatalog()` 每次都调用
`ctx.llm.listModels(provider)`，所以只要收到事件，重载就能拿到插件的新目录。

### 2.2 插件侧从未发出该事件

改动前 `src/host/` 内没有任何 `llm/models-updated`。设置页的刷新只走到插件自己的 HTTP 路由：

```
GET /api/llm-qoder-cn/models?brand=global&fresh=1
  → QoderAdapter.invalidateCatalog()
  → describeCatalog() → QoderModelCatalog.liveModels()   // 只更新插件私有的缓存
```

这条路径不经过 `ctx.emit`，GUI 无从得知。`bridge.log` 里也只有 `apply` / `session/*` / `turn/end`，
没有任何目录变化记录（本次已补 `catalog/updated` 事件）。

### 2.3 为什么「先额度、后模型」

- `GET /usage`：一次 CLI 控制调用（`getUsageInfo`），通常不到一秒。
- `GET /models`：冷启动 CLI → `accountInfo()` → `getAvailableModels()`，首次登录时上游可能先回空列表，
  再依次用 `cache` / `live` 策略重试，最坏要等数秒到十几秒（见 `QoderModelCatalog.read()`）。
- 设置页的两个按钮各自独立：额度卡片有 `busy`，模型列表的「刷新」没有（`busy` 只被 `write()` 占用）。
  于是观感是「额度立刻出来，模型过一会儿才出来，而且点刷新没有任何反馈」。

---

## 三、修复

### 3.1 Host：目录变化要通知 harness

- `QoderModelCatalog` / `CodeBuddyCatalog` 增加 `onChange(ids)`：**成功读到与上次不同的目录时**
  （按 id + 显示名比较）才回调一次；失败的读取沿用上次列表，不回调。
- `QoderAdapter` / `CodeBuddyAdapter` 透传该回调；CodeBuddy 的登录成功、退出登录这两条
  「列表变了但没有读取过程能发现」的路径自行上报。
- `src/host/index.ts` 把它接到 `ctx.emit('llm/models-updated', provider)`，并写一行
  `catalog/updated` 轨迹（含 provider 与模型数），便于下次直接看日志确认「有没有通知到」。
- 事件失败不影响目录读取本身（try/catch + warn）。

`llm/models-updated` 在本插件编译所用的 `@deepseek-ai/dsh-llm` 版本里还没有声明，
所以按仓库既有做法（`loader/volatile-update`）在 `src/host/index.ts` 的 `Events` 上做了本地声明；
实际运行的 0.2.2-rc.5 已声明并转发该事件（`dsh-api-remotes/src/remote-events.ts`）。

### 3.2 Client：一次动作同时重读额度与模型

- 设置页新增 `refreshAccount()`：`fresh` 读模型目录 + 递增 `usageTick`（额度卡片强制 fresh 读），
  顶部「刷新列表」、加载失败时的「重试」都用它。
- 额度卡片新增可选 `onRefresh`：两项按钮在有该回调时走 `refreshAccount`，不再只刷额度。
- 模型目录读取新增独立的 `reading` 状态（与配置写入的 `busy` 分开），刷新期间按钮显示「刷新中…」并禁用。
- 额度卡片的 `refreshSignal > 0` 时按 fresh 读取，避免登录后仍命中 60 秒内的旧缓存。

---

## 四、生效方式

本插件在 profile 里是 `link:` 安装，`lib/` 已重新构建。**需要重载一次插件 entry**
（插件管理器里禁用再启用，或重启 DSH）才会加载新代码；此后登录 / 刷新不再需要重启应用。

## 五、验证

- `test/core/live.test.ts`：`apply()` 后目录变化 → `llm/models-updated`（provider 正确），
  同一列表重复读取不重复通知。
- `test/providers/qoder/models.test.ts`：首次列表、新增模型、清空列表各通知一次；
  相同列表、失败刷新、账号自带（BYOK）模型变化不通知。
- `test/providers/codebuddy/codebuddy-catalog.test.ts`：同一区域列表变化才通知。
- `npm test`：26 个文件、250 条用例通过；`tsc` 的 host / client / test 三套程序均通过。
- 构建产物冒烟：加载 `lib/index.js`，桩上下文下 `apply()` → `liveModels()` 只发出一次
  `llm/models-updated("qoder-intl")`，并写入 `catalog/updated`。

## 六、剩余限制

若用户登录后**从不打开设置页**，也没有任何东西调用 `listModels()`，插件就不会去读目录，
自然也不会通知——选择器会停留在启动时的空目录，直到下一次 Host 事件（重启、切换版本、
登录 CodeBuddy 等）。这是上游 GUI「一个 generation 一份缓存」的设计决定的，本插件无法在没有
读取动作的情况下主动发现账号变化；要覆盖这种情况，需要上游在打开选择器时重新 `modelCatalog()`，
或由插件定时预热目录（会持续拉起 CLI 进程，未采纳）。
