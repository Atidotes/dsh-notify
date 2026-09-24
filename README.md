# dsh-notify — 审批 / 提问 / 任务完成的系统通知

不管你现在在哪个应用、在做什么，只要 DeepSeek Harness 这边出现下面三种情况之一，
就会立刻弹出一条**系统通知**（带 DeepSeek 官方彩色图标）—— 跟浏览器无关，页面关掉也能收到：

| 触发 | 事件 | 系统横幅 |
|---|---|---|
| 需要你审批 | `approval/request` | **DeepSeek Harness** ／ 🔐 需要审批：bash |
| 需要你回答 | `user-questions/request` | **DeepSeek Harness** ／ ❓ 需要你回答：要不要先跑一遍测试？ |
| 任务跑完了 | `agent/status` running → idle | **DeepSeek Harness** ／ ✅ 任务完成 · 1 分 23 秒 |

文案原则：**横幅只有一个标题 + 一句话**。标题固定是 `DeepSeek Harness`（不显示项目名），第二行是动作 + 最短的必要信息；长理由、长提问留在 feed 的 `detail` 字段里备查，不塞进横幅。**通知只在系统层面出现，页面里不再渲染任何卡片。** 想先看效果不用重启：

```bash
npm run preview    # 把三种通知的实际文案原样打出来
```

> **Windows 上「什么都没弹」？** 先跑 `npm run windows-check` 拿两段可粘进 PowerShell 的自检脚本，
> 再按 [Windows 排查顺序](#windows-上什么都没弹排查顺序) 走：90% 是「系统 Toast 被专注助手吞掉」
> 或「插件装了但没重启 DSH」。Windows 默认形态已经改成**自绘弹出窗**（不受专注助手影响）。


两条系统级通道，按可靠性排序（**没有页面内通知**）：

1. **系统通知（host 半，主通道）** — 直接调 macOS 通知中心，**跟浏览器无关**：切到任何 App、最小化浏览器、甚至把浏览器完全关掉都能看到；未处理的审批会按间隔反复提醒。
2. **浏览器系统通知（client 半，兜底）** — 仅当 host 半报告自己没有可用通道时（`diag.backend === 'none'`）才启用：改用浏览器 `Notification` 弹**系统横幅**，只要 DSH 这个标签页开着 —— 哪怕它在后台、你正在看别的网页 —— 都能收到。host 通道正常时这一半什么都不做（不重复打扰），页面上也不会出现任何东西（唯一例外：需要授权时会出现一条一次性的「开启浏览器通知」提示条）。

## 平台支持

| 能力 | macOS | Windows | Linux |
|---|---|---|---|
| 三种触发 / feed / SSE / 诊断路由 | ✅ | ✅ | ✅ |
| 系统通知（host 直发） | ✅ 自编译 Swift app | ✅ 自绘弹出窗（默认）/ SnoreToast / PowerShell Toast | ✅ notify-send |
| 官方彩色图标 | ✅ app 图标位 | ✅ 见下（各通道落点不同） | ✅ `notify-send -i` = 图标位 |
| 通知位置 | 系统决定（右上角） | ✅ 默认右上角（`banner`）；`toast` 时系统固定在右下角 | 系统决定 |
| 专注助手 / 勿扰 | 遵守（系统级） | `banner` 不受影响；`toast` 会被吞 | 遵守（系统级） |
| 浏览器兜底通知 | ✅ | ✅ | ✅ |
| 页面内卡片 | 已按需求移除 | — | — |
| 通知点击跳转 | 需 `terminal-notifier` | ❌ | ❌ |

### 图标：三个平台都支持官方彩色图标

| 平台 | 机制 | 落点 |
|---|---|---|
| macOS | 自建 Swift app 的 **app bundle 图标** | 通知左侧图标位（你截图里的位置） |
| Windows + PowerShell | Toast XML 的 **`appLogoOverride`** | 通知左侧图标位 —— 与 macOS 对齐 |
| Windows + SnoreToast | `-p <png>` | 通知**内部**的图片区（位置随模板/版本略有差异） |
| Windows + `banner` 模式 | 自绘窗口里的 `PictureBox` | 横幅左侧，64×64（**位置/尺寸完全可控**） |
| Linux | `notify-send -i <png 绝对路径>` | 通知图标位（GNOME / KDE / dunst 都是这个槽） |

Windows 的 toast 图片有平台限制：**≤ 1024×1024、≤ 200 KB、必须是本地 `file://` URI** ——
包内自带的 `deepseek.png`（512×512 / 88 KB）正好满足，无需额外处理。

> 想要 Windows 上「像 macOS 那样把官方图标放在左侧」，把 `backend` 设为 `powershell`
> （默认 auto 会优先 SnoreToast，那是为了免安装/免注册，图标落在通知内部）。

### Linux（开箱即用）

装了 libnotify 即可，插件自动检测（`notify-send` 不在 PATH 时退回 `command`）：

```bash
sudo apt install libnotify-bin     # Debian/Ubuntu
sudo pacman -S libnotify           # Arch
```

通知参数：`-a "DeepSeek Harness"`、`-i <包内官方彩色图标绝对路径>`、
审批/提问用 `-u critical`（桌面环境通常不会自动收起），完成用默认级别。

### Windows 的通知位置（系统 Toast 改不了）

Windows 的通知位置由系统固定在**右下角**，微软明确表示没有提供修改位置的选项，
SnoreToast / node-notifier 也都没有位置参数。想要**右上角**，只能自己画一个窗口 ——
这就是 Windows 的**默认形态** `banner`：

配置文件：`~/.dsh/dsh-notify/config.json`（Windows：`%USERPROFILE%\.dsh\dsh-notify\config.json`）。
**必须是严格 JSON —— 不能带注释**，带注释会解析失败、整个文件被忽略（回退到默认值）。

```json
{
  "windowsStyle": "banner",
  "bannerPosition": "topright",
  "bannerWidth": 350,
  "bannerMinWidth": 310,
  "bannerRadius": 40,
  "bannerDurationMs": 8000
}
```

| 键 | 可取值 | 说明 |
|---|---|---|
| `windowsStyle` | `banner`（默认）/ `toast` | `toast` = 系统通知（右下角、进通知中心、可能被专注助手吞） |
| `bannerPosition` | `topright`（默认）/ `topleft` / `bottomright` / `bottomleft` | 自绘弹出窗的位置 |
| `bannerWidth` | `350` | 宽度**上限**（96 DPI 下的逻辑像素）：卡片会按标题/正文自己收窄，不留一截空白 |
| `bannerMinWidth` | `310` | 宽度**下限**；把上下限设成同一个值 = 钉死宽度 |
| `bannerRadius` | `40` | 圆角半径（越大越圆）；自动夹在卡片高度的一半（= 胶囊形）以内 |
| `bannerHeight` | `0`（= 自适应） | 高度：**默认按正文行数自适应**（单行 ≈ 49、两行 ≈ 64），不留白；填正数则固定高度 |
| `bannerDurationMs` | `8000` | 自动关闭毫秒数；`0` = 一直显示到点击关闭 |

> ⚠️ 早前版本把 `bannerHeight` 默认成了 `84`。如果你当时照着写进过 `config.json`，
> **把那一行删掉（或设成 `0`）**，否则会钉死在 84 —— 正是「高度太高、留白太多」的来源。

想**强制**走自绘弹出窗（不看 `windowsStyle`、也不依赖默认值），再加一行
`"backend": "banner"` —— 这样连旧版本插件也会走右上角那条路。

效果：置顶、无边框的**通知卡片**，点击任意位置打开 DSH，到点自动消失。

外观按 **macOS 通知横幅** 对齐，并且**四周都不留空白**：**宽度按标题/正文里更长的那条量出来**
（默认 **310–350** 之间；正文右侧另留 16px 呼吸位，长提问最多 350 后换行）、**高度 = 标题 + 正文 +
底部 5px**（用 `TextRenderer.MeasureText` 量正文真实行高，单行 ≈ **49**、两行 ≈ **64**；
测量带 `NoPadding`，否则默认测量值里的边框留白会让卡片凭空高几像素）、**34×34** 官方
彩色图标（垂直居中）、**13px 半粗标题 + 12px 正文**、左内边距 10px / 右 16px、**圆角取满（胶囊）**、
1px 描边、浅色卡片（**深色主题下自动变深色** —— 跟随 Windows 的「应用模式」设置）。

> 卡片实际几何会写进 stderr（形如 `dsh-notify 卡片 360x49（正文 16px / scale 1）`），
> 在 `diag.lastStderr` 里能看到 —— 觉得还高/还矮时，把这个数字发出来即可。

> **关于「弹出窗太大 / 留白太多 / 太长 / 太短 / 不够圆」**：宽度贴着内容（310–350）、高度按正文
> 行数自适应（单行 ≈ 62），上下留白对称（14 / 12）、图标 38px。**圆角上限 = 卡片高度的一半**，所以「更圆」
> 需要卡片略高；脚本还会先声明 **DPI 感知**（`SetProcessDPIAware`）
> 再按 `DpiX / 96` 缩放全部版式。想钉死尺寸：`bannerMinWidth` = `bannerWidth` 固定宽，
> `bannerHeight` > 0 固定高。不做这一步时，150% / 200% 缩放的屏幕上 Windows 会把
> 整个窗口当位图放大 —— 又大又糊，这才是「太大」的根因；同时 `AutoScaleMode`
> 设为 `None`，字号用「点」交给 GDI+ 按屏幕 DPI 换算。
>
> **故障隔离（真机踩过的坑）**：整段脚本外层有 `try/catch`，但**装饰性语句各自还带
> 一层** —— DPI、主题、图标、字体、圆角、描边任何一条失败都只丢一点外观，并把原因
> `Write-Warning` 到 stderr（进 `diag.lastStderr`），**横幅本身照弹**。
> 早期版本把整段套一个 try/catch，结果某条装饰语句报错就让整条通知消失（exit 1），
> 表现是「Windows 上什么都没有」。
>
> **兜底**：万一横幅整体失败（PowerShell 报错 / WinForms 不可用），插件会**自动退回
> 系统 Toast**，`diag.lastFallback` 记 `toast`，`diag.lastError` 保留横幅失败的原因 ——
> 「什么都没弹」这个最差的结果不允许出现。

**为什么默认是它**：系统 Toast 会被**专注助手 / 勿扰 / 通知总开关 / AUMID 未注册**
静默吞掉 —— 表现就是「Windows 上什么都没弹」，而且插件完全看不出来（命令跑成功了，
只是系统没显示）。自绘窗口不受这些影响，是「一定要弹出来」唯一可靠的形态。

> 代价说清楚：`banner` **不是系统通知** —— 不进「通知中心」、不受专注助手管理、
> 错过就没了。想要进通知中心的系统 Toast，把 `windowsStyle` 设成 `'toast'`。
> 审批这类「等用户处理」的场景，插件本来就会每 30 秒重提醒（新横幅会再出现一条）。

### Windows 的三种形态

`windowsStyle: 'toast'` 时按优先级自动挑（`windowsStyle: 'banner'` 是默认，直接走 PowerShell + WinForms 自绘横幅，`backend: 'banner'` 也能强制指定）：

1. **SnoreToast**（auto 优先）：单文件 exe、无需注册 AUMID、支持通知内图片
   ```json
   { "snoretoastCommand": "C:\\tools\\SnoreToast.exe" }
   ```
2. **PowerShell WinRT Toast**（免安装兜底，也是**图标落点最好**的那条）：
   用 `ToastGeneric` 模板 + `appLogoOverride` 把官方图标放进通知左侧（与 macOS 对齐）；
   默认借系统 PowerShell 的 AppUserModelID，所以免注册也能弹，代价是应用名显示为
   「Windows PowerShell」—— 想换成自己的名字，注册一个 AUMID 并填 `windowsAppId`。
3. 都没有 → 用 `command` 模板接你自己的通知工具。

### Windows 上「什么都没弹」排查顺序

按这个顺序，三步就能定位（前两步那条命令在**跑 DSH 的那台 Windows** 上执行）：

```powershell
# ① 插件到底有没有在这台机器上跑起来、走的是哪条通道、命令有没有失败
curl.exe -s "http://127.0.0.1:3080/dsh-notify/feed?since=0"
```

| 结果 | 含义 | 下一步 |
|---|---|---|
| HTTP 404 | 插件没装 / 没启用 | 装 bundle，然后**重启 DSH** |
| `diag.backend: "none"` | 没有可用通道 | 确认 `powershell.exe` 在 PATH（或装 SnoreToast） |
| `diag.failed > 0` + `lastStderr` | 通知命令跑了但报错 | `lastStderr` 就是 PowerShell 的原话，照着修 |
| `delivered > 0`、`failed: 0`，但屏幕上什么都没有 | 命令成功了、系统没显示 | 最典型就是**专注助手**吞掉 Toast → 用默认的 `banner` 形态 |
| 弹出来的是**右下角**的「Windows PowerShell」通知 | 走的是系统 Toast，不是自绘弹出窗 | 看 `windowsStyle`：是 `toast` 就改成 `banner`（见下），是旧版代码则更新 + 重启 |
| 没有弹出窗，但右下角有 Toast | 横幅命令失败了，这是自动兜底 | 看 `diag.lastError` / `lastStderr`，那里是 PowerShell 的原话 |
| 弹出窗出现了，但外观/尺寸不对 | 某条装饰性语句降级了 | `diag.lastStderr` 里会有 `dsh-notify 横幅降级：…` |

```powershell
# ② 直接验证「弹出窗」能不能画出来（用的就是插件会 spawn 的那段脚本）
npm run windows-check
```

把输出里的第 1 段整条粘进 **Windows PowerShell 5.1**（不是 PowerShell 7）回车：
右上角出现深色小窗 = 命令层面完全没问题，剩下的只是插件侧（装没装 / 重启没重启）。

```text
③ 仍然什么都没有 → 就差这一步
```

- 插件改动（含本文件）**必须重启 DSH** 才生效：JS 模块在 host 进程里按代际缓存。
- 关掉**专注助手 / 勿扰**，或直接用默认的 `banner`（不受它管）。
- PowerShell 7（`pwsh`）**不支持** WinRT 类型解析，Toast 那条会失败；插件会自动找
  `powershell.exe`（5.1）优先，`windows-check` 第 2 段可以单独验证 Toast 路线。

> ⚠️ 诚实说明：Windows / Linux 后端是按两平台的官方机制实现、并用**参数级单元测试**
> 覆盖的（59 条冒烟里 7 条直接覆盖这两个平台），但我手上没有 Windows/Linux 机器做真机验证。
> macOS 那条路是真机跑通的；Windows 上出问题就用 `npm run windows-check` 生成的两段
> 自检脚本（就是插件真正会 spawn 的那两条命令）在真机上单独验。

### 自定义命令（任意平台）

`backend: 'command'` + `command` 模板，占位符 `{title}` `{subtitle}` `{body}` `{app}` `{icon}`：

```json
{ "backend": "command",
  "command": ["notify-send", "-a", "{app}", "-i", "{icon}", "{title}", "{body}"] }
```

### 两类图标，别混

| | 用什么 | 哪里看得到 |
|---|---|---|
| **插件卡片图标** | 本包自己的绿色消息气泡 [icon.svg](./icon.svg) | Harness 的插件列表 / 设置里的插件条目 |
| **系统通知图标** | DeepSeek 官方图标 [dsh/deepseek.icns](./dsh/deepseek.icns) | macOS 通知中心的横幅（由自建的 Swift 通知 app 承载） |

两者互不相干：前者是这个插件在 Harness 里的身份，后者是你希望在系统通知里看到的品牌标识。

![图标](./icon.svg)

## 安装

```bash
# 用 harness 的 plugin_manager：
#   action: install_bundle, target: /Users/you/work/deepseek/deepseek-plugin/dsh-notify
# 或命令行：
dsh plugin --profile web add /Users/you/work/deepseek/deepseek-plugin/dsh-notify
```

安装后 profile 的 `dsh.profile.bundles` 会多出 `dsh-notify`，`cordis.patch.yml` 自动生效，无需手改 profile。

> **改了代码要让运行中的 DSH 生效，必须重启一次 app。**
> 已安装插件的 JS 模块在 host 进程里是按代际缓存的：单文件改动、禁用再启用、甚至移除后重装，都只会复用旧模块；`cordis.yml` 这类配置是热更新的，但模块不是。重启后浏览器再刷新一次页面（拿新的 client 半）。

## 架构

```
host 半（通知引擎，唯一事件观察者）
  approval/request        ← ctx.on(..., { prepend: true })
  user-questions/request  ← ctx.on(..., { prepend: true })
  agent/status            ← emit，所有监听都会执行
        │
        ├─→ ① 系统通知：terminal-notifier / osascript / 自定义命令
        │        （跟浏览器无关，关掉浏览器也在）
        └─→ 环形缓冲 + SSE 推送 + GET /dsh-notify/feed（轮询兜底）
                              │
client 半（只做兜底）──────────┘ host 无通道时 → 浏览器 Notification 补位
                                 （弹的也是系统横幅；页面开着即可）
```

数据面用 **SSE 长连接**（`/dsh-notify/stream`），轮询（`/dsh-notify/feed`）只作兜底：后台标签页里浏览器会限流定时器（Chrome 挂后台几分钟后降到每分钟一次），长连接不受影响。

### 为什么审批观察者必须 `prepend`

`approval/request` 与 `user-questions/request` 都是 **waterfall**：先注册的监听会直接把请求「领走」并等用户作答，**排在后面的监听根本不会被调用**。内置的 `ui-approval` 就是这样的 gate，所以普通 `ctx.on(...)` 注册的观察者收不到任何审批事件 —— 浏览器侧的 `ctx.remote.$on` 更连 options 参数都没有，抢不到链首。

这是本插件第一版实测时踩到的坑（页面上只有审批弹窗、没有任何通知）。修法是 `ctx.on(event, listener, { prepend: true })` 把观察者插到链首：**先发通知，再原样 `next()` 把请求交还下游**。该能力在 harness 自己的 `user-approval` 源码注释里有明确记载。

### 为什么客户端不直接订阅事件

同一条 waterfall 规则决定了客户端 `$on('approval/request')` 同样会被 gate 跳过，所以审批/提问的观察权统一交给 host 半，客户端只消费 `/dsh-notify/feed` 的结果 —— 既不会漏通知，也少了一条可能与审批互相干扰的监听。

### 为什么「页面关掉也能收到」

浏览器里的 toast 只活在页面里；host 进程（正在服务 `http://127.0.0.1:3080` 的那个进程）一直活着，所以由它直接调系统通知：

```
terminal-notifier（装了就用它：可点击打开页面、-group 去重）
        │  没装
        ▼
osascript `display notification`（macOS 自带，永远可用）
        │  非 macOS
        ▼
config.command 自定义 argv（PowerShell toast / notify-send …）
```

`osascript` 用 `on run argv` 收参，**不做任何字符串拼接**，所以中文、引号、反斜杠都不会破坏脚本。

## 配置

默认值写在 `dsh/host.js` 的 `DEFAULT_CONFIG` 里，也可以用**外部配置文件**覆盖（不改代码、各平台一致）：

```json
{ "remindEveryMs": 60000, "titleFrom": "project",
  "backend": "command",
  "command": ["notify-send", "-a", "{app}", "-i", "{icon}", "{title}", "{body}"] }
```

（同上：严格 JSON，不能带注释。）

下面的表就是全部可调项：

| 键 | 默认 | 含义 |
|---|---|---|
| `approval` / `question` / `done` | `true` | 三个触发点各自开关 |
| `titleFrom` | `app` | 唯一标题取什么：`app`（固定 `fallbackName`）或 `project`（项目名） |
| `fallbackName` | `DeepSeek Harness` | `titleFrom: 'app'` 时的标题 |
| `appName` | `DeepSeek Harness` | 通知的应用身份：自建通知 app 的名字（见下） |
| `notifierDir` | `~/.dsh/dsh-notify` | 通知 app 的存放目录（含 queue/ 与编译缓存） |
| `iconPath` | 包内 `dsh/deepseek.icns` | 通知图标（官方 DeepSeek 图标） |
| `iconPngPath` | 包内 `dsh/deepseek.png` | 给 terminal-notifier `-appIcon` 用的 PNG |
| `subtitle` | 空 | 横幅第二行（应用名）；默认空 = 不显示，两行最干净 |
| `snippetChars` | `24` | 横幅里附带的提问片段上限；越小越简洁 |
| `detailChars` | `120` | feed 里 `detail` 字段的长度上限（页面不显示，仅供诊断/其它消费者） |
| `sound` | `Glass` | macOS 提示音名；空串静音（可选 `Ping` `Hero` `Morse` …） |
| `remindEveryMs` | `30000` | 未处理的审批多久再提醒一次；`0` = 只提醒一次 |
| `maxReminders` | `10` | 同一条审批最多提醒多少次（默认约 5 分钟后停止提醒）|
| `minRunMs` | `3000` | 跑多久才算「值得通知」，避免秒回也弹窗 |
| `includeSubagents` | `false` | 子代理 / teammate 会话是否也通知 |
| `backend` | `auto` | `auto` / `osascript` / `terminal-notifier` / `notify-send` / `snoretoast` / `powershell` / `banner` / `command` |
| `command` | — | `backend: 'command'` 时的 argv 模板，占位符 `{title}` `{subtitle}` `{body}` |
| `openUrl` | `http://127.0.0.1:3080` | 点击通知打开的地址（仅 terminal-notifier 支持） |
| `windowsStyle` | `banner` | Windows 通知形态：`banner`（自绘弹出窗，不受专注助手影响）或 `toast`（系统通知，进通知中心） |
| `bannerPosition` | `topright` | banner 位置：`topright` / `topleft` / `bottomright` / `bottomleft` |
| `bannerWidth` | `350` | banner 宽度上限（逻辑像素） |
| `bannerMinWidth` | `310` | banner 宽度下限 |
| `bannerRadius` | `40` | banner 圆角半径（上限 = 高度一半） |
| `bannerHeight` | `0` | banner 高度：`0` = 按正文行数自适应（推荐）；正数 = 固定高度 |
| `bannerDurationMs` | `8000` | banner 自动关闭毫秒数；`0` = 一直显示到手动关闭 |
| `snoretoastCommand` | `SnoreToast.exe` | Windows：SnoreToast 的命令名或绝对路径 |
| `windowsAppId` | 系统 PowerShell 的 AUMID | Windows：PowerShell Toast 用的 AppUserModelID |
| `linuxUrgentUrgency` | `critical` | Linux：审批/提问的 `notify-send -u` 级别 |
| `feedPath` | `/dsh-notify/feed` | 页面轮询兜底的同源路由 |
| `streamPath` | `/dsh-notify/stream` | 页面 SSE 即时推送的同源路由 |

## 诊断

```bash
# 通知数据源 + 运行时诊断（通道、最近错误、最近命令、投递计数）
curl -s 'http://127.0.0.1:3080/dsh-notify/feed?since=0'
```

返回示例：

```json
{ "head": 3,
  "items": [{ "seq": 1, "kind": "approval", "name": "deepseek-plugin", "body": "🔐 bash 需要你审批…" }],
  "diag": { "platform": "darwin", "subprocess": true, "backend": "osascript",
            "backendConfig": "auto", "windowsStyle": "banner",
            "delivered": 3, "failed": 0, "lastError": null,
            "lastCommand": "/usr/bin/osascript -e on run argv",
            "lastExitCode": 0, "lastStderr": null, "lastDeliveredAt": 1790165239653,
            "streams": 1 } }
```

- `backend: "osascript"` → 主通道正常（跟浏览器无关）；`"none"` → 主通道不可用，页面会亮出「开启浏览器通知」的提示条走兜底。
- `streams` → 当前连着的页面数（SSE 长连接）。
- `backend` → 实际选中的通道；`backendConfig` / `windowsStyle` → **生效的配置值**。
  Windows 上「弹的是右下角 Toast 还是右上角弹出窗」就由后两个值决定 —— 如果
  `windowsStyle` 是 `toast`，说明被 `config.json` 覆盖了（不是默认值 `banner`）。
- `delivered` → 已 spawn 的通知命令数；`failed` → 其中**非 0 退出**的次数。
- `lastFallback` → 横幅失败后退回系统 Toast 时记 `toast`（区分「本来就该弹 Toast」和「兜底」）。
- `lastError` / `lastExitCode` / `lastStderr` → 最近一次失败的原因、退出码、命令的 stderr 尾巴。
  PowerShell 出错时**退出码经常是 0**，所以脚本被包成「失败就非 0 退出 + 写 stderr」，
  Windows 上「什么都没弹」时这三个字段就是根因所在。

## 自检与验证

```bash
npm run check                    # manifest / 语法 / patch / 图标素材 / 抢位 / SSE 断言
npm run smoke                    # host 半逻辑自测（59 条断言：真机 bug 回归 + 跨平台分支）
npm run preview                  # 打印三种通知的实际文案（改文案时先看这个）
npm run windows-check            # 打印 Windows 上可直接粘贴的两段自检脚本（弹出窗 / Toast）
npm run notifier                 # 预建通知 app（幂等，可加 --test 弹测试通知）
npm run notifier -- --test       # 建好后弹一条测试通知，用来确认图标
npm run smoke -- --real          # 真的弹出系统通知，确认通道可用
```

`npm run smoke` 里前两条用例就是回归测试：先注册一个完全复刻 `ui-approval` 的 gate，再加载插件，断言通知在 gate 之前发出、且请求被原样交还。

## 设计纪律

- 通知全程 `try/catch`，且**永远**调用 `next()` 并透传下游结果：通知失败绝不影响审批流程，`next()` 抛错照常上抛。
- `agent/status` 只在 `running → idle` 且运行时长 ≥ `minRunMs` 时通知。
- 插件卸载时清掉所有提醒定时器、关闭所有推送流（`ctx.effect` 清理）。
- 客户端不接管任何事件，也不渲染通知；它只在 host 通道失效时用浏览器补一条**系统**通知。

## 已知限制

1. **通知图标 / 应用名**：macOS 的 `osascript` 通知恒定归属「脚本编辑器」，`display notification` 也不能指定图标。所以插件会**自编译一个 `DeepSeek Harness.app`**（Swift + 官方 `UNUserNotificationCenter`，带官方 DeepSeek 图标）来发通知 —— 首次使用自动构建（`swiftc` 编译 + 签名 + 注册，约 2–5 秒），失败则退回 `osascript`（图标变回「脚本编辑器」，`diag.notifier` 会显示 `failed`）。宿主进程若没有写 `~/.dsh` 的权限，先手动跑一次 `npm run notifier`（插件会复用已存在的 app）。

   构建配方里的每一环都是实测必需，少一个就不显示通知：

   | 要素 | 缺了会怎样 |
   |---|---|
   | `NSApplication` + `.accessory` | 裸 CLI 进程调 `requestAuthorization` 直接返回 `Notifications are not allowed for this application` |
   | 官方 `UNUserNotificationCenter` | 换 AppleScript applet（`osacompile`）时 macOS 26 根本不给它通知身份：静默丢弃、从不弹授权 |
   | `CFBundleIdentifier` | `osacompile` 默认不写；没有身份同样进不了通知系统 |
   | ad-hoc 签名 + `lsregister` 注册 | 系统不把它当合法 app |
   | 经 `open -a` 启动 | 直连可执行文件没有通知身份 |
   | 队列文件传参 | `open -a App --args …` **不会**把参数传给进程（实测） |
   | 带构建版本号的 app 路径 | 原地重建时，macOS 图标服务会一直沿用旧图缓存（实测：文件里已是彩色 icns、`NSWorkspace` 取出来也是彩色，通知横幅却仍是上一代图标）。换路径 = 换缓存记录；同时旧路径会被清掉，避免同一 bundle id 多份注册（多份注册同样会让通知显示到旧副本的图标上，也实测踩过） |
2. **专注模式 / 勿扰**：macOS 的专注模式会静默投递，任何第三方应用都绕不过。
3. **首次授权**：第一次弹通知时 macOS 会询问是否允许 **DeepSeek Harness** 发送通知，允许一次即可（此后同一 bundle id 不再询问）。若没弹或被拒绝，去「系统设置 → 通知 → DeepSeek Harness」打开。浏览器兜底通道需要你在提示条上点一次「开启浏览器通知」（浏览器要求用户手势）。诊断里 `notifierStatus` 会显示 app 自己回报的结果（`ok:N` / `denied` / `request failed: …`），这是「系统到底收没收到」的客观反馈。
4. **改动需要重启 DSH** 才生效（原因见上）。
5. 通知标题默认固定为 `DeepSeek Harness`；想让它显示项目目录名（如 `dsh-notify`），把 `titleFrom` 设为 `'project'`。
6. 会话被「停止并归档」时也会走一次 idle，可能收到一条「任务已完成」——属于可接受的误报。
