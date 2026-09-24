// dsh-notify — host half（系统级通知引擎）。
//
// 目标：不管用户当前在哪个 App、在做什么，只要 DSH 需要他处理审批 / 回答提问
// 或者一轮任务跑完，就在 macOS 通知中心弹出一条「像微信消息一样」的横幅。
//
// 为什么通知引擎放在 host 半：浏览器里的 toast 只有页面开着时才存在；host 进程
// 一直活着（它就是在服务 http://127.0.0.1:3080 的那个进程），所以由它调用系统
// 通知，页面关掉、浏览器退出、用户切到别的 App 都能收到。
//
// ---------------------------------------------------------------------------
// 观察点为什么这样选（这是本插件最容易踩的坑）
// ---------------------------------------------------------------------------
// `approval/request` 与 `user-questions/request` 都是 **waterfall**：先注册的
// 监听（内置 ui-approval / ui-user-questions 的应答者）会直接把请求「领走」并
// 等待用户作答，**后面的监听根本不会被调用** —— 普通 `ctx.on(...)` 注册的观察者
// 收不到任何东西（浏览器侧 `ctx.remote.$on` 更是连 options 都没有，无法抢位）。
//
// 因此这里用 `{ prepend: true }` 把观察者插到链首：先发通知，再原样 `next()`
// 把请求交还给真正的应答者。该选项是 harness 自己在 user-approval 的源码注释里
// 明确记录的能力（"a listener registered with `prepend: true`"）。
//
// `agent/status` 是 emit 模式，所有监听都会执行，不需要抢位。
//
// ---------------------------------------------------------------------------
// 投递通道
// ---------------------------------------------------------------------------
//   terminal-notifier（若已装）→ 可点击打开页面、-group 去重、自定义图标
//   osascript `display notification`（macOS 自带，永远可用）→ argv 传参，无转义问题
//   command → 自定义 argv 模板，给 Windows / Linux 留的口子
//
// 页面内卡片不再自己订阅事件（那样会漏掉审批）：host 半把每条通知写进一个
// 环形缓冲，并通过同源路由 `/dsh-notify/feed` 暴露，client 半轮询渲染。
// 该路由同时返回诊断信息（通道、最近错误、最近命令），便于排查。

export const name = 'dsh-notify'

// 软依赖：subprocess / webServer 都可能不存在（headless / 精简 profile）。
// 取不到就降级（没有系统通知 / 没有页面卡片），而不是让插件激活失败。
export const inject = []

const DEFAULT_CONFIG = {
  /** 审批请求是否通知。 */
  approval: true,
  /** ask_user_question 是否通知。 */
  question: true,
  /** 一轮任务跑完是否通知。 */
  done: true,
  /** 取不到项目名时的标题兜底。 */
  fallbackName: 'DeepSeek Harness',
  /**
   * 横幅标题取什么（只显示一个标题）：
   *   'app'     = 固定用 fallbackName（默认）
   *   'project' = 会话工作目录名（相当于微信横幅里的联系人名）
   */
  titleFrom: 'app',
  /**
   * 通知的「应用身份」。macOS 上 `osascript` 的通知恒定归属「脚本编辑器」，
   * 而且 display notification 没有指定图标的能力；所以这里自建一个同名通知 app
   * （图标 = 官方 DeepSeek 图标），由它来发通知 —— 通知就带上了官方图标。
   */
  appName: 'DeepSeek Harness',
  /** 通知 app 的存放目录；默认 `~/.dsh/dsh-notify`。 */
  notifierDir: undefined,
  /** 通知 app 的图标（.icns）；默认用包内自带的官方图标。 */
  iconPath: undefined,
  /** 给 terminal-notifier `-appIcon` 用的 PNG；默认用包内自带的官方图标。 */
  iconPngPath: undefined,
  /**
   * 系统横幅第二行（应用名）。默认空串 = 不显示 —— 一行标题 + 一行正文最干净，
   * 应用名是常量、不携带任何本条通知的信息，所以默认省掉。
   */
  subtitle: '',
  /** 横幅正文里附带的片段长度上限（提问内容等）；越小越简洁。 */
  snippetChars: 24,
  /** 页面卡片第二行（详情）的长度上限；卡片比横幅能放下更多。 */
  detailChars: 120,
  /** 系统提示音名（macOS 声音名，如 Glass / Ping / Hero；空串表示静音）。 */
  sound: 'Glass',
  /** 未处理的审批每隔多久再提醒一次；0 表示只提醒一次。 */
  remindEveryMs: 30_000,
  /** 同一条审批最多提醒多少次，防止挂机刷屏。 */
  maxReminders: 10,
  /** 一轮任务至少跑了这么久才值得通知（毫秒），避免「秒回」也弹窗。 */
  minRunMs: 3_000,
  /** 子代理 / teammate 会话是否也通知。 */
  includeSubagents: false,
  /** 'auto' | 'osascript' | 'terminal-notifier' | 'command'。 */
  backend: 'auto',
  /** backend='command' 时的 argv 模板，占位符 {title} {subtitle} {body}。 */
  command: undefined,
  /** 点击通知（仅 terminal-notifier 支持）时打开的地址；空串则不可点击。 */
  openUrl: 'http://127.0.0.1:3080',
  /** Windows：SnoreToast 的命令名或绝对路径（自备一个单文件 exe 即可，无需注册）。 */
  snoretoastCommand: 'SnoreToast.exe',
  /**
   * Windows：PowerShell Toast 使用的 AppUserModelID。
   * 默认用系统 PowerShell 的 AUMID —— 它已经在系统里注册过，所以免注册也能弹；
   * 想显示成自己的名字，就注册一个 AUMID 并改成它。
   */
  windowsAppId: '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe',
  /** Linux：notify-send 的紧急级别映射（审批/提问用 critical 更不容易被自动收起）。 */
  linuxUrgentUrgency: 'critical',
  /**
   * Windows 通知形态：
   *   'banner' = 自绘的置顶横幅小窗（**默认**）：位置/尺寸完全可控，能贴右上角，
   *              并且**不受专注助手 / 通知设置影响** —— 「一定要弹出来」只有这条靠得住
   *   'toast'  = 系统 Toast（进通知中心；位置被系统固定在右下角，而且可能被专注
   *              助手、通知总开关、AUMID 注册状态静默吞掉，表现就是「什么都没弹」）
   */
  windowsStyle: 'banner',
  /** banner 模式的位置：topright / topleft / bottomright / bottomleft。 */
  bannerPosition: 'topright',
  /**
   * banner 模式的宽度**上限**（96 DPI 下的逻辑像素）：默认 360。
   * 卡片会按标题/正文里更长的那条自己收窄（最短 `bannerMinWidth`），不会留一截空白。
   */
  bannerWidth: 360,
  /** banner 模式的宽度**下限**：想钉死宽度就把 `bannerMinWidth` 和 `bannerWidth` 设成同一个值。 */
  bannerMinWidth: 290,
  /** 卡片圆角半径（96 DPI 下的逻辑像素）；会被自动限制在「卡片高度的一半」以内。 */
  bannerRadius: 32,
  /**
   * banner 模式的高度（96 DPI 下的逻辑像素）：
   *   0（默认）= 按正文实际行数**自适应**（单行 ≈ 54、两行 ≈ 70），不留白
   *   > 0      = 固定高度（想钉死尺寸才用；设大了就会出现多余留白）
   */
  bannerHeight: 0,
  /** banner 模式自动关闭的毫秒数；0 = 一直显示直到点击关闭。 */
  bannerDurationMs: 8_000,
  /** 页面卡片轮询的同源路由。 */
  feedPath: '/dsh-notify/feed',
  /** 页面即时推送（SSE）的同源路由。 */
  streamPath: '/dsh-notify/stream',
}

/** AppleScript 的固定头部：用 argv 收参，因此没有任何转义问题。 */
const OSA_HEAD = [
  'on run argv',
  '  set t to item 1 of argv',
  '  set s to item 2 of argv',
  '  set b to item 3 of argv',
  '  set sn to item 4 of argv',
]

/** 按「有没有副标题 / 有没有提示音」拼出四种脚本，避免空 subtitle 被当成一行空文本。 */
function osaScript(hasSubtitle, hasSound) {
  const clauses = ['with title t']
  if (hasSubtitle) clauses.push('subtitle s')
  if (hasSound) clauses.push('sound name sn')
  return [...OSA_HEAD, `  display notification b ${clauses.join(' ')}`, 'end run'].join('\n')
}

const OSA_SCRIPTS = {
  plain: osaScript(false, false),
  withSound: osaScript(false, true),
  withSubtitle: osaScript(true, false),
  withSubtitleSound: osaScript(true, true),
}

const OSA_PATH = '/usr/bin/osascript'

/** 图标资源（相对 host.js）在包内的相对路径。 */
const ICON_ICNS_RELATIVE = './deepseek.icns'
const ICON_PNG_RELATIVE = './deepseek.png'
/** 通知 app 的 Swift 源码（相对 host.js）。 */
const NOTIFIER_SWIFT_RELATIVE = './notifier.swift'
/**
 * 通知 app 的构建配方版本。改过构建步骤就 +1：目录里的 `.built-<版本>` 标记
 * 不匹配时会自动重建，避免沿用上一代的坏产物。
 */
const NOTIFIER_BUILD = 'swift-v3'

/**
 * 通知身份版本（拼进 bundle id）。
 *
 * 为什么需要它：macOS 会**按 bundle id 记住这个 app 的通知图标快照** —— 只换图标文件、
 * 甚至换 app 路径都无效（实测：文件已是彩色 icns、NSWorkspace 也解析出彩色，通知横幅
 * 仍是第一代的黑白图标）。换 bundle id = 换一个全新身份，图标快照才会重建。
 *
 * 换图标 / 改品牌标识时 +1，代价是系统会重新询问一次通知授权。
 */
const NOTIFIER_IDENTITY = '3'

/** 通知 app 的 bundle id。 */
function notifierBundleId() {
  return `com.dsh-notify.notifier.${NOTIFIER_IDENTITY}`
}

/** 环形缓冲上限：够页面刷新后回溯几分钟，又不会无限增长。 */
const FEED_LIMIT = 50

/** 点分错误信息，永远不抛出。 */
function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 把毫秒转成「1 分 23 秒」这种人类可读的时长。 */
function humanDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes === 0) return `${seconds} 秒`
  if (minutes < 60) return `${minutes} 分 ${seconds} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

/**
 * 压成一行并截断 —— 系统横幅放不下一整段话，长理由/长提问只留一小截。
 * @param text - 原始文本（可能含换行）。
 * @param max - 字符上限；<= 0 表示不截断（仅压成一行）。
 * @returns 单行文本，超长时以省略号结尾。
 */
function clip(text, max) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  const limit = Number.isFinite(max) && max > 0 ? max : 0
  if (limit === 0 || flat.length <= limit) return flat
  return `${flat.slice(0, limit)}…`
}

/** 解析包内资源（图标）的绝对路径；模块不是 ESM 时返回 undefined。 */
function assetPath(relative) {
  try {
    let path = decodeURIComponent(new URL(relative, import.meta.url).pathname)
    // Windows：URL 的 pathname 形如 /C:/dir/file → C:\dir\file
    if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1).replaceAll('/', '\\')
    return path
  } catch {
    return undefined
  }
}

/** 用户主目录（POSIX 用 HOME，Windows 用 USERPROFILE / HOMEDRIVE+HOMEPATH）。 */
function homeDir() {
  try {
    const env = process.env
    if (typeof env.HOME === 'string' && env.HOME !== '') return env.HOME
    if (typeof env.USERPROFILE === 'string' && env.USERPROFILE !== '') return env.USERPROFILE
    if (typeof env.HOMEDRIVE === 'string' && typeof env.HOMEPATH === 'string') return `${env.HOMEDRIVE}${env.HOMEPATH}`
    return ''
  } catch {
    return ''
  }
}

/** 绝对路径判断：POSIX `/…`、Windows 盘符 `C:\…`、UNC `\\server\share`。 */
function isAbsolutePath(candidate) {
  if (typeof candidate !== 'string' || candidate === '') return false
  if (candidate.startsWith('/')) return true
  if (/^[a-zA-Z]:[\\/]/.test(candidate)) return true
  return candidate.startsWith('\\\\')
}

/** cwd 的最后一段，作为「会话名」（类似微信里的联系人名）。 */function baseName(path) {
  if (typeof path !== 'string' || path === '') return ''
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

/** 只接受绝对目录（跨平台），否则回到进程 cwd。 */
function safeCwd(candidate) {
  try {
    if (isAbsolutePath(candidate)) return candidate
  } catch {
    // fallthrough
  }
  try {
    return process.cwd()
  } catch {
    return process.platform === 'win32' ? 'C:\\' : '/'
  }
}

/** XML 文本转义（toast XML 里的 title/body）。 */
function escapeXmlText(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * 把一段 PowerShell 包成「失败就非 0 退出 + 写 stderr」。
 *
 * 为什么必须包：PowerShell 的非终止错误只写 stderr、**退出码仍是 0**，宿主侧
 * `delivered += 1` 就会把「根本没弹出来」记成「投递成功」—— Windows 上「什么都没弹、
 * 诊断却一切正常」正是这么来的。包上 try/catch 后，失败会以退出码 1 落到 diag 里。
 */
function wrapPowerShell(body) {
  return `try { ${body} } catch { Write-Error $_; exit 1 }`
}

/**
 * 生成一段 PowerShell 脚本，用 WinRT Toast 弹通知。
 *
 * 用字符串拼接而不是 `$args`：`-Command` 后跟参数时 `$args` 的绑定行为在各版本
 * PowerShell 上并不一致，而 spawn 是直接传 argv（无 shell），所以只需按 PowerShell
 * 的规则转义单引号即可，确定性更好。
 *
 * 图标：用 `ToastGeneric` 模板 + `appLogoOverride` —— 这就是 **Windows 上把自定义
 * 图标放在通知左侧（app 图标槽位）** 的官方做法，效果与 macOS 那条路对齐。
 * WinRT 要求图片是本地文件（`file:///` URI），尺寸 ≤ 1024×1024、体积 ≤ 200 KB，
 * 包内的 deepseek.png（512×512 / 88 KB）正合适。
 */
export function powershellToastScript(title, body, appId, iconPath) {
  const psQuote = (text) => `'${String(text).replaceAll("'", "''")}'`
  // file URI：POSIX `/a/b` → `file:///a/b`；Windows `C:/a/b` → `file:///C:/a/b`。
  const slashPath = typeof iconPath === 'string' ? iconPath.replaceAll('\\', '/') : ''
  const fileUri = slashPath === ''
    ? ''
    : slashPath.startsWith('/') ? `file://${slashPath}` : `file:///${slashPath}`
  const image = fileUri === ''
    ? ''
    : `<image placement="appLogoOverride" src="${fileUri}"/>`
  const xml = `<toast><visual><binding template="ToastGeneric">${image}`
    + `<text>${escapeXmlText(title)}</text><text>${escapeXmlText(body)}</text>`
    + '</binding></visual></toast>'
  return wrapPowerShell([
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] > $null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml(${psQuote(xml)})`,
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(appId)}).Show($toast)`,
  ].join('; '))
}

/**
 * 生成一段 PowerShell 脚本：在屏幕角落画一个置顶的通知卡片小窗。
 *
 * 为什么需要它：Windows 的系统 Toast 位置由系统固定（右下角），微软明确表示没有
 * 提供修改位置的设置；SnoreToast 也没有位置参数。想放到右上角，只能自己画窗口。
 *
 * 外观对齐 macOS 通知横幅，但**卡片贴着内容走**：宽度按标题/正文里更长的那条量出来
 * （默认 240–360 之间，不再固定 360 留一截空白），高度 = 标题 + 正文实际行高 + 5px；
 * 34×34 应用图标、13px 半粗标题 + 12px 正文、圆角（最大 = 卡片高度一半，即胶囊）浅色卡片。
 *
 * **DPI**：不调 `SetProcessDPIAware` 时，Windows 在 150% / 200% 缩放的屏幕上会把整个
 * 窗口当位图放大 —— 又大又糊（这是「弹出窗太大」的真正原因）。所以脚本先声明 DPI
 * 感知，再按 `DpiX / 96` 缩放全部尺寸与字号（字号用 Pixel 单位，避免二次缩放）。
 *
 * 代价（必须说清楚）：它**不是系统通知** —— 不进「通知中心」、不受专注助手管理，
 * 也不会被错过后的历史列表记住。这是**默认形态**：系统 Toast 会被专注助手 / 通知
 * 总开关静默吞掉（表现就是「Windows 上什么都没弹」），而自绘窗口不受这些影响；
 * 想换回进通知中心的系统 Toast，把 `windowsStyle` 设成 `'toast'`。
 */
export function powershellBannerScript(options) {
  const q = (text) => `'${String(text).replaceAll("'", "''")}'`
  const margin = 16
  const width = Math.round(options.width)
  const height = Math.round(options.height)
  const atLeft = options.position === 'topleft' || options.position === 'bottomleft'
  const atBottom = options.position === 'bottomleft' || options.position === 'bottomright'
  const leftExpr = atLeft ? '$wa.Left + $m' : '$wa.Right - $form.Width - $m'
  const topExpr = atBottom ? '$wa.Bottom - $form.Height - $m' : '$wa.Top + $m'
  const openUrl = typeof options.openUrl === 'string' && options.openUrl !== '' ? options.openUrl : ''
  const click = openUrl === '' ? '' : [
    `$onClick = { Start-Process ${q(openUrl)}; $form.Close() }`,
    '$form.Add_Click($onClick); $title.Add_Click($onClick)',
    '$body.Add_Click($onClick); $pic.Add_Click($onClick)',
  ].join('; ')
  const autoClose = options.durationMs > 0
    // 时长是时间，不跟着 DPI 缩放。
    ? `$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = ${Math.round(options.durationMs)}`
      + '; $timer.Add_Tick({ $form.Close() }); $timer.Start()'
    : ''
  /** 把 96 DPI 下的基准尺寸换算成当前屏幕的像素。 */
  const px = (base) => `[int][Math]::Round(${base} * $scale)`
  /**
   * 卡片高度：
   *   options.height <= 0（默认）= 按正文实际行数自适应（单行 ≈ 56、两行 ≈ 72），
   *                              不留白；这是 macOS / Win11 的做法。
   *   options.height  > 0        = 固定高度（想钉死尺寸时才用）。
   */
  const fixedHeight = Number.isFinite(options.height) && options.height > 0 ? Math.round(options.height) : 0
  const fitHeight = fixedHeight === 0
  /**
   * 卡片宽度：options.width 是**上限**，再按标题/正文里更长的那条收窄，下限 options.minWidth。
   * 想钉死宽度就把 minWidth 和 width 设成同一个值。
   */
  const minWidth = Number.isFinite(options.minWidth) && options.minWidth > 0 ? Math.round(options.minWidth) : 290
  /** 圆角半径：越大越圆；构建 Region 时会夹到「高度的一半」以内，避免矮卡片画歪。 */
  const radius = Number.isFinite(options.radius) && options.radius > 0 ? Math.round(options.radius) : 32
  /**
   * 让一条**装饰性**语句失败时不至于整条通知消失。
   *
   * 教训（真机反馈）：给整段脚本套一个 try/catch 之后，任何一句装饰性语句报错都会被
   * 外层捕获并 exit 1 —— 窗口直接不出现，而这条语句在旧版里只是打一行错、窗口照弹。
   * 所以装饰性语句一律「自带 try/catch + Write-Warning 进 stderr」，窗口才是必须出现的。
   */
  const soft = (body) => `try { ${body} } catch { Write-Warning "dsh-notify 横幅降级：$_" }`
  return wrapPowerShell([
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    // DPI 感知：不做这一步，缩放屏上整窗会被位图放大（又大又糊）。失败只降级成 100%。
    soft("Add-Type -Namespace Dsh -Name Dpi -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();'"),
    soft('[Dsh.Dpi]::SetProcessDPIAware() | Out-Null'),
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    '$scale = 1.0',
    soft('$g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero); if ($g -ne $null) { if ($g.DpiX -gt 0) { $scale = [Math]::Round($g.DpiX / 96.0, 2) }; $g.Dispose() }'),
    'if ($scale -le 0.5 -or $scale -gt 4) { $scale = 1.0 }',
    // 版式基准（96 DPI）：紧贴内容 —— 左右内边距 10、图标 34、标题 13px、正文 12px、
    // **底部只留 5**（正文下面那块空白是「留白太多」的来源）
    `$W = ${px(width)}; $minW = ${px(minWidth)}`,
    `$m = ${px(margin)}; $r = ${px(radius)}; $pad = ${px(10)}; $rightPad = ${px(16)}; $icon = ${px(34)}; $gap = ${px(10)}`,
    `$titleTop = ${px(10)}; $titleH = ${px(17)}; $bodyTop = ${px(28)}; $bottomPad = ${px(5)}`,
    fitHeight
      // 自适应：先按「单行正文」估高，后面量出真实行数再定稿
      ? `$bodyH = ${px(16)}; $H = $bodyTop + $bodyH + $bottomPad`
      : `$H = ${px(fixedHeight)}; $bodyH = $H - $bodyTop - ${px(5)}`,
    // 浅色/深色跟随 Windows 应用主题（macOS 通知也跟随系统外观）
    '$light = 1',
    soft("$light = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' -Name AppsUseLightTheme -ErrorAction Stop).AppsUseLightTheme"),
    'if ($null -eq $light) { $light = 1 }',
    '$bg = if ($light -eq 1) { [System.Drawing.Color]::FromArgb(248, 248, 250) } else { [System.Drawing.Color]::FromArgb(44, 44, 46) }',
    '$fg = if ($light -eq 1) { [System.Drawing.Color]::FromArgb(29, 29, 31) } else { [System.Drawing.Color]::White }',
    '$muted = if ($light -eq 1) { [System.Drawing.Color]::FromArgb(92, 92, 98) } else { [System.Drawing.Color]::FromArgb(199, 199, 204) }',
    '$lineColor = if ($light -eq 1) { [System.Drawing.Color]::FromArgb(28, 0, 0, 0) } else { [System.Drawing.Color]::FromArgb(38, 255, 255, 255) }',
    '$form = New-Object System.Windows.Forms.Form',
    "$form.FormBorderStyle = 'None'",
    "$form.StartPosition = 'Manual'",
    // 自己按 DPI 缩放，禁止 WinForms 再缩一次（否则又是「太大」）
    soft("$form.AutoScaleMode = 'None'"),
    '$form.TopMost = $true',
    '$form.ShowInTaskbar = $false',
    '$form.BackColor = $bg',
    '$form.Width = $W',
    '$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea',
    '$pic = New-Object System.Windows.Forms.PictureBox',
    '$pic.SizeMode = "Zoom"; $pic.Left = $pad; $pic.Width = $icon; $pic.Height = $icon',
    typeof options.iconPath === 'string' && options.iconPath !== ''
      // 图标读不出来只降级（警告进 stderr → diag.lastStderr）：横幅本身必须照弹。
      ? soft(`$pic.Image = [System.Drawing.Image]::FromFile(${q(options.iconPath)})`) : '',
    '$form.Controls.Add($pic)',
    '$title = New-Object System.Windows.Forms.Label',
    `$title.Text = ${q(options.title)}`,
    '$title.ForeColor = $fg',
    // 字号用「点」：DPI 感知后 GDI+ 会自己按屏幕 DPI 换算，正好等于 13px / 12px 的观感
    soft('$title.Font = New-Object System.Drawing.Font("Segoe UI", 9.75, [System.Drawing.FontStyle]::Bold)'),
    '$title.Left = $pad + $icon + $gap; $title.Top = $titleTop; $title.Height = $titleH',
    '$form.Controls.Add($title)',
    '$body = New-Object System.Windows.Forms.Label',
    `$body.Text = ${q(options.body)}`,
    '$body.ForeColor = $muted',
    soft('$body.Font = New-Object System.Drawing.Font("Segoe UI", 9)'),
    '$body.Left = $title.Left; $body.Top = $bodyTop',
    '$form.Controls.Add($body)',
    // 自适应宽度：卡片宽度贴着「标题 / 正文」里更长的那条，长度不再固定 360 留一截空白。
    // NoPadding 很关键：默认测量值含文本边框的额外内边距，会让卡片凭空长出几像素。
    soft('$flagsS = [System.Windows.Forms.TextFormatFlags]::SingleLine -bor [System.Windows.Forms.TextFormatFlags]::NoPadding; $tw = [System.Windows.Forms.TextRenderer]::MeasureText($title.Text, $title.Font, (New-Object System.Drawing.Size(10000, 1000)), $flagsS); $bw = [System.Windows.Forms.TextRenderer]::MeasureText($body.Text, $body.Font, (New-Object System.Drawing.Size(10000, 1000)), $flagsS); $needW = [Math]::Max($tw.Width, $bw.Width) + $title.Left + $rightPad; if ($needW -gt 0 -and $needW -lt $W) { $W = [Math]::Max($needW, $minW) }'),
    '$title.Width = $W - $title.Left - $rightPad; $body.Width = $title.Width',
    // 自适应高度：量出正文真实行高再定卡片高度（单行不留白，两行也不会被裁）。
    ...(fitHeight ? [
      soft('$flags = [System.Windows.Forms.TextFormatFlags]::WordBreak -bor [System.Windows.Forms.TextFormatFlags]::NoPadding; $measured = [System.Windows.Forms.TextRenderer]::MeasureText($body.Text, $body.Font, (New-Object System.Drawing.Size($body.Width, 1000)), $flags); if ($measured.Height -gt 0) { $bodyH = [int]$measured.Height }'),
      '$H = $bodyTop + $bodyH + $bottomPad',
    ] : []),
    // 定稿：卡片宽高、图标垂直居中、贴角位置都按最终尺寸算
    '$body.Height = $bodyH; $form.Width = $W; $form.Height = $H',
    '$pic.Top = [int][Math]::Round(($H - $icon) / 2)',
    `$form.Left = ${leftExpr}; $form.Top = ${topExpr}`,
    // 14px 圆角 + 1px 描边：通知卡片的形状（失败只丢外观）
    // 圆角不能超过卡片高度的一半，否则四个 Arc 会互相重叠、边缘画歪
    '$r = [Math]::Min($r, [int][Math]::Floor($H / 2))',
    soft('$path = New-Object System.Drawing.Drawing2D.GraphicsPath; $path.AddArc(0, 0, $r, $r, 180, 90); $path.AddArc($W - $r, 0, $r, $r, 270, 90); $path.AddArc($W - $r, $H - $r, $r, $r, 0, 90); $path.AddArc(0, $H - $r, $r, $r, 90, 90); $path.CloseFigure(); $form.Region = New-Object System.Drawing.Region($path)'),
    soft('$form.Add_Paint({ param($sender, $e) try { $pen = New-Object System.Drawing.Pen($lineColor, 1); $e.Graphics.SmoothingMode = "AntiAlias"; $e.Graphics.DrawPath($pen, $path); $pen.Dispose() } catch { } })'),
    click,
    autoClose,
    // 把卡片实际几何写进 stderr（进 diag.lastStderr）：下次调版式不用再猜
    soft('[Console]::Error.WriteLine("dsh-notify 卡片 {0}x{1}（正文 {2}px / scale {3}）" -f $W, $H, $bodyH, $scale)'),
    '$form.ShowDialog() | Out-Null',
  ].filter((line) => line !== '').join('; '))
}

/** 序列化一个 JSON 响应。 */
function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/**
 * @param ctx - Cordis 插件上下文。
 * @param config - bundle patch 行里的 config（未声明时为空对象）。
 */
export function apply(ctx, config = {}) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, config && typeof config === 'object' ? config : {})
  const platform = (() => {
    try {
      return process.platform
    } catch {
      return 'unknown'
    }
  })()

  /** 按需取服务：避免了「激活顺序不同就拿不到服务」的隐患。 */
  const service = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)

  /** 页面卡片的数据源：环形缓冲。 */
  const feed = []
  let feedSeq = 0

  /** 未 settle 的审批/提问提醒计划：key → { stop() }。 */
  const openPlans = new Map()
  /** sessionId → 本轮 running 开始时间。 */
  const runs = new Map()
  const timers = new Set()
  let disposed = false
  let backendPromise

  /** 诊断字段（通过 feed 路由返回，排查时不用翻日志）。 */
  let backendKind
  let delivered = 0
  let failed = 0
  let lastError
  let lastCommand
  let lastExitCode
  let lastStderr
  let lastDeliveredAt
  /** 横幅失败后退回系统 Toast 时记一句，便于区分「本来就该是 Toast」和「兜底」。 */
  let lastFallback

  // 通知 app（自编译 Swift，带官方图标）的状态：undefined → 'ready' | 'failed'
  let notifierState
  let notifierPath
  let notifierPromise
  let payloadSeq = 0

  /**
   * subprocess 服务可能在**本插件之后**才注册：apply 时刻 `ctx.get('subprocess')`
   * 可能是 undefined（这正是第一版把「没有通道」永久缓存住、导致重启后仍不弹通知的原因）。
   * 因此这里用 ctx.inject 等待它就绪，并始终保留按需查询的兜底。
   */
  let injectedSubprocess
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['subprocess'], (scope) => {
        injectedSubprocess = scope.subprocess
      })
    } catch (error) {
      console.error(`[dsh-notify] subprocess 注入失败：${describe(error)}`)
    }
  }

  /**
   * Node 的文件读写：用**动态 import** 拿到 `node:fs/promises`。
   *
   * 为什么不 spawn `/bin/sh -c 'printf …'` / `/bin/cat`：那两条在 Windows 上不存在，
   * 这套代码要跨平台。动态 import 不引入任何 npm 依赖，仍然满足「零依赖」。
   */
  let fsPromise
  function nodeFs() {
    if (fsPromise === undefined) {
      fsPromise = import('node:fs/promises').then((mod) => mod, () => undefined)
    }
    return fsPromise
  }

  /** 把三行载荷写进队列目录（目录不存在就建）；失败记诊断并返回 false。 */
  async function writePayloadFile(queueDir, file, lines) {
    const fs = await nodeFs()
    if (fs === undefined) {
      lastError = 'node:fs 不可用'
      return false
    }
    try {
      await fs.mkdir(queueDir, { recursive: true })
      await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8')
      return true
    } catch (error) {
      lastError = describe(error)
      return false
    }
  }

  /** 读一个小文本文件；失败返回 undefined。 */
  async function readTextFile(file) {
    const fs = await nodeFs()
    if (fs === undefined) return undefined
    try {
      return await fs.readFile(file, 'utf8')
    } catch {
      return undefined
    }
  }

  /**
   * 可选的外部配置：`<基础目录>/config.json`。
   *
   * 为什么需要它：bundle patch 行里的 `config` 依赖 loader 的 Config 机制，而本插件
   * 刻意不声明 Config（保持零依赖）；用文件覆盖 DEFAULT_CONFIG 则各平台一致、免重启改配置。
   */
  const configReady = (async () => {
    try {
      const base = resolveNotifierBase()
      if (base === '') return
      const text = await readTextFile(`${base}/config.json`)
      if (typeof text !== 'string' || text.trim() === '') return
      const parsed = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object') Object.assign(cfg, parsed)
    } catch (error) {
      console.warn(`[dsh-notify] config.json 解析失败，已忽略：${describe(error)}`)
    }
  })()

  /** 取 subprocess 服务：优先注入引用，其次按需查询。 */
  function subprocessService() {
    return injectedSubprocess ?? service('subprocess')
  }

  /** 已连接的浏览器（SSE 长连接）。 */
  const streams = new Set()

  // 插件卸载时：停掉所有提醒定时器与已连接的推送流，避免插件已卸载还在弹通知。
  ctx.effect(() => () => {
    disposed = true
    for (const plan of openPlans.values()) {
      try {
        plan.stop()
      } catch {
        // ignore
      }
    }
    openPlans.clear()
    for (const timer of timers) clearInterval(timer)
    timers.clear()
    for (const res of [...streams]) {
      try {
        res.end()
      } catch {
        // ignore
      }
    }
    streams.clear()
  }, 'dsh-notify: 清理提醒定时器与推送流')

  // -------------------------------------------------------------------------
  // 页面卡片数据源
  // -------------------------------------------------------------------------

  /** 把一条数据即时推给所有已连接页面；连接已死就顺手摘掉。 */
  function broadcast(payload) {
    if (streams.size === 0) return
    let text
    try {
      text = `data: ${JSON.stringify(payload)}\n\n`
    } catch (error) {
      console.error(`[dsh-notify] 推送序列化失败：${describe(error)}`)
      return
    }
    for (const res of [...streams]) {
      try {
        res.write(text)
      } catch {
        streams.delete(res)
      }
    }
  }

  /** 推送一次状态（通道、投递计数），供页面决定要不要用浏览器通知兜底。 */
  function broadcastStatus() {
    broadcast({
      kind: 'status',
      backend: backendKind ?? 'unresolved',
      delivered,
      failed,
      streams: streams.size,
      lastError,
    })
  }

  /** 追加一条卡片数据，返回它的 seq（同时作为卡片 id）。 */
  function publish(item) {
    feedSeq += 1
    const entry = Object.assign({ seq: feedSeq, at: Date.now() }, item)
    feed.push(entry)
    if (feed.length > FEED_LIMIT) feed.splice(0, feed.length - FEED_LIMIT)
    broadcast(entry)
    return feedSeq
  }

  /** 供页面轮询的同源路由（SSE 不可用时的兜底）；顺带返回诊断。 */
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scope) => {
        ctx.effect(() => scope.webServer.register({
          kind: 'exact',
          path: cfg.feedPath,
          handler: async (req, res) => {
            try {
              const url = new URL(req.url ?? cfg.feedPath, 'http://localhost')
              const raw = url.searchParams.get('since')
              let since
              if (raw !== null) {
                since = Number(raw)
                if (!Number.isFinite(since)) {
                  sendJson(res, 400, { error: 'since 必须是数字' })
                  return
                }
              }
              // 通知 app 把最近一次投递结果写在 last-status.txt：这是「系统到底收没收到」
              // 的唯一客观反馈（open -a 只会告诉我们有没有启动成功）。
              let notifierStatus
              const notifierDir = resolveNotifierDir()
              if (notifierDir !== '') {
                const text = await readTextFile(`${notifierDir}/last-status.txt`)
                if (typeof text === 'string') notifierStatus = text.trim()
              }
              sendJson(res, 200, {
                head: feedSeq,
                // 不带 since = 只要游标：页面刚打开时不回放历史通知。
                items: since === undefined ? [] : feed.filter((item) => item.seq > since),
                diag: {
                  platform,
                  subprocess: service('subprocess') !== undefined,
                  backend: backendKind ?? 'unresolved',
                  // 生效的配置：Windows 上「弹的是右下角 Toast 还是右上角弹出窗」
                  // 完全由这两个值决定，写进诊断就不用猜是哪一层覆盖了默认值。
                  backendConfig: cfg.backend,
                  windowsStyle: cfg.windowsStyle,
                  notifier: notifierState ?? 'idle',
                  notifierPath,
                  notifierBundleId: notifierBundleId(),
                  notifierStatus,
                  delivered,
                  failed,
                  lastError,
                  lastCommand,
                  lastExitCode,
                  lastStderr,
                  lastDeliveredAt,
                  lastFallback,
                  streams: streams.size,
                },
              })
            } catch (error) {
              sendJson(res, 500, { error: describe(error) })
            }
          },
        }), 'dsh-notify: 通知 feed 路由')

        // 实时推送：轮询在后台标签页会被浏览器限流（Chrome 挂后台几分钟后降到
        // 每分钟一次），SSE 是长连接，后台标签页也能即时收到。
        ctx.effect(() => scope.webServer.register({
          kind: 'exact',
          path: cfg.streamPath,
          handler: (req, res) => {
            try {
              res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache, no-transform',
                connection: 'keep-alive',
                'x-accel-buffering': 'no',
              })
              res.write(': connected\n\n')
              streams.add(res)
              broadcastStatus()
              const drop = () => {
                streams.delete(res)
              }
              req.on('close', drop)
              req.on('error', drop)
            } catch (error) {
              console.error(`[dsh-notify] SSE 建立失败：${describe(error)}`)
              try {
                res.writeHead(500)
                res.end()
              } catch {
                // ignore
              }
            }
          },
        }), 'dsh-notify: 通知 SSE 路由')

        // 心跳兼状态同步：没有它，长时间空闲的连接可能被中间层掐掉，
        // 页面也就无从知道 host 的通道状态。
        const heartbeat = setInterval(() => {
          if (disposed || streams.size === 0) return
          broadcastStatus()
        }, 15_000)
        if (typeof heartbeat.unref === 'function') heartbeat.unref()
        timers.add(heartbeat)
      })
    } catch (error) {
      console.error(`[dsh-notify] feed 路由注册失败：${describe(error)}`)
    }
  }

  // -------------------------------------------------------------------------
  // 会话信息
  // -------------------------------------------------------------------------

  /** 从 live session header 里取 cwd / 是否子代理；取不到就当作主会话。 */
  function sessionInfo(sessionId) {
    try {
      const sessions = service('sessions')
      const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
      const header = session && session.header
      if (!header) return {}
      return {
        cwd: header.cwd,
        subagent: header.origin === 'subagent' || (header.delegationDepth || 0) > 0,
      }
    } catch {
      return {}
    }
  }

  /** 横幅唯一的标题行：默认项目名（微信横幅里"联系人名"的位置）。 */
  function conversationName(cwd) {
    if (cfg.titleFrom === 'app') return cfg.fallbackName
    return baseName(cwd) || cfg.fallbackName
  }

  // -------------------------------------------------------------------------
  // 通道选择与投递
  // -------------------------------------------------------------------------

  /**
   * 探测可用通道。**只缓存成功结果**：subprocess 可能晚于本插件注册，
   * 把「暂时没有服务」也缓存下来，会让之后所有通知都静默失败。
   */
  function resolveBackend() {
    if (backendPromise) return backendPromise
    const attempt = (async () => {
      const subprocess = subprocessService()
      if (!subprocess || typeof subprocess.spawn !== 'function') return undefined

      // 显式指定优先
      if (cfg.backend === 'command') return cfg.command ? { kind: 'command' } : undefined
      if (cfg.backend === 'osascript') return platform === 'darwin' ? { kind: 'osascript' } : undefined
      if (cfg.backend === 'terminal-notifier') {
        const exe = await resolveExe('terminal-notifier')
        return exe === undefined ? undefined : { kind: 'terminal-notifier', exe }
      }
      if (cfg.backend === 'notify-send') return pickNotifySend()
      if (cfg.backend === 'snoretoast') return pickSnoreToast()
      if (cfg.backend === 'powershell') return pickPowerShell()
      if (cfg.backend === 'banner') return pickBanner()

      // auto：按平台挑
      if (platform === 'darwin') {
        // 自编译的通知 app（官方 UNUserNotificationCenter → 官方图标 + 官方应用名，
        // 且首次会正常弹一次授权）。构建失败时 deliver 退回 osascript。
        return { kind: 'notifier' }
      }
      if (platform === 'win32') {
        // banner：自绘右上角横幅（位置可控，但不是系统通知）
        if (cfg.windowsStyle === 'banner' && (await pickBanner()) !== undefined) return pickBanner()
        // SnoreToast 最省事（单文件、支持图片、无需注册）；没有就退回 PowerShell Toast。
        return (await pickSnoreToast()) ?? (await pickPowerShell())
          ?? (cfg.command ? { kind: 'command' } : undefined)
      }
      if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd' || platform === 'sunos') {
        return (await pickNotifySend()) ?? (cfg.command ? { kind: 'command' } : undefined)
      }
      return cfg.command ? { kind: 'command' } : undefined
    })().then((backend) => {
      if (backend === undefined) {
        backendPromise = undefined // 不缓存失败：下一次调用重新探测
        return undefined
      }
      backendKind = backend.kind
      return backend
    })
    backendPromise = attempt
    return attempt
  }

  /** Linux：notify-send（libnotify）。 */
  async function pickNotifySend() {
    const exe = await resolveExe('notify-send')
    return exe === undefined ? undefined : { kind: 'notify-send', exe }
  }

  /** Windows：SnoreToast（自备单文件 exe；支持通知内图片、无需注册 AUMID）。 */
  async function pickSnoreToast() {
    if (platform !== 'win32') return undefined
    const command = typeof cfg.snoretoastCommand === 'string' && cfg.snoretoastCommand !== ''
      ? cfg.snoretoastCommand
      : 'SnoreToast.exe'
    if (isAbsolutePath(command)) return { kind: 'snoretoast', exe: command }
    const exe = await resolveExe(command)
    return exe === undefined ? undefined : { kind: 'snoretoast', exe }
  }

  /** Windows：自绘置顶横幅小窗（位置可控：默认右上角）。 */
  async function pickBanner() {
    if (platform !== 'win32') return undefined
    const ps = await pickPowerShell()
    return ps === undefined ? undefined : { kind: 'banner', exe: ps.exe }
  }

  /** Windows：PowerShell + WinRT Toast（免安装；图标只能靠通知内图片）。 */
  async function pickPowerShell() {
    if (platform !== 'win32') return undefined
    const exe = await resolveExe('powershell.exe') ?? await resolveExe('powershell') ?? await resolveExe('pwsh.exe') ?? await resolveExe('pwsh')
    return exe === undefined ? undefined : { kind: 'powershell', exe }
  }

  /** 用 subprocess 服务的执行世界解析可执行文件；找不到返回 undefined。 */
  async function resolveExe(bare) {
    try {
      const subprocess = subprocessService()
      if (!subprocess || typeof subprocess.resolveExecutable !== 'function') return undefined
      return await subprocess.resolveExecutable(bare)
    } catch {
      return undefined
    }
  }

  /** 读一条 collected 流的尾巴（没有 / 非采集模式则返回空串）。 */
  function collectedTail(handle, stream) {
    try {
      const reader = handle?.collected?.[stream]
      if (reader === undefined || typeof reader.readFrom !== 'function') return ''
      const read = reader.readFrom(0)
      return typeof read?.text === 'string' ? read.text.trim() : ''
    } catch {
      return ''
    }
  }

  /**
   * fire-and-forget 地跑一条命令；**失败要看得见**。
   *
   * 只记录「spawn 成功」是不够的：Windows 上 PowerShell 报错也常常退出码 0，
   * 于是「根本没弹出来」和「投递成功」在诊断里长得一模一样。所以这里把 stderr 采集
   * 下来、并等命令结束，把退出码与 stderr 尾巴写进 diag（`failed` / `lastExitCode` /
   * `lastStderr`），失败时同时升级 `lastError`。
   */
  function spawnNotify(argv, cwd) {
    const subprocess = subprocessService()
    if (!subprocess || typeof subprocess.spawn !== 'function') {
      lastError = 'subprocess 服务不可用'
      return false
    }
    try {
      const handle = subprocess.spawn({
        argv,
        cwd: safeCwd(cwd),
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: { maxBytes: 4_096 } },
        graceMs: 5_000,
      })
      delivered += 1
      lastError = undefined
      lastCommand = argv.slice(0, 3).join(' ')
      if (handle && handle.done && typeof handle.done.then === 'function') {
        handle.done.then((outcome) => {
          // 卸载/退出时子进程会被终止，那不是「投递失败」，不要制造噪音。
          if (disposed) return
          const exitCode = outcome?.exitCode
          const tail = clip(collectedTail(handle, 'stderr'), 200)
          lastExitCode = typeof exitCode === 'number' ? exitCode : undefined
          lastStderr = tail === '' ? undefined : tail
          lastDeliveredAt = Date.now()
          if (lastExitCode !== undefined && lastExitCode !== 0) {
            failed += 1
            lastError = `通知命令退出码 ${lastExitCode}${lastStderr === undefined ? '' : `：${lastStderr}`}`
            console.warn(`[dsh-notify] ${lastError}`)
          }
        }, (error) => {
          if (disposed) return
          failed += 1
          lastError = describe(error)
          console.warn(`[dsh-notify] 通知命令执行失败：${lastError}`)
        })
      }
      return handle ?? true
    } catch (error) {
      lastError = describe(error)
      console.error(`[dsh-notify] 无法执行通知命令：${lastError}`)
      return false
    }
  }

  /**
   * 自绘横幅失败（PowerShell 报错 / WinForms 不可用）时，退回系统 Toast。
   *
   * 「什么都没弹」是最差的失败模式：用户根本不知道有通知。退回 Toast 至少右下角能看到，
   * 而且失败原因（退出码 + stderr）已经写进 diag，不会变成静默。
   */
  function attachToastFallback(handle, message, iconPath) {
    if (!handle || !handle.done || typeof handle.done.then !== 'function') return
    handle.done.then((outcome) => {
      if (disposed) return
      const exitCode = outcome?.exitCode
      if (exitCode === 0 || exitCode === null) return
      void pickPowerShell().then((ps) => {
        if (disposed || ps === undefined) return
        const bannerError = lastError
        lastFallback = 'toast'
        spawnNotify([
          ps.exe, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-Command', powershellToastScript(message.title, message.body, cfg.windowsAppId, iconPath),
        ], message.cwd)
        // spawnNotify 会把 lastError 清空：把横幅失败的原因补回去，
        // 否则「右下角弹了 Toast」会掩盖「右上角为什么没弹」。
        if (bannerError !== undefined) lastError = `${bannerError}（已退回系统 Toast）`
      })
    }, () => {})
  }

  /** 跑一条命令并等它结束；任何失败都返回 undefined。构建通知 app 用。 */
  function spawnWait(argv, cwd, timeoutMs) {
    return new Promise((resolve) => {
      const subprocess = subprocessService()
      if (!subprocess || typeof subprocess.spawn !== 'function') {
        resolve(undefined)
        return
      }
      try {
        const handle = subprocess.spawn({
          argv,
          cwd: safeCwd(cwd),
          stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
          graceMs: timeoutMs ?? 20_000,
        })
        if (handle && handle.done && typeof handle.done.then === 'function') {
          handle.done.then(resolve, () => resolve(undefined))
        } else {
          resolve({ exitCode: 0 })
        }
      } catch (error) {
        lastError = describe(error)
        resolve(undefined)
      }
    })
  }

  /** 跑一条命令并回收 stdout（需要读取输出时用，例如取 SDK 路径）。 */
  function spawnCapture(argv, cwd, timeoutMs) {
    return new Promise((resolve) => {
      const subprocess = subprocessService()
      if (!subprocess || typeof subprocess.spawn !== 'function') {
        resolve(undefined)
        return
      }
      try {
        const handle = subprocess.spawn({
          argv,
          cwd: safeCwd(cwd),
          stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
          graceMs: timeoutMs ?? 20_000,
        })
        const finish = (outcome) => {
          let out = ''
          try {
            out = handle?.collected?.stdout?.readFrom(0)?.text ?? ''
          } catch {
            out = ''
          }
          resolve({ exitCode: outcome?.exitCode ?? -1, out })
        }
        if (handle && handle.done && typeof handle.done.then === 'function') {
          handle.done.then(finish, () => resolve(undefined))
        } else {
          resolve({ exitCode: 0, out: '' })
        }
      } catch (error) {
        lastError = describe(error)
        resolve(undefined)
      }
    })
  }

  /** 通知 app 的基础目录（默认 ~/.dsh/dsh-notify）。 */
  function resolveNotifierBase() {
    if (typeof cfg.notifierDir === 'string' && cfg.notifierDir !== '') return cfg.notifierDir
    const home = homeDir()
    return home === '' ? '' : `${home}/.dsh/dsh-notify`
  }

  /**
   * 通知 app 的存放目录：**带构建版本号**。
   *
   * 为什么不吃「原地重建」：macOS 的图标服务按路径缓存 app 图标，同一路径下换了图标
   * 也会继续显示旧图（实测：文件里已经是彩色 icns、NSWorkspace 取出来也是彩色，
   * 但通知横幅仍是上一代的黑白图标）。换路径 = 换缓存记录。
   *
   * 同时它也让「同一 bundle id 多份注册」不会再发生（旧路径的 app 会被清掉）——
   * 重复注册同样会让通知显示到旧副本的图标上（实测踩过）。
   */
  function resolveNotifierDir() {
    const base = resolveNotifierBase()
    return base === '' ? '' : `${base}/${NOTIFIER_BUILD}`
  }

  /** LaunchServices 命令行工具路径。 */
  const LSREGISTER_PATH = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

  /** 清掉旧一代的 app 目录与注册，避免同一 bundle id 出现多份。 */
  async function purgeLegacyNotifiers(base) {
    if (base === '') return
    const legacy = [
      `${base}/${cfg.appName}.app`, // 早期版本直接放在基础目录
      `${base}/swift-v1`,
      `${base}/swift-v2`,
    ]
    for (const path of legacy) {
      if (path === resolveNotifierDir()) continue
      await spawnWait([LSREGISTER_PATH, '-u', `${path}/` + cfg.appName + '.app'])
      await spawnWait(['/bin/rm', '-rf', path])
    }
    // 早期版本直接写在基础目录下的散件（队列、编译缓存、源码、状态、旧标记）。
    if (base !== resolveNotifierDir()) {
      for (const name of ['queue', 'modulecache', 'notifier.swift', 'last-status.txt',
        '.built-swift-v1', '.built-swift-v2', '.built-v3']) {
        await spawnWait(['/bin/rm', '-rf', `${base}/${name}`])
      }
    }
  }

  /**
   * 幂等地构建带官方图标的通知 app（Swift + UNUserNotificationCenter）。
   *
   * 为什么不用 AppleScript applet：macOS 26 不给它通知身份（实测静默丢弃、从不弹授权）。
   * 这个 app 的每个构建步骤都是实测得出的必要条件：真正的 NSApplication 运行时、
   * 官方通知 API、bundle id、ad-hoc 签名、LaunchServices 注册。
   *
   * 失败不抛错：返回 false，由 deliver 退回 osascript。
   */
  function ensureNotifier() {
    if (notifierState === 'ready') return Promise.resolve(true)
    if (notifierState === 'failed') return Promise.resolve(false)
    if (notifierPromise) return notifierPromise
    notifierPromise = (async () => {
      const subprocess = subprocessService()
      if (!subprocess || typeof subprocess.spawn !== 'function') return false
      if (platform !== 'darwin') return false
      const base = resolveNotifierBase()
      const dir = resolveNotifierDir()
      if (base === '' || dir === '') return false
      const target = `${dir}/${cfg.appName}.app`
      const icns = typeof cfg.iconPath === 'string' && cfg.iconPath !== ''
        ? cfg.iconPath
        : assetPath(ICON_ICNS_RELATIVE)
      const source = assetPath(NOTIFIER_SWIFT_RELATIVE)
      if (source === undefined) return false

      const mkdir = await spawnWait(['/bin/mkdir', '-p', `${dir}/queue`, `${dir}/modulecache`])
      if (mkdir === undefined || mkdir.exitCode !== 0) return false

      // 复用已建好的（例如先跑过 npm run notifier）：宿主若没有写 ~/.dsh 的权限也能用。
      // **但必须先校验身份**：只认路径会把「换了 bundle id」的旧 app 也复用掉
      // （实测踩过：换了身份后重启，插件复用了旧 app，通知里仍是旧图标快照）。
      const exists = await spawnWait(['/bin/test', '-f', `${target}/Contents/MacOS/notifier`])
      if (exists !== undefined && exists.exitCode === 0) {
        const probe = await spawnCapture(
          ['/usr/bin/plutil', '-extract', 'CFBundleIdentifier', 'raw', `${target}/Contents/Info.plist`],
          undefined, 5_000,
        )
        const current = probe !== undefined && probe.exitCode === 0 ? probe.out.trim() : ''
        if (current === notifierBundleId()) {
          await purgeLegacyNotifiers(base)
          notifierPath = target
          return true
        }
        console.log(`[dsh-notify] 通知 app 身份已变（${current || '未知'} → ${notifierBundleId()}），重建`)
      }

      // 换图标/换配方时先清掉旧路径，避免同一 bundle id 多份注册（会让通知显示旧图标）。
      await purgeLegacyNotifiers(base)

      // 换图标/换配方时先清掉旧 bundle，避免残留上一代的可执行文件或图标。
      await spawnWait(['/bin/rm', '-rf', target])
      const dirs = await spawnWait(['/bin/mkdir', '-p', `${target}/Contents/MacOS`, `${target}/Contents/Resources`])
      if (dirs === undefined || dirs.exitCode !== 0) return false
      const copiedSource = await spawnWait(['/bin/cp', source, `${dir}/notifier.swift`])
      if (copiedSource === undefined || copiedSource.exitCode !== 0) return false

      // 显式给 SDK 与模块缓存路径：缺了它们 swiftc 可能报模块/缓存错误（实测）。
      const sdk = await spawnCapture(['/usr/bin/xcrun', '--show-sdk-path'])
      const sdkPath = sdk !== undefined && sdk.exitCode === 0 ? sdk.out.trim() : ''
      const compileArgv = ['/usr/bin/swiftc', '-O']
      if (sdkPath !== '') compileArgv.push('-sdk', sdkPath)
      compileArgv.push(
        '-module-cache-path', `${dir}/modulecache`,
        '-o', `${target}/Contents/MacOS/notifier`,
        `${dir}/notifier.swift`,
      )
      const compiled = await spawnCapture(compileArgv, undefined, 180_000)
      if (compiled === undefined || compiled.exitCode !== 0) {
        const tail = (compiled?.out ?? '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'unknown'
        lastError = `通知 app 编译失败：${tail}`
        return false
      }

      const plist = `${target}/Contents/Info.plist`
      const created = await spawnWait(['/usr/bin/plutil', '-create', 'xml1', plist])
      if (created === undefined || created.exitCode !== 0) return false
      const fields = [
        ['CFBundleIdentifier', notifierBundleId()],
        ['CFBundleName', cfg.appName],
        ['CFBundleDisplayName', cfg.appName],
        ['CFBundleExecutable', 'notifier'],
        ['CFBundlePackageType', 'APPL'],
        ['CFBundleShortVersionString', '1.0'],
        ['CFBundleVersion', '1'],
        ['CFBundleIconFile', 'applet.icns'],
        ['LSMinimumSystemVersion', '11.0'],
      ]
      for (const [key, value] of fields) {
        await spawnWait(['/usr/bin/plutil', '-insert', key, '-string', value, plist])
      }
      // 后台代理：不占 Dock（与 Swift 侧的 .accessory 一致）。
      await spawnWait(['/usr/bin/plutil', '-insert', 'LSUIElement', '-bool', 'true', plist])
      if (icns !== undefined) {
        await spawnWait(['/bin/cp', icns, `${target}/Contents/Resources/applet.icns`])
      }

      // 签名 + 注册：通知系统只认真实、已注册的 app。
      await spawnWait(['/usr/bin/codesign', '--force', '-s', '-', target])
      await spawnWait([LSREGISTER_PATH, '-f', target])
      notifierPath = target
      return true
    })().then((ok) => {
      notifierState = ok ? 'ready' : 'failed'
      if (ok) {
        console.log(`[dsh-notify] 通知 app 就绪：${notifierPath}`)
      } else {
        console.warn(`[dsh-notify] 通知 app 未就绪，退回 osascript（图标会是「脚本编辑器」）：${lastError ?? ''}`)
      }
      return ok
    })
    return notifierPromise
  }

  /**
   * 用通知 app 投递：把三行载荷丢进队列目录，再 `open -a` 启动它取走。
   *
   * 为什么走队列而不是参数：`open -a App --args ...` **不会**把参数传给进程（实测），
   * 而 applet 的 droplet 语义对普通 app 不适用；队列文件 + app 侧原子改名抢占，
   * 既避免转义问题，也不会在并发时重复显示。
   *
   * @returns 是否成功
   */
  async function deliverViaNotifier(message, sound) {
    if (!(await ensureNotifier())) return false
    if (notifierPath === undefined) return false
    const dir = resolveNotifierDir()
    payloadSeq += 1
    const payload = `${dir}/queue/${Date.now()}-${payloadSeq}.txt`
    // 用 node:fs 落盘（动态 import）：Windows 上没有 /bin/sh，这套代码要跨平台。
    const written = await writePayloadFile(`${dir}/queue`, payload, [message.title, message.body, sound || ''])
    if (!written) return false
    const opened = await spawnWait(['/usr/bin/open', '-a', notifierPath], message.cwd)
    if (opened === undefined || opened.exitCode !== 0) return false
    delivered += 1
    lastError = undefined
    lastCommand = `open -a ${cfg.appName}.app`
    lastExitCode = 0
    lastDeliveredAt = Date.now()
    return true
  }

  /**
   * 投递一条系统通知。
   * @param message - { title, subtitle, body, sound, cwd, group }
   */
  async function deliver(message) {
    if (disposed) return
    try {
      await configReady // 先让 <基础目录>/config.json 生效
      const backend = await resolveBackend()
      backendKind = backend === undefined ? 'none' : backend.kind
      if (backend === undefined) return
      const sound = typeof message.sound === 'string' ? message.sound : cfg.sound
      const subtitle = typeof message.subtitle === 'string' ? message.subtitle : ''
      if (backend.kind === 'notifier') {
        if (await deliverViaNotifier(message, sound)) return
        // 构建或投递失败：退回 osascript，保证通知一定发得出去。
      }
      if (backend.kind === 'osascript' || backend.kind === 'notifier') {
        // 按是否有副标题/提示音挑脚本：默认没有副标题，横幅就是干净的两行。
        const script = subtitle === ''
          ? (sound === '' ? OSA_SCRIPTS.plain : OSA_SCRIPTS.withSound)
          : (sound === '' ? OSA_SCRIPTS.withSubtitle : OSA_SCRIPTS.withSubtitleSound)
        spawnNotify([OSA_PATH, '-e', script, message.title, subtitle, message.body, sound || ''], message.cwd)
        return
      }
      if (backend.kind === 'terminal-notifier') {
        const argv = [
          backend.exe || 'terminal-notifier',
          '-title', message.title,
          '-message', message.body,
        ]
        if (subtitle !== '') argv.push('-subtitle', subtitle)
        if (sound) argv.push('-sound', sound)
        if (message.group) argv.push('-group', message.group)
        if (cfg.openUrl) argv.push('-open', cfg.openUrl)
        // 官方图标（terminal-notifier 的 -appIcon）。
        const appIcon = typeof cfg.iconPngPath === 'string' && cfg.iconPngPath !== ''
          ? cfg.iconPngPath
          : assetPath(ICON_PNG_RELATIVE)
        if (appIcon !== undefined) argv.push('-appIcon', appIcon)
        spawnNotify(argv, message.cwd)
        return
      }
      const iconPath = typeof cfg.iconPngPath === 'string' && cfg.iconPngPath !== ''
        ? cfg.iconPngPath
        : assetPath(ICON_PNG_RELATIVE)

      // Linux：notify-send（-i 通知图标、-u 紧急级别、-a 应用名）
      if (backend.kind === 'notify-send') {
        const argv = [backend.exe, '-a', cfg.appName]
        if (iconPath !== undefined) argv.push('-i', iconPath)
        if (message.urgency) argv.push('-u', message.urgency)
        argv.push(message.title, message.body)
        spawnNotify(argv, message.cwd)
        return
      }

      // Windows：SnoreToast（单文件、无需注册；-p 是通知里的图片）
      if (backend.kind === 'snoretoast') {
        const argv = [backend.exe, '-t', message.title, '-m', message.body]
        if (iconPath !== undefined) argv.push('-p', iconPath)
        argv.push('-appID', cfg.windowsAppId)
        if (!sound) argv.push('-silent')
        spawnNotify(argv, message.cwd)
        return
      }

      // Windows：自绘置顶横幅（位置可控，默认右上角；不是系统通知）
      if (backend.kind === 'banner') {
        const bannerHandle = spawnNotify([
          backend.exe, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-Command', powershellBannerScript({
            title: message.title,
            body: message.body,
            iconPath,
            position: cfg.bannerPosition,
            width: cfg.bannerWidth,
            minWidth: cfg.bannerMinWidth,
            radius: cfg.bannerRadius,
            height: cfg.bannerHeight,
            durationMs: cfg.bannerDurationMs,
            openUrl: cfg.openUrl,
          }),
        ], message.cwd)
        // 自绘窗口失败时至少退回系统 Toast —— 不允许「什么都没有」。
        attachToastFallback(bannerHandle, message, iconPath)
        return
      }

      // Windows：PowerShell + WinRT Toast（免安装；AUMID 默认用系统 PowerShell 的）
      if (backend.kind === 'powershell') {
        spawnNotify([
          backend.exe, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-Command', powershellToastScript(message.title, message.body, cfg.windowsAppId, iconPath),
        ], message.cwd)
        return
      }

      if (backend.kind === 'command') {
        const template = Array.isArray(cfg.command) ? cfg.command : []
        if (template.length === 0) return
        const argv = template.map((part) => String(part)
          .replaceAll('{title}', message.title)
          .replaceAll('{subtitle}', message.subtitle)
          .replaceAll('{body}', message.body)
          .replaceAll('{app}', cfg.appName)
          .replaceAll('{icon}', iconPath ?? ''))
        spawnNotify(argv, message.cwd)
      }
    } catch (error) {
      lastError = describe(error)
      console.error(`[dsh-notify] 通知失败：${lastError}`)
    }
  }

  /** 不等待结果地投递。 */
  function fire(message) {
    void deliver(message)
  }

  /**
   * 记录一条通知：写 feed（页面卡片）+ 弹系统通知。
   * @param item - feed 条目（kind/name/body/sessionId）
   * @param message - 系统通知文案
   * @returns feed seq，用作卡片 id
   */
  function notify(item, message) {
    const seq = publish(item)
    fire(message)
    return seq
  }

  /**
   * 带重复提醒的待办：先通知，再按 remindEveryMs 反复提醒，直到 stop()。
   * stop() 无论提醒开没开都会补一条 resolve —— 否则页面卡片会永远卡在「待处理」。
   * @param message - 系统通知文案
   * @param ref - resolve 时回传的卡片 id
   */
  function startPlan(message, ref) {
    let stopped = false
    let timer
    if (cfg.remindEveryMs > 0 && cfg.maxReminders > 0) {
      let reminder = 0
      timer = setInterval(() => {
        if (disposed) return
        reminder += 1
        if (reminder > cfg.maxReminders) {
          clearInterval(timer)
          timers.delete(timer)
          return
        }
        fire(Object.assign({}, message, { body: `${message.body}（第 ${reminder} 次提醒）` }))
      }, cfg.remindEveryMs)
      timers.add(timer)
    }
    return {
      stop() {
        if (stopped) return
        stopped = true
        if (timer !== undefined) {
          clearInterval(timer)
          timers.delete(timer)
        }
        publish({ kind: 'resolve', ref })
      },
    }
  }

  // -------------------------------------------------------------------------
  // ① 审批 / 提问：waterfall 里的「抢位观察者」
  // -------------------------------------------------------------------------

  /**
   * 注册一个 waterfall 观察者：**先**发通知，再把请求原样交还下游。
   * `prepend: true` 是关键 —— 否则内置应答者会先领走请求，这里永远不执行。
   */
  function observeWaterfall(eventName, build) {
    try {
      ctx.on(eventName, function (request, next) {
        let outcome
        let stopPlan
        try {
          const plan = build(request)
          stopPlan = plan ? plan.stop : undefined
        } catch (error) {
          console.error(`[dsh-notify] 处理 ${eventName} 通知失败：${describe(error)}`)
        }
        try {
          outcome = next()
        } catch (error) {
          if (stopPlan) stopPlan()
          throw error
        }
        return Promise.resolve(outcome).finally(() => {
          if (stopPlan) {
            try {
              stopPlan()
            } catch (error) {
              console.error(`[dsh-notify] 清理 ${eventName} 提醒失败：${describe(error)}`)
            }
          }
        })
      }, { prepend: true })
    } catch (error) {
      console.error(`[dsh-notify] 无法注册 ${eventName} 监听：${describe(error)}`)
    }
  }

  if (cfg.approval) {
    observeWaterfall('approval/request', (req) => {
      const sessionId = req && req.agent ? req.agent.id : undefined
      const info = sessionInfo(sessionId)
      if (info.subagent && !cfg.includeSubagents) return undefined
      const name = conversationName(info.cwd)
      const toolName = clip(req?.toolName, 24) || '工具调用'
      // 横幅只留一句：工具名比一整段理由有用得多；理由放卡片的详情行。
      const body = `🔐 需要审批：${toolName}`
      const detail = clip(req?.reason, cfg.detailChars)
      const message = {
        title: name,
        subtitle: cfg.subtitle,
        body,
        cwd: info.cwd,
        sound: cfg.sound,
        urgency: cfg.linuxUrgentUrgency,
        group: `dsh-notify-approval-${String(req?.callId ?? sessionId ?? 'unknown')}`,
      }
      const ref = notify({ kind: 'approval', name, body, detail, sessionId }, message)
      const plan = startPlan(message, ref)
      const key = String(req?.callId ?? sessionId ?? '')
      if (key) openPlans.set(key, plan)
      return {
        stop() {
          if (key) openPlans.delete(key)
          plan.stop()
        },
      }
    })
  }

  if (cfg.question) {
    observeWaterfall('user-questions/request', (request) => {
      const sessionId = request && request.agent ? request.agent.id : undefined
      const info = sessionInfo(sessionId)
      if (info.subagent && !cfg.includeSubagents) return undefined
      const name = conversationName(info.cwd)
      const first = Array.isArray(request?.questions) ? request.questions[0] : undefined
      const text = first && typeof first.question === 'string' ? first.question : '有一个问题需要你回答'
      // 横幅只带一小截题干；完整内容放卡片的详情行。
      const snippet = clip(text, cfg.snippetChars)
      const body = snippet === '' ? '❓ 需要你回答' : `❓ 需要你回答：${snippet}`
      const detail = clip(text, cfg.detailChars)
      const message = {
        title: name,
        subtitle: cfg.subtitle,
        body,
        cwd: info.cwd,
        sound: cfg.sound,
        urgency: cfg.linuxUrgentUrgency,
      }
      const ref = notify({ kind: 'question', name, body, detail, sessionId }, message)
      const plan = startPlan(message, ref)
      return { stop: () => plan.stop() }
    })
  }

  // -------------------------------------------------------------------------
  // ② 任务跑完（agent/status 是 emit，所有监听都会执行）
  // -------------------------------------------------------------------------

  if (cfg.done) {
    try {
      ctx.on('agent/status', (payload) => {
        try {
          const agent = payload && payload.agent
          const status = payload && payload.status
          if (!agent || !agent.id) return
          if (status === 'running') {
            runs.set(agent.id, Date.now())
            return
          }
          if (status !== 'idle') return
          const startedAt = runs.get(agent.id)
          runs.delete(agent.id)
          if (startedAt === undefined) return
          const elapsed = Date.now() - startedAt
          if (elapsed < cfg.minRunMs) return
          const info = sessionInfo(agent.id)
          if (info.subagent && !cfg.includeSubagents) return
          const name = conversationName(info.cwd)
          const body = `✅ 任务完成 · ${humanDuration(elapsed)}`
          notify({ kind: 'done', name, body, sessionId: agent.id }, {
            title: name,
            subtitle: cfg.subtitle,
            body,
            cwd: info.cwd,
            sound: cfg.sound,
            urgency: 'normal',
            group: `dsh-notify-done-${String(agent.id)}`,
          })
        } catch (error) {
          console.error(`[dsh-notify] 处理 agent/status 失败：${describe(error)}`)
        }
      })
    } catch (error) {
      console.error(`[dsh-notify] 无法注册 agent/status 监听：${describe(error)}`)
    }
  }

  // 启动自检：subprocess 等依赖可能晚一拍注册，所以这里是有界重试而不是一次性判定，
  // 免得把「暂时还没就绪」当成「永远没有通道」（第一版就是在这里翻的车）。
  let probeAttempts = 0
  function probeBackend() {
    if (disposed) return
    void resolveBackend().then((backend) => {
      if (disposed) return
      if (backend !== undefined) {
        console.log(`[dsh-notify] 系统通知通道：${backend.kind}`)
        // 通知 app 需要先构建（swiftc 编译 + 签名 + 注册，约 2-5 秒）。提前在后台
        // 做好，这样第一条通知不必等构建。失败会自行退回 osascript。
        if (backend.kind === 'notifier') void ensureNotifier()
        return
      }
      probeAttempts += 1
      if (probeAttempts >= 15) {
        backendKind = 'none'
        lastError = '未找到可用的系统通知通道（缺少 subprocess 服务或平台不受支持）'
        console.warn(`[dsh-notify] ${lastError}`)
        return
      }
      const timer = setTimeout(() => {
        timers.delete(timer)
        probeBackend()
      }, 2_000)
      // 自检不该拖住宿主进程退出。
      if (typeof timer.unref === 'function') timer.unref()
      timers.add(timer)
    })
  }
  probeBackend()
}
