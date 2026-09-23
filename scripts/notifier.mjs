#!/usr/bin/env node
/**
 * 预建 / 更新通知 app：node scripts/notifier.mjs [--test] [--rebuild]
 *
 * 为什么需要它：macOS 上 `osascript` 的通知恒定归属「脚本编辑器」且不能指定图标；
 * 而 `osacompile` 出来的 AppleScript applet 在 macOS 26 上根本拿不到通知身份
 * （实测：静默丢弃、从不弹授权）。所以插件自编译一个真正的 Swift app，
 * 用官方 UNUserNotificationCenter 投递，并带上官方 DeepSeek 图标。
 *
 * 插件自己也会建（首次通知前自动完成），但宿主进程可能没有写 `~/.dsh` 的权限；
 * 先手动跑一次本脚本即可 —— 插件会直接复用已存在的 app，不再重建。
 *
 *   --test     建完弹一条测试通知（首次会请求系统授权）
 *   --rebuild  即使已存在也重建（换过图标/改过代码后用）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const APP_NAME = 'DeepSeek Harness'

const BUILD = 'swift-v3' // 与 dsh/host.js 的 NOTIFIER_BUILD 保持一致
const IDENTITY = '3' // 与 dsh/host.js 的 NOTIFIER_IDENTITY 保持一致（换图标时 +1）
const base = join(homedir(), '.dsh', 'dsh-notify')
// 带版本号的路径：换图标时路径也变，系统图标缓存才会重新生成（否则通知一直显示旧图标）
const dir = join(base, BUILD)
const app = join(dir, `${APP_NAME}.app`)
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

// 清掉旧一代的 app，避免同一 bundle id 多份注册（重复注册同样会让通知显示旧图标）
for (const legacy of [`${APP_NAME}.app`, 'swift-v1', 'swift-v2']) {
  const stale = join(base, legacy)
  if (stale === dir) continue
  try { execFileSync(LSREGISTER, ['-u', join(stale, `${APP_NAME}.app`)]) } catch {}
  rmSync(stale, { recursive: true, force: true })
}

if (existsSync(join(app, 'Contents', 'MacOS', 'notifier')) && !args.includes('--rebuild')) {
  console.log(`已存在，跳过构建：${app}`)
  console.log('（要重建加 --rebuild）')
} else {
  mkdirSync(join(dir, 'queue'), { recursive: true })
  mkdirSync(join(dir, 'modulecache'), { recursive: true })
  rmSync(app, { recursive: true, force: true })
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })

  const source = join(dir, 'notifier.swift')
  writeFileSync(source, readFileSync(join(root, 'dsh', 'notifier.swift'), 'utf8'))

  const sdk = execFileSync('/usr/bin/xcrun', ['--show-sdk-path']).toString().trim()
  const compile = ['-O']
  if (sdk !== '') compile.push('-sdk', sdk)
  compile.push('-module-cache-path', join(dir, 'modulecache'),
    '-o', join(app, 'Contents', 'MacOS', 'notifier'), source)
  execFileSync('/usr/bin/swiftc', compile, { stdio: 'inherit' })

  const plist = join(app, 'Contents', 'Info.plist')
  execFileSync('/usr/bin/plutil', ['-create', 'xml1', plist])
  for (const [key, value] of [
    ['CFBundleIdentifier', `com.dsh-notify.notifier.${IDENTITY}`],
    ['CFBundleName', APP_NAME],
    ['CFBundleDisplayName', APP_NAME],
    ['CFBundleExecutable', 'notifier'],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', '1.0'],
    ['CFBundleVersion', '1'],
    ['CFBundleIconFile', 'applet.icns'],
    ['LSMinimumSystemVersion', '11.0'],
  ]) {
    execFileSync('/usr/bin/plutil', ['-insert', key, '-string', value, plist])
  }
  execFileSync('/usr/bin/plutil', ['-insert', 'LSUIElement', '-bool', 'true', plist])
  execFileSync('/bin/cp', [join(root, 'dsh', 'deepseek.icns'), join(app, 'Contents', 'Resources', 'applet.icns')])
  execFileSync('/usr/bin/codesign', ['--force', '-s', '-', app])
  execFileSync(LSREGISTER, ['-f', app])
  console.log(`通知 app 已就绪：${app}`)
}

if (args.includes('--test')) {
  const payload = join(dir, 'queue', `${Date.now()}-selftest.txt`)
  writeFileSync(payload, `${APP_NAME}\n✅ 自检通知 · 图标应为 DeepSeek 官方图标\nGlass\n`, 'utf8')
  execFileSync('/usr/bin/open', ['-a', app])
  console.log('已投递测试通知。首次会请求系统授权（允许一次即可）。')
  console.log('若一直没出现：系统设置 → 通知 → DeepSeek Harness → 允许通知。')
}
