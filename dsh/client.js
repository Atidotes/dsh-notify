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
    }

    return { inject: [], apply }
  },
})
