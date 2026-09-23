#!/usr/bin/env node
/**
 * Windows 侧自检：直接打印可以粘进 Windows PowerShell 的脚本。
 *
 * 为什么需要它：本插件在 macOS 上开发，Windows 那条路没有真机验证的条件。
 * 一旦 Windows 上「什么都没弹」，必须先把两件事分开：
 *   ① PowerShell + WinForms 能不能画出弹出窗（默认形态 banner）
 *   ② PowerShell + WinRT 能不能弹系统 Toast（windowsStyle: 'toast' 才走）
 * 这两段脚本就是插件真正会 spawn 的命令（同一份生成器），所以在 Windows 上
 * 跑通它们 == 插件的命令本身没问题，问题就只剩「插件有没有装/有没有重启」。
 *
 *   node scripts/windows-check.mjs
 *   node scripts/windows-check.mjs --icon "C:\path\to\dsh-notify\dsh\deepseek.png"
 *   node scripts/windows-check.mjs --position topleft --duration 0
 */
import { powershellBannerScript, powershellToastScript } from '../dsh/host.js'

const args = process.argv.slice(2)

/** 取 `--name value`；缺省时返回 fallback。 */
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = args[index + 1]
  return typeof value === 'string' && !value.startsWith('--') ? value : fallback
}

const icon = flag('icon', 'C:\\path\\to\\dsh-notify\\dsh\\deepseek.png')
const position = flag('position', 'topright')
const durationMs = Number(flag('duration', '8000'))
const width = Number(flag('width', '380'))

const line = '='.repeat(78)
const banner = powershellBannerScript({
  title: 'DeepSeek Harness',
  body: '✅ 自检 · 右上角弹出窗（banner 默认形态）',
  iconPath: icon,
  position,
  width,
  height: 96,
  durationMs: Number.isFinite(durationMs) ? durationMs : 8_000,
  openUrl: 'http://127.0.0.1:3080',
})
const toast = powershellToastScript(
  'DeepSeek Harness',
  '✅ 自检 · 系统 Toast（windowsStyle: toast 才走这条）',
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe',
  icon,
)

console.log(`
dsh-notify · Windows 自检
${line}

【第 0 步】先看插件在这台机器上的诊断（在跑 DSH 的 Windows 上执行）：

  curl.exe -s "http://127.0.0.1:3080/dsh-notify/feed?since=0"

  · HTTP 404            → 插件没装 / 没启用 / DSH 没重启（先解决这个）
  · diag.backend        → banner = 自绘弹出窗；powershell = 系统 Toast；none = 没有通道
  · diag.failed / lastExitCode / lastStderr
                        → 命令失败的真实原因（PowerShell 报错都在这里）

【第 1 步】验证「自绘弹出窗」（默认形态；不受专注助手影响）
把下面整段粘进「Windows PowerShell」（5.1，不是 PowerShell 7）后回车：
期望：右上角出现深色圆角小窗，8 秒自动消失，点击打开 DSH。

${banner}

【第 2 步】验证系统 Toast（只有 windowsStyle: 'toast' 才走这条）
同样粘进 Windows PowerShell 后回车：

${toast}

【如果第 1 步脚本报错】
  · 找不到 System.Windows.Forms / System.Drawing → PowerShell 或 .NET 被裁剪（少见）
  · 窗口出现在别的屏幕      → 改 bannerPosition（topright/topleft/bottomright/bottomleft）
  · 什么都不显示            → 把 PowerShell 里那句红色错误原样发回来，那里就是根因

【如果第 1 步能弹、插件却不弹】
  → 说明命令没问题，问题在插件侧：确认 profile 里装了 dsh-notify、并且**重启过 DSH**
    （JS 模块在 host 进程里按代际缓存，不重启就一直是旧代码）。
${line}
`)
