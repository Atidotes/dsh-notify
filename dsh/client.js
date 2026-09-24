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
      // 配置卡（Plugins → dsh-notify → 配置区）
      '.dsn-cfg { display: flex; flex-direction: column; gap: 14px; font-size: 13px; color: var(--dsw-alias-label-primary, inherit); }',
      '.dsn-cfg-group { display: flex; flex-direction: column; gap: 8px; }',
      '.dsn-cfg-group > h4 { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-label-secondary, inherit); }',
      '.dsn-cfg-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px 18px; }',
      '.dsn-cfg-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }',
      '.dsn-cfg-field > label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }',
      '.dsn-cfg-field input[type="text"], .dsn-cfg-field input[type="number"], .dsn-cfg-field select { box-sizing: border-box; width: 100%; padding: 5px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; font: inherit; }',
      '.dsn-cfg-field input:disabled, .dsn-cfg-field select:disabled { opacity: .55; }',
      '.dsn-cfg-hint { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }',
      '.dsn-cfg-inline { display: flex; align-items: center; gap: 8px; }',
      '.dsn-cfg-check { width: 16px; height: 16px; accent-color: #07c160; }',
      '.dsn-cfg-tag { font-size: 11px; padding: 0 6px; border-radius: 6px; background: rgba(7,193,96,.14); color: #07c160; }',
      '.dsn-cfg-link { border: none; background: none; padding: 0; font: inherit; font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); cursor: pointer; text-decoration: underline; }',
      '.dsn-cfg-foot { display: flex; align-items: center; gap: 10px; }',
      '.dsn-cfg-btn { border: none; border-radius: 8px; padding: 6px 14px; font: inherit; font-size: 12px; cursor: pointer; background: #07c160; color: #fff; }',
      '.dsn-cfg-btn.ghost { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14)); color: inherit; }',
      '.dsn-cfg-btn:disabled { opacity: .5; cursor: default; }',
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
          if (typeof item.backend === 'string') {
            store.hostBackend = item.backend
            updateHint()
          }
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
      tag.textContent = CSS
      document.head.appendChild(tag)
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

    /** 配置字段（与 dsh/host.js 的 Config schema 一一对应）。 */
    const CONFIG_FIELDS = [
      { group: 'switch', key: 'approval', kind: 'boolean' },
      { group: 'switch', key: 'question', kind: 'boolean' },
      { group: 'switch', key: 'done', kind: 'boolean' },
      { group: 'timing', key: 'minRunMs', kind: 'number' },
      { group: 'timing', key: 'remindEveryMs', kind: 'number' },
      { group: 'timing', key: 'maxReminders', kind: 'number' },
      { group: 'type', key: 'windowsStyle', kind: 'enum', values: ['banner', 'toast'] },
      { group: 'type', key: 'backend', kind: 'enum', values: ['auto', 'banner', 'powershell', 'snoretoast', 'osascript', 'terminal-notifier', 'notify-send'] },
      { group: 'copy', key: 'titleFrom', kind: 'enum', values: ['app', 'project'] },
      { group: 'copy', key: 'fallbackName', kind: 'text' },
      { group: 'copy', key: 'subtitle', kind: 'text' },
      { group: 'copy', key: 'sound', kind: 'text' },
      { group: 'look', key: 'bannerWidth', kind: 'number' },
      { group: 'look', key: 'bannerMinWidth', kind: 'number' },
      { group: 'look', key: 'bannerRadius', kind: 'number' },
      { group: 'look', key: 'bannerHeight', kind: 'number' },
      { group: 'look', key: 'bannerPosition', kind: 'enum', values: ['topright', 'topleft', 'bottomright', 'bottomleft'] },
      { group: 'look', key: 'bannerDurationMs', kind: 'number' },
    ]

    /** 分组顺序 + 标题的词典键。 */
    const CONFIG_GROUPS = [
      { id: 'switch', title: 'group.switch' },
      { id: 'timing', title: 'group.timing' },
      { id: 'type', title: 'group.type' },
      { id: 'copy', title: 'group.copy' },
      { id: 'look', title: 'group.look' },
    ]

    /** 字典命名空间（也是 settings 的 namespace）。 */
    const CONFIG_NS = 'dsh-notify'

    const CONFIG_ZH = {
      'group.switch': '通知开关',
      'group.timing': '触发时机',
      'group.type': '提醒类型',
      'group.copy': '文案',
      'group.look': 'Windows 弹出窗外观',
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
      'v.backend.auto': '自动', 'v.backend.banner': '自绘弹出窗', 'v.backend.powershell': 'PowerShell Toast',
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
      'f.bannerPosition': '位置',
      'h.bannerPosition': '弹出窗贴屏幕的哪个角',
      'f.bannerDurationMs': '停留时长（毫秒）',
      'h.bannerDurationMs': '0 = 一直显示到点击关闭',
      'v.bannerPosition.topright': '右上角', 'v.bannerPosition.topleft': '左上角',
      'v.bannerPosition.bottomright': '右下角', 'v.bannerPosition.bottomleft': '左下角',
      'save': '保存', 'saving': '保存中…', 'discard': '放弃修改',
      'reset': '重置', 'overridden': '已自定义',
      'saveFailed': '保存失败，请重试', 'readOnly': '当前连接不可写', 'loading': '正在读取配置…',
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
      'v.backend.auto': 'Auto', 'v.backend.banner': 'Self-drawn popup', 'v.backend.powershell': 'PowerShell Toast',
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
      'f.bannerPosition': 'Position',
      'h.bannerPosition': 'Which screen corner the popup sticks to',
      'f.bannerDurationMs': 'Dismiss after (ms)',
      'h.bannerDurationMs': '0 = stay until clicked',
      'v.bannerPosition.topright': 'Top right', 'v.bannerPosition.topleft': 'Top left',
      'v.bannerPosition.bottomright': 'Bottom right', 'v.bannerPosition.bottomleft': 'Bottom left',
      'save': 'Save', 'saving': 'Saving…', 'discard': 'Discard',
      'reset': 'Reset', 'overridden': 'Customized',
      'saveFailed': 'Save failed, please retry', 'readOnly': 'This connection is read-only', 'loading': 'Loading configuration…',
      'unavailableRemote': 'Configuration can only be edited from a page opened on this machine (127.0.0.1 / localhost).',
      'unavailableHost': 'Configuration is not readable yet: the plugin host may still run the old module — restart DSH and refresh.',
      'dirty': 'Unsaved changes',
    }

    /**
     * 一行的草稿 diff：只提交改动过的键。
     * @returns 变更键数组
     */
    function changedKeys(draft, current) {
      if (draft === null || draft === undefined) return []
      const keys = new Set([...Object.keys(draft), ...Object.keys(current ?? {})])
      const out = []
      for (const key of keys) {
        const before = current?.[key]
        const after = draft[key]
        if (after === undefined) continue
        if (before !== after) out.push(key)
      }
      return out
    }

    /** 一行的取值：草稿优先，其次宿主值。 */
    function fieldValue(key, draft, current) {
      if (draft !== null && draft !== undefined && Object.hasOwn(draft, key)) return draft[key]
      return current?.[key]
    }

    /** 字段控件：布尔用开关、枚举用下拉、数字/文本用输入框。 */
    function Field(props) {
      const { spec, value, disabled, overridden, t } = props
      const label = t(`f.${spec.key}`)
      const hint = t(`h.${spec.key}`)
      let control
      if (spec.kind === 'boolean') {
        control = h('input', {
          type: 'checkbox', className: 'dsn-cfg-check', checked: value === true, disabled,
          onChange: (event) => props.onEdit(event.target.checked),
        })
      } else if (spec.kind === 'enum') {
        control = h('select', {
          value: value === undefined || value === null ? '' : String(value), disabled,
          onChange: (event) => props.onEdit(event.target.value),
        }, (spec.values ?? []).map((option) => h('option', { key: option, value: option },
          t(`v.${spec.key}.${option}`))))
      } else if (spec.kind === 'number') {
        control = h('input', {
          type: 'number', inputMode: 'numeric', min: '0',
          value: value === undefined || value === null ? '' : String(value), disabled,
          onChange: (event) => {
            const text = event.target.value
            // 清空 = 回到默认层（否则会出现"输入框空了但什么都没改"的怪状态）
            if (text === '') props.onEdit(props.baseValue)
            else if (Number.isFinite(Number(text))) props.onEdit(Number(text))
          },
        })
      } else {
        control = h('input', {
          type: 'text', value: value === undefined || value === null ? '' : String(value), disabled,
          onChange: (event) => props.onEdit(event.target.value),
        })
      }
      return h('div', { className: 'dsn-cfg-field' },
        h('label', null,
          spec.kind === 'boolean' ? control : null,
          h('span', null, label),
          overridden ? h('span', { className: 'dsn-cfg-tag' }, t('overridden')) : null,
        ),
        spec.kind === 'boolean' ? null : control,
        hint === `h.${spec.key}` ? null : h('span', { className: 'dsn-cfg-hint' }, hint),
        overridden
          ? h('button', { type: 'button', className: 'dsn-cfg-link', disabled, onClick: () => props.onReset() }, t('reset'))
          : null,
      )
    }

    /** 配置卡：Plugins → dsh-notify → 配置。 */
    function ConfigCard(props) {
      const { t, form, view } = props
      const snapshot = React.useSyncExternalStore(
        React.useCallback((listener) => form.subscribe(listener), [form]),
        () => form.getSnapshot(),
        () => form.getSnapshot(),
      )
      const [draft, setDraft] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      if (view !== 'page') return null
      const current = snapshot.value ?? {}
      const user = snapshot.user ?? {}
      const pending = changedKeys(draft, current)
      const writable = snapshot.writable === true
      const disabled = !writable || saving

      const edit = (key, value) => {
        setFailed(false)
        setDraft((previous) => Object.assign({}, previous === null ? current : previous, { [key]: value }))
      }
      const resetField = async (key) => {
        setFailed(false)
        setDraft((previous) => {
          if (previous === null) return previous
          const next = Object.assign({}, previous)
          delete next[key]
          return next
        })
        try {
          const ok = await form.unset(key)
          if (!ok) setFailed(true)
        } catch (error) {
          console.error('[dsh-notify] 重置配置失败', error)
          setFailed(true)
        }
      }
      const save = async () => {
        if (pending.length === 0 || saving) return
        setSaving(true)
        setFailed(false)
        let ok = true
        for (const key of pending) {
          const value = fieldValue(key, draft, current)
          try {
            const accepted = await form.set(key, value)
            if (!accepted) ok = false
          } catch (error) {
            console.error('[dsh-notify] 保存配置失败', error)
            ok = false
          }
        }
        setSaving(false)
        if (ok) setDraft(null)
        else setFailed(true)
      }

      if (snapshot.status === 'unavailable') {
        return h('p', { className: 'dsn-cfg-note' }, snapshot.mode === 'memory' ? t('unavailableRemote') : t('unavailableHost'))
      }
      if (snapshot.status === 'loading' && snapshot.value === undefined) return h('p', { className: 'dsn-cfg-note' }, t('loading'))
      return h('div', { className: 'dsn-cfg' },
        CONFIG_GROUPS.map((group) => h('section', { key: group.id, className: 'dsn-cfg-group' },
          h('h4', null, t(group.title)),
          h('div', { className: 'dsn-cfg-fields' },
            CONFIG_FIELDS.filter((spec) => spec.group === group.id).map((spec) => h(Field, {
              key: spec.key,
              spec,
              t,
              disabled,
              value: fieldValue(spec.key, draft, current),
              baseValue: snapshot.base?.[spec.key],
              overridden: Object.hasOwn(user, spec.key),
              onEdit: (value) => edit(spec.key, value),
              onReset: () => { void resetField(spec.key) },
            })),
          ),
        )),
        h('div', { className: 'dsn-cfg-foot' },
          h('button', { type: 'button', className: 'dsn-cfg-btn', disabled: disabled || pending.length === 0, onClick: () => { void save() } },
            saving ? t('saving') : t('save')),
          h('button', { type: 'button', className: 'dsn-cfg-btn ghost', disabled: !writable || saving || draft === null, onClick: () => { setDraft(null); setFailed(false) } }, t('discard')),
          !writable ? h('span', { className: 'dsn-cfg-note' }, t('readOnly')) : null,
          draft !== null && pending.length > 0 ? h('span', { className: 'dsn-cfg-note' }, t('dirty')) : null,
          failed ? h('span', { className: 'dsn-cfg-error' }, t('saveFailed')) : null,
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
        inject: () => ({ form }),
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
    const internals = { CONFIG_FIELDS, CONFIG_GROUPS, CONFIG_ZH, CONFIG_EN, changedKeys, fieldValue }

    return { inject: [], apply, internals }
  },
})
