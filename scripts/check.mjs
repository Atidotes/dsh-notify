#!/usr/bin/env node
/**
 * 安装前自检：npm run check
 *
 * 每条规则都对应 Harness 在「列出 / 安装 / 读取」这个包时真正会做的事：
 * patch 解析不了、icon 越出包目录、locale 没被自己 exports 暴露——这些都是
 * 静默失败（插件列表退回显示裸包名、没有图），在这里一秒能发现，在 GUI 里
 * 可能得重启才发现。零依赖，只用 Node 内置模块。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const warnings = []
const ok = (message) => console.log(`  \u2713 ${message}`)
const bad = (message) => { failures.push(message); console.log(`  \u2717 ${message}`) }
const warn = (message) => { warnings.push(message); console.log(`  ! ${message}`) }
const skip = (message) => console.log(`  \u2013 ${message} (跳过)`)
const section = (title) => console.log(`\n${title}`)

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    bad(`${label} 不是可读 JSON：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

// --- package.json ----------------------------------------------------------
section('package.json')
const manifest = readJson(join(root, 'package.json'), 'package.json')
const name = manifest?.name

if (manifest !== undefined) {
  for (const field of ['name', 'version', 'description', 'icon']) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      bad(`package.json.${field} 必须是非空字符串`)
    }
  }
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch !== 'string' && !Array.isArray(patch)) {
    bad('package.json.dsh.bundle.patch 必须是文件路径或路径数组')
  }
  if (typeof manifest.dsh?.client?.platform !== 'string') {
    bad('package.json.dsh.client.platform 必须是字符串')
  }
  for (const key of ['.', './client', './package.json']) {
    if (typeof manifest.exports?.[key] !== 'string') {
      bad(`package.json.exports[${JSON.stringify(key)}] 必须是字符串路径`)
    }
  }
  for (const key of ['.', './client']) {
    const target = manifest.exports?.[key]
    if (typeof target === 'string' && !existsSync(join(root, target))) {
      bad(`exports[${JSON.stringify(key)}] 指向不存在的文件：${target}`)
    }
  }
  if (failures.length === 0) ok(`name=${name} version=${manifest.version}`)
}

// --- host / browser 两半 ---------------------------------------------------
section('两半代码')
for (const file of ['dsh/host.js', 'dsh/client.js']) {
  const path = join(root, file)
  if (!existsSync(path)) { bad(`${file} 缺失`); continue }
  const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
  if (checked.status === 0) ok(`${file} 语法通过`)
  else bad(`${file} 语法错误：${(checked.stderr ?? '').trim().split('\n')[0]}`)
}

const hostSource = existsSync(join(root, 'dsh/host.js')) ? readFileSync(join(root, 'dsh/host.js'), 'utf8') : ''
// 配置卡需要 schemastery 声明 Config；除此之外 host 半仍然零依赖。
const topImports = [...hostSource.matchAll(/^import\s+[^\n]*from\s+'([^']+)'/gm)].map(match => match[1])
if (topImports.length === 0) warn('dsh/host.js 没有顶层 import（Config schema 缺失？配置卡会没有字段）')
else if (topImports.every(spec => spec === '@deepseek-ai/schemastery')) ok(`dsh/host.js 的顶层 import 只有 schemastery（${topImports.length} 处）`)
else bad(`dsh/host.js 引入了意料之外的顶层依赖：${topImports.join(', ')}`)
const dynamicImports = [...hostSource.matchAll(/import\((['"])([^'"]+)\1\)/g)].map((m) => m[2])
if (dynamicImports.length > 0 && dynamicImports.every((spec) => spec.startsWith('node:'))) {
  ok(`动态 import 只用 Node 内置模块（${dynamicImports.join(', ')}）`)
} else if (dynamicImports.length === 0) {
  ok('没有动态 import')
} else {
  bad(`动态 import 引入了非内置模块：${dynamicImports.join(', ')}`)
}

// 跨平台：三处平台假设都要照顾到
for (const [needle, label] of [
  ['USERPROFILE', '主目录兼容 Windows（USERPROFILE / HOMEDRIVE+HOMEPATH）'],
  ['a-zA-Z]:[', '绝对路径判断兼容 Windows 盘符'],
  ['notify-send', 'Linux：notify-send 后端'],
  ['SnoreToast', 'Windows：SnoreToast 后端'],
  ['ToastNotificationManager', 'Windows：PowerShell WinRT Toast 兜底'],
  ['ShowDialog', 'Windows：自绘横幅模式（位置可控，可贴右上角）'],
  ['SetProcessDPIAware', 'Windows：DPI 感知（缩放屏上不被位图放大 = 不会「太大」）'],
  ['AppsUseLightTheme', 'Windows：横幅浅色/深色跟随系统外观'],
  ['bannerPosition', '横幅位置可配（topright/topleft/…）'],
  ["windowsStyle: 'banner'", 'Windows 默认形态是自绘弹出窗（系统 Toast 会被专注助手静默吞掉）'],
  ['wrapPowerShell', 'PowerShell 脚本失败要非 0 退出（否则「没弹出来」与「投递成功」无法区分）'],
  ['横幅降级', '横幅装饰性语句逐条兜底（单句报错只丢外观，不能整条通知消失）'],
  ['attachToastFallback', '横幅失败退回系统 Toast（绝不允许「什么都没弹」）'],
  ['lastStderr', '诊断暴露通知命令的 stderr / 退出码（Windows 排错靠它定位）'],
  ['Error.WriteLine((', '诊断行用「双层括号 + 拼接」：-f 写在方法参数里会被逗号拆开而报 FormatException'],
  ['node:fs/promises', '文件读写走 node:fs（不再依赖 /bin/sh、/bin/cat）'],
]) {
  if (hostSource.includes(needle)) ok(label)
  else bad(`缺少跨平台处理：${label}`)
}
// 通知正文不带前缀 emoji（用户要求：勾选 / 锁 / 问号这几个图标不展示）
for (const emoji of ['\u{1F510}', '\u{2753}', '\u{2705}']) {
  if (hostSource.includes(emoji)) bad(`通知正文又出现了 emoji：${emoji}`)
  else ok('通知正文不带前缀图标（勾选 / 锁 / 问号）')
}
if (hostSource.includes("spawnWait(['/bin/sh'") || hostSource.includes("spawnCapture(['/bin/cat'")) {
  bad('仍有 /bin/sh 或 /bin/cat 依赖（Windows 上不存在）')
} else {
  ok('没有 /bin/sh、/bin/cat 依赖')
}

// 客户端半是纯渲染器：必须落位 shell.overlay，并消费 host 的 feed 路由。
const clientSource = existsSync(join(root, 'dsh/client.js')) ? readFileSync(join(root, 'dsh/client.js'), 'utf8') : ''
if (clientSource.includes('shell.overlay')) ok('客户端半仍注册 shell.overlay（只作降级提示条的挂载点）')
else bad('客户端半没有注册到 shell.overlay')
if (clientSource.includes('dsn-card')) bad('页面里又出现了通知卡片：本插件只做系统通知')
else ok('页面内不渲染任何通知卡片（只保留系统通知）')
if (clientSource.includes('/dsh-notify/feed')) ok('客户端半消费 host 的 /dsh-notify/feed')
else bad('客户端半没有接上 feed 路由')
if (clientSource.includes('EventSource') && clientSource.includes('/dsh-notify/stream')) {
  ok('客户端半优先用 SSE 长连接（后台标签页不受轮询限流影响）')
} else {
  bad('客户端半没有接上 SSE 推送')
}

// 配置卡：注册进 Plugins 页的 bundle 配置区，走 settings 的 configForms
if (clientSource.includes("'plugins.bundle.config'") && clientSource.includes('configForms.get')) {
  ok('客户端半把配置卡注册进 plugins.bundle.config（Plugins 页的插件详情）')
} else {
  bad('客户端半没有注册配置卡')
}
if (clientSource.includes('CONFIG_ZH') && clientSource.includes('CONFIG_EN')) {
  ok('配置卡带中英双语词典')
} else {
  bad('配置卡缺少中英词典')
}
for (const [needle, label] of [
  ['border: solid #fff', '复选框自绘白色勾（不用系统绘制的黑色对勾）'],
  ["type: 'text', inputMode: 'numeric'", '数字字段用普通文本框（不要原生数字框箭头）'],
  ['.dsn-cfg-selectwrap', '下拉自绘箭头（去掉原生外观）'],
  ['appearance: none; -webkit-appearance: none; -moz-appearance: none', '下拉去掉原生样式'],
  ["key: 'approval'", '开关字段'], ["key: 'minRunMs'", '触发时机字段'],
  ["key: 'windowsStyle'", '提醒类型字段'], ["key: 'titleFrom'", '文案字段'],
  ["key: 'bannerWidth'", '长度字段'], ["key: 'bannerRadius'", '圆角字段'],
]) {
  if (clientSource.includes(needle)) ok(`配置卡含${label}（${needle}）`)
  else bad(`配置卡缺${label}`)
}
if (/require\((['"])@deepseek-ai\//.test(clientSource)) {
  bad('客户端半 require 了非客户端模块行的包（浏览器里解析不到）')
} else {
  ok('客户端半只 require 能解析到的模块（react）')
}
if (clientSource.includes('requestPermission') && clientSource.includes('new api(')) {
  ok('客户端半带浏览器系统通知兜底 + 权限申请（只在 host 通道失效时启用）')
} else {
  bad('客户端半缺少浏览器通知兜底')
}
if (/remote\.\$on\(\s*['"]/.test(clientSource)) bad('客户端半不应再订阅 remote 事件（会被 waterfall 的 gate 跳过）')
else ok('客户端半没有会漏通知的 remote 事件订阅')

// host 半的审批观察者必须抢位，否则会被内置应答者领走请求。
if (hostSource.includes('prepend: true')) ok('host 半用 prepend 抢在 gate 之前观察审批')
else bad('host 半没有 prepend：审批通知会被内置应答者跳过')
if (hostSource.includes('text/event-stream')) ok('host 半提供 SSE 推送路由')
else bad('host 半缺少 SSE 推送路由')
if (/backendPromise = undefined/.test(hostSource)) ok('host 半不缓存失败的通道探测（服务晚注册也能恢复）')
else bad('host 半会把失败的通道探测永久缓存')
if (hostSource.includes('swiftc') && hostSource.includes('notifier.swift')) {
  ok('host 半自编译带官方图标的通知 app（Swift + 官方通知 API）')
} else {
  bad('host 半缺少通知 app 通道：通知会退化成 osascript（「脚本编辑器」图标）')
}
for (const [needle, label] of [
  ['CFBundleIdentifier', '写入 CFBundleIdentifier（缺了通知系统直接 "not allowed"）'],
  ['codesign', 'ad-hoc 签名'],
  ['lsregister', '注册到 LaunchServices'],
  ['UNUserNotificationCenter', '官方通知 API'],
  ['NSApplication', '真正的 App 运行时（裸 CLI 进程拿不到通知身份）'],
]) {
  const inHost = hostSource.includes(needle)
  const inSwift = existsSync(join(root, 'dsh/notifier.swift'))
    && readFileSync(join(root, 'dsh/notifier.swift'), 'utf8').includes(needle)
  if (inHost || inSwift) ok(label)
  else bad(`缺少：${label}`)
}

// --- bundle 层 -------------------------------------------------------------
section('bundle 层')
const patchFiles = typeof manifest?.dsh?.bundle?.patch === 'string'
  ? [manifest.dsh.bundle.patch]
  : Array.isArray(manifest?.dsh?.bundle?.patch) ? manifest.dsh.bundle.patch : []
if (patchFiles.length === 0) {
  skip('未声明 bundle patch')
} else {
  for (const file of patchFiles) {
    const path = resolve(root, file)
    if (!existsSync(path)) { bad(`bundle patch 缺失：${file}`); continue }
    const text = readFileSync(path, 'utf8')
    if (text.includes('- insert:') && text.includes(`name: '${name}'`)) {
      ok(`${file} 声明了指向 ${name} 的 insert 行`)
    } else {
      bad(`${file} 没有声明指向 ${name} 的 insert 行`)
    }
    // 行 id 必须与 patch 里的 id 一致，否则 profile 里会出现两个身份。
    const idMatch = /-\s*id:\s*([^\s]+)/.exec(text)
    if (idMatch !== null && idMatch[1] === name) ok(`行 id 与包名一致（${idMatch[1]}）`)
    else if (idMatch !== null) warn(`行 id（${idMatch[1]}）与包名（${name}）不同：功能可用，但 profile 里会是两个名字`)
  }
}

// --- icon ------------------------------------------------------------------
section('图标')
const icon = manifest?.icon
if (typeof icon !== 'string') {
  skip('未声明图标')
} else if (isAbsolute(icon) || /^[A-Za-z][A-Za-z\d+.-]*:/.test(icon)) {
  bad('package.json.icon 必须是相对路径')
} else {
  const mediaTypes = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
  const media = mediaTypes[extname(icon).toLowerCase()]
  const path = resolve(root, icon)
  const within = relative(root, path)
  if (media === undefined) bad('图标必须是 SVG / PNG / JPEG / WebP')
  else if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) bad('图标必须留在包目录内')
  else if (!existsSync(path) || !statSync(path).isFile()) bad(`图标缺失：${icon}`)
  else if (statSync(path).size > 256 * 1024) bad(`图标超过 256 KiB（${statSync(path).size} 字节）`)
  else {
    const local = relative(realpathSync(root), realpathSync(path))
    if (local === '..' || local.startsWith(`..${sep}`)) bad('图标经符号链接逃出了包目录')
    else ok(`${icon}（${media}，${statSync(path).size} 字节）`)
  }
}

// --- 两类图标：别混 ---------------------------------------------------------
section('两类图标')
if (manifest?.icon === './icon.svg') {
  ok('插件卡片图标 = ./icon.svg（消息气泡，插件列表里显示的那个）')
} else {
  bad(`插件卡片图标应为 ./icon.svg（当前 ${manifest?.icon}）：它是插件列表的图标，不是系统通知的`)
}
if (existsSync(join(root, 'dsh/deepseek.icns')) && existsSync(join(root, 'dsh/deepseek.png'))) {
  ok('系统通知图标 = 包内 DeepSeek 官方图标（由自建通知 app 承载，与插件卡片图标无关）')
} else {
  bad('缺少系统通知用的 DeepSeek 官方图标素材')
}

// --- 通知图标素材 -----------------------------------------------------------
section('通知图标素材')
for (const asset of ['dsh/deepseek.icns', 'dsh/deepseek.png', 'dsh/notifier.swift', 'dsh/host.js']) {
  const path = join(root, asset)
  if (existsSync(path)) ok(`${asset}（${statSync(path).size} 字节）`)
  else bad(`缺少 ${asset}`)
}

// --- locale ----------------------------------------------------------------
section('locale')
const localeDir = join(root, 'locale')
if (!existsSync(localeDir)) {
  warn('没有 locale/ 目录：插件列表会退回裸包名与 package.json description')
} else {
  const files = readdirSync(localeDir).filter((entry) => entry.endsWith('.json')).sort()
  if (!files.includes('en.json')) bad('locale/en.json 必需（Harness 只有英文资源能解析时才枚举其它语言）')
  const selfReference = createRequire(import.meta.url)
  for (const file of files) {
    const path = join(localeDir, file)
    const dictionary = readJson(path, `locale/${file}`)
    if (dictionary === undefined) continue
    if (typeof dictionary.meta?.title !== 'string' || dictionary.meta.title.trim() === '') {
      bad(`locale/${file}: meta.title 必须是非空字符串`)
      continue
    }
    const specifier = `${name}/locale/${file}`
    try {
      const resolved = selfReference.resolve(specifier)
      if (realpathSync(resolved) === realpathSync(path)) ok(`locale/${file} → ${dictionary.meta.title}`)
      else bad(`locale/${file} 解析到了别的文件：${resolved}`)
    } catch (error) {
      bad(`exports 没有暴露 ${specifier}：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }
}

// --- 已安装 profile 一致性（尽力而为） -------------------------------------
section('已安装 profile')
const home = process.env.HOME ?? ''
const profileDir = join(home, '.dsh', 'profiles', process.env.DSH_PROFILE ?? 'web')
const profileManifest = join(profileDir, 'package.json')
if (!existsSync(profileManifest)) {
  skip(`没有找到 profile：${profileDir}`)
} else {
  const profile = readJson(profileManifest, 'profile package.json')
  const selected = profile?.dsh?.profile?.bundles ?? []
  if (selected.includes(name)) ok(`已作为 bundle 选中：${name}`)
  else warn(`${name} 尚未作为 bundle 选中（安装后即可用）`)
}

console.log('')
if (warnings.length > 0) console.log(`${warnings.length} 条警告`)
if (failures.length > 0) {
  console.log(`${failures.length} 项检查失败`)
  process.exitCode = 1
} else {
  console.log('全部检查通过')
}
