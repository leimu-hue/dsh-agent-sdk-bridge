# dsh-agent-sdk-bridge 「轮次被误报为断链」优化方案

- 针对文档：`dsh-reconnect-diagnosis-2026-11-18.md`
- 代码基线：v2.0.0，HEAD `cf5dfac`（工作区仅多出诊断文档）
- 结论：诊断文档的**核心判断正确**（`STREAM_CLOSED` 把「宿主主动关闭」和「上游断流」混成一条出口），
  但其中两条推论与当前代码不符，且漏掉三个同族触发器。方案按「先测量 → 再改语义 → 再改生命周期」
  三段推进，全部改动都能落在本插件内，不需要动 DSH 核心。

---

## 一、事实校准

### 1.1 成立的部分

| 结论 | 证据 |
|---|---|
| `turn/end` 记录的是插件自己抛出的错误，不是网络断链 | `src/host/providers/qoder/session.ts:845` 是 `qoder session stream ended unexpectedly` 的唯一来源 |
| 宿主 `close()` 会让 `asyncIterator` 返回 `done`，因此与真实断流共用同一出口 | `qoder/session.ts:697-704`（`q.close()`）→ `qoder/session.ts:833-845` |
| CodeBuddy 侧同一个缺陷 | `codebuddy/session.ts:1308-1314` → `codebuddy/session.ts:1382` |
| 客户端（`src/client`）可排除 | 三个只读路由（`surface/api.ts:185-292`），无 transport 操作 |

### 1.2 需要修正的两条

**① §4.3「让配置写入走 `loader/volatile-update`」已经是现状，不是待办项。**

- 全部字段都已 `.volatile()`（`core/config.ts:189-228`）；
- 全部读取都经 `liveConfig()` 的 thunk（`core/config.ts:289-336`），`Live<T>` 在**使用点**读值（`core/live.ts:32-44`）；
- `apply()` 里只捕获结构性字段，且已订阅 `loader/volatile-update` 做重新发布（`host/index.ts:147-150`、`host/index.ts:349-356`）。

所以「配置写入会不会热更新」在插件侧已经没有可优化的地方。若 18:17:02 那次写入仍然重建了 entry，
原因只可能在 loader / 插件管理器的**整层 re-apply**，插件无法阻止 —— 只能选择「活下来」和「说实话」。
另外，诊断文档把「turn 3 的 contextWindow 变成 400000」当作「写入已生效」的证据，
但这条证据是**中性**的：热更新路径同样会让新值立刻生效，它不能区分「重建」与「热更新」。
区分方法是 §4.3（新的 P1-3）：加一行 `apply()` 代数计数器。

**② 「重载不打断进行中的轮次」不需要等 DSH 侧配合，插件自己就能做到。**

诊断文档把希望寄托在「插件管理器检测到进行中的 turn 时延后 uninstall」。实际上更简单：
**宿主已经在消费的 `AsyncGenerator` 不会因为插件被 dispose 而停止**。
`ctx.effect` 的 disposer 只会调用 `adapters.close()`（`host/index.ts:360-364`），
没有任何东西会取消一个已经在跑的 `stream()`；而 `stream()` 的产出是被 harness 自己的
`for await` 拉取的。也就是说，只要 dispose 不主动杀子进程，正在飞的那一轮**可以正常跑完**，
用户拿到完整回答，子进程在这之后才退出。这是比「延后 uninstall」更彻底的做法（P0-2）。

### 1.3 漏掉的三个同族触发器

**① 池容量驱逐会杀掉进行中的轮次。**
`QoderSessionManager.forSession()` 在超出 `maxSessions` 时直接 `victim.close()`
（`qoder/session.ts:1133-1139`，CodeBuddy 同 `codebuddy/session.ts:1678-1684`），
**没有任何「该会话是否正在跑轮次」的判断**。8 个并发会话 + 第 9 个会话开一轮，
就足以让某个正在长跑的轮次拿到 `STREAM_CLOSED`。这与本次事件同症状、同错误码、不同触发器。

**② 登录 / 登出 CodeBuddy 会关掉所有温会话，包括正在跑的轮次。**
`adapter.ts:161`（登录成功回调）与 `adapter.ts:172`（登出）都是 `this.sessions.closeAll()`。
诊断文档第 5 节恰好检查了「登录轮询」并据「18:17 时未在登录流程」排除客户端，
但没有注意到这个按钮本身就是一个跨会话的清除器 —— 用户点一次「登录」，
所有正在进行的对话都会以 `STREAM_CLOSED` 结束。

**③ 被 dispose 的旧 adapter 仍能「复活」会话并泄漏。**
`closeAll()` 只是清空 Map（`qoder/session.ts:1151-1154`、`codebuddy/session.ts:1695-1699`），
没有「封存」标记。`prepareCall()` 已经把 generation 绑给了某次 dispatch
（`qoder/adapter.ts:530-536`），若重载后 harness 对同一 step 重试，会走**旧 adapter** 的
`dispatch()` → 旧 manager 的 `forSession()` → 新建一个**永远没人关闭**的子进程。
这既是泄漏路径，也是「重装后进程数变多」的一个候选解释（见 §1.4）。

### 1.4 关于 11 个 `codebuddy-headless`（诊断 §6.1）的更正

`codebuddy-headless` 是**每个 session 一个子进程**（`codebuddy/session.ts:346-353` 的注释明确写了
「the SDK gives CodeBuddy no daemon: every `createSession` is a fresh child process」），
而 `session.close()` 走 transport 的「关 stdin → 到点兜底 kill」（SDK `lib/transport/process-transport.js:707-770`）。

因此「10 个进程启动于 16:14–16:55、跨过了 17:45/17:46 两次重装仍在」这件事，
现有证据不足以归因。三种可能都还成立：
(a) 它们属于仍在使用的温会话（不是泄漏）；
(b) dispose 时 `close()` 没生效（transport 兜底 kill 失败）；
(c) 旧 adapter 被重试复活（§1.3 ③）或 CodeBuddy 的 `createSession` 内部另有守护进程。

诊断文档直接把结论落在「空闲也不回收」上，属于**归因过早**。方案里把它改成「先测量再修」（P1-2）：
只需一次 30 行的探针实验（开 1 个会话 → close → 数进程），就能把 (a)(b)(c) 区分开。
在结论出来之前，空闲 TTL（P1-1）只作为兜底，不作为「已定位问题」的修复。

---

## 二、目标与非目标

**目标**

1. 「插件被重载 / 会话被回收 / 账号切换」不再伪装成网络故障：告警文案、错误码、`turn/end.reason` 三者一致。
2. 插件重载、配置保存、装/卸载过程中，**正在进行的一轮不被截断**（能跑完就跑完，超时才收）。
3. 生命周期操作（驱逐、空闲回收、登录/登出、区域切换）不杀忙碌会话。
4. 池和子进程的状态可观测：任何时候能回答「谁在跑、谁在等、谁没退」。

**非目标**

- 不改 `src/client`（诊断已排除，且它没有关闭通道的能力）。
- 不改 DSH 核心 / 插件管理器（本仓库无权）。
- 不做「重载后接管旧子进程」的会话热迁移（成本远高于收益：冷重建已有正确路径，
  `adapter.ts:590-603` 的 `fedMessages === undefined` → `firstTurn` 会重灌完整历史）。
- 不改用量计量、上下文窗口、模型目录相关逻辑。

---

## 三、核心设计：一次关闭，四种语义

### 3.1 关闭原因（`CloseCause`）

```ts
/** 谁要求这个内层会话停止服务；决定轮次如何收尾、日志如何归因。 */
export type CloseCause =
  | 'dispose'   // 插件被卸载/重载（宿主环境变化，不再重启即恢复）
  | 'evicted'   // 池容量驱逐
  | 'idle'      // 空闲回收
  | 'account'   // 登录/登出/账号切换
  | 'region'    // CodeBuddy 区域切换
  | 'rebuild'   // 历史分叉，需要冷重建
```

### 3.2 收尾语义（`endTurn` 分流）

| CloseCause | 今天 | 期望 `FinishReason` | 用户看到 |
|---|---|---|---|
| `dispose` | `error / STREAM_CLOSED` | `{ kind: 'aborted', failure: { code: 'ABORTED', message: 'DSH 已重新加载本插件，本轮中断；再次发送即可续上（会话将冷重建）' } }` | 中断提示 + 可续发 |
| `evicted` / `idle` | `error / STREAM_CLOSED` | 同上，文案换成「会话已被回收」/「长时间空闲已回收」 | 中断提示 + 可续发 |
| `account` / `region` | `error / STREAM_CLOSED` | `{ kind: 'aborted', code: 'ABORTED', message: '登录账号已切换，本轮中断' }` | 中断提示 |
| `rebuild` | 不发生（先 dispose 再新建） | 不需要（新建即冷重建） | — |
| **无原因**（真的 `done` 了） | `error / STREAM_CLOSED` | 保持 `error / STREAM_CLOSED`，但消息补上 `provider`、`sessionId`、已产出字符数 | 现有告警 |

为什么用 `aborted` 而不是继续用 `error`：

- `dsh-llm` 会把 `code === 'ABORTED'` 的失败归一化成 `kind: 'aborted'`（`@deepseek-ai/dsh-llm/lib/types/index.js:942`），
  这是框架认可的「非故障中断」通道；
- 默认重试集合只含 `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`
  （`@deepseek-ai/dsh-llm/lib/types/retry-policy.js:16-22`），`ABORTED` 不在其中，
  因此不会出现「重载一次 → 自动重试 5 次 → 每次都重灌历史」的假重连风暴。

> **需在第一次迭代确认的未知项**：DSH 前端对 `reason.kind === 'aborted'` 的文案可能是「用户已中断」。
> 若文案不贴合，退化为 `{ kind: 'error', failure: { code: 'HOST_RELOADED', ... } }`（同样不在重试集合内），
> 只保留「不伪装成网络故障」这一目标。两种选择都不影响后面所有改动。

### 3.3 drain：让在飞的轮次跑完

```
close('dispose') 被调用
├─ 无在飞轮次 ────────────────────────► teardown()            立即关闭
└─ 有在飞轮次（queue !== null）
   ├─ drainSeconds === 0 ────────────► teardown()            保持今天的行为（逃生口）
   └─ drainSeconds > 0
      ├─ 标记 closing，不再接受新轮次
      ├─ 不 interrupt、不 clear pairing、不关子进程
      ├─ 轮次正常跑到 finish ─────────► stream() 的 finally → teardown()
      ├─ 宿主取消（signal abort）─────► 现有 abort 路径 → finally → teardown()
      └─ 超过 drainSeconds ──────────► teardown() + 以 ABORTED 收尾该轮
```

`teardown()` 保持今天的清理顺序（`pairing.clear()` → `q.close()`），只是延后执行。
关键点：**`pairing.clear()` 必须延后**，否则正在等宿主工具结果的 handler 会在 drain 窗口里被误取消。

---

## 四、改动清单

### P0-1 关闭原因与收尾分流（约 0.5 天）

**位置**：`qoder/session.ts:833-858`（`consume`）、`823-831`（`endTurn`）、`697-704`（`close`）；
`codebuddy/session.ts:1376-1389`（`consume`）、`1308-1314`（`close`）。

```ts
// 纯函数，便于单测：原因 → 收尾理由
export function closeFinishReason(cause: CloseCause): FinishReason {
  const text: Record<CloseCause, string> = {
    dispose: 'DSH 已重新加载本插件，本轮被中断；会话将在下次请求时重建',
    evicted: '本会话已被回收（会话数超出上限），本轮被中断',
    idle: '本会话长时间空闲已被回收，本轮被中断',
    account: '登录账号已变更，本轮被中断',
    region: 'CodeBuddy 登录区域已切换，本轮被中断',
    rebuild: '会话历史已分叉，本轮被中断',
  }
  return { kind: 'aborted', failure: { message: text[cause], code: 'ABORTED' } }
}
```

`consume()` 的 `done` 分支改为：

```ts
const cause = this.closing
this.endTurn(cause === undefined
  ? {
      kind: 'error',
      failure: {
        message: `qoder 内层流在没有 finish 事件的情况下结束（brand=${this.brand}, session=${this.sessionId}, 已产出 ${this.output.outputChars} 字符）`,
        code: 'STREAM_CLOSED',
      },
    }
  : closeFinishReason(cause))
```

`stream()` 顶部的两个守卫改成**非可重试**码（今天是 `TRANSPORT`，属于默认重试集合，
让已 dispose 的会话被 harness 反复重试没有意义）：

```ts
if (this.queue !== null) throw new LlmError(..., 'INVALID_REQUEST')      // 现状
if (this.closing !== undefined) throw new LlmError(`... closing(${this.closing})`, 'INVALID_REQUEST')
if (this.disposed) throw new LlmError(..., 'INVALID_REQUEST')            // 由 'TRANSPORT' 改
```

**验收**：单测覆盖 `closeFinishReason` 全部分支；用一个假 `Query`（`[Symbol.asyncIterator]` 可控结束）
构造「close 后 iterator 返回 done」的场景，断言 `finish.reason.kind === 'aborted'` 且 `code === 'ABORTED'`。

---

### P0-2 dispose 走 drain（约 0.5 天）

**位置**：`qoder/session.ts:697-704`、`stream()` 的 `finally`（`qoder/session.ts:650-661`）；
`codebuddy/session.ts:1308-1314`、`1258-1305`；`host/index.ts:360-364`；两个 adapter 的 `close()`。

```ts
// QoderSession / CodeBuddySession
private closing: CloseCause | undefined
private forceTimer: ReturnType<typeof setTimeout> | undefined

/** 只请求关闭，不保证已关闭；有在飞轮次时先让它跑完。 */
close(cause: CloseCause = 'dispose'): void {
  if (this.closing !== undefined) return
  this.closing = cause
  const drainMs = readLive(this.drainMs, DEFAULT_DRAIN_MS)
  if (this.queue === null || drainMs <= 0) { this.teardown(); return }
  trace('session/drain', { session: this.sessionId, cause, drainMs })
  this.forceTimer = setTimeout(() => this.teardown(), drainMs)
  unrefTimer(this.forceTimer)
}

private teardown(): void {
  if (this.disposed) return
  this.disposed = true
  if (this.forceTimer !== undefined) { clearTimeout(this.forceTimer); this.forceTimer = undefined }
  this.pairing.clear()
  if (this.q !== null) void this.q.close().catch(() => undefined)
}

/** stream() 的 finally 末尾追加 */
if (this.closing !== undefined) this.teardown()
```

**细则**

- `drainMs` 来自新配置 `disposeDrainSeconds`，默认 **120**，`0` 表示退回今天的「立即关闭」。
  之所以要上限：插件被卸载后旧模块仍被在飞的 generator 引用，无限等会留下不可见的子进程。
- drain 期间 `this.disposed` 保持 `false`，但 `closing !== undefined`，两个守卫都拒绝新轮次。
- 宿主取消自己那一轮时，generator 会被 `return()`，`finally` 仍然跑到 `teardown()` —— 不新增泄漏。
- `host/index.ts` 的 disposer 改成传原因：`adapters.cn.close('dispose')`（Qoder/CodeBuddy 各一句）。

**验收**：假 `Query` 在 close 之后继续吐 3 个 chunk 再 `result`，断言：
(1) 3 个 chunk 都到达宿主；(2) `finish.kind === 'stop'`；(3) `pairing.clear` 在 finish 之后才被调用。

---

### P0-3 驱逐/回收不碰忙碌会话 + manager 封存（约 0.5 天）

**位置**：`qoder/session.ts:1109-1154`、`codebuddy/session.ts:1655-1699`。

```ts
// QoderSession
get busy(): boolean { return this.queue !== null }

// QoderSessionManager
forSession(sessionId, model) {
  if (this.sealed) throw new LlmError('会话池已封存（插件正在卸载）', 'INVALID_REQUEST')
  ...
  while (this.sessions.size > cap) {
    const victim = [...this.sessions.entries()]
      .find(([id, s]) => id !== sessionId && !s.busy)      // ← 忙碌会话永不被驱逐
    if (victim === undefined) break                        // 全是忙的：允许暂时超编
    this.sessions.delete(victim[0])
    victim[1].close('evicted')
  }
}

/** 可复用：换账号、切区域、区域重登 —— 池之后还要继续服务。 */
closeAll(cause: CloseCause = 'account'): void {
  for (const s of this.sessions.values()) s.close(cause)
  this.sessions.clear()
}

/** 终结：插件 dispose。封存后旧 adapter 不能再复活会话（§1.3 ③）。 */
seal(cause: CloseCause = 'dispose'): void {
  this.sealed = true
  this.closeAll(cause)
}
```

调用点：

| 位置 | 今天 | 改为 |
|---|---|---|
| `QoderAdapter.close()` (`qoder/adapter.ts:701-703`) | `sessions.closeAll()` | `sessions.seal('dispose')` |
| `QoderAdapter.resetAccount()` (`:397-402`) | `sessions.closeAll()` | `sessions.closeAll('account')` |
| `CodeBuddyAdapter.close()` (`codebuddy/adapter.ts:401-403`) | `sessions.closeAll()` | `sessions.seal('dispose')` |
| `CodeBuddyAdapter.startLogin` 成功回调 (`:161`) | `sessions.closeAll()` | `sessions.closeAll('account')` |
| `CodeBuddyAdapter.logout` (`:172`) | `sessions.closeAll()` | `sessions.closeAll('account')` |
| 区域切换 (`forSession` 内 `existing.session.close()`, `:1667`) | `close()` | `close('region')` |

**验收**：池里 3 个会话，2 个 busy，`cap = 2`，新建第 4 个 → 只驱逐那个 idle 的；全是 busy 时池短暂为 3，不抛错。
封存后 `forSession` 抛 `INVALID_REQUEST`，且不再新建子进程。

---

### P1-1 空闲 TTL + `maxSessions` 语义修正（约 0.5 天）

**现状**：Qoder 没有任何空闲回收；CodeBuddy 只有控制会话有空闲回收
（`codebuddy/session.ts:86` `CONTROL_IDLE_MS`、`:477-490` `armControl`），温会话没有。

**改法**：manager 持有**一个** `setInterval`（`unref`，60s），扫描 `lastUsedAt`，跳过 `busy`：

```ts
private readonly sweeper = setInterval(() => this.sweep(), 60_000)
private sweep(): void {
  const idleMs = readLive(this.idleMs, DEFAULT_SESSION_IDLE_MS)   // 0 = 关闭
  if (!(idleMs > 0)) return
  const now = Date.now()
  for (const [id, s] of this.sessions) {
    if (s.busy || now - s.lastUsedAt < idleMs) continue
    this.sessions.delete(id)
    s.close('idle')
  }
}
```

**新配置**

| 字段 | 默认 | 说明 |
|---|---|---|
| `sessionIdleSeconds` | 600 | 温会话空闲多久回收；`0` 关闭。每个 Qoder 会话是一个 CLI 子进程，每个 CodeBuddy 会话是一个约 150–190 MB 的 `codebuddy-headless` |
| `disposeDrainSeconds` | 120 | 插件卸载/重载时，允许在飞轮次跑完的宽限；`0` = 立即关闭（旧行为） |

**文案修正**：`config.ts:219` 与 README 里 `maxSessions` 的说明改为「**空闲**内层会话数上限；
进行中的轮次不会被驱逐」，否则设置页在骗人。

> 注意：本项在此只作为**兜底**。真正的 1.8 GB 归属要先由 P1-2 测出来；
> 如果那 10 个进程是 (b)/(c) 两种情况，空闲 TTL 不会让它们消失。

---

### P1-2 子进程账本：先测量，再决定修法（约 0.5 天）

1. **spawn/close 打点**：两个 provider 的 `ensureStarted()` / `ensureStarted()`（CodeBuddy）
   与 `teardown()` 各写一行日志，字段：`bootId, sessionId, brand/region, cause, at, 存活 ms`。
2. **进程标记**：在 `cliEnv()`（`codebuddy/session.ts:250-255`）与 `qoderCliOptions()`
   （`infra/cli/lookup.ts:108-118`）里追加
   `DSH_BRIDGE_BOOT=<bootId>`、`DSH_BRIDGE_SESSION=<sessionId>`，让遗留进程可归因到某次插件装载。
3. **诊断路由（可选但推荐）**：`GET /api/llm-qoder-cn/diagnostics` 返回池快照
   （sessionId、brand、busy、spawnedAt、lastUsedAt、fedMessages.length）
   + Windows 下的 `tasklist /fo csv /fi "imagename eq codebuddy-headless.exe"` 结果（pid/启动时间/内存）。
   这是唯一能一次性回答「这 11 个进程是谁的」的东西。
4. **探针实验（30 行，手工即可）**：置 `maxSessions=1`、`sessionIdleSeconds=1`，
   跑一轮 → 等 90s → `Get-Process codebuddy-headless | Select Id,StartTime`。
   分别验证：正常结束、`close()` 后、dispose 后。三种情况的结果直接决定是否需要
   在 SDK 边界上补 `kill`，或需要关掉 CLI 的常驻行为。

**产出**：一份「1.8 GB 归属」结论 + 是否需要进程级补丁的判定。**不要在没有这一步之前直接改 close 逻辑。**

---

### P1-3 可观测性：`bridge.log` + `apply` 代数（约 0.5 天）

**新增** `src/host/infra/log.ts`：

```ts
const BOOT_ID = randomUUID().slice(0, 8)
export function trace(event: string, fields: Record<string, unknown> = {}): void
```

- 目标文件 `~/.dsh/agent-sdk-bridge/bridge.log`（目录已存在，CodeBuddy 状态文件就在里面）；
- JSONL，每行 `{ t: ISO+毫秒, boot: BOOT_ID, pid, event, ...fields }`；
- 4 MB 轮转为 `bridge.log.1`；写失败静默（不能因为日志让插件崩）；
- 默认开启（配置 `traceEnabled`，默认 `true`）。

**打点位置**（每个都只有一行）：

| 事件 | 位置 | 为什么 |
|---|---|---|
| `apply` | `host/index.ts:191` 开头，带 `n: ++applyCount` | **直接回答诊断 §8**：保存一次配置后 `apply` 是否再次出现 |
| `dispose` | `host/index.ts:360` 的 disposer 内 | 与 `apply` 配对，得到「entry 被重建」的铁证 |
| `volatile-update` | `host/index.ts:349` 回调内，打印 paths | 区分「热更新」与「重建」 |
| `session/spawn` `session/close` `session/drain` | 两个 provider | 池生命周期 |
| `turn/start` `turn/end` | `endTurn()` | 与 DSH 事件流对时间轴 |
| `stream/ended-without-finish` | `consume` 的 `done` 分支 | 今天的 `STREAM_CLOSED` 唯一来源 |

配置保存后 `bridge.log` 里只会出现两种形态之一，一眼可辨：

```
{"event":"volatile-update","paths":[["intlModelContextWindows"]]}     → 热更新，没重建
{"event":"apply","n":2}  {"event":"dispose"}                          → entry 被重建
```

---

### P2-1 显式声明重试策略（约 0.2 天）

`LlmAdapter.providerRetryPolicy()`（`@deepseek-ai/dsh-llm/lib/types/index.d.ts:142`）默认返回
`undefined`（用框架默认）。建议两个 adapter 显式返回：

```ts
providerRetryPolicy(): ResolvedRetryPolicy {
  return {
    mode: 'normal',
    maxRetries: 5,
    retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'],
    backoff: { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 },
  }
}
```

收益：本插件会抛出的所有码（`STREAM_CLOSED`、`ABORTED`、`BACKEND_ERROR`、`BACKEND_TURN_ERROR`、
`CONTEXT_WINDOW_EXCEEDED`、`QUOTA`）与可重试集合的关系被写死在代码里，
下次改码不会意外掉进/掉出重试集合。

### P2-2 配置项、文案、文档（约 0.3 天）

- 新配置：`sessionIdleSeconds`、`disposeDrainSeconds`、`traceEnabled`（全部 `.volatile()`，默认值见上）；
- `maxSessions` 说明改写（见 P1-1）；
- README「高级设置」补三个新字段与日志路径；
- 在诊断文档顶部加一段「后续结论」链接到本方案，避免后来人重复提出「配置写入走热更新」这一已完成的建议。

### P2-3 可选重构：把池逻辑抽成 `core/pool.ts`（约 0.5 天）

两个 manager 已经在重复同一套 LRU（`qoder/session.ts:1123-1141` / `codebuddy/session.ts:1663-1686`），
而 P0-3、P1-1 要给两边各加同样的三个能力（busy 判断、idle 扫描、seal）。
抽成泛型池 `SessionPool<T extends { busy: boolean, close(cause: CloseCause): void }>`：

```ts
class SessionPool<T> {
  forSession(id: string, create: () => T): T
  dispose(id: string, cause: CloseCause): void
  closeAll(cause: CloseCause): void
  seal(cause: CloseCause): void
  snapshot(): PoolRow[]          // diagnostics 用
}
```

收益：两处改一处；**可测试性**是关键 —— 今天的 manager 直接 `new QoderSession(...)`，
没有注入点，改完也没法写单测。抽池后可以用假会话测驱逐/空闲/封存的全部分支。
若排期紧，可以**先按 P0-3 就地改两处**，把重构放到最后。

---

## 五、复现与验收矩阵

`bridge.log` 与 DSH 事件流双轨对照，每个场景都应产出唯一一条可预期的 trace 序列。

| # | 场景 | 操作 | 期望 trace | 期望 `turn/end.reason` |
|---|---|---|---|---|
| 1 | 重载插件（在飞轮次） | 跑一轮 → 插件管理器重装 | `apply(n)` `dispose` `session/drain` … `turn/end` `session/close` | `aborted/ABORTED`，回答**完整** |
| 2 | 保存配置（在飞轮次） | 跑一轮 → 设置页改窗口并保存 | `volatile-update[w]`（无 `apply`/`dispose`） | `stop`（不缺断） |
| 3 | 保存配置导致 entry 重建 | 同上，若出现 `apply(n+1)` | `apply` `dispose` `session/drain` | `aborted/ABORTED`，回答完整 |
| 4 | 池驱逐 | `maxSessions=1` + 两个会话各跑一轮 | `session/close{evicted}` **只落在空闲会话** | 忙碌轮次 `stop` |
| 5 | 空闲回收 | `sessionIdleSeconds=1`，跑一轮后静置 90s | `session/close{idle}` | 上一轮早已 `stop` |
| 6 | 登录/登出 CodeBuddy | 跑一轮 → 点登录 | `session/close{account}` | `aborted/ABORTED` |
| 7 | 真实断流（回归） | kill 掉 qodercli 子进程 | `stream/ended-without-finish` | 仍是 `error/STREAM_CLOSED`（未被混淆） |
| 8 | 外部停止（回归） | 用户点停止 | — | `aborted/ABORTED`（不变） |

**量化验收**

- 场景 1/3/6：被中断的轮次中，`finish` 之前的 chunk 数 = 该轮内部产出的 chunk 数（不丢）；
- 场景 2：`bridge.log` 中**没有** `apply`/`dispose`（证明确实热更新，不需要 drain 参与）；
- 场景 4：忙碌会话的 `sessionId` 在 `session/close` 中**不出现**；
- 池规模：静置 15 分钟后 `tasklist` 中 `codebuddy-headless` 数量 ≤ 2（两个控制会话）+ 0 温会话。

---

## 六、风险与回退

| 风险 | 影响 | 处理 |
|---|---|---|
| drain 让子进程在插件卸载后继续存活 | 用户以为「已卸载但还在跑」 | `disposeDrainSeconds` 上限（默认 120s）+ trace 明示；设 `0` 退回旧行为 |
| `aborted` 的前端文案可能像「用户取消」 | 误导方向 | 第一轮先确认文案；不合适就退 `error/HOST_RELOADED`（§3.2 备注） |
| 空闲回收把大历史会话关掉，下一轮重灌 | 首次请求变慢、计费上升 | 默认 600s，可关；trace 记录 `feedTokens` 便于判断代价 |
| 封存后旧 adapter 的 retry 直接失败 | 极端情况下丢掉一次自动重试 | 这是期望行为（重试旧 adapter 必然重建冷会话，代价与成功率都更差）；`INVALID_REQUEST` 不可重试，避免风暴 |
| 空闲 TTL 掩盖真实泄漏 | 1.8 GB 问题看起来「好了」但没修 | P1-2 的测量先于/并行于 P1-1，结论写进 trace 与文档 |

**回退**：三个改动互相独立。P0-1 只改断言值；P0-2 一个配置即可关闭；P0-3 是纯条件判断。
任何一项出问题都能单独 revert，不影响其余。

---

## 七、排期建议

| 阶段 | 内容 | 工作量 | 交付 |
|---|---|---|---|
| 第 1 天 | P1-3 日志 + `apply` 代数；复现场景 1/2/3 | 0.5 d | **先回答诊断 §8**：那次写入到底重没重建 entry |
| 第 1 天 | P0-1 关闭原因与收尾分流 + 单测 | 0.5 d | 不再误报网络故障 |
| 第 2 天 | P0-2 drain + 单测 | 0.5 d | 重载不再截断在飞轮次 |
| 第 2 天 | P0-3 驱逐跳过忙碌 + seal + 单测 | 0.5 d | 关掉另外两个「假断链」入口 |
| 第 3 天 | P1-2 子进程账本 + 探针实验 | 0.5 d | 1.8 GB 归属结论 |
| 第 3 天 | P1-1 空闲 TTL（按探针结论决定默认值） | 0.5 d | 池收敛 |
| 第 4 天 | P2-1/2 策略与文案；P2-3 池重构（可选） | 0.5–1 d | 可维护性 |

**建议先做第 1 天**：`apply` 代数这一行日志的成本是 15 分钟，
却能把诊断文档里唯一悬空的因果（§8「18:17:02 那次写入是否重建了 entry」）彻底钉死。
在它出结果之前，P0-2 的 drain 是**无论如何都值得做**的（它不依赖这个结论），
而「让配置写入走热更新」这条建议**不应该再被安排**——它已经是现状（§1.2）。

---

## 附录 A：关键代码位置

| 语义 | 位置 |
|---|---|
| 插件挂载 / dispose / volatile 订阅 | `src/host/index.ts:191`、`:349-356`、`:360-364` |
| 配置 schema（全 volatile） | `src/host/core/config.ts:189-228` |
| Live 读取机制 | `src/host/core/live.ts:32-58`、`core/config.ts:289-336` |
| Qoder 会话关闭 | `src/host/providers/qoder/session.ts:697-704` |
| Qoder 流消费（误报点） | `src/host/providers/qoder/session.ts:833-858` |
| Qoder 轮次收尾 | `src/host/providers/qoder/session.ts:820-831` |
| Qoder 池 / 驱逐 | `src/host/providers/qoder/session.ts:1109-1154` |
| CodeBuddy 会话关闭 | `src/host/providers/codebuddy/session.ts:1308-1314` |
| CodeBuddy 流消费（误报点） | `src/host/providers/codebuddy/session.ts:1376-1389` |
| CodeBuddy 池 / 驱逐 | `src/host/providers/codebuddy/session.ts:1655-1699` |
| CodeBuddy 登录/登出清池 | `src/host/providers/codebuddy/adapter.ts:161`、`:172` |
| 控制会话空闲回收（可参照） | `src/host/providers/codebuddy/session.ts:477-490` |
| 轮次队列 | `src/host/core/host-session.ts:246-286` |
| 设置 API 路由 | `src/host/surface/api.ts:167-298` |
| 框架重试默认集合 | `node_modules/@deepseek-ai/dsh-llm/lib/types/retry-policy.js:16-22` |
| 框架 ABORTED 归一化 | `node_modules/@deepseek-ai/dsh-llm/lib/types/index.js:942` |

## 附录 B：新增配置项汇总

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `sessionIdleSeconds` | number (0–86400) | 600 | 温会话空闲回收；`0` 关闭 |
| `disposeDrainSeconds` | number (0–600) | 120 | 卸载/重载时允许在飞轮次跑完的宽限；`0` = 立即关闭 |
| `traceEnabled` | boolean | true | 写 `~/.dsh/agent-sdk-bridge/bridge.log`（JSONL，4 MB × 2 轮转） |

---

## 九、实施记录（2026-11-18 当晚）

**已落地**

| 项 | 位置 | 结果 |
|---|---|---|
| P1-3 日志 | 新增 `src/host/infra/log.ts`；`host/index.ts` 的 `apply` / `dispose` / `volatile-update` 打点 | `~/.dsh/agent-sdk-bridge/bridge.log`，JSONL + `boot` + `pid`，4 MB 轮转，`traceEnabled` 可关 |
| P0-1 关闭语义 | 新增 `src/host/core/lifecycle.ts`（`CloseCause` / `closeFinishReason` / `CloseGate`）；两个 provider 的 `consume` 与 `endTurn` | 宿主关闭 → `aborted/ABORTED`（带具体原因文案）；真实断流仍是 `error/STREAM_CLOSED` |
| P0-1 错误码 | `QoderSession.stream` / `CodeBuddySession.stream` | 已关闭会话抛 `INVALID_REQUEST`（不再是可重试的 `TRANSPORT` / `UNKNOWN`） |
| P0-2 drain | 两个 session 的 `close()` → `teardown()`；`stream()` 的 `finally` → `closeGate.settled()` | 在飞轮次跑完才关子进程；超时由 `disposeDrainSeconds`（默认 120s）强制收尾，并以 `aborted` 结束该轮 |
| P0-3 池 | 两个 manager：驱逐跳过 `busy`、`seal()`、`closeAll(cause)`、`dispose('rebuild')`、可注入 factory | 忙碌轮次不再被容量驱逐；旧 adapter 无法复活会话 |
| P0-3 调用点 | `QoderAdapter.close/resetAccount`、`CodeBuddyAdapter.close/startLogin/logout`、区域切换 | 分别使用 `seal('dispose')` 与 `closeAll('account')` / `close('region')` |
| P2-2 配置与文案 | `disposeDrainSeconds`、`traceEnabled`、`maxSessions` 说明 | 设置页与 README 同步 |
| 测试 | 新增 `test/core/lifecycle.test.ts`、`test/core/session-pool.test.ts`、`test/infra/log.test.ts`、`test/providers/codebuddy/codebuddy-close.test.ts` | 全套 242 passed / 1 skipped；`lib` 已重建 |

**有意延后**

- **P1-1 空闲 TTL**：按 §1.4 的结论，`codebuddy-headless` 的归属尚未测量，先加 TTL 只会掩盖问题。
- **P1-2 子进程账本 / 诊断路由**：`session/spawn` 与 `session/close{aliveMs}` 已经能支撑那次 30 行探针实验，诊断路由等实验结论再决定要不要做。
- **P2-1 显式 retryPolicy**、**P2-3 池重构**：不影响本次故障路径，留作后续。

**仍待确认**

1. DSH 前端对 `kind: 'aborted'` 的文案。若显示成「用户已中断」，改成 `error` + `HOST_RELOADED`（同样不可重试），只保留「不伪装成网络故障」。
2. `codebuddy-headless` 遗留进程的归属：`bridge.log` 的 `session/spawn`/`session/close` 与进程启动时间对照即可判定（§1.4 的 (a)(b)(c)）。
3. 插件需重载一次才会加载新 `lib`；重载本身现在也会走 drain，这正是场景 1 的实测机会。
