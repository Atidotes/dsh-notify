// dsh-notify 的系统通知投递器（macOS）。
//
// 为什么需要它：macOS 上 `osascript` 的通知恒定归属「脚本编辑器」，且
// `display notification` 没有指定图标的参数；而 `osacompile` 出来的 applet 是
// Carbon 时代产物，macOS 26 根本不给它通知身份（实测：静默丢弃、从不弹授权）。
//
// 可行配方（逐项实测得出）：
//   1. 必须是真正的 App 运行时：`NSApplication` + `.accessory`。
//      裸 CLI 进程调 `requestAuthorization` 会直接返回
//      "Notifications are not allowed for this application"。
//   2. 用官方 `UNUserNotificationCenter`：首次会弹一次系统授权，之后正常投递。
//   3. 必须经 LaunchServices 启动（`open -a <app>`）：直连可执行文件同样没有身份。
//   4. 签名 + 注册：`codesign --force -s -` 与 `lsregister -f`。
//
// 载荷传递：`open --args` **不会**把参数传给进程（实测），所以这里用队列目录：
// 调用方把 title/body/sound 写成三行文本丢进 `<app 同级>/queue/`，本程序启动后
// 用「原子改名抢占」的方式取走文件 —— 多个实例并发也不会重复显示。
//
// 状态：把最近一次结果写进 `<app 同级>/last-status.txt`，便于宿主侧诊断。

import AppKit
import Foundation
import UserNotifications

let fm = FileManager.default
let baseDir = Bundle.main.bundleURL.deletingLastPathComponent()
let queueDir = baseDir.appendingPathComponent("queue", isDirectory: true)
let statusFile = baseDir.appendingPathComponent("last-status.txt")

/// 覆盖写入一行状态，供宿主诊断（best-effort）。
func writeStatus(_ text: String) {
  try? (text + "\n").write(to: statusFile, atomically: true, encoding: .utf8)
}

struct Payload {
  let title: String
  let body: String
  let sound: String
}

/// 原子抢占队列里的一条载荷：改名成功才算归本进程所有。
func claimOne() -> Payload? {
  guard let names = try? fm.contentsOfDirectory(atPath: queueDir.path) else { return nil }
  for name in names.sorted() where name.hasSuffix(".txt") {
    let source = queueDir.appendingPathComponent(name)
    let claimed = queueDir.appendingPathComponent(".claimed-\(UUID().uuidString)")
    do {
      try fm.moveItem(at: source, to: claimed)
    } catch {
      continue // 被别的实例抢走了
    }
    defer { try? fm.removeItem(at: claimed) }
    guard let text = try? String(contentsOf: claimed, encoding: .utf8) else { continue }
    let lines = text.components(separatedBy: "\n")
    return Payload(
      title: lines.count > 0 && !lines[0].isEmpty ? lines[0] : "DeepSeek Harness",
      body: lines.count > 1 ? lines[1] : "",
      sound: lines.count > 2 ? lines[2] : "",
    )
  }
  return nil
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let center = UNUserNotificationCenter.current()
var idleTicks = 0
var sent = 0

/// 处理一条载荷；完成后继续泵队列。
func post(_ payload: Payload, then next: @escaping () -> Void) {
  let content = UNMutableNotificationContent()
  content.title = payload.title
  content.body = payload.body
  if !payload.sound.isEmpty {
    content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: payload.sound + ".aiff"))
  }
  let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
  center.add(request) { error in
    if let error = error {
      writeStatus("add failed: \(error.localizedDescription)")
      exit(4)
    }
    sent += 1
    next()
  }
}

/// 授权后才开始泵队列；已授权则直接开始。
func ensureAuthorized(_ start: @escaping () -> Void) {
  center.getNotificationSettings { settings in
    switch settings.authorizationStatus {
    case .authorized, .provisional, .ephemeral:
      start()
    case .denied:
      writeStatus("denied")
      exit(2)
    default:
      center.requestAuthorization(options: [.alert, .sound]) { granted, error in
        if let error = error {
          writeStatus("request failed: \(error.localizedDescription)")
          exit(3)
        }
        guard granted else {
          writeStatus("denied")
          exit(2)
        }
        start()
      }
    }
  }
}

/// 持续泵队列：空闲 5 秒后退出。这样「app 已在运行时再来一条」也不会漏
/// （`open -a` 对已运行的 app 只是激活，不会起第二个进程）。
func pump() {
  guard let payload = claimOne() else {
    idleTicks += 1
    if idleTicks >= 5 {
      writeStatus("ok:\(sent)")
      exit(0)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { pump() }
    return
  }
  idleTicks = 0
  post(payload) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { pump() }
  }
}

ensureAuthorized { pump() }
app.run()
