#!/usr/bin/env node
/**
 * 看通知长什么样：node scripts/preview.mjs
 *
 * 用假的 ctx 驱动真实的 host 半，把三种通知的「系统横幅」和「卡片详情」原样打出来 ——
 * 改文案、调 snippetChars/detailChars 之后不用重启 DSH 就能先看效果。
 */
import { apply } from '../dsh/host.js'

const captured = []

function makeCtx(sessions) {
  const handlers = new Map()
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions[id] }
      if (name === 'subprocess') {
        return {
          async resolveExecutable() { throw new Error('not installed') },
          spawn(spec) { captured.push(spec.argv); return { done: Promise.resolve({ exitCode: 0 }) } },
        }
      }
      if (name === 'webServer') return { register(route) { routes.set(route.path, route); return () => {} } }
      return undefined
    },
    effect(callback) { return callback() },
    on(event, listener, opts) {
      const list = handlers.get(event) ?? []
      if (opts?.prepend === true) list.unshift({ listener })
      else list.push({ listener })
      handlers.set(event, list)
      return () => {}
    },
    inject(names, callback) {
      const scope = Object.create(ctx)
      for (const name of names) {
        const value = ctx.get(name)
        if (value !== undefined) scope[name] = value
      }
      if (names.some((name) => ctx.get(name) === undefined)) return
      callback(scope)
    },
  }
  return {
    ctx,
    async call(event, ...args) {
      const list = handlers.get(event) ?? []
      let index = 0
      const next = () => {
        if (index >= list.length) return Promise.resolve('downstream-outcome')
        const entry = list[index]
        index += 1
        return Promise.resolve(entry.listener(...args, next))
      }
      return next()
    },
    async route(path) {
      let body
      await routes.get(path.split('?')[0]).handler({ url: path }, { writeHead() {}, end(text) { body = text } })
      return JSON.parse(body)
    },
  }
}

/** argv: [osascript, -e, script, title, subtitle, body, sound] */
function show(label, argv) {
  if (argv === undefined) {
    console.log(`${label}：（没有产生通知）`)
    return
  }
  const [, , , title, subtitle, body] = argv
  const lines = subtitle ? `${title} ／ ${subtitle}` : title
  console.log(`  ${label}： [${lines}]  ${body}`)
  return body
}

const bench = makeCtx({
  'session-1': { header: { cwd: '/Users/you/work/deepseek-plugin' } },
})
apply(bench.ctx, { remindEveryMs: 0, minRunMs: 0, backend: 'osascript' })

console.log('\n三种通知的实际文案（只在系统通知中心出现，页面里不再有卡片；实际投递由自建的 Swift 通知 app 完成（Windows/Linux 走各自的后端））\n')

// 审批：给一条很长的理由，验证它不会挤进横幅。
captured.length = 0
await bench.call('approval/request', {
  agent: { id: 'session-1' },
  toolName: 'bash',
  reason: 'escalate sandbox to danger-full-access: 用户要求实测通知链路，这条理由很长很长很长很长很长',
})
await new Promise((resolve) => setTimeout(resolve, 30))
show('审批横幅', captured[0])

// 提问
captured.length = 0
await bench.call('user-questions/request', {
  agent: { id: 'session-1' },
  questions: [{ id: 'q1', question: '要不要先跑一遍完整测试再提交？' }],
})
await new Promise((resolve) => setTimeout(resolve, 30))
show('提问横幅', captured[0])

// 完成
captured.length = 0
await bench.call('agent/status', { agent: { id: 'session-1' }, status: 'running' })
await new Promise((resolve) => setTimeout(resolve, 1_200))
await bench.call('agent/status', { agent: { id: 'session-1' }, status: 'idle' })
await new Promise((resolve) => setTimeout(resolve, 30))
show('完成横幅', captured[0])

// 另一种标题口径：用会话所在目录名（titleFrom: 'project'），而不是固定应用名。
const alt = makeCtx({ 'session-1': { header: { cwd: '/Users/you/work/deepseek-plugin' } } })
apply(alt.ctx, { remindEveryMs: 0, minRunMs: 0, backend: 'osascript', titleFrom: 'project' })
captured.length = 0
await alt.call('agent/status', { agent: { id: 'session-1' }, status: 'running' })
await new Promise((resolve) => setTimeout(resolve, 1_200))
await alt.call('agent/status', { agent: { id: 'session-1' }, status: 'idle' })
await new Promise((resolve) => setTimeout(resolve, 30))
show("完成横幅（titleFrom: 'project'）", captured[0])

console.log('\n调 `snippetChars` 可改提问片段长短（默认 24）；titleFrom 设为 "project" 可把标题从应用名改回项目名。\n')
process.exit(0)
