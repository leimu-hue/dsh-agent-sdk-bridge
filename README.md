# dsh-agent-sdk-bridge

把 **Qoder CN**、**Qoder 国际版** 与 **CodeBuddy** 订阅接入
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 LLM 适配器插件。

- **官方 SDK**：Qoder 用 [`@qodercn-ai/qodercn-agent-sdk`](https://www.npmjs.com/package/@qodercn-ai/qodercn-agent-sdk)
  与 [`@qoder-ai/qoder-agent-sdk`](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk)；
  CodeBuddy 用 [`@tencent-ai/agent-sdk`](https://www.npmjs.com/package/@tencent-ai/agent-sdk)。
- **零凭据**：复用本机 CLI 登录态，不需要 API key。
- **额度可见**：Qoder 显示套餐、已用百分比、剩余 credits、加量包与到期时间；CodeBuddy 通过其
  计费接口显示积分余额与各积分包（与官方账号页同源），卡片上的「用量明细」可直接打开当前区域
  官网的用量页。
- **三套设置页**：Qoder CN / Qoder 国际版 / CodeBuddy，各自独立的模型开关、
  上下文窗口与登录面板。

## 为什么需要它

本项目直接依赖各家**官方 SDK** 完成调用：

- Qoder CN 使用 [`@qodercn-ai/qodercn-agent-sdk`](https://www.npmjs.com/package/@qodercn-ai/qodercn-agent-sdk)，
  Qoder 国际版使用 [`@qoder-ai/qoder-agent-sdk`](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk)；
- CodeBuddy 使用 [`@tencent-ai/agent-sdk`](https://www.npmjs.com/package/@tencent-ai/agent-sdk)，由其自带 CLI 管理登录与会话。

登录、模型目录、会话生命周期与工具循环都交给官方实现；插件只负责把 DSH 的 LLM 请求翻译成
对应的 SDK 调用，再把流式回复、工具调用和用量翻译回来。这样行为始终与官方客户端保持一致，
上游升级时也只需跟随其接口，而不是维护一套自写的协议实现。

由于 Qoder 两家发行版各有一个独立的官方 SDK，且品牌在编译期写死，本插件按 provider 分别加载
对应的 SDK、分别建立会话，账号、模型目录与登录态互不串台。

## 安装

### 1. 装插件

**插件 → 添加插件**，填 github 仓库地址。

若提示**「需要允许安装脚本」**（SDK 下载自己的 worker runtime），点「允许这些脚本并重试」即可；
不授权也能用，SDK 会回退到 PATH 上的系统 CLI。

### 2. 登录

插件不持有凭据，内层会话直接复用对应 CLI 的登录态：

| 版本 | npm 包 | 登录方式 | 登录态目录 |
|---|---|---|---|
| Qoder CN | `@qodercn-ai/qoderclicn` | `qoderclicn login` | `~/.qoder-cn/.auth` |
| Qoder 国际版 | `@qoder-ai/qodercli` | `qodercli login` | `~/.qoder/.auth` |
| CodeBuddy | `@tencent-ai/agent-sdk`（已随插件安装） | 页面选择区域后点「登录」 | 由 CodeBuddy CLI 管理 |

**设置 → CodeBuddy** → 顶部选择「国际版（codebuddy.ai）」或「国内版
（copilot.tencent.com）」，点「登录」后在浏览器完成授权。两个区域的登录凭据分别保存在本机
（`~/.dsh/agent-sdk-bridge/codebuddy-state.json`，权限 0600），切换区域会立即恢复对应账号的
账号、额度与模型表，各自启用哪些模型和上下文窗口也按区域独立保存；未登录时不会读取或显示
模型目录。浏览器由 CodeBuddy CLI 打开，插件不再重复打开。企业域名 / IOA 登录不在支持范围内。

> 插件**不再随包附带安装/登录脚本**，也不代为执行 `npm install`：每个厂商的包名、推荐版本和
> 参数都会变。设置页只报告该 CLI 在本机是否就位，并说明安装与登录由你在终端完成，
> 所以页面上的说法不会随上游命令变化而腐烂。

也可以手动执行 Qoder 的两步：

```bash
npm install -g @qodercn-ai/qoderclicn && qoderclicn login   # Qoder CN
npm install -g @qoder-ai/qodercli       && qodercli login    # 国际版
```

`qoderclicn status` / `qodercli status` 能列出 `Username` 即登录成功。

> `QODERCLI_PATH` 若指向另一版本的 CLI，对应版本会明确报错，而不是借用那个账号回答。国际版
> 专用覆盖变量是 `QODER_CLI_PATH`。

## 设置页

**设置 → Qoder CN**、**设置 → Qoder 国际版**、**设置 → CodeBuddy**
是三个独立入口：

- **额度 / 登录卡片**：Qoder 显示套餐、已用百分比进度、套餐 / 加量包 / 组织资源包剩余量、到期时间，
  以及官方用量与升级链接；CodeBuddy 显示登录区域、账号、积分余额与已用百分比，积分包默认折叠为
  一行摘要（包数、合计额度、最近到期），点「详细信息」才在限高滚动区里展开逐包明细
  （通过其账号页使用的计费接口读取）。
- **模型清单**：来自账号实时目录，逐个启用 / 关闭、指定上下文窗口；倍率取自上游报价。
- **高级设置**：并发会话数、目录缓存、超时、默认思考档位、模型别名、分组名称等，可折叠。
  其中 `maxSessions` 只约束**空闲**会话，正在进行的轮次不会被驱逐；
  `disposeDrainSeconds`（默认 120 秒）决定插件被重载/停用时给进行中轮次留多少时间跑完，
  `0` 表示立即关闭（会截断正在生成的回答）；`traceEnabled` 控制插件自身的日志。
- **CLI 提示**：Qoder 页面底部显示该 CLI 的安装与登录命令，以及本机是否已检测到
  它；插件不安装、不登录，命令以文本给出。
- 再次打开页面时**先显示上次快照**，模型与账户在后台更新，不再每次都停在「正在读取」。

每个 provider 只注册一条路由（`qoder-cn` / `qoder-intl` / `codebuddy`），只服务
订阅自带的模型；BYOK 自定义模型会被过滤掉。

三个入口是否出现，在**插件 → Agent SDK Bridge → 启用的版本**里控制。关闭后对应的设置页、模型
列表、选择器分组与 provider 路由一起移除；已保存的模型选择保留，重新打开即可恢复。

## 用 YAML 配置

设置页之外，也可以直接写进 profile 的 `cordis.patch.yml`：

```yaml
- id: llm-qoder-cn
  name: dsh-agent-sdk-bridge
  config:
    cnEnabled: true
    intlEnabled: false                # 关闭国际版：设置页与模型分组一起移除
    displayName: Qoder CN (工作号)
    intlDisplayName: Qoder (Global)
    maxSessions: 4
    disabledModels: [mmodel]          # CN：关闭的模型
    modelContextWindows:
      qmodel_38max: 1000000           # CN：按模型指定窗口（token）
    intlDisabledModels: [auto]        # 国际版：独立的关闭清单
    intlModelContextWindows:
      dmodel: 1000000
    intlModelAliases:
      claude-sonnet: dmodel
    codebuddyRegion: cn                 # global（国际版）或 cn（国内版）
    codebuddyDisplayName: CodeBuddy
    codebuddyCnDisabledModels: [glm-5.2]
    codebuddyCnModelContextWindows:
      glm-5.3: 1000000
    codebuddyModelAliases:
      cb-fast: fast-model
```

各个 provider 的模型开关、窗口和别名是**分开的字段**；并发会话数、超时、思考档位等运行参数共享。

## 排查：对话「突然中断」

插件把会话启停、轮次结束与插件装载写进 `~/.dsh/agent-sdk-bridge/bridge.log`
（JSONL，每行带毫秒时间戳、`boot`（本次模块装载标识）与 `pid`，4 MB 轮转一次，由
`traceEnabled` 开关控制）。「重新连接」类问题先看这里：

| 日志里出现 | 含义 |
|---|---|
| `apply` 的 `n` 变成 2 或 `boot` 变化 | 插件 entry 被**重建**了（不是热更新），当轮会被中断 |
| 只有 `volatile-update`、没有新的 `apply` | 设置是**热更新**，没有重启，也就不会打断对话 |
| `session/drain` 后跟 `turn/end kind=stop` | 重载时正在跑的一轮被放行到自然结束，回答完整 |
| `turn/end kind=aborted code=ABORTED` | 会话被宿主关闭（重载/回收/换账号），不是故障，重发即可继续 |
| `session/stream-ended` | 上游流自己结束了（真实断流），这才会报 `STREAM_CLOSED` |
| `session/spawn` / `session/close` 的 `aliveMs` | 一个内层子进程的完整生命周期 |

## 免责声明

本项目仅供个人学习和研究使用，请勿用于商业用途或超出个人合理使用的场景。

上游条款由你遵守。使用各渠道即表示你同意对应上游的服务条款与用量政策；因违反上游政策导致的
限流、封禁或其它后果由使用者自行承担。插件不对任何上游的可用性、准确性或连续性作任何承诺。

## 许可

MIT。本仓库是 [JiamingZang/dsh-llm-qodersdk](https://github.com/JiamingZang/dsh-llm-qodersdk)
（MIT）的衍生作品，上游许可与版权声明保留在 [`LICENSE.original`](./LICENSE.original)，出处与
改动清单见 [`NOTICE`](./NOTICE)。