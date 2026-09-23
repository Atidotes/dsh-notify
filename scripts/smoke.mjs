#!/usr/bin/env node
/**
 * host 半的冒烟测试：node scripts/smoke.mjs [--real]
 *
 * 默认只捕获通知命令的 argv（快速、可重复、不会打扰你）；
 * 加 --real 会真的把命令跑起来 —— 屏幕上应当立刻出现系统通知。
 *
 * 覆盖的行为（前两条正是线上踩过的坑）：
 *   1. 观察者必须用 { prepend: true } 注册：否则内置 ui-approval 这样的「gate」
 *      会先领走请求，后注册的监听永远不执行 —— 审批通知就是这么丢的
 *   2. 抢位成功的同时，请求必须原样交还下游（返回值不被改写）
 *   3. next() 抛错 → 异常继续上抛，且 feed 里补一条 resolve（卡片标记已处理）
 *   4. agent/status running → idle 发「任务完成」
 *   5. 子代理会话默认不通知
 *   6. 没有 subprocess 服务时不崩，页面卡片数据照常产生
 *   7. /dsh-notify/feed：首次只给游标，带 since 才回放条目，并带诊断
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../dsh/host.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const REAL = process.argv.includes('--real')
const FEED_PATH = '/dsh-notify/feed'
const failures = []
const captured = []

/**
 * 断言 osascript 具体 argv 的用例要把通道钉死在 osascript：
 * 默认配置在 macOS 上会走自建 applet（会额外产生 mkdir/osacompile/cp/open 等命令）。
 */
const OSA = { remindEveryMs: 0, backend: 'osascript' }
const OSA_RUN = { remindEveryMs: 0, minRunMs: 0, backend: 'osascript' }

function ok(message) { console.log(`  \u2713 ${message}`) }
function bad(message) { failures.push(message); console.log(`  \u2717 ${message}`) }

/** 假的 SSE 响应对象：把写出的分片记下来，供断言使用。 */
function makeRes() {
  return {
    chunks: [],
    statusCode: undefined,
    headers: undefined,
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    write(text) {
      this.chunks.push(String(text))
      return true
    },
    end(text) {
      if (text !== undefined) this.chunks.push(String(text))
      this.ended = true
    },
  }
}

/** 一个只实现 harness 用到的部分的 ctx 替身（含 waterfall 的 prepend 语义）。 */
function makeCtx(options = {}) {
  const handlers = new Map()
  const routes = new Map()
  const sessions = {
    get(id) {
      return options.sessions?.[id]
    },
  }
  const subprocessLate = options.subprocessLate === true
  let subprocessReady = !subprocessLate
  const subprocess = options.noSubprocess ? undefined : {
    async resolveExecutable(name) {
      // 默认假装什么都没装；options.executables 可以按平台指定存在哪些可执行文件。
      const table = options.executables ?? {}
      if (typeof table[name] === 'string') return table[name]
      throw new Error(`not found: ${name}`)
    },
    spawn(spec) {
      captured.push(spec.argv)
      if (REAL) execFile(spec.argv[0], spec.argv.slice(1), () => {})
      const failed = options.failOn !== undefined
        && spec.argv.some((part) => String(part).includes(options.failOn))
      // `/bin/test`：默认「不存在」→ 强制走构建路径；notifierExists 时走复用路径。
      const isTest = spec.argv[0] === '/bin/test'
      const exitCode = failed
        ? 1
        : isTest
          ? (options.notifierExists === true ? 0 : 1)
          : 0
      // spawnCapture 会读 collected.stdout：模拟 `plutil -extract`（当前 app 的 bundle id）
      // 与 `xcrun --show-sdk-path` 的输出。stderr 只在 failStderr 用例里给（模拟 PowerShell 报错）。
      const stdoutText = spec.argv[0] === '/usr/bin/plutil' && spec.argv.includes('-extract')
        ? (options.bundleId ?? 'com.dsh-notify.notifier.3')
        : spec.argv[0] === '/usr/bin/xcrun' ? '/fake/sdk' : ''
      const stderrText = failed && typeof options.failStderr === 'string' ? options.failStderr : ''
      return {
        done: Promise.resolve({ exitCode, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: stdoutText, nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderrText, nextOffset: 0, lossy: false }) },
        },
      }
    },
  }
  const pendingInject = []
  const currentSubprocess = () => (options.noSubprocess || !subprocessReady ? undefined : subprocess)
  const webServer = {
    register(route) {
      routes.set(route.path, route)
      return () => {}
    },
  }
  const ctx = {
    get(name) {
      if (name === 'sessions') return sessions
      if (name === 'subprocess') return currentSubprocess()
      if (name === 'webServer') return webServer
      return undefined
    },
    effect(callback) {
      return callback()
    },
    on(event, listener, opts) {
      const entry = { listener, opts }
      const list = handlers.get(event) ?? []
      if (opts && opts.prepend === true) list.unshift(entry)
      else list.push(entry)
      handlers.set(event, list)
      return () => {}
    },
    inject(names, callback) {
      // 还原 cordis 的语义：依赖不齐就不调用；subprocess 可以「晚一步」才就绪。
      const scope = (target) => {
        const built = Object.create(target)
        for (const name of names) {
          const value = target.get(name)
          if (value !== undefined) built[name] = value
        }
        return built
      }
      if (names.includes('subprocess') && currentSubprocess() === undefined) {
        if (subprocessLate) pendingInject.push(() => callback(scope(ctx)))
        return
      }
      callback(scope(ctx))
    },
  }
  return {
    ctx,
    handlers,
    routes,
    sessions,
    registrations(event) {
      return handlers.get(event) ?? []
    },
    /** 让「晚注册」的 subprocess 就绪，并触发 cordis 的 inject 回调。 */
    flushInject() {
      subprocessReady = true
      const queued = pendingInject.splice(0, pendingInject.length)
      for (const fire of queued) fire()
    },
    /** 按 waterfall 语义调用：每个监听拿到 next()，返回非 undefined 即「领走」。 */
    call(event, ...args) {
      const list = handlers.get(event) ?? []
      if (list.length === 0) throw new Error(`no listener for ${event}`)
      let index = 0
      const next = () => {
        if (index >= list.length) return Promise.resolve('downstream-outcome')
        const entry = list[index]
        index += 1
        return Promise.resolve(entry.listener(...args, next))
      }
      return next()
    },
    /** 直接调用注册进 webServer 的路由。 */
    async route(path) {
      const route = routes.get(path.split('?')[0])
      if (route === undefined) throw new Error(`no route ${path}`)
      let body
      const res = {
        writeHead() {},
        end(text) { body = text },
      }
      await route.handler({ url: path }, res)
      return JSON.parse(body)
    },
    /** 直接调用路由并交回原始响应对象（SSE 这类长连接用）。 */
    async rawRoute(path, res) {
      const route = routes.get(path.split('?')[0])
      if (route === undefined) throw new Error(`no route ${path}`)
      const listeners = new Map()
      const req = {
        url: path,
        on(event, fn) { listeners.set(event, fn) },
      }
      await route.handler(req, res)
      return listeners
    },
  }
}

/** 临时把 process.platform 换成别的平台（apply 时会读取它）。 */
function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

/** 每个用例一个独立的通知目录（载荷走真实 fs，所以必须落在工作区内）。 */
let tmpSeq = 0
function tmpNotifierDir() {
  tmpSeq += 1
  return resolve(root, '.smoke-tmp', `case-${tmpSeq}`)
}

/** 等待 fire-and-forget 的通知投递完成。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

console.log(`\nhost 半冒烟测试${REAL ? '（真实弹出系统通知）' : '（仅捕获 argv）'}`)

// --- 1 & 2. 抢位观察 + 原样放行（复现线上丢通知的坑） ----------------------
{
  captured.length = 0
  const bench = makeCtx({
    sessions: { 'session-1': { header: { cwd: '/Users/x/work/我的项目' } } },
  })
  // 先注册一个「gate」：完全复刻内置 ui-approval —— 它把请求领走并等待用户作答。
  let gateReached = false
  bench.ctx.on('approval/request', () => {
    gateReached = true
    return Promise.resolve('allowed-once')
  })
  apply(bench.ctx, OSA)

  const entries = bench.registrations('approval/request')
  if (entries[0]?.opts?.prepend === true) ok('审批观察者以 { prepend: true } 抢在 gate 之前注册')
  else bad('审批观察者没有 prepend，会被 gate 领走而完全不执行')

  const outcome = await bench.call('approval/request', {
    agent: { id: 'session-1' },
    toolName: 'bash',
    reason: 'escalate sandbox to danger-full-access: 用户要求实测通知链路，这条理由很长很长很长',
    callId: 'call-1',
  })
  await settle()
  if (captured.length > 0) ok('gate 之前先发出了通知（审批通知不再丢失）')
  else bad('观察者被 gate 跳过，没有发出任何通知')
  if (gateReached && outcome === 'allowed-once') ok('请求原样交还下游，审批结果未被改写')
  else bad(`waterfall 交还失败：gateReached=${gateReached} outcome=${JSON.stringify(outcome)}`)
  const argv = captured[0]
  const joined = (argv ?? []).join(' ')
  if (argv?.[0] === '/usr/bin/osascript') ok('走 osascript 通道')
  else bad(`第一个参数不是 osascript：${argv?.[0]}`)
  // argv: [osascript, -e, <script>, title, subtitle, body, sound]
  const bannerTitle = argv?.[3]
  const bannerSubtitle = argv?.[4]
  const bannerBody = argv?.[5]
  if (bannerBody === '🔐 需要审批：bash') ok(`横幅正文简洁：「${bannerBody}」`)
  else bad(`横幅正文不对：${JSON.stringify(bannerBody)}`)
  if (bannerSubtitle === '') ok('横幅不再显示常量应用名（省掉一行）')
  else bad(`横幅副标题应为空：${JSON.stringify(bannerSubtitle)}`)
  if (typeof bannerBody === 'string' && bannerBody.length <= 24) ok(`横幅正文长度 ${bannerBody.length} ≤ 24（长理由不进横幅）`)
  else bad(`横幅正文过长：${bannerBody?.length}`)
  if (!joined.includes('escalate sandbox')) ok('长理由没有被塞进横幅')
  else bad('长理由仍出现在横幅里')
  const feed = await bench.route(`${FEED_PATH}?since=0`)
  const approvalItem = feed.items.find((item) => item.kind === 'approval')
  if (typeof approvalItem?.detail === 'string' && approvalItem.detail.includes('escalate sandbox')) {
    ok('长理由改为放进卡片详情行')
  } else {
    bad(`卡片详情行没有理由：${JSON.stringify(approvalItem?.detail)}`)
  }
  if (argv?.[2]?.includes('display notification') && !argv?.[2]?.includes('subtitle s')) {
    ok('osascript 使用「无副标题」脚本变体')
  } else {
    bad('osascript 脚本变体不对（仍带 subtitle）')
  }
}

// --- 3. next() 抛错：异常透传 + feed 补 resolve ----------------------------
{
  const bench = makeCtx()
  apply(bench.ctx, OSA)
  const entries = bench.registrations('approval/request')
  let threw = false
  try {
    await entries[0].listener({ agent: { id: 'session-2' }, toolName: 'write' }, () => {
      throw new Error('boom')
    })
  } catch (error) {
    threw = error instanceof Error && error.message === 'boom'
  }
  if (threw) ok('下游异常原样上抛（观察者没有吞掉失败）')
  else bad('下游异常被吞掉了')
  const feed = await bench.route(`${FEED_PATH}?since=0`)
  const kinds = feed.items.map((item) => item.kind)
  if (kinds.includes('approval') && kinds.includes('resolve')) ok('异常后 feed 里补了 resolve（卡片不会永远卡在待处理）')
  else bad(`feed 缺少 resolve：${JSON.stringify(kinds)}`)
  await settle()
}

// --- 4. 任务完成 -----------------------------------------------------------
{
  captured.length = 0
  const bench = makeCtx({
    sessions: { 'session-3': { header: { cwd: '/Users/x/work/dsh-notify', delegationDepth: 0 } } },
  })
  apply(bench.ctx, OSA_RUN)
  await bench.call('agent/status', { agent: { id: 'session-3' }, status: 'running' })
  await bench.call('agent/status', { agent: { id: 'session-3' }, status: 'idle' })
  await settle()
  const joined = (captured[0] ?? []).join(' ')
  if (joined.includes('任务完成')) ok('running → idle 发出「任务完成」')
  else bad(`任务完成通知缺失：${joined}`)
  const doneArgv = captured[0] ?? []
  if (doneArgv[3] === 'DeepSeek Harness') ok('横幅标题是 DeepSeek Harness（默认不显示项目名）')
  else bad(`标题不对：${JSON.stringify(doneArgv[3])}`)
  if (doneArgv[4] === '') ok('没有副标题（横幅只有一行标题）')
  else bad(`副标题应为空：${JSON.stringify(doneArgv[4])}`)
}

// --- 4b. 标题口径可切回项目名 ---------------------------------------------
{
  captured.length = 0
  const bench = makeCtx({ sessions: { 'session-11': { header: { cwd: '/tmp/my-project' } } } })
  apply(bench.ctx, { remindEveryMs: 0, minRunMs: 0, backend: 'osascript', titleFrom: 'project' })
  await bench.call('agent/status', { agent: { id: 'session-11' }, status: 'running' })
  await bench.call('agent/status', { agent: { id: 'session-11' }, status: 'idle' })
  await settle()
  if ((captured[0] ?? [])[3] === 'my-project') ok("titleFrom: 'project' 时标题回到项目名")
  else bad(`titleFrom 切换失败：${JSON.stringify((captured[0] ?? [])[3])}`)
}

// --- 5. 子代理默认不通知 ---------------------------------------------------
{
  captured.length = 0
  const bench = makeCtx({
    sessions: { 'session-4': { header: { cwd: '/tmp/x', origin: 'subagent', delegationDepth: 1 } } },
  })
  apply(bench.ctx, OSA_RUN)
  await bench.call('approval/request', { agent: { id: 'session-4' }, toolName: 'bash' })
  await settle()
  if (captured.length === 0) ok('子代理会话默认不打扰')
  else bad(`子代理仍然通知了：${(captured[0] ?? []).join(' ')}`)
}

// --- 6. 没有 subprocess 服务也不崩，卡片数据照常 ---------------------------
{
  captured.length = 0
  const bench = makeCtx({ noSubprocess: true, sessions: { 'session-5': { header: { cwd: '/tmp/y' } } } })
  apply(bench.ctx, OSA)
  const outcome = await bench.call('approval/request', { agent: { id: 'session-5' }, toolName: 'bash' })
  await settle()
  const feed = await bench.route(`${FEED_PATH}?since=0`)
  if (outcome === 'downstream-outcome' && captured.length === 0) {
    ok('缺少 subprocess 服务时静默降级，审批流程不受影响')
  } else {
    bad('缺少 subprocess 服务时行为异常')
  }
  if (feed.items.some((item) => item.kind === 'approval')) ok('系统通知不可用时，页面卡片数据照常产生')
  else bad('页面卡片数据也丢了')
  if (feed.diag?.subprocess === false && feed.diag?.backend === 'none') {
    ok('诊断字段如实反映：无 subprocess、无可用通道')
  } else {
    bad(`诊断字段不对：${JSON.stringify(feed.diag)}`)
  }
}

// --- 7. feed 路由语义 ------------------------------------------------------
{
  const bench = makeCtx({ sessions: { 'session-6': { header: { cwd: '/tmp/z' } } } })
  apply(bench.ctx, OSA)
  await bench.call('approval/request', { agent: { id: 'session-6' }, toolName: 'write' })
  await settle()
  const head = await bench.route(FEED_PATH)
  if (head.items.length === 0 && typeof head.head === 'number') ok('首次只返回游标，不回放历史通知')
  else bad(`首次请求不应回放条目：${JSON.stringify(head.items)}`)
  const replay = await bench.route(`${FEED_PATH}?since=0`)
  if (replay.items.length > 0 && replay.items[0].seq === 1) ok('带 since 时按序回放条目')
  else bad(`回放异常：${JSON.stringify(replay.items)}`)
  if (replay.diag?.backend === 'osascript' && replay.diag?.delivered > 0) {
    ok('诊断显示通道与投递计数正常（osascript）')
  } else {
    bad(`诊断异常：${JSON.stringify(replay.diag)}`)
  }
}

// --- 8. subprocess 晚于插件注册：失败不得被缓存（重启后仍不通知的真 bug）---
{
  captured.length = 0
  const bench = makeCtx({
    subprocessLate: true,
    sessions: { 'session-7': { header: { cwd: '/tmp/late' } } },
  })
  apply(bench.ctx, OSA)
  // apply 时刻服务还没就绪：这一次发不出系统通知，是预期行为（页面卡片照常）。
  await bench.call('approval/request', { agent: { id: 'session-7' }, toolName: 'bash' })
  await settle()
  const before = captured.length
  const late = await bench.route(FEED_PATH)
  const backendBefore = late.diag?.backend
  // 服务就绪 —— 等价于 cordis 的 inject 回调触发。
  bench.flushInject()
  await settle()
  await bench.call('approval/request', { agent: { id: 'session-7' }, toolName: 'bash' })
  await settle()
  if (before === 0) ok('依赖未就绪时如实降级，不假装成功')
  else bad(`依赖未就绪却发出了通知：${(captured[0] ?? []).join(' ')}`)
  if (backendBefore === 'none') ok('依赖未就绪时诊断显示 none（而不是崩溃）')
  else bad(`诊断异常：${backendBefore}`)
  if (captured.length > 0) ok('subprocess 晚注册后立刻恢复通知（失败的探测结果不会被永久缓存）')
  else bad('subprocess 晚注册后仍然发不出通知 —— 就是重启后不弹的那个 bug')
  const after = await bench.route(FEED_PATH)
  if (after.diag?.backend === 'osascript' && after.diag?.delivered > 0) {
    ok('恢复后诊断转为 osascript 且投递计数增长')
  } else {
    bad(`恢复后诊断异常：${JSON.stringify(after.diag)}`)
  }
}

// --- 9. SSE 即时推送（后台标签页也能收到）--------------------------------
{
  const bench = makeCtx({ sessions: { 'session-8': { header: { cwd: '/tmp/sse' } } } })
  apply(bench.ctx, OSA)
  const res = makeRes()
  await bench.rawRoute('/dsh-notify/stream', res)
  const headers = res.headers ?? {}
  if (typeof headers['content-type'] === 'string' && headers['content-type'].includes('text/event-stream')) {
    ok('SSE 路由返回 text/event-stream')
  } else {
    bad(`SSE 响应头不对：${JSON.stringify(headers)}`)
  }
  const initial = res.chunks.join('')
  if (initial.includes('"kind":"status"')) ok('连接即同步通道状态（页面据此决定是否用浏览器通知兜底）')
  else bad(`连接时没有同步状态帧：${initial}`)
  res.chunks.length = 0
  await bench.call('approval/request', { agent: { id: 'session-8' }, toolName: 'bash' })
  await settle()
  const pushed = res.chunks.join('')
  if (pushed.includes('"kind":"approval"') && pushed.startsWith('data: ')) {
    ok('SSE 即时推送审批通知（不依赖轮询定时器）')
  } else {
    bad(`SSE 没有推送到位：${pushed}`)
  }
  // 页面关掉/断线后，继续发通知不应抛错。
  let threw = false
  try {
    await bench.call('agent/status', { agent: { id: 'session-8' }, status: 'running' })
    await bench.call('agent/status', { agent: { id: 'session-8' }, status: 'idle' })
    await settle()
  } catch (error) {
    threw = true
  }
  if (!threw) ok('推送目标断开后继续通知不抛错')
  else bad('断开后通知抛错')
}

// --- 10. 默认通道：自编译的通知 app（Swift + 官方通知 API）-------------------
{
  captured.length = 0
  const bench = makeCtx({ sessions: { 'session-9': { header: { cwd: '/tmp/notifier' } } } })
  const dir = tmpNotifierDir()
  apply(bench.ctx, { remindEveryMs: 0, notifierDir: dir })
  await bench.call('approval/request', { agent: { id: 'session-9' }, toolName: 'bash' })
  await settle()
  await settle()

  const commands = captured.map((argv) => argv[0])
  if (commands.includes('/usr/bin/swiftc')) ok('默认通道会编译通知 app（swiftc）')
  else bad(`没有编译通知 app：${commands.join(', ')}`)
  const compile = captured.find((argv) => argv[0] === '/usr/bin/swiftc')
  if (compile?.some((part) => String(part).includes('notifier.swift'))) ok('编译的是包内 notifier.swift')
  else bad(`编译输入不对：${JSON.stringify(compile)}`)
  const idInsert = captured.find((argv) => argv[0] === '/usr/bin/plutil' && argv.includes('CFBundleIdentifier'))
  const bundleId = idInsert?.[idInsert.indexOf('CFBundleIdentifier') + 2]
  if (typeof bundleId === 'string' && /^com\.dsh-notify\.notifier\./.test(bundleId)) {
    ok(`bundle id 带身份版本号（${bundleId}）：通知图标按 bundle id 缓存，换图标必须换身份`)
  } else if (bundleId !== undefined) {
    bad(`bundle id 缺身份版本号：${bundleId}`)
  } else {
    bad('没有写入 CFBundleIdentifier（没有它通知系统直接 "not allowed"）')
  }
  if (captured.some((argv) => argv[0] === '/usr/bin/codesign')) ok('ad-hoc 签名（通知身份的必要条件）')
  else bad('没有签名')
  if (captured.some((argv) => String(argv[0]).endsWith('lsregister'))) ok('注册到 LaunchServices')
  else bad('没有注册到 LaunchServices')
  if (captured.some((argv) => argv[0] === '/bin/cp' && argv.some((x) => String(x).includes('deepseek.icns')))) {
    ok('图标用官方 DeepSeek 图标')
  } else {
    bad('没有装官方图标')
  }
  // 载荷走真实 fs（node:fs），所以直接读磁盘验证内容与版本化路径
  const queueDir = resolve(dir, 'swift-v3', 'queue')
  const files = existsSync(queueDir) ? readdirSync(queueDir) : []
  const queueFile = files.find((name) => name.endsWith('.txt'))
  if (queueFile !== undefined) {
    const lines = readFileSync(resolve(queueDir, queueFile), 'utf8').split('\n')
    if (lines[0] === 'DeepSeek Harness' && lines[1] === '🔐 需要审批：bash' && lines[2] === 'Glass') {
      ok('载荷三行写进带版本号的 queue/（标题 / 正文 / 声音）')
    } else {
      bad(`载荷内容不对：${JSON.stringify(lines.slice(0, 3))}`)
    }
    rmSync(resolve(queueDir, queueFile), { force: true })
  } else {
    bad('队列里没有载荷文件（node:fs 写入失败？）')
  }
  if (captured.some((argv) => String(argv[0]).endsWith('lsregister') && argv.includes('-u'))) {
    ok('清理旧路径的 LaunchServices 注册（避免同一 bundle id 多份，重复会让通知显示旧图标）')
  } else {
    bad('没有清理旧注册')
  }
  const open = captured.find((argv) => argv[0] === '/usr/bin/open')
  if (open !== undefined && open[1] === '-a' && String(open[2]).endsWith('.app')) {
    ok(`用 open -a 启动通知 app：${String(open[2]).split('/').pop()}`)
  } else {
    bad(`启动命令不对：${JSON.stringify(open)}`)
  }
  const feed = await bench.route(`${FEED_PATH}?since=0`)
  if (feed.diag?.backend === 'notifier' && feed.diag?.notifier === 'ready') ok('诊断显示通知 app 就绪')
  else bad(`诊断不对：${JSON.stringify(feed.diag)}`)
  if (feed.diag?.delivered > 0) ok('投递计数已增长')
  else bad('投递计数没有增长')
}

// --- 10b. 已有通知 app 时直接复用（宿主没权限写 ~/.dsh 的兜底）---------------
{
  captured.length = 0
  const bench = makeCtx({
    notifierExists: true,
    sessions: { 'session-12': { header: { cwd: '/tmp/reuse' } } },
  })
  apply(bench.ctx, { remindEveryMs: 0, notifierDir: tmpNotifierDir() })
  await bench.call('approval/request', { agent: { id: 'session-12' }, toolName: 'bash' })
  await settle()
  await settle()
  if (!captured.some((argv) => argv[0] === '/usr/bin/swiftc')) ok('已存在的通知 app 直接复用，不重复编译')
  else bad('已有通知 app 却仍重新编译')
  if (captured.some((argv) => argv[0] === '/usr/bin/open')) ok('复用路径照样投递通知')
  else bad('复用路径没有投递')
}

// --- 10c. 身份变了必须重建（复用不能只看路径）-------------------------------
{
  captured.length = 0
  const bench = makeCtx({
    notifierExists: true,
    bundleId: 'com.dsh-notify.notifier', // 旧身份
    sessions: { 'session-13': { header: { cwd: '/tmp/identity' } } },
  })
  apply(bench.ctx, { remindEveryMs: 0, notifierDir: tmpNotifierDir() })
  await bench.call('approval/request', { agent: { id: 'session-13' }, toolName: 'bash' })
  await settle()
  await settle()
  if (captured.some((argv) => argv[0] === '/usr/bin/swiftc')) {
    ok('bundle id 与当前身份不一致时强制重建（否则会一直用旧图标快照）')
  } else {
    bad('身份变了却复用了旧 app')
  }
}

// --- 11. 编译失败 → 退回 osascript（通知不能丢）-----------------------------
{
  captured.length = 0
  const bench = makeCtx({
    failOn: 'swiftc',
    sessions: { 'session-10': { header: { cwd: '/tmp/fallback' } } },
  })
  apply(bench.ctx, { remindEveryMs: 0, notifierDir: tmpNotifierDir() })
  await bench.call('approval/request', { agent: { id: 'session-10' }, toolName: 'bash' })
  await settle()
  await settle()
  const osa = captured.find((argv) => argv[0] === '/usr/bin/osascript')
  if (osa !== undefined) ok('通知 app 构建失败时退回 osascript（通知照发）')
  else bad('构建失败后没有任何通知命令')
  const feed = await bench.route(`${FEED_PATH}?since=0`)
  if (feed.diag?.notifier === 'failed') ok('诊断如实显示通知 app 构建失败')
  else bad(`诊断不对：${JSON.stringify(feed.diag)}`)
}

// --- 12. 跨平台后端 ---------------------------------------------------------
{
  // Linux：notify-send（-i 图标 / -u 紧急级别 / -a 应用名）
  captured.length = 0
  const linux = makeCtx({
    executables: { 'notify-send': '/usr/bin/notify-send' },
    sessions: { 'session-14': { header: { cwd: '/home/me/proj' } } },
  })
  await withPlatform('linux', async () => {
    apply(linux.ctx, { remindEveryMs: 0 })
  })
  await linux.call('approval/request', { agent: { id: 'session-14' }, toolName: 'bash' })
  await settle()
  const ns = captured.find((argv) => String(argv[0]).includes('notify-send'))
  if (ns !== undefined) {
    const joined = ns.join(' ')
    if (joined.includes('-a DeepSeek Harness') && joined.includes('deepseek.png')
      && joined.includes('-u critical') && joined.includes('🔐 需要审批：bash')) {
      ok('Linux：notify-send 带应用名 / 图标 / 紧急级别')
    } else {
      bad(`notify-send 参数不对：${joined}`)
    }
  } else {
    bad(`Linux 没有走 notify-send：${captured.map((a) => a[0]).join(', ')}`)
  }

  // Windows：SnoreToast（-t/-m/-p/-appID）
  captured.length = 0
  const win = makeCtx({
    executables: { 'SnoreToast.exe': 'C:\\tools\\SnoreToast.exe' },
    sessions: { 'session-15': { header: { cwd: 'C:\\work\\proj' } } },
  })
  await withPlatform('win32', async () => {
    apply(win.ctx, { remindEveryMs: 0 })
  })
  await win.call('approval/request', { agent: { id: 'session-15' }, toolName: 'bash' })
  await settle()
  const snore = captured.find((argv) => String(argv[0]).includes('SnoreToast'))
  if (snore !== undefined && snore.includes('-t') && snore.includes('-m')
    && snore.includes('-p') && snore.includes('-appID')) {
    ok('Windows：优先生成 SnoreToast 参数（-t/-m/-p/-appID）')
  } else {
    bad(`SnoreToast 参数不对：${JSON.stringify(snore)}`)
  }
  // Windows：没有 SnoreToast 时退回 PowerShell Toast（windowsStyle 显式设成 toast）
  captured.length = 0
  const win2 = makeCtx({
    executables: { 'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    sessions: { 'session-16': { header: { cwd: 'C:\\work\\proj' } } },
  })
  await withPlatform('win32', async () => {
    apply(win2.ctx, { remindEveryMs: 0, windowsStyle: 'toast' })
  })
  await win2.call('approval/request', { agent: { id: 'session-16' }, toolName: 'bash' })
  await settle()
  const ps = captured.find((argv) => String(argv[0]).includes('powershell'))
  const psScript = ps?.find((part) => String(part).includes('ToastNotificationManager')) ?? ''
  if (ps !== undefined && ps.includes('-NoProfile')
    && psScript.includes('ToastGeneric') && psScript.includes('appLogoOverride')
    && psScript.includes('file:///') && !psScript.includes('file:////')
    && psScript.includes('deepseek.png')) {
    ok('Windows：无 SnoreToast 时退回 PowerShell Toast，并把官方图标放进 appLogoOverride（= 通知左侧图标位）')
  } else {
    bad(`PowerShell Toast 参数不对：${JSON.stringify(ps)}`)
  }
}

// 清理用例产生的临时目录
rmSync(resolve(root, '.smoke-tmp'), { recursive: true, force: true })

// --- 13. Windows 右上角横幅模式（系统 Toast 位置改不了）----------------------
{
  captured.length = 0
  const bench = makeCtx({
    executables: { 'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    sessions: { 'session-17': { header: { cwd: 'C:\\work\\proj' } } },
  })
  await withPlatform('win32', async () => {
    apply(bench.ctx, {
      remindEveryMs: 0,
      windowsStyle: 'banner',
      bannerPosition: 'topright',
      bannerDurationMs: 6000,
    })
  })
  await bench.call('approval/request', { agent: { id: 'session-17' }, toolName: 'bash' })
  await settle()
  const ps = captured.find((argv) => String(argv[0]).includes('powershell'))
  const script = ps?.find((part) => String(part).includes('ShowDialog')) ?? ''
  const checks = [
    ['TopMost', '置顶'],
    ['WorkingArea', '按屏幕工作区定位'],
    ['$wa.Right - $form.Width', '右上角（右缘对齐）'],
    ['$wa.Top +', '右上角（上缘对齐）'],
    ['deepseek.png', '横幅里带官方图标'],
    ['Interval = 6000', '自动关闭时长可配'],
    ['Start-Process', '点击横幅打开 DSH'],
  ]
  const missing = checks.filter(([needle]) => !script.includes(needle))
  if (ps !== undefined && missing.length === 0) {
    ok('Windows banner 模式：自绘右上角置顶横幅（位置 / 图标 / 时长 / 点击跳转齐全）')
  } else {
    bad(`banner 脚本缺少：${missing.map(([, label]) => label).join('、')}｜${JSON.stringify(ps?.slice(0, 2))}`)
  }
  if (script.includes('ToastNotificationManager')) {
    bad('banner 模式不应再走系统 Toast')
  } else {
    ok('banner 模式不再走系统 Toast（位置才可控）')
  }
}

// --- 14. Windows 默认就是「弹出窗」（用户实测：default toast 时什么都没弹）----
{
  captured.length = 0
  const bench = makeCtx({
    executables: { 'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    sessions: { 'session-18': { header: { cwd: 'C:\\work\\proj' } } },
  })
  await withPlatform('win32', async () => {
    // 不给 windowsStyle：走默认值
    apply(bench.ctx, { remindEveryMs: 0 })
  })
  await bench.call('approval/request', { agent: { id: 'session-18' }, toolName: 'bash' })
  await settle()
  const ps = captured.find((argv) => String(argv[0]).includes('powershell'))
  const script = ps?.find((part) => String(part).includes('ShowDialog')) ?? ''
  if (script !== '' && !script.includes('ToastNotificationManager')) {
    ok('Windows 默认形态就是自绘弹出窗（banner），不再默认走会被专注助手吞掉的 Toast')
  } else {
    bad(`Windows 默认形态不是 banner：${JSON.stringify(ps?.slice(0, 2))}`)
  }
  const diag = await bench.route(`${FEED_PATH}?since=0`)
  if (diag?.diag?.backend === 'banner') ok('诊断里 backend=banner（Windows 默认通道可核对）')
  else bad(`诊断 backend 不对：${JSON.stringify(diag?.diag?.backend)}`)
}

// --- 15. 投递失败必须看得见（PowerShell 出错但退出码 0 的坑）------------------
{
  captured.length = 0
  const bench = makeCtx({
    executables: { 'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    sessions: { 'session-19': { header: { cwd: 'C:\\work\\proj' } } },
    failOn: 'ShowDialog',
    failStderr: 'Add-Type : 无法加载文件或程序集 System.Windows.Forms',
  })
  await withPlatform('win32', async () => {
    apply(bench.ctx, { remindEveryMs: 0 })
  })
  // 通道探测：失败命令也会被记录，先把探测阶段的结果清掉再看真实投递
  await bench.call('approval/request', { agent: { id: 'session-19' }, toolName: 'bash' })
  await settle()
  const diag = await bench.route(`${FEED_PATH}?since=0`)
  const d = diag?.diag ?? {}
  if (d.failed >= 1) ok(`投递失败计入诊断（failed=${d.failed}）`)
  else bad(`投递失败没有计入诊断：${JSON.stringify(d.failed)}`)
  if (typeof d.lastError === 'string' && d.lastError.includes('退出码 1')) ok(`失败原因进 lastError：「${d.lastError}」`)
  else bad(`lastError 没说明失败：${JSON.stringify(d.lastError)}`)
  if (typeof d.lastStderr === 'string' && d.lastStderr.includes('System.Windows.Forms')) {
    ok('PowerShell 的 stderr 被采集进诊断（能定位到具体原因）')
  } else {
    bad(`lastStderr 没采到：${JSON.stringify(d.lastStderr)}`)
  }
  if (d.lastExitCode === 1) ok('诊断里有命令退出码（lastExitCode=1）')
  else bad(`lastExitCode 不对：${JSON.stringify(d.lastExitCode)}`)
}

console.log('')
if (failures.length > 0) {
  console.log(`${failures.length} 项失败`)
  process.exitCode = 1
} else {
  console.log('全部通过')
}
