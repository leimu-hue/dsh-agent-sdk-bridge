# dsh 会话「突然重新连接」问题结论文档

- 事件时间：2026-11-18 18:17:02 ~ 18:17:42（UTC+08:00）
- 现象：dsh 会话（qoder-intl / dfmodel）在一轮进行中突然中断并表现为「重新连接」
- 被疑对象：`D:\custom_project\ai-project\dsh-agent-sdk-bridge`（dsh-agent-sdk-bridge v2.0.0，本地 link 安装）
- 结论级别：**确认由该插件引起，触发点在 host 半边而非 `src/client`**

---

## 一、结论摘要

1. dsh 侧记录到的真实事件不是网络断链，而是**一轮请求被错误终止**：

   ```
   18:17:04  turn/end  reason = { kind: 'error',
               error = { message: 'qoder session stream ended unexpectedly', code: 'STREAM_CLOSED' } }
   ```

2. 该错误由插件自身抛出（`qoder session stream ended unexpectedly` 只存在于插件代码中），触发条件是内层 SDK 的 `asyncIterator` 返回 `done`。插件的会话 `close()` 也会让它返回 `done`，因此**「插件被停用/重载」与「真实断流」在日志里是同一个错误码**，这是本次误判为「网络重连」的根本原因。

3. 同一秒内的事实链完全吻合「插件被重新加载」：
   - 18:17:02 profile patch 层被写入（`cordis.patch.yml`）
   - 18:17:02.9 当前轮开始产出（reasoning 分片）
   - 18:17:04.8 流被切断 → 轮次以错误结束
   - 18:17:22 ~ 18:17:34 插件管理器卸载并重装插件（pnpm `remove` → `add`，v2.0.0）
   - 18:17:42 新轮次开始，`contextWindow` 从 200000 变为 400000（说明配置确实在 18:17:02 那次写入中生效）

4. `src/client`（浏览器半边）可基本排除：它只有三个只读 fetch 路由和一个「登录进行中才启动」的 1.5s 轮询，18:17 时未处于登录流程中，且它没有关闭宿主传输通道的能力（`transportDropped` 在所有操作记录中均为 `0`）。

---

## 二、事件时间线（本地时间）

| 时间 | 来源 | 事件 |
|---|---|---|
| 16:14:57 ~ 17:46:44 | 进程表 / CLI 日志 | 多批 `codebuddy-headless` 子进程启动，现存 11 个常驻 |
| 17:11:11 | 会话事件流 | turn 1 开始（qoder-intl/dfmodel，contextWindow 200000） |
| 17:45:17 | 会话事件流 | turn 1 结束，`aborted / user` |
| 17:45:34 / 17:46:22~26 | `operations.jsonl` | 插件 remove → install → bundle（v1.3.4） |
| 17:46:33 | 会话事件流 | turn 2 开始 |
| 18:17:02 | 文件时间戳 | `~/.dsh/profiles/desktop/cordis.patch.yml` 被写入 |
| 18:17:02.939 | 会话事件流 | turn 2 / step 50 的 attempt 开始产出 reasoning |
| 18:17:04.821 | 会话事件流 | attempt 结束；`turn/end` = error，`STREAM_CLOSED` |
| 18:17:04 | 文件时间戳 | `.dshw-turn.json` 记录本轮结束 |
| 18:17:22 / 18:17:31 / 18:17:34 | `operations.jsonl` | 插件 `remove` → `install` → `bundle`（v2.0.0） |
| 18:17:24 / 18:17:33 | 插件管理器 `pnpm.log` | `- dsh-agent-sdk-bridge link:...` → `+ dsh-agent-sdk-bridge link:...` |
| 18:17:32 / 18:17:34 | 文件时间戳 | `pnpm-lock.yaml` / `package.json` 落盘 |
| 18:17:42 | 会话事件流 | turn 3 开始，`request/context` 的 contextWindow = **400000** |

关键点：**patch 写入（18:17:02）→ 流被切断（18:17:04）→ 插件重装（18:17:22~34）** 三步在同一条因果链上，间隔 2 秒与 20 秒。

---

## 三、证据来源与提取方法

### 3.1 会话事件流（决定性证据）

```
C:\Users\XPENG_USER\.dsh\sessions\--D-custom_project-xp-xpd-auto-service--\
  session-3f2c9d82-0555-44df-b925-e8b7ddfd05e9\session.v4.jsonl.zstd
```

- 该文件是 zstd 压缩的 JSONL，共 1585 条事件；`zstandard`（Python）流式解压后可读。
- 关键事件：

  ```
  {"type":"assistant/attempt","seq":1318,"time":1794997024821,
   "data":{"turn":2,"step":50,"stream":[... 首帧 time 1794997022939 ...]}}
  {"type":"turn/end","data":{"turn":2,
   "reason":{"kind":"error","error":{"message":"qoder session stream ended unexpectedly",
                                     "code":"STREAM_CLOSED"}}}}
  {"type":"request/context","data":{"provider":"qoder-intl","model":"dfmodel",
                                    "contextWindow":400000}}   # turn 3
  ```

### 3.2 profile 配置层写入时间

```
C:\Users\XPENG_USER\.dsh\profiles\desktop\cordis.patch.yml      最后写入 18:17:02
  内容相关行：id: llm-qoder-cn / config:
              intlDisabledModels: [] / intlModelAliases: {} / codebuddyRegion: cn
              intlModelContextWindows: { dfmodel: 400000 }
```

### 3.3 插件安装/卸载操作日志

```
C:\Users\XPENG_USER\AppData\Roaming\@deepseek-ai\dsh-desktop\plugin-operations\operations.jsonl
  ... "time":"2026-11-18T10:17:22.761Z","reason":"remove", "target":"dsh-agent-sdk-bridge","version":"2.0.0"
  ... "time":"2026-11-18T10:17:31.699Z","reason":"install",... "enabled":false,"version":"2.0.0"
  ... "time":"2026-11-18T10:17:34.601Z","reason":"bundle", ... "enabled":true, "version":"2.0.0"
  （UTC 时间 +8 即本地时间；全部记录 transportDropped = 0）
```

pnpm 明细：

```
C:\Users\XPENG_USER\.dsh\profiles\desktop\.plugin-manager\logs\operation-mWCfnM\pnpm.log  (18:17:24, 卸载)
  dependencies:
  - dsh-agent-sdk-bridge link:D:/custom_project/ai-project/dsh-agent-sdk-bridge
C:\Users\XPENG_USER\.dsh\profiles\desktop\.plugin-manager\logs\operation-oZoxPs\pnpm.log  (18:17:33, 安装)
  dependencies:
  + dsh-agent-sdk-bridge link:D:/custom_project/ai-project/dsh-agent-sdk-bridge
```

### 3.4 CodeBuddy CLI 侧日志（用于排除 CodeBuddy 路径）

```
C:\Users\XPENG_USER\.dsh\agent-sdk-bridge\codebuddy-cli\cn\logs\2026-11-18\desktop__c82342ee...log
C:\Users\XPENG_USER\.dsh\agent-sdk-bridge\codebuddy-cli\global\logs\2026-11-18\desktop__c82342ee...log
```

- 18:17 前后只有既存进程的 `WorkflowMemProbe` 心跳，没有新的 CLI 启动、没有错误、没有 Centrifugo 重连。
- 唯一的 `Disconnecting from Centrifugo` 出现在 16:54:31（pid 5720/24444），与本次事件无关。

### 3.5 不存在的日志

`C:\Users\XPENG_USER\AppData\Roaming\@deepseek-ai\dsh-desktop\logs` 为空目录 —— dsh 主进程（`dsh-desktop-host`，pid 16112）未把日志落盘，因此无法直接从主进程侧看到 plugin reload 记录，只能靠上述文件时间戳与事件流交叉印证。

---

## 四、机制分析（附代码位置）

### 4.1 插件被 dispose 时主动关闭所有内层会话

`src/host/index.ts` L358-L363：

```ts
// registerAdapter's disposer only withdraws the routes; the warm qodercli
// subprocesses are owned by the adapters and must close with the plugin.
ctx.effect(() => () => {
  adapters.cn.close()
  adapters.global.close()
  ;(adapters.codebuddy as CodeBuddyAdapter).close()
})
```

`CodeBuddyAdapter.close()` / Qoder 适配器的 `close()` → `sessions.closeAll()` → 每个会话 `close()`。

`src/host/providers/qoder/session.ts` L697-L703：

```ts
close(): void {
  if (this.disposed) return
  this.disposed = true
  ...
  if (this.q !== null) void this.q.close().catch(() => undefined)
}
```

### 4.2 会话被 close 被误报成「流意外结束」

`src/host/providers/qoder/session.ts` L833-L857：

```ts
private async consume(q: Query): Promise<void> {
  try {
    const iterator = q[Symbol.asyncIterator]()
    while (true) {
      const next = await iterator.next()
      if (next.done) break              // ← 宿主 close() 也会走到这里
      ...
    }
    this.endTurn({ kind: 'error',
      failure: { message: 'qoder session stream ended unexpectedly', code: 'STREAM_CLOSED' } })
  } catch (error) { ... }
}
```

**这是本次问题的核心缺陷**：正常的「宿主主动关闭」与异常的「上游断流」共用同一个错误出口，UI 只能呈现为「断线 / 重新连接」，无法区分是我方重载还是网络故障。

### 4.3 为什么「保存配置」可能直接重启 entry

`src/host/core/config.ts` L191-L227 中所有字段均带 `.volatile()`，理论上「volatile-only 写入不重启插件」，插件也通过 `Live<T>` thunk 在使用点读值。但 18:17 的观测结果表明：**profile patch 层整体重新 apply 时，entry 仍可能被重建**（写入时间 18:17:02 与流切断 18:17:04 相差 2 秒，且新值 400000 在下一轮立即生效）。
`src/host/index.ts` L349 已存在 `loader/volatile-update` 订阅，可用它做「真正不重启」的热更新路径。

### 4.4 为什么不是 host 进程崩溃

`dsh-desktop-host`（pid 16112）启动于 16:09:07，事件发生后仍在运行；`transportDropped` 全为 `0`；渲染进程与 GPU 进程未重启。因此排除「宿主崩溃导致的前端重连」。

---

## 五、对 `src/client` 的排除依据

| 检查项 | 结论 |
|---|---|
| 客户端路由 | 只有 `GET /models`、`GET /usage`、`GET/POST /auth`，全部只读或登录控制（`src/host/surface/api.ts`） |
| 请求超时 | `api()` 默认 30s；`/usage` 45s；`/auth` 10s，超时只影响卡片状态（`src/client/api.ts` L40-L61） |
| 定时器 | 唯一 `setInterval(…, 1500)` 仅在 `auth.running === true` 时生效（`src/client/components/codebuddy-card.tsx` L139-L143）；18:17 无登录流程（`codebuddy-state.json` 两个 region 均 `signedIn:false`，最后写入 17:46:47） |
| 能否影响传输 | 不能。所有写操作走宿主自己的 revision-fenced config form（`configForms`），不存在直接操作 transport 的代码 |
| 旁证 | `operations.jsonl` 中 `transportDropped` 全为 `0` |

**可能的间接关联**：若 18:17:02 的 patch 写入来自「设置页保存配置」（例如把 `intlModelContextWindows.dfmodel` 改为 400000），则 client 是扳机，但断链发生在 host（4.1 / 4.2）。这是目前唯一需要进一步确认的分支。

---

## 六、次要发现（与本次重连无关，但建议处理）

1. **CodeBuddy 内层进程滞留**：当前 11 个 `codebuddy-headless` 常驻子进程，合计约 **1.8 GB** 内存，最早 16:14:57 启动，之后只打内存心跳。

   | pid | RSS | 启动时间 |
   |---|---|---|
   | 35340 | 188MB | 16:14:57 |
   | 34632 | 200MB | 16:18:40 |
   | 34868 | 183MB | 16:52:20 |
   | 24444 | 193MB | 16:52:27 |
   | 9296 | 153MB | 16:53:12 |
   | 14140 | 137MB | 16:54:31 |
   | 31852 | 147MB | 16:54:58 |
   | 1236 | 136MB | 16:55:05 |
   | 13036 | 174MB | 16:55:16 |
   | 36652 | 142MB | 16:55:20 |
   | 15568 | 172MB | 17:46:44 |

   `maxSessions` 默认 8（`config.ts` L219），但两个 region 各自一个 manager，加上 catalog/control 会话会突破该上限；且这些会话在未登录、空闲状态也不会被回收。

2. **多项目会话并行**：同一会话内 `turn 2` 持续 31 分钟、50 步，插件重装正好落在其中，放大了中断的可见性。

---

## 七、修复建议

### P0：区分「宿主主动关闭」与「真实断流」

在 Qoder / CodeBuddy Session 中增加 `closedByHost` 标记：`close()` 内先置位，`consume()` 结束时若为真则 `endTurn({ kind: 'aborted', reason: { kind: 'reload' } })`，不再抛 `STREAM_CLOSED`。收益：重载/配置变更不再伪装成网络故障。

### P1：重载不打断进行中的轮次

- 让配置写入走 `loader/volatile-update`（`src/host/index.ts` L349）在不重建 entry 的前提下热更新；
- 插件管理器层面：检测到存在进行中的 turn 时，延后 uninstall/install 或在 UI 上明确提示「会中断当前对话」。

### P1：回收空闲内层会话

为内层会话增加 idle TTL；`logout` / region 切换时强制 `closeAll()` 并回收子进程，避免 1.8 GB 常驻。

### P2：补齐可观测性

dsh 主进程不落盘日志，建议插件自身把 `dispose`、`closeAll`、`session spawn/exit`、配置写入写入 `~/.dsh/agent-sdk-bridge/*.log`（带毫秒时间戳与 pid），本次这类问题即可一次定位。

---

## 八、待确认项 / 如何最终确认

尚未确定的是：18:17:02 那次 patch 写入的操作来源（设置页保存 vs 插件重装的第一步禁用）。验证方式：

1. 在 `src/host/index.ts` 的 dispose effect 与 `src/host/surface/api.ts` 的写入口各加一行带时间戳的日志；
2. 复现「对话进行中保存一次模型上下文窗口配置」，观察是否出现同一组 `patch 写入 → STREAM_CLOSED` 时间戳；
3. 复现「对话进行中重装插件」，对比两者的日志特征差异（是否伴随 `remove/install` 操作记录）。

---

## 附录：关键日志原文

```
[2026/11/18 18:31:50.668] [Debug] [pid=13036] [AgentModelResolver] resolved 18 agents, no model id changes
[2026/11/18 18:32:03.188] [Info]  [pid=31852] [cbc-kw=WORKFLOW] [WorkflowMemProbe] tick runId=(none) | rss=150MB ...
（CodeBuddy CLI 日志在 18:17 前后无异常，仅心跳）
```

```
18:17:04  turn/end  {"kind":"error","error":{"message":"qoder session stream ended unexpectedly","code":"STREAM_CLOSED"}}
18:17:42  turn/start turn=3  request/context provider=qoder-intl model=dfmodel contextWindow=400000
```
