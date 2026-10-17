# pace

[English](README.md)

在终端里为 Claude Code 把控用量节奏。pace 在你工作时把 5 小时额度和每周额度与时间进度对照显示，给每条提示估价，并防止长时间运行的会话 **gassed out（油尽）**：额度用完、一直卡到重置。

灵感来自 [weektoken](https://github.com/3dnow/claude-mods/tree/main/weektoken)，一个 Claude Code 的额度配速图表。pace 是对这个想法的独立实现：以终端为先的移植版本，并加入了一些小升级和易用性改进。

## 显示内容

- **提示框上方的横条：** 5 小时和每周额度的进度条，各自带有配速状态和对应的使用速率，然后是提示缓存的倒计时，以及下一条提示的成本。
- **状态栏条目**，或者设置 `placement: status` 后，由你的状态栏命令打印的一整行。
- **`/pace`：** 在独立的终端窗口中全屏显示每个额度的燃尽图。终端够宽时分两栏。按键：`1`–`9` 单独显示一个额度，`w` 切换保温模式，`r` 刷新，`q` 退出。`/pace pane` 在 Claude Code 内的面板中显示同样内容。

`/pace` 立即执行（即使在一轮对话进行中），并以弹出提示回应。不会写进对话，所以从不占用上下文。

## 状态

| 状态 | 含义 |
| --- | --- |
| Under pace（低于配速） | 用量少于已过去的时间 |
| On pace（贴合配速） | 与均匀配速相差不到几个百分点 |
| Over pace（超速） | 用量快于时间进度 |
| **Gassed out（油尽）** | 额度已用完：重置前提示都会失败 |

每个额度都会显示**按当前速率会落在哪里**：照这样继续发送提示，到重置时会用到的百分比（`→ 71% at reset`），若会提前用完，则显示何时用完（`out in 38m`）。越接近重置，落点越接近已用量，因此直到最后一分钟都清晰可读。尚未得出单次提示成本的额度显示 `→ —`。某个模型自己的周额度只计入发给该模型的提示和花费：使用 Opus 不会推高 Fable 周额度的速率。针对某个额度的速率分为 **steady（平稳）**、**brisk（偏快，接近预算）**、**burst（爆发：照此持续会提前用完，但平均仍在配速内）** 和 **too fast（过快：会在重置前用完，且已经超速）**。

只有 **too fast** 会闪红，而且只在你正在发送提示时出现。超速的额度若最近 15 分钟内没有提示，则显示为 idle（空闲）：状态仍是“超速”，但不会闪烁，因为你此刻并没有让它变得更糟。尚未得出单次提示成本时，正在提示的超速额度显示 `▲ over pace · no cost yet`，同样不闪烁：还没有依据表明这个速率会用完它。

## 多个并行会话共同配速

每个会话把自己的花费记录到所有会话共享的存储中。配速按所有会话合计的每小时美元花费，对照每个额度剩余的部分来判断，所以同时开五个会话也会被当作同一份预算。一条提示的成本 = 每美元消耗多少额度（从过去一周的读数学习）× 最近每条提示的美元花费，因此从第一条提示起就有估值。

pace 在每个窗口内只提醒一次，以弹出提示和系统通知：额度用到 80% 和 95% 时、当前速率会在重置前导致油尽时、以及已经油尽时。

## On pace 模式

`/pace on` 让长时间运行的会话保持在配速内：

- 每轮结束后，如果上下文已很重（窗口的 60%），趁缓存仍然有效时压缩（此时压缩最便宜）
- 防止空闲的缓存过期：上下文大时压缩，小时发送一次轻量请求保温
- 在额度油尽前提醒

`/pace off` 关闭。

## 自动模式

`/pace auto <计划文件> [轮数]` 在无人值守的情况下逐步完成一份计划或路线图。第一次使用时，会弹出面板说明它会做什么、以及它会自行消耗额度；按下 Start 后才开始。

- 每轮结束后 pace 发送下一条提示，直到 Claude 以 `PACE: DONE` 或 `PACE: BLOCKED` 结束一轮，或达到轮数上限（默认 40）。
- 它不会为只是等待的一轮发送提示。Claude 在等待后台任务（测试运行、子代理、CI）时，会以 `PACE: WAITING <内容>` 结束这一轮，pace 不再发送任何提示：后台任务完成时 Claude Code 会自行开始下一轮，若 15 分钟仍无结果，pace 会提醒检查一次。连续两轮既未改动计划文件也未改动 `.pace/handoff.md` 视为没有进展：pace 停止发送提示，依次等待 5、10、20、30 分钟，直到某一轮再次推进计划。
- 它会用推荐选项回答 Claude 的提问。
- 它让 Claude 把搜索和常规修改交给使用更轻量模型的子代理，并保持 `.pace/handoff.md` 更新。当上下文变重，或缓存已过期且上下文很大时，pace 会清空上下文并从该文件继续。
- 当速率会导致额度油尽、或某个额度已油尽时，它会暂停等待，直到重置。
- 它会同时开启 on pace 模式。

自动模式、配速模式和保温模式只属于开启它们的会话：其他会话不会执行你的计划，`claude --resume` 可以继续之前的运行。横条和状态栏条目在所有会话中一致；额度、提示和花费在会话间共享，因此所有会话按同一预算配速。

它的指令是固定的系统提示片段，因此提示缓存能保留它们；实时的配速提示则放在每条提示中。`/pace auto off` 停止；中断会暂停它，直到 `/pace auto resume`。

## 供其他插件使用

pace 在引擎上添加了 `$.pace`。在你的 `plugin.json` 的 `dependencies` 中列出 `pace`，Claude Code 就会把它的类型放进你的插件。

```ts
const snap = await $.pace.snapshot()
snap.quotas        // [{ key, name, percent, status, resetsAt, runOutAt, rate: { level, percentAtReset, emptyIn, percentPerHour, usdPerHour, … } }]
snap.cache         // { tokens, secondsLeft, nextWarm, nextCold, nextWarmUsd, … } 或 null
snap.spend         // { usdPerHour, sessions, usdPerPrompt }
snap.gassedOut     // 有额度已用完
snap.modes         // { onPace, auto }
snap.advice        // [{ level, text }]
```

快照对应 `snap.at` 时刻：pace 在每次回复、每次读数和每分钟刷新它。

## 安装

```
/plugin install pace --marketplace Bruno-Tome/pace
```

`/pace` 窗口需要 macOS，以及 `PATH` 中能直接运行 TypeScript 的 Node（23.6 或更高）。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/pace` | 打开图表窗口（无法打开时改用面板） |
| `/pace pane` | 在面板中显示图表 |
| `/pace refresh` | 重新读取所有数据源 |
| `/pace on`、`/pace off` | On pace 模式 |
| `/pace auto <计划> [轮数]`、`auto off`、`auto resume` | 自动模式 |
| `/pace warm ping \| compact \| off` | 为空闲的缓存保温 |
| `/pace hide`、`/pace show` | 横条 |
| `/pace line on \| off` | 状态栏条目 |

## 选项

| 选项 | 取值 | 默认 |
| --- | --- | --- |
| `placement` | `above`（提示框上方的横条）或 `status`（写入 `~/.claude/pace-row.txt` 供状态栏打印） | `above` |
| `cacheTtl` | `auto`、`1h`、`5m` | `auto` |
| `terminal` | `/pace` 打开窗口所用的 macOS 应用 | `Terminal` |

## 数据来源

- **额度：** 每次回复后会话自身的速率限制读数、`~/.claude.json` 中 Claude Code 的用量缓存，以及 Anthropic 的用量接口（用于分模型额度），使用 Claude Code 自己的登录调用。pace 从不接触凭据。
- **花费：** 会话的费用账本，即 `/cost` 的合计。
- **局限：** pace 看不到的用量（claude.ai、另一台机器）会让额度变动却没有花费记录，使每美元看起来更贵。读数是整数百分点，所以一个额度的价格要等它变动 8 个百分点后才有。

pace 没有遥测。它发出的请求只有用量接口调用（与 `/usage` 相同），以及保温模式 `ping` 下读取缓存的一字模型调用。

它在 `~/.claude` 中写入的文件：`pace-row.txt`（状态栏行）、`pace-state.json` 和 `pace-keys.json`（窗口的数据与按键）、`pace-view.command`（窗口启动脚本）。自动模式会让 Claude 在你的项目中维护 `.pace/handoff.md`。

## 开发

```
claude --plugin-dir .        # 从此目录运行
claude plugin test .         # 运行测试
claude plugin validate .     # 检查引擎会拒绝什么
```

## 许可

MIT，见 [LICENSE](LICENSE)。
