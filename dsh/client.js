// dsh-notify — browser half（只做兜底：host 通道失效时，用浏览器发系统通知）。
//
// 页面里**不再渲染任何通知卡片**：通知只在系统层面出现（macOS 通知中心）。
// 这一半只剩两件事：
//   1. 订阅 host 的推送（SSE，失败退回轮询），拿到「刚刚发生了一条通知」；
//   2. 若 host 报告自己没有系统通知通道（diag.backend === 'none'），改用浏览器
//      Notification 补位 —— 它弹的同样是系统横幅，只要这个页面开着（后台标签、
//      你正在看别的网页都行），不需要盯着这个页面。
//
// host 通道正常时，这一半什么都不做（不会重复打扰）。
//
// 唯一的页面内 UI 是一条**降级提示条**：浏览器通知需要用户手势授权，host 通道
// 不可用时才出现，点一下就授权；它本身不是通知，host 正常时永远不出现。

window.__ModuleLoader__.load({
  id: 'dsh-notify',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const CSS_ID = 'dsh-notify/css'
    const FEED_PATH = '/dsh-notify/feed'
    const STREAM_PATH = '/dsh-notify/stream'
    const POLL_MS = 2_000
    const CSS = [
      '.dsn-hint { position: fixed; top: 14px; right: 14px; z-index: 60; display: flex; align-items: center; gap: 8px; max-width: 360px; padding: 8px 10px; border-radius: 10px; background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #fff)); border: 1px solid var(--dsw-alias-state-warn-primary, rgba(250,157,59,.5)); box-shadow: 0 10px 28px rgba(0,0,0,.18); font-family: inherit; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary, inherit); }',
      '.dsn-hint button { flex: none; border: none; border-radius: 6px; padding: 3px 9px; background: #07c160; color: #fff; font-size: 12px; cursor: pointer; font-family: inherit; }',
      // 配置卡（Plugins → dsh-notify → 配置区）：面板 + 分组 + 平台徽标
      '.dsn-cfg { display: flex; flex-direction: column; gap: 12px; font-size: 13px; color: var(--dsw-alias-label-primary, inherit); }',
      '.dsn-cfg-showall { display: flex; align-items: center; gap: 8px; padding: 0 2px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); cursor: pointer; }',
      '.dsn-cfg-panel { border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.04)); padding: 4px 14px; }',
      '.dsn-cfg-group { padding: 12px 0; }',
      '.dsn-cfg-group + .dsn-cfg-group { border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18)); }',
      '.dsn-cfg-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }',
      '.dsn-cfg-title { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-label-primary, inherit); }',
      '.dsn-cfg-chip { font-size: 10px; line-height: 16px; padding: 0 7px; border-radius: 999px; letter-spacing: .02em; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.16)); color: var(--dsw-alias-label-secondary, rgba(127,127,127,.95)); }',
      '.dsn-cfg-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px 20px; }',
      '.dsn-cfg-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }',
      '.dsn-cfg-field > label { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary, inherit); }',
      '.dsn-cfg-field > label.dsn-cfg-switch { font-size: 13px; color: var(--dsw-alias-label-primary, inherit); cursor: pointer; }',
      '.dsn-cfg-input, .dsn-cfg-field input[type="text"], .dsn-cfg-field input[type="number"], .dsn-cfg-field select { box-sizing: border-box; width: 100%; height: 30px; padding: 0 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; font: inherit; font-size: 12px; }',
      '.dsn-cfg-selectwrap { position: relative; display: block; }',
      ".dsn-cfg-selectwrap::after { content: ''; position: absolute; right: 12px; top: 50%; width: 6px; height: 6px; margin-top: -4px; border-right: 1.5px solid var(--dsw-alias-label-tertiary, rgba(127,127,127,.95)); border-bottom: 1.5px solid var(--dsw-alias-label-tertiary, rgba(127,127,127,.95)); transform: rotate(45deg); pointer-events: none; }",
      '.dsn-cfg-select { appearance: none; -webkit-appearance: none; -moz-appearance: none; padding-right: 30px; cursor: pointer; }',
      '.dsn-cfg-select option { color: #111; background: #fff; }',
      '.dsn-cfg-field input:focus-visible, .dsn-cfg-field select:focus-visible { outline: 2px solid #07c160; outline-offset: 1px; }',
      '.dsn-cfg-field input:disabled, .dsn-cfg-field select:disabled { opacity: .55; }',
      '.dsn-cfg-hint { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }',
      '.dsn-cfg-check { appearance: none; -webkit-appearance: none; flex: none; width: 17px; height: 17px; margin: 0; border-radius: 5px; border: 1.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.5)); background: var(--dsw-alias-bg-layer-2, transparent); cursor: pointer; position: relative; transition: background-color .15s ease, border-color .15s ease; }',
      '.dsn-cfg-check:hover { border-color: #07c160; }',
      '.dsn-cfg-check:checked { background: #07c160; border-color: #07c160; }',
      // 纯 CSS 白勾：右边 + 下边描边旋转 45°，不依赖系统绘制的对勾颜色
      ".dsn-cfg-check:checked::after { content: ''; position: absolute; left: 5px; top: 1.5px; width: 4px; height: 8px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }",
      '.dsn-cfg-check:focus-visible { outline: 2px solid #07c160; outline-offset: 1px; }',
      '.dsn-cfg-check:disabled { opacity: .5; cursor: default; }',
      '.dsn-cfg-reset { border: none; background: none; padding: 0; font: inherit; font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); cursor: pointer; text-decoration: underline; align-self: flex-start; }',
      '.dsn-cfg-badge { font-size: 10px; line-height: 15px; padding: 0 6px; border-radius: 999px; background: rgba(7,193,96,.14); color: #07c160; }',
      '.dsn-cfg-foot { display: flex; align-items: center; gap: 10px; padding-top: 2px; }',
      '.dsn-cfg-btn { border: none; border-radius: 8px; height: 30px; padding: 0 16px; font: inherit; font-size: 12px; cursor: pointer; background: #07c160; color: #fff; }',
      '.dsn-cfg-btn.ghost { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14)); color: inherit; }',
      '.dsn-cfg-btn:disabled { opacity: .45; cursor: default; }',
      '.dsn-cfg-note { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }',
      '.dsn-cfg-error { font-size: 12px; color: var(--dsw-alias-state-error-primary, #e5484d); }',
    ].join('\n')

    /** 极简状态：host 通道 + 是否需要提示授权。 */
    const store = {
      hostBackend: undefined,
      hint: null,
      listeners: new Set(),
      timers: new Set(),
    }

    /**
     * 宿主平台（`diag.platform`）：配置卡只显示这个平台真实存在的字段
     * （macOS 不显示 Windows 弹出窗那一套，Windows 不显示 macOS 提示音）。
     * 平台未知时只显示跨平台字段 —— 不猜，避免先显示再消失。
     */
    let hostPlatform
    const platformListeners = new Set()

    function setHostPlatform(next) {
      if (typeof next !== 'string' || next === '' || next === hostPlatform) return
      hostPlatform = next
      for (const listener of platformListeners) {
        try {
          listener()
        } catch (error) {
          console.error('[dsh-notify] 平台订阅者失败', error)
        }
      }
    }

    function subscribeHostPlatform(listener) {
      platformListeners.add(listener)
      return () => platformListeners.delete(listener)
    }

    const getHostPlatform = () => hostPlatform

    function emit() {
      for (const listener of store.listeners) {
        try {
          listener()
        } catch (error) {
          console.error('[dsh-notify] 渲染订阅者失败', error)
        }
      }
    }

    function schedule(delay, fn) {
      const timer = setTimeout(() => {
        store.timers.delete(timer)
        fn()
      }, delay)
      store.timers.add(timer)
      return timer
    }

    function clearAllTimers() {
      for (const timer of store.timers) clearTimeout(timer)
      store.timers.clear()
    }

    // -----------------------------------------------------------------------
    // 浏览器系统通知（host 通道失效时的兜底）
    // -----------------------------------------------------------------------

    function notificationApi() {
      return typeof Notification === 'undefined' ? undefined : Notification
    }

    function setHint(next) {
      if (store.hint === next) return
      store.hint = next
      emit()
    }

    function updateHint() {
      const api = notificationApi()
      if (api === undefined || store.hostBackend !== 'none') {
        setHint(null)
        return
      }
      if (api.permission === 'default') setHint('request')
      else if (api.permission === 'denied') setHint('denied')
      else setHint(null)
    }

    /** 用户手势里申请浏览器通知权限。 */
    function requestPermission() {
      const api = notificationApi()
      if (api === undefined) return
      try {
        const result = api.requestPermission()
        if (result && typeof result.then === 'function') {
          result.then(() => updateHint()).catch(() => updateHint())
        } else {
          schedule(200, updateHint)
        }
      } catch (error) {
        console.error('[dsh-notify] 申请通知权限失败', error)
      }
    }

    /** host 通道不可用时，用浏览器通知补位（弹的也是系统横幅）。 */
    function browserNotify(item) {
      try {
        const api = notificationApi()
        if (api === undefined) return
        if (store.hostBackend !== 'none') return // host 已经发过了，不重复打扰
        if (api.permission !== 'granted') return
        const notification = new api(item.name || 'DeepSeek Harness', {
          body: item.body || '',
          tag: `dsh-notify-${item.seq}`,
          silent: false,
        })
        notification.onclick = () => {
          try {
            window.focus()
          } catch {
            // 浏览器可能拒绝 focus，忽略
          }
        }
      } catch (error) {
        console.error('[dsh-notify] 浏览器通知失败', error)
      }
    }

    /** 处理一条推送/轮询条目：只负责发系统通知，不渲染任何卡片。 */
    function applyItem(item) {
      try {
        if (!item || typeof item !== 'object') return
        if (item.kind === 'status') {
          // 'unresolved' = 宿主还在探测：不要用它覆盖已知结论（否则会把 'none' 抹掉，
          // 该用浏览器兜底时反而不兜底）
          if (typeof item.backend === 'string' && item.backend !== 'unresolved') {
            store.hostBackend = item.backend
            updateHint()
          }
          setHostPlatform(item.platform)
          return
        }
        if (item.kind !== 'approval' && item.kind !== 'question' && item.kind !== 'done') return
        browserNotify(item)
      } catch (error) {
        console.error('[dsh-notify] 处理推送条目失败', error)
      }
    }

    // -----------------------------------------------------------------------
    // 降级提示条（host 通道不可用时才出现）
    // -----------------------------------------------------------------------
    function Pill() {
      const [, setTick] = React.useState(0)
      React.useEffect(() => {
        const update = () => setTick((value) => value + 1)
        store.listeners.add(update)
        return () => {
          store.listeners.delete(update)
        }
      }, [])
      if (store.hint === null) return null
      return h('div', { className: 'dsn-hint', role: 'status' },
        h('span', null, store.hint === 'denied'
          ? '系统通知通道不可用，且浏览器通知被拒绝 —— 请在浏览器站点设置里允许通知。'
          : '系统通知通道不可用。开启浏览器通知后，只要这个页面开着，切到别的网页也能收到提醒。'),
        store.hint === 'denied' ? null : h('button', { onClick: requestPermission }, '开启浏览器通知'),
      )
    }

    // -----------------------------------------------------------------------
    // 推送订阅：SSE 优先，失败退回轮询
    // -----------------------------------------------------------------------
    function insertStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.pluginCss = CSS_ID
      // 模块系统按 data-plugin 归属样式（HMR 换代时清理、避免被别的插件 claimStyles 收走）
      tag.dataset.plugin = 'dsh-notify'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return tag
    }

    function startFeed() {
      let stopped = false
      /** null = 还没有游标：第一次只取 head，不回放历史通知。 */
      let since = null
      let timer = null
      let source = null
      let polling = false

      function scheduleTick() {
        if (stopped || !polling) return
        timer = setTimeout(tick, POLL_MS)
      }

      async function tick() {
        if (stopped || !polling) return
        try {
          const url = since === null ? FEED_PATH : `${FEED_PATH}?since=${since}`
          const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          if (data.diag && typeof data.diag.backend === 'string') {
            store.hostBackend = data.diag.backend
            updateHint()
          }
          if (data.diag) setHostPlatform(data.diag.platform)
          if (typeof data.head === 'number') {
            if (since === null) {
              since = data.head
            } else if (data.head > since) {
              const items = Array.isArray(data.items) ? data.items : []
              since = data.head
              for (const item of items) applyItem(item)
            }
          }
        } catch (error) {
          // 兜底通道不可用不影响系统通知，静默重试。
        }
        scheduleTick()
      }

      function startPolling() {
        if (stopped || polling) return
        polling = true
        void tick()
      }

      function stopStream() {
        if (source === null) return
        try {
          source.close()
        } catch {
          // ignore
        }
        source = null
      }

      function startStream() {
        if (typeof EventSource !== 'function') {
          startPolling()
          return
        }
        try {
          source = new EventSource(STREAM_PATH)
          source.onmessage = (event) => {
            try {
              applyItem(JSON.parse(event.data))
            } catch (error) {
              console.error('[dsh-notify] 推送数据解析失败', error)
            }
          }
          source.onerror = () => {
            // SSE 不可用（服务重启、代理干扰）：退回轮询，兜底通道不丢。
            if (stopped) return
            stopStream()
            startPolling()
          }
        } catch (error) {
          startPolling()
        }
      }

      // SSE 长连接本身不返回 diag：页面用 SSE 时也先取一次，配置卡才能知道宿主平台。
      void (async () => {
        try {
          const response = await fetch(FEED_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' })
          if (!response.ok) return
          const data = await response.json()
          if (data.diag) {
            if (typeof data.diag.backend === 'string') store.hostBackend = data.diag.backend
            setHostPlatform(data.diag.platform)
            updateHint()
          }
        } catch {
          // 兜底信息拿不到不影响系统通知，静默。
        }
      })()

      startStream()

      return () => {
        stopped = true
        stopStream()
        if (timer !== null) {
          clearTimeout(timer)
          store.timers.delete(timer)
        }
      }
    }

    /** 注册资源：优先用 ctx.effect 托管，缺失时直接登记。 */
    function useEffectScope(scope, register) {
      try {
        if (typeof scope.effect === 'function') {
          scope.effect(register)
          return
        }
      } catch (error) {
        console.error('[dsh-notify] ctx.effect 注册失败', error)
      }
      try {
        register()
      } catch (error) {
        console.error('[dsh-notify] 注册失败', error)
      }
    }


    // -----------------------------------------------------------------------
    // 配置卡：注册进 Plugins 页的 bundle 配置区（plugins.bundle.config）
    //
    // 为什么走这条路：harness 的 settings 服务会把插件 Config 里标了 `.volatile()` 的字段
    // 投影成一张可写表单（namespace = 插件入口 id = 'dsh-notify'），保存时写进 profile 的
    // cordis.patch.yml，并由 volatile HMR 原地生效 —— 改完不用重启 DSH。
    // 我们只负责画控件：宿主半已经声明了 Config（见 dsh/host.js）。
    // -----------------------------------------------------------------------

    /** 只在 Windows 上存在的字段（自绘弹出窗那一套）。 */
    const WINDOWS_ONLY = ['win32']

    /**
     * 通知通道选项：`auto` 之外只列**当前平台真实存在**的通道。
     * 其它平台的值仍然保留词典（当前值不在列表里时会补进去，避免下拉"吃掉"已配置的值）。
     */
    const BACKEND_BY_PLATFORM = {
      // 'command'（自定义 argv 模板）在任何平台都能用，所以每个平台都列
      darwin: ['auto', 'command', 'osascript', 'terminal-notifier'],
      win32: ['auto', 'command', 'banner', 'powershell', 'snoretoast'],
      linux: ['auto', 'command', 'notify-send'],
    }
    const BACKEND_ALL = ['auto', 'command', 'banner', 'powershell', 'snoretoast', 'osascript', 'terminal-notifier', 'notify-send']

    /**
     * 配置字段（与 dsh/host.js 的 Config schema 一一对应）。
     * `platforms` 省略 = 所有平台都显示；否则只在列出的平台上显示（宿主平台由 feed 诊断提供）。
     */
    const CONFIG_FIELDS = [
      { group: 'switch', key: 'approval', kind: 'boolean' },
      { group: 'switch', key: 'question', kind: 'boolean' },
      { group: 'switch', key: 'done', kind: 'boolean' },
      { group: 'timing', key: 'minRunMs', kind: 'number' },
      { group: 'timing', key: 'remindEveryMs', kind: 'number' },
      { group: 'timing', key: 'maxReminders', kind: 'number' },
      { group: 'type', key: 'backend', kind: 'enum', values: BACKEND_ALL },
      { group: 'type', key: 'windowsStyle', kind: 'enum', values: ['banner', 'toast'], platforms: WINDOWS_ONLY },
      { group: 'type', key: 'linuxUrgentUrgency', kind: 'enum', values: ['critical', 'normal', 'low'], platforms: ['linux'] },
      { group: 'copy', key: 'titleFrom', kind: 'enum', values: ['app', 'project'] },
      { group: 'copy', key: 'fallbackName', kind: 'text' },
      { group: 'copy', key: 'subtitle', kind: 'text' },
      { group: 'copy', key: 'sound', kind: 'text', platforms: ['darwin'] },
      { group: 'copy', key: 'snippetChars', kind: 'number' },
      { group: 'look', key: 'bannerWidth', kind: 'number', platforms: WINDOWS_ONLY },
      { group: 'look', key: 'bannerMinWidth', kind: 'number', platforms: WINDOWS_ONLY },
      { group: 'look', key: 'bannerRadius', kind: 'number', platforms: WINDOWS_ONLY },
      { group: 'look', key: 'bannerHeight', kind: 'number', platforms: WINDOWS_ONLY },
      { group: 'look', key: 'bannerPosition', kind: 'enum', values: ['topright', 'topleft', 'bottomright', 'bottomleft'], platforms: WINDOWS_ONLY },
      { group: 'look', key: 'bannerDurationMs', kind: 'number', platforms: WINDOWS_ONLY },
    ]

    /** 分组顺序 + 标题的词典键；平台专属分组带徽标，且只在对应平台上出现。 */
    const CONFIG_GROUPS = [
      { id: 'switch', title: 'group.switch' },
      { id: 'timing', title: 'group.timing' },
      { id: 'type', title: 'group.type' },
      { id: 'copy', title: 'group.copy' },
      { id: 'look', title: 'group.look', chip: 'chip.windows', platforms: WINDOWS_ONLY },
    ]

    /** 字段在当前平台上是否展示（平台未知时只展示跨平台字段，避免闪一下又消失）。 */
    function matchesPlatform(spec, platform) {
      if (spec.platforms === undefined) return true
      return platform !== undefined && spec.platforms.includes(platform)
    }

    /** 枚举字段在当前平台上的选项；已配置但不在列表里的值补进来，避免下拉显示错值。 */
    function optionsFor(spec, platform, current) {
      const all = spec.values ?? []
      const values = spec.key === 'backend' ? (BACKEND_BY_PLATFORM[platform] ?? all).slice() : all.slice()
      if (typeof current === 'string' && current !== '' && !values.includes(current)) values.push(current)
      return values
    }

    /**
     * 数值字段的边界，与 dsh/host.js 的 Config schema 一一对应。
     * 客户端先校验：改到超范围当场标红，而不是等宿主整批拒绝、只回一句"保存失败"。
     */
    const NUMBER_LIMITS = {
      minRunMs: { min: 0, max: 86_400_000, step: 500 },
      remindEveryMs: { min: 0, max: 86_400_000, step: 1_000 },
      maxReminders: { min: 0, max: 1_000, step: 1 },
      snippetChars: { min: 0, max: 120, step: 1 },
      bannerWidth: { min: 160, max: 1_200, step: 10 },
      bannerMinWidth: { min: 120, max: 1_200, step: 10 },
      bannerRadius: { min: 0, max: 200, step: 1 },
      bannerHeight: { min: 0, max: 400, step: 1 },
      bannerDurationMs: { min: 0, max: 60_000, step: 500 },
    }

    /** 校验一个草稿值；返回错误文案的词典键，undefined 表示合法。 */
    function invalidReason(key, kind, value) {
      if (kind !== 'number') return undefined
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return 'invalidNumber'
      const limit = NUMBER_LIMITS[key]
      if (limit === undefined) return undefined
      if (value < limit.min || value > limit.max) return 'invalidRange'
      return undefined
    }

    /** 当前平台上可见的字段。 */
    function fieldsForPlatform(platform) {
      return CONFIG_FIELDS.filter((spec) => matchesPlatform(spec, platform))
    }

    /** 字典命名空间（也是 settings 的 namespace）。 */
    const CONFIG_NS = 'dsh-notify'

    const CONFIG_ZH = {
      'group.switch': '通知开关',
      'group.timing': '触发时机',
      'group.type': '提醒类型',
      'group.copy': '文案',
      'group.look': 'Windows 弹出窗外观',
      'chip.windows': 'Windows',
      'platformUnknown': '正在识别运行平台…（先只显示跨平台配置）',
      'f.approval': '需要审批时通知',
      'h.approval': '工具调用（bash 等）等待审批时弹通知',
      'f.question': '需要回答时通知',
      'h.question': '提问（ask_user_question）等待回答时弹通知',
      'f.done': '任务完成时通知',
      'h.done': '一轮任务跑完时弹通知',
      'f.minRunMs': '最短运行时长（毫秒）',
      'h.minRunMs': '跑得比它短就不通知，避免"秒回也弹窗"；0 = 每次都通知',
      'f.remindEveryMs': '重复提醒间隔（毫秒）',
      'h.remindEveryMs': '未处理的审批隔多久再提醒一次；0 = 只提醒一次',
      'f.maxReminders': '最多提醒次数',
      'h.maxReminders': '同一条审批最多重复提醒多少次',
      'f.windowsStyle': 'Windows 提醒形态',
      'h.windowsStyle': '自绘弹出窗位置可控、不受专注助手影响；系统通知会进通知中心',
      'v.windowsStyle.banner': '自绘弹出窗（推荐）',
      'v.windowsStyle.toast': '系统通知',
      'f.backend': '通知通道',
      'h.backend': '自动 = 按平台挑最合适的通道',
      'v.backend.auto': '自动', 'v.backend.command': '自定义命令（需在 config.json 里配 command 模板）',
      'v.backend.banner': '自绘弹出窗', 'v.backend.powershell': 'PowerShell Toast',
      'v.backend.snoretoast': 'SnoreToast', 'v.backend.osascript': 'AppleScript（macOS）',
      'v.backend.terminal-notifier': 'terminal-notifier（macOS）', 'v.backend.notify-send': 'notify-send（Linux）',
      'f.titleFrom': '标题取什么',
      'h.titleFrom': '固定应用名，或用会话所在的目录名',
      'v.titleFrom.app': '固定应用名', 'v.titleFrom.project': '项目目录名',
      'f.fallbackName': '固定标题',
      'h.fallbackName': '「标题取什么 = 固定应用名」时显示的文字',
      'f.subtitle': '副标题',
      'h.subtitle': '默认留空（横幅只有标题 + 正文最干净）',
      'f.sound': '提示音',
      'h.sound': 'macOS 提示音名（Glass / Ping / Hero…）；留空 = 静音',
      'f.bannerWidth': '最大宽度',
      'h.bannerWidth': '弹出窗宽度上限（96 DPI 逻辑像素）',
      'f.bannerMinWidth': '最小宽度',
      'h.bannerMinWidth': '短消息的实际宽度；与最大宽度设成同一个值 = 钉死宽度',
      'f.bannerRadius': '圆角',
      'h.bannerRadius': '越大越圆；上限是卡片高度的一半（= 胶囊形）',
      'f.bannerHeight': '高度',
      'h.bannerHeight': '0 = 按正文行数自适应；填正数则固定高度',
      'f.linuxUrgentUrgency': 'Linux 通知级别',
      'h.linuxUrgentUrgency': 'notify-send 的 -u 级别；critical 更不容易被自动收起',
      'v.linuxUrgentUrgency.critical': 'critical（紧急）', 'v.linuxUrgentUrgency.normal': 'normal（普通）', 'v.linuxUrgentUrgency.low': 'low（低）',
      'f.snippetChars': '提问片段长度',
      'h.snippetChars': '横幅里附带多少字的提问内容（越小越简洁）',
      'showAll': '显示所有平台的字段',
      'h.showAll': '默认只显示当前平台的配置；打开后可以看到并预配置其它平台的字段',
      'f.bannerPosition': '位置',
      'h.bannerPosition': '弹出窗贴屏幕的哪个角',
      'f.bannerDurationMs': '停留时长（毫秒）',
      'h.bannerDurationMs': '0 = 一直显示到点击关闭',
      'v.bannerPosition.topright': '右上角', 'v.bannerPosition.topleft': '左上角',
      'v.bannerPosition.bottomright': '右下角', 'v.bannerPosition.bottomleft': '左下角',
      'save': '保存', 'saving': '保存中…', 'discard': '放弃修改',
      'reset': '重置', 'overridden': '已自定义',
      'saveFailed': '保存失败，请重试', 'readOnly': '当前连接不可写', 'loading': '正在读取配置…',
      'invalidNumber': '请填整数', 'invalidRange': '超出允许范围', 'invalidFields': '有字段不合法，先改好再保存',
      'unavailableRemote': '配置只能在通过本机地址（127.0.0.1 / localhost）打开的页面里修改 —— 当前页面不是本机地址。',
      'unavailableHost': '暂时读不到配置：插件宿主可能还在跑旧模块，完全重启 DSH 后刷新页面再试。',
      'dirty': '有未保存的修改',
    }

    const CONFIG_EN = {
      'group.switch': 'Notifications',
      'group.timing': 'Trigger timing',
      'group.type': 'Delivery',
      'group.copy': 'Copy',
      'group.look': 'Windows popup appearance',
      'chip.windows': 'Windows',
      'platformUnknown': 'Detecting the host platform… (showing cross-platform settings for now)',
      'f.approval': 'Notify on approvals',
      'h.approval': 'A tool call (bash …) is waiting for approval',
      'f.question': 'Notify on questions',
      'h.question': 'ask_user_question is waiting for an answer',
      'f.done': 'Notify when a task finishes',
      'h.done': 'One agent run went idle',
      'f.minRunMs': 'Minimum run time (ms)',
      'h.minRunMs': 'Shorter runs stay silent; 0 = notify every time',
      'f.remindEveryMs': 'Reminder interval (ms)',
      'h.remindEveryMs': 'How often an unanswered approval reminds again; 0 = once',
      'f.maxReminders': 'Maximum reminders',
      'h.maxReminders': 'How many times one approval repeats',
      'f.windowsStyle': 'Windows delivery style',
      'h.windowsStyle': 'The self-drawn popup is positionable and ignores Focus Assist; system notifications enter the Action Center',
      'v.windowsStyle.banner': 'Self-drawn popup (recommended)',
      'v.windowsStyle.toast': 'System notification',
      'f.backend': 'Delivery channel',
      'h.backend': 'auto picks the best channel for the platform',
      'v.backend.auto': 'Auto', 'v.backend.command': 'Custom command (needs a command template in config.json)',
      'v.backend.banner': 'Self-drawn popup', 'v.backend.powershell': 'PowerShell Toast',
      'v.backend.snoretoast': 'SnoreToast', 'v.backend.osascript': 'AppleScript (macOS)',
      'v.backend.terminal-notifier': 'terminal-notifier (macOS)', 'v.backend.notify-send': 'notify-send (Linux)',
      'f.titleFrom': 'Title source',
      'h.titleFrom': 'A fixed app name, or the session directory name',
      'v.titleFrom.app': 'Fixed app name', 'v.titleFrom.project': 'Project directory',
      'f.fallbackName': 'Fixed title',
      'h.fallbackName': 'Shown when the title source is the fixed app name',
      'f.subtitle': 'Subtitle',
      'h.subtitle': 'Empty by default (title + one line reads cleanest)',
      'f.sound': 'Sound',
      'h.sound': 'macOS sound name (Glass / Ping / Hero…); empty = silent',
      'f.bannerWidth': 'Maximum width',
      'h.bannerWidth': 'Upper bound of the popup width (96-DPI logical pixels)',
      'f.bannerMinWidth': 'Minimum width',
      'h.bannerMinWidth': 'Actual width of short messages; set both widths equal to pin it',
      'f.bannerRadius': 'Corner radius',
      'h.bannerRadius': 'Rounder when larger; capped at half the card height (capsule)',
      'f.bannerHeight': 'Height',
      'h.bannerHeight': '0 = fit the body lines; a positive value pins the height',
      'f.linuxUrgentUrgency': 'Linux urgency',
      'h.linuxUrgentUrgency': 'notify-send -u level; critical is harder to auto-dismiss',
      'v.linuxUrgentUrgency.critical': 'critical', 'v.linuxUrgentUrgency.normal': 'normal', 'v.linuxUrgentUrgency.low': 'low',
      'f.snippetChars': 'Question snippet length',
      'h.snippetChars': 'How many characters of a question the banner carries (smaller = cleaner)',
      'showAll': 'Show settings for every platform',
      'h.showAll': 'By default only the current platform is shown; enable to view and pre-configure other platforms',
      'f.bannerPosition': 'Position',
      'h.bannerPosition': 'Which screen corner the popup sticks to',
      'f.bannerDurationMs': 'Dismiss after (ms)',
      'h.bannerDurationMs': '0 = stay until clicked',
      'v.bannerPosition.topright': 'Top right', 'v.bannerPosition.topleft': 'Top left',
      'v.bannerPosition.bottomright': 'Bottom right', 'v.bannerPosition.bottomleft': 'Bottom left',
      'save': 'Save', 'saving': 'Saving…', 'discard': 'Discard',
      'reset': 'Reset', 'overridden': 'Customized',
      'saveFailed': 'Save failed, please retry', 'readOnly': 'This connection is read-only', 'loading': 'Loading configuration…',
      'invalidNumber': 'Enter a whole number', 'invalidRange': 'Out of the allowed range', 'invalidFields': 'Some fields are invalid — fix them before saving',
      'unavailableRemote': 'Configuration can only be edited from a page opened on this machine (127.0.0.1 / localhost).',
      'unavailableHost': 'Configuration is not readable yet: the plugin host may still run the old module — restart DSH and refresh.',
      'dirty': 'Unsaved changes',
    }

    /** 「显示所有平台的字段」偏好（localStorage；不可用时静默丢弃）。 */
    const SHOW_ALL_KEY = 'dsh-notify/show-all-platforms'

    function readShowAll() {
      try {
        return globalThis.localStorage?.getItem(SHOW_ALL_KEY) === '1'
      } catch {
        return false
      }
    }

    function writeShowAll(value) {
      try {
        globalThis.localStorage?.setItem(SHOW_ALL_KEY, value ? '1' : '0')
      } catch {
        // 隐私模式写不进去，忽略
      }
    }

    /**
     * 草稿：只记录用户真正动过的键（稀疏），值为一个 op：`{ op: 'set', value }` 或 `{ op: 'unset' }`。
     *
     * 为什么稀疏：整段拷贝 + 全字段 diff 会把「别的窗口 / 另一个设置页刚改过的值」当成自己的
     * 编辑，保存时覆盖回去（review 里复现过）。只提交自己动过的键，再用打开草稿时的 revision
     * 兜底：期间宿主被别处改过就整批拒绝，而不是盲写。
     */
    function draftValue(key, draft, current, base) {
      const entry = draft?.[key]
      if (entry === undefined) return current?.[key]
      if (entry.op === 'unset') return base?.[key] ?? current?.[key]
      return entry.value
    }

    /** 草稿 → 宿主的 path ops：一次 mutate 提交（原子，只写一次 patch 文件、只重探测一次通道）。 */
    function draftOps(draft) {
      return Object.entries(draft ?? {}).map(([key, entry]) => (
        entry.op === 'unset' ? { op: 'unset', path: [key] } : { op: 'set', path: [key], value: entry.value }
      ))
    }

    /** 字段控件：布尔用开关、枚举用下拉、数字/文本用输入框；带 id/htmlFor 与字段级错误。 */
    function Field(props) {
      const { spec, value, disabled, overridden, t, invalid } = props
      const label = t(`f.${spec.key}`)
      const hint = t(`h.${spec.key}`)
      const inputId = `dsn-cfg-${spec.key}`
      let control
      if (spec.kind === 'boolean') {
        control = h('input', {
          id: inputId, type: 'checkbox', className: 'dsn-cfg-check', checked: value === true, disabled,
          onChange: (event) => props.onEdit(event.target.checked),
        })
      } else if (spec.kind === 'enum') {
        control = h('div', { className: 'dsn-cfg-selectwrap' },
          h('select', {
            id: inputId, className: 'dsn-cfg-select',
            value: value === undefined || value === null ? '' : String(value), disabled,
            onChange: (event) => props.onEdit(event.target.value),
          }, (props.options ?? spec.values ?? []).map((option) => h('option', { key: option, value: option },
            t(`v.${spec.key}.${option}`)))))
      } else if (spec.kind === 'number') {
        // 普通文本框（type=number 会带原生上下箭头，样式难统一）；边界见 NUMBER_LIMITS
        const limit = props.limit ?? {}
        control = h('input', {
          id: inputId, type: 'text', inputMode: 'numeric', autoComplete: 'off', spellCheck: false,
          value: value === undefined || value === null ? '' : String(value), disabled,
          'aria-invalid': invalid !== undefined ? 'true' : undefined,
          onChange: (event) => {
            const text = event.target.value.trim()
            // 清空 = 回到默认层（排一个 unset op，跟随保存/放弃，而不是立刻写宿主）
            if (text === '') props.onReset()
            else if (/^\d+$/.test(text)) props.onEdit(Number(text))
          },
        })
      } else {
        control = h('input', {
          id: inputId, type: 'text', autoComplete: 'off', spellCheck: false,
          value: value === undefined || value === null ? '' : String(value), disabled,
          onChange: (event) => props.onEdit(event.target.value),
        })
      }
      const reset = h('button', {
        type: 'button', className: 'dsn-cfg-reset', disabled,
        'aria-label': `${t('reset')}：${label}`,
        onClick: () => props.onReset(),
      }, t('reset'))
      return h('div', { className: 'dsn-cfg-field' },
        spec.kind === 'boolean'
          ? h('label', { className: 'dsn-cfg-switch', htmlFor: inputId },
              control, h('span', null, label),
              overridden ? h('span', { className: 'dsn-cfg-badge' }, t('overridden')) : null)
          : h('label', { htmlFor: inputId }, h('span', null, label),
              overridden ? h('span', { className: 'dsn-cfg-badge' }, t('overridden')) : null),
        spec.kind === 'boolean' ? null : control,
        invalid !== undefined
          ? h('span', { className: 'dsn-cfg-error' }, t(invalid))
          : (hint === `h.${spec.key}` ? null : h('span', { className: 'dsn-cfg-hint' }, hint)),
        overridden ? reset : null,
      )
    }

    /** 配置卡：Plugins → dsh-notify → 配置。 */
    function ConfigCard(props) {
      const { t, configForm, view } = props
      const snapshot = React.useSyncExternalStore(
        React.useCallback((listener) => configForm.subscribe(listener), [configForm]),
        () => configForm.getSnapshot(),
        () => configForm.getSnapshot(),
      )
      const platform = React.useSyncExternalStore(
        React.useCallback((listener) => subscribeHostPlatform(listener), []),
        getHostPlatform,
        getHostPlatform,
      )
      const [draft, setDraft] = React.useState(null)
      const [draftRevision, setDraftRevision] = React.useState(undefined)
      const [saving, setSaving] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      const [showAll, setShowAll] = React.useState(readShowAll)
      if (view !== 'page') return null

      const current = snapshot.value ?? {}
      const base = snapshot.base ?? {}
      const user = snapshot.user ?? {}
      const entryKeys = Object.keys(draft ?? {})
      const writable = snapshot.writable === true
      const busy = !writable || saving

      /** 开始一次草稿：记住当时的 revision，保存时用它做冲突栅栏。 */
      const stage = (key, entry) => {
        setFailed(false)
        setDraft((previous) => {
          if (previous === null) setDraftRevision(snapshot.revision)
          return Object.assign({}, previous ?? {}, { [key]: entry })
        })
      }
      const edit = (key, spec, value) => stage(key, { op: 'set', value })
      const resetField = (key) => stage(key, { op: 'unset' })

      const invalidKeys = {}
      for (const spec of CONFIG_FIELDS) {
        const entry = draft?.[spec.key]
        if (entry === undefined || entry.op === 'unset') continue
        const reason = invalidReason(spec.key, spec.kind, entry.value)
        if (reason !== undefined) invalidKeys[spec.key] = reason
      }
      const invalidCount = Object.keys(invalidKeys).length
      const dirty = entryKeys.length > 0

      const save = async () => {
        if (!dirty || invalidCount > 0 || saving) return
        setSaving(true)
        setFailed(false)
        try {
          // 一次 mutate 提交全部改动：原子、一个 revision 栅栏、一次 patch 写盘、一次通道重探测
          const accepted = await configForm.mutate(draftOps(draft), draftRevision)
          if (accepted) {
            setDraft(null)
            setDraftRevision(undefined)
          } else {
            setFailed(true)
          }
        } catch (error) {
          console.error('[dsh-notify] 保存配置失败', error)
          setFailed(true)
        } finally {
          setSaving(false)
        }
      }

      if (snapshot.status === 'unavailable') {
        return h('p', { className: 'dsn-cfg-note' }, snapshot.mode === 'memory' ? t('unavailableRemote') : t('unavailableHost'))
      }
      if (snapshot.status === 'loading' && snapshot.value === undefined) return h('p', { className: 'dsn-cfg-note' }, t('loading'))

      // 默认只显示当前宿主平台上真实存在的字段 / 分组；打开顶部开关后可预配置其它平台的字段。
      const effective = showAll ? undefined : platform
      const visible = showAll ? CONFIG_FIELDS : fieldsForPlatform(platform)
      const groups = CONFIG_GROUPS
        .filter((group) => showAll || group.platforms === undefined || matchesPlatform(group, effective))
        .filter((group) => visible.some((spec) => spec.group === group.id))

      return h('div', { className: 'dsn-cfg' },
        h('label', { className: 'dsn-cfg-showall' },
          h('input', {
            type: 'checkbox', className: 'dsn-cfg-check', checked: showAll,
            onChange: (event) => { setShowAll(event.target.checked); writeShowAll(event.target.checked) },
          }),
          h('span', null, t('showAll')),
        ),
        !showAll && platform === undefined ? h('p', { className: 'dsn-cfg-note' }, t('platformUnknown')) : null,
        h('div', { className: 'dsn-cfg-panel' },
          groups.map((group) => h('section', { key: group.id, className: 'dsn-cfg-group' },
            h('div', { className: 'dsn-cfg-head' },
              h('h4', { className: 'dsn-cfg-title' }, t(group.title)),
              group.chip === undefined ? null : h('span', { className: 'dsn-cfg-chip' }, t(group.chip)),
            ),
            h('div', { className: 'dsn-cfg-fields' },
              visible.filter((spec) => spec.group === group.id).map((spec) => h(Field, {
                key: spec.key,
                spec,
                t,
                disabled: busy,
                limit: NUMBER_LIMITS[spec.key],
                options: spec.kind === 'enum' ? optionsFor(spec, effective, draftValue(spec.key, draft, current, base)) : undefined,
                value: draftValue(spec.key, draft, current, base),
                overridden: draft?.[spec.key] !== undefined || Object.hasOwn(user, spec.key),
                invalid: invalidKeys[spec.key],
                onEdit: (value) => edit(spec.key, spec, value),
                onReset: () => resetField(spec.key),
              })),
            ),
          )),
        ),
        h('div', { className: 'dsn-cfg-foot' },
          h('button', {
            type: 'button', className: 'dsn-cfg-btn',
            disabled: busy || !dirty || invalidCount > 0,
            onClick: () => { void save() },
          }, saving ? t('saving') : t('save')),
          h('button', {
            type: 'button', className: 'dsn-cfg-btn ghost',
            disabled: !writable || saving || !dirty,
            onClick: () => { setDraft(null); setDraftRevision(undefined); setFailed(false) },
          }, t('discard')),
          !writable ? h('span', { className: 'dsn-cfg-note' }, t('readOnly')) : null,
          dirty ? h('span', { className: 'dsn-cfg-note' }, t('dirty')) : null,
          invalidCount > 0 ? h('span', { className: 'dsn-cfg-error' }, t('invalidFields')) : null,
          failed ? h('span', { className: 'dsn-cfg-error', role: 'alert' }, t('saveFailed')) : null,
        ),
      )
    }

    /** 注册配置卡（只有 Plugins 页声明了该 slot 时才会挂上）。 */
    function mountConfigCard(scope) {
      insertStyles()
      let form
      try {
        form = scope.configForms.get(CONFIG_NS)
      } catch (error) {
        console.error('[dsh-notify] 取配置表单失败，配置卡跳过', error)
        return
      }
      useEffectScope(scope, () => scope.locale.register(CONFIG_NS, { zh: CONFIG_ZH, en: CONFIG_EN }))
      scope.slots.inject('plugins.bundle.config', () => scope.slots.register({
        name: 'plugins.bundle.config',
        key: CONFIG_NS,
        locale: CONFIG_NS,
        inject: () => ({ configForm: form }),
      }, ConfigCard))
    }

    function mount(scope) {
      insertStyles()

      // 只是降级提示条的挂载点：host 通道正常时它渲染 null，页面上不会出现任何东西。
      scope.slots.inject('shell.overlay', () => scope.slots.register(
        { name: 'shell.overlay', id: 'dsh-notify', order: 1000, label: '消息通知' },
        Pill,
      ))

      useEffectScope(scope, () => {
        const stopFeed = startFeed()
        return () => {
          stopFeed()
          clearAllTimers()
          store.listeners.clear()
        }
      })
    }

    function apply(ctx) {
      if (typeof ctx.inject !== 'function') {
        console.error('[dsh-notify] ctx.inject 不可用，浏览器兜底通知跳过')
        return
      }
      try {
        ctx.inject(['slots'], (scope) => mount(scope))
      } catch (error) {
        console.error('[dsh-notify] 浏览器兜底通知注册失败', error)
      }
      // 配置卡需要 settings 的 configForms + locale；缺任何一个就只跳过卡片。
      try {
        ctx.inject(['slots', 'locale', 'configForms'], (scope) => mountConfigCard(scope))
      } catch (error) {
        console.error('[dsh-notify] 配置卡注册失败', error)
      }
    }

    /** 供 node 侧测试读取（浏览器里不用）。 */
    const internals = {
      CONFIG_FIELDS, CONFIG_GROUPS, CONFIG_ZH, CONFIG_EN, NUMBER_LIMITS,
      matchesPlatform, fieldsForPlatform, optionsFor, BACKEND_BY_PLATFORM,
      draftValue, draftOps, invalidReason,
    }

    return { inject: [], apply, internals }
  },
})
