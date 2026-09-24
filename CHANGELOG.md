# 更新日志

版本号写在 `package.json`，每个版本对应一个 git tag（`v1.0.0` 这样的形式）。
本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## 1.0.0 — 首个正式版

从"能弹通知"做到"可配置、可诊断、不静默失败"的第一个正式版本。

**通知**

- 三个触发点：需要审批 / 需要你回答 / 一轮任务跑完；三个开关在配置卡里切换**立即生效**（不用重启）。
- 未处理的审批按间隔重复提醒；重提醒会**替换**上一个同事件窗口，不会在同一个角叠成一摞。
- Windows 默认右上角**自绘置顶弹出窗**（位置 / 宽度 / 圆角 / 高度 / 停留时长可调，DPI 感知、
  跟随系统深浅色、点击整张卡片打开 DSH），也可以切回系统 Toast（进通知中心）。
- macOS 默认**自建 `DeepSeek Harness.app`**（官方彩色图标 + 官方应用名，`swiftc` 现场编译），
  构建失败退回 `osascript`。
- Linux 走 `notify-send`；任意平台都可以用 `command` 配自己的 argv 模板。
- 显式指定的通道在本机不可用时**自动回退 auto**，并在诊断里记 `backendFallback`——
  不会出现"选错一次，通知全停"。

**配置**

- Plugins → 消息通知 里有配置卡：20 个字段分五组，**按平台显示**（macOS 不显示 Windows 外观，
  Windows 不显示 macOS 提示音，通知通道下拉按平台列选项），顶部可一键「显示所有平台的字段」。
- 保存 = **一次原子写入**（一个 revision 栅栏 + 一次 patch 写盘 + 一次通道重探测），
  失败时草稿保留；重置跟随保存 / 放弃，不会卡住。
- 字段级校验：越界就地标红并给出允许区间，计数类只收整数，像素 / 毫秒类可填小数。
- 优先级：**GUI 配置卡 > `~/.dsh/dsh-notify/config.json` > 内置默认值**。GUI 管理的键写在文件里
  无效（启动日志与 `diag.configConflicts` 会列出被忽略的键）。

**诊断与可靠性**

- `/dsh-notify/feed`（轮询兜底）与 `/dsh-notify/stream`（SSE）返回完整诊断：通道、投递 / 失败计数、
  最后的错误与退出码、兜底记录、宿主平台、文案口径。
- host 侧没有可用通道时，页面用**浏览器通知补位**（文案跟随宿主配置，提醒也会重复）。
- 审批 / 提问观察者 `prepend` 抢位、永远 `next()`：只发通知，绝不吞掉或改变审批结果。
- Windows 脚本"每条装饰语句各自兜底"：DPI / 主题 / 图标 / 字体任何一条失败只丢一点外观，横幅照弹。

**工程**

- `npm run check`：清单 / 语法 / **真实解析依赖并 import 宿主半** / 用 **PowerShell 自己的解析器**
  校验生成的两段脚本（不需要 Windows）。
- `npm run smoke`：111 条断言（真机 bug 回归 + 跨平台分支），CI 在 Ubuntu / macOS / Windows 三系统跑。
- 唯一运行时依赖：`@deepseek-ai/schemastery`（用来声明 GUI 配置 schema）。

## 0.2.0

- 配置卡进入 Plugins 页；配置改用 schemastery `Config` + volatile 字段（改完即时生效）。
- Windows 默认形态改为右上角自绘弹出窗。

## 0.1.0

- 首个可用版本：审批 / 提问 / 完成三类通知；macOS 自建通知 app + `osascript` 兜底。
