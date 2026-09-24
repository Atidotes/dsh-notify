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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// 依赖缺失（比如新克隆没跑 npm install）时给一句人话，而不是 ERR_MODULE_NOT_FOUND 堆栈。
let apply
let Config
let DEFAULT_CONFIG
try {
  ({ apply, Config, DEFAULT_CONFIG } = await import('../dsh/host.js'))
} catch (error) {
  console.error('[smoke] 无法加载 dsh/host.js —— 先在插件目录执行 npm install（需要 @deepseek-ai/schemastery）。')
  console.error(String(error))
  process.exit(1)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const REAL = process.argv.includes('--real')

// 这套冒烟是「mock 子进程 + 断言 argv」的：把基准平台钉在 darwin，它在 Linux / Windows 的
// CI 上同样有效（要别的平台语义的用例自己用 withPlatform() 覆盖）。
// `--real` 会真的弹通知，那必须用真实平台。
if (!REAL) Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
const FEED_PATH = '/dsh-notify/feed'
const failures = []
const captured = []
/** 被 terminate() 的通知进程 argv（重提醒替换旧窗口的行为用它断言）。 */
const terminated = []

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
      // 横幅进程在真机上会停留 bannerDurationMs（done 很晚才落地）；需要模拟这一点时
      // 用 hangBanner，否则 done 立刻落地会让"重提醒替换旧窗"的簿记被提前清掉。
      const isBanner = spec.argv.some((part) => String(part).includes('ShowDialog'))
      const done = isBanner && options.hangBanner === true
        ? new Promise(() => {})
        : Promise.resolve({ exitCode, signal: null })
      return {
        terminate() {
          terminated.push(spec.argv)
        },
        done,
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
  if (bannerBody === '需要审批：bash') ok(`横幅正文简洁、不带 emoji：「${bannerBody}」`)
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
    if (lines[0] === 'DeepSeek Harness' && lines[1] === '需要审批：bash' && lines[2] === 'Glass') {
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
      && joined.includes('-u critical') && joined.includes('需要审批：bash')) {
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
    // macOS 观感：DPI 感知 + 自己缩放（否则缩放屏上整窗被位图放大，就是「太大」）
    ['SetProcessDPIAware', 'DPI 感知（缩放屏上不再位图放大）'],
    ["AutoScaleMode = 'None'", '禁止 WinForms 二次缩放'],
    ['Round(350 * $scale); $minW = [int][Math]::Round(310 * $scale)', '宽度上限 350 / 下限 310'],
    ['$rightPad = [int][Math]::Round(16 * $scale)', '右侧留 16px 呼吸位（文字不贴边）'],
    ['$needW = [Math]::Max($tw.Width, $bw.Width)', '宽度贴着标题/正文里更长的那条收窄（不再固定留白）'],
    ['$form.Width = $W; $form.Height = $H', '宽高都在定稿阶段一次算清'],
    ['Round(38 * $scale)', '图标 38×38'],
    ['Round(40 * $scale)', '圆角 40px（夹到高度一半 = 胶囊）'],
    ['[Math]::Floor($H / 2)', '圆角夹在卡片高度一半以内（矮卡片不会画歪）'],
    ['$bottomPad = [int][Math]::Round(9 * $scale)', '底部留白 9px（收紧但不影响圆角取满）'],
    ['$H = $bodyTop + $bodyH + $bottomPad', '高度 = 标题+正文+底部留白，按内容自适应'],
    ['MeasureText', '用正文实际行高定卡片高度（两行也不会被裁）'],
    ['TextFormatFlags]::NoPadding', '测量用 NoPadding（默认测量含边框留白，会凭空高出几像素）'],
    ['dsh-notify 卡片', '把卡片实际几何写进 stderr（进 diag，调版式不用猜）'],
    ['Font("Segoe UI", 9.75', '标题 13px 观感（DPI 感知后按点自动换算）'],
    ['AppsUseLightTheme', '浅色/深色跟随系统外观'],
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
  // 装饰性语句必须逐条兜底：单句报错不能让整条通知消失（真机踩过的坑）
  const softened = (script.match(/横幅降级/g) ?? []).length
  if (softened >= 5) ok(`装饰性语句逐条兜底（${softened} 处 try/catch，单句报错只丢外观）`)
  else bad(`装饰性语句没有逐条兜底：只找到 ${softened} 处`)

  // 显式给了 bannerHeight 时走固定高度（想钉死尺寸的老行为）
  captured.length = 0
  const fixed = makeCtx({
    executables: { 'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    sessions: { 'session-17b': { header: { cwd: 'C:\\work\\proj' } } },
  })
  await withPlatform('win32', async () => {
    apply(fixed.ctx, { remindEveryMs: 0, windowsStyle: 'banner', bannerHeight: 72 })
  })
  await fixed.call('approval/request', { agent: { id: 'session-17b' }, toolName: 'bash' })
  await settle()
  const fixedScript = captured
    .find((argv) => String(argv[0]).includes('powershell'))
    ?.find((part) => String(part).includes('ShowDialog')) ?? ''
  if (fixedScript.includes('Round(72 * $scale)') && !fixedScript.includes('$H = $bodyTop + $bodyH + $bottomPad')) {
    ok('bannerHeight > 0 时走固定高度（高度自适应只作用于默认值 0）')
  } else {
    bad('显式 bannerHeight 没有走固定高度')
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
  if (diag?.diag?.windowsStyle === 'banner') ok('诊断回显生效的 windowsStyle（能看出是不是被 config.json 覆盖成 toast）')
  else bad(`诊断没有回显 windowsStyle：${JSON.stringify(diag?.diag?.windowsStyle)}`)
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
  // 兜底 Toast 会覆盖 lastStderr/lastExitCode（它们记的是「最后一条命令」），
  // 但横幅失败原因必须已经落在 lastError 里（含 PowerShell 的 stderr 原文）。
  if (typeof d.lastError === 'string' && d.lastError.includes('System.Windows.Forms')) {
    ok('PowerShell 的 stderr 被采集进诊断（能定位到具体原因）')
  } else {
    bad(`lastError 里没有 stderr 原文：${JSON.stringify(d.lastError)}`)
  }
  // 横幅失败 → 必须还有一条系统 Toast 兜底，不允许「什么都没有」
  const fallbackToast = captured.find((argv) => argv.some((part) => String(part).includes('ToastNotificationManager')))
  if (fallbackToast !== undefined) ok('横幅失败后自动退回系统 Toast（不会「什么都没弹」）')
  else bad(`横幅失败后没有兜底通知：${JSON.stringify(captured.map((a) => a[0]))}`)
  if (d.lastFallback === 'toast') ok('诊断记录 lastFallback=toast（能区分兜底和本来就该弹的 Toast）')
  else bad(`lastFallback 不对：${JSON.stringify(d.lastFallback)}`)
  if (typeof d.lastError === 'string' && d.lastError.includes('已退回系统 Toast')) {
    ok('兜底后仍保留横幅失败的原因（lastError 不被清掉）')
  } else {
    bad(`兜底把失败原因冲掉了：${JSON.stringify(d.lastError)}`)
  }
}

// --- 16. Toast 本身失败时，原样保留退出码与 stderr（没有兜底可退）------------
{
  captured.length = 0
  const bench = makeCtx({
    executables: { 'powershell.exe': 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' },
    sessions: { 'session-20': { header: { cwd: 'C:\work\proj' } } },
    failOn: 'ToastNotificationManager',
    failStderr: '无法解析 WinRT 类型 Windows.UI.Notifications',
  })
  await withPlatform('win32', async () => {
    apply(bench.ctx, { remindEveryMs: 0, windowsStyle: 'toast' })
  })
  await bench.call('approval/request', { agent: { id: 'session-20' }, toolName: 'bash' })
  await settle()
  const d = (await bench.route(`${FEED_PATH}?since=0`))?.diag ?? {}
  if (d.failed >= 1) ok(`Toast 失败也计入诊断（failed=${d.failed}）`)
  else bad(`Toast 失败没有计入诊断：${JSON.stringify(d.failed)}`)
  if (d.lastExitCode === 1) ok('失败命令的退出码留在 lastExitCode')
  else bad(`lastExitCode 不对：${JSON.stringify(d.lastExitCode)}`)
  if (typeof d.lastStderr === 'string' && d.lastStderr.includes('WinRT')) {
    ok('失败命令的 stderr 留在 lastStderr')
  } else {
    bad(`lastStderr 没采到：${JSON.stringify(d.lastStderr)}`)
  }
  if (d.lastFallback === undefined) ok('走 Toast 主通道时不会多此一举地再兜底一次')
  else bad(`不该出现兜底：${JSON.stringify(d.lastFallback)}`)
}

// --- 17. 配置卡：schema 默认值不漂移 + volatile 值生效 + 文件同名键被接管 ------
{
  // ① schema 里的默认值必须与 DEFAULT_CONFIG 一致（两处默认值漂移会让 GUI 显示错值）
  const resolved = Config({})
  const drifted = Object.keys(Config.dict).filter((key) => {
    const live = resolved[key]
    const value = live !== null && typeof live === 'object' && typeof live.get === 'function' ? live.get() : live
    return value !== DEFAULT_CONFIG[key]
  })
  if (drifted.length === 0) ok(`配置卡 schema 的 ${Object.keys(Config.dict).length} 个字段默认值与 DEFAULT_CONFIG 一致`)
  else bad(`schema 默认值与 DEFAULT_CONFIG 漂移：${drifted.join(', ')}`)

  // ② loader（= GUI 配置卡）传来的 volatile 引用要按当前值读取
  captured.length = 0
  const bench = makeCtx({
    executables: { 'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    sessions: { 'session-21': { header: { cwd: 'C:\\work\\proj' } } },
  })
  await withPlatform('win32', async () => {
    apply(bench.ctx, Config({ remindEveryMs: 0, bannerWidth: 420, bannerRadius: 60 }))
  })
  await bench.call('approval/request', { agent: { id: 'session-21' }, toolName: 'bash' })
  await settle()
  const banner = captured.find((argv) => String(argv[0]).includes('powershell'))
  const script = banner?.find((part) => String(part).includes('ShowDialog')) ?? ''
  if (script.includes('Round(420 * $scale)') && script.includes('Round(60 * $scale)')) {
    ok('GUI 配置（volatile 引用）生效：bannerWidth=420 / bannerRadius=60 进了脚本')
  } else {
    bad('volatile 配置没有生效（还是默认值？）')
  }

  // ③ config.json 里与 GUI 同名的键要被接管（否则"界面改了不生效"）
  const dir = tmpNotifierDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/config.json`, JSON.stringify({ bannerWidth: 999, command: ['echo', 'hi'] }), 'utf8')
  captured.length = 0
  const fileBench = makeCtx({
    executables: { 'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    sessions: { 'session-22': { header: { cwd: 'C:\\work\\proj' } } },
  })
  await withPlatform('win32', async () => {
    apply(fileBench.ctx, Object.assign(Config({ remindEveryMs: 0, notifierDir: dir }), {}))
  })
  await fileBench.call('approval/request', { agent: { id: 'session-22' }, toolName: 'bash' })
  await settle()
  const fileScript = captured
    .find((argv) => String(argv[0]).includes('powershell'))
    ?.find((part) => String(part).includes('ShowDialog')) ?? ''
  if (fileScript.includes('Round(350 * $scale)')) ok('config.json 里的同名键被 GUI 接管（文件值不生效）')
  else bad('config.json 竟然覆盖了 GUI 的字段')
  const fileDiag = (await fileBench.route(`${FEED_PATH}?since=0`))?.diag ?? {}
  if (Array.isArray(fileDiag.configConflicts) && fileDiag.configConflicts.includes('bannerWidth')) {
    ok(`诊断列出被接管的键：${fileDiag.configConflicts.join('、')}`)
  } else {
    bad(`诊断没有列出冲突键：${JSON.stringify(fileDiag.configConflicts)}`)
  }
}

// --- 18. 配置卡（浏览器半）：字段 / 词典与宿主 schema 对齐，并真的注册到 slot ----
{
  // client.js 是浏览器模块：用假的 __ModuleLoader__ 把它 load 进来，再手工调 factory。
  let spec
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (loaded) => { spec = loaded } } }
  try {
    await import('../dsh/client.js')
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  if (spec?.id !== 'dsh-notify') {
    bad(`client.js 没有以 dsh-notify 注册到模块加载器：${JSON.stringify(spec?.id)}`)
  } else {
    ok('client.js 仍是 lazy-CJS 工厂模块（id=dsh-notify）')
  }

  /** 极简 React 替身：只要 factory 能构造出组件与纯函数即可。 */
  const fakeReact = {
    createElement: () => null,
    useCallback: (fn) => fn,
    useState: () => [null, () => {}],
    useSyncExternalStore: () => ({}),
  }
  const mod = spec.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error(`client.js 请求了不可解析的模块：${id}`)
  })
  const card = mod.internals
  if (card === undefined) {
    bad('client.js 没有导出 internals（无法校验配置卡）')
  } else {
    // ① 卡片字段与宿主 Config schema 必须一一对应
    const hostKeys = Object.keys(Config.dict)
    const cardKeys = card.CONFIG_FIELDS.map((field) => field.key)
    const missing = hostKeys.filter((key) => !cardKeys.includes(key))
    const extra = cardKeys.filter((key) => !hostKeys.includes(key))
    if (missing.length === 0 && extra.length === 0) {
      ok(`配置卡 ${cardKeys.length} 个字段与宿主 Config schema 完全一致`)
    } else {
      bad(`配置卡字段与 schema 不一致：缺 ${missing.join(', ') || '—'}；多 ${extra.join(', ') || '—'}`)
    }

    // ② 中英词典必须覆盖：分组标题 + 每个字段的标签/说明 + 每个枚举值 + 界面文案
    const needed = [
      // 分组标题 + 平台徽标
      ...card.CONFIG_GROUPS.flatMap((group) => [group.title, group.chip].filter((key) => typeof key === 'string')),
      ...card.CONFIG_FIELDS.flatMap((field) => [`f.${field.key}`, `h.${field.key}`]),
      ...card.CONFIG_FIELDS.filter((field) => field.kind === 'enum')
        .flatMap((field) => (field.values ?? []).map((value) => `v.${field.key}.${value}`)),
      // 枚举字段在别的平台的取值也要有词条（BACKEND_BY_PLATFORM 里列出的那些）
      ...Object.values(card.BACKEND_BY_PLATFORM).flat()
        .map((value) => `v.backend.${value}`),
      // 界面文案（含后加的平台提示与「显示所有平台」开关）
      'save', 'saving', 'discard', 'reset', 'overridden', 'saveFailed',
      'unavailableRemote', 'unavailableHost', 'readOnly', 'loading', 'dirty',
      'platformUnknown', 'showAll', 'h.showAll',
      // 字段级校验错误（invalidReason 返回的键，动态引用）
      'invalidNumber', 'invalidRange', 'invalidFields',
    ]
    for (const [name, dict] of [['zh', card.CONFIG_ZH], ['en', card.CONFIG_EN]]) {
      const gaps = needed.filter((key) => typeof dict[key] !== 'string' || dict[key] === '')
      if (gaps.length === 0) ok(`配置卡 ${name} 词典齐全（${needed.length} 个键）`)
      else bad(`配置卡 ${name} 词典缺 ${gaps.length} 个键：${gaps.slice(0, 6).join(', ')}…`)
    }
    // 中英必须一一对应，且不留没人引用的僵尸键
    const zhKeys = Object.keys(card.CONFIG_ZH).sort()
    const enKeys = Object.keys(card.CONFIG_EN).sort()
    if (JSON.stringify(zhKeys) === JSON.stringify(enKeys)) ok(`配置卡中英词典一一对应（${zhKeys.length} 个键）`)
    else bad('配置卡中英词典键不一致')
    const zombie = zhKeys.filter((key) => !needed.includes(key))
    if (zombie.length === 0) ok('配置卡词典没有未被引用的僵尸键')
    else bad(`配置卡词典有僵尸键：${zombie.slice(0, 6).join(', ')}…`)

    // ③ 平台筛选：macOS 不显示 Windows 那一套，Linux 不显示 macOS 提示音
    const mac = card.fieldsForPlatform('darwin').map((spec) => spec.key)
    const win = card.fieldsForPlatform('win32').map((spec) => spec.key)
    const linux = card.fieldsForPlatform('linux').map((spec) => spec.key)
    const unknown = card.fieldsForPlatform(undefined).map((spec) => spec.key)
    if (!mac.includes('bannerWidth') && mac.includes('sound') && mac.includes('minRunMs')) {
      ok('macOS 只显示 macOS 相关字段（隐藏弹出窗尺寸，保留提示音）')
    } else {
      bad(`macOS 字段筛选不对：${mac.join(', ')}`)
    }
    if (win.includes('bannerWidth') && win.includes('windowsStyle') && !win.includes('sound')) {
      ok('Windows 只显示 Windows 相关字段（弹出窗尺寸在，macOS 提示音不在）')
    } else {
      bad(`Windows 字段筛选不对：${win.join(', ')}`)
    }
    if (!linux.includes('bannerWidth') && !linux.includes('sound') && linux.includes('backend')) {
      ok('Linux 只显示 Linux 相关字段')
    } else {
      bad(`Linux 字段筛选不对：${linux.join(', ')}`)
    }
    if (unknown.every((key) => ['approval', 'question', 'done', 'minRunMs', 'remindEveryMs', 'maxReminders', 'backend', 'titleFrom', 'fallbackName', 'subtitle', 'snippetChars'].includes(key))) {
      ok('平台未知时只显示跨平台字段（不猜平台）')
    } else {
      bad(`平台未知时的字段不对：${unknown.join(', ')}`)
    }
    const winBackends = card.optionsFor({ key: 'backend', values: ['auto'] }, 'win32', 'auto')
    const macBackends = card.optionsFor({ key: 'backend', values: ['auto'] }, 'darwin', 'auto')
    if (winBackends.includes('powershell') && !winBackends.includes('osascript')
      && macBackends.includes('osascript') && !macBackends.includes('powershell')) {
      ok('通知通道下拉按平台过滤选项')
    } else {
      bad(`通道选项没按平台过滤：win=${winBackends.join('/')} mac=${macBackends.join('/')}`)
    }
    // 'command' 是任意平台都能用的通道，每个平台的列表里都必须有（否则 README 那条路仍不可达）
    if (winBackends.includes('command') && macBackends.includes('command')
      && card.optionsFor({ key: 'backend', values: ['auto'] }, 'linux', 'auto').includes('command')) {
      ok("三个平台的通道下拉都包含 'command'（自定义命令在任何平台都可选）")
    } else {
      bad('有平台的通道下拉缺少 command')
    }
    if (card.optionsFor({ key: 'backend', values: ['auto'] }, 'linux', 'powershell').includes('powershell')) {
      ok('已配置但不在当前平台列表里的通道值会补进下拉（不会显示错值）')
    } else {
      bad('当前值没有补进下拉选项')
    }

    // ④ 草稿：稀疏 + path ops（一次 mutate 提交）
    const ops = card.draftOps({ bannerWidth: { op: 'set', value: 420 }, subtitle: { op: 'unset' } })
    const setOp = ops.find((op) => op.path[0] === 'bannerWidth')
    const unsetOp = ops.find((op) => op.path[0] === 'subtitle')
    if (ops.length === 2 && setOp?.op === 'set' && setOp.value === 420 && unsetOp?.op === 'unset') {
      ok('草稿 → path ops（set / unset 一次提交，原子）')
    } else {
      bad(`path ops 不对：${JSON.stringify(ops)}`)
    }
    if (card.draftValue('bannerWidth', { bannerWidth: { op: 'set', value: 420 } }, { bannerWidth: 350 }, {}) === 420) {
      ok('草稿值优先于宿主值（只覆盖用户动过的键）')
    } else {
      bad('草稿取值优先级不对')
    }
    if (card.draftValue('sound', { subtitle: { op: 'unset' } }, { sound: 'Glass' }, {}) === 'Glass') {
      ok('没动过的键不受草稿影响（不会覆盖别处改的值）')
    } else {
      bad('草稿影响了没动过的键')
    }
    if (card.draftValue('subtitle', { subtitle: { op: 'unset' } }, { subtitle: 'x' }, { subtitle: 'y' }) === 'y') {
      ok('unset 草稿回落到继承层（重置跟随保存/放弃，而不是立刻写宿主）')
    } else {
      bad('unset 草稿的取值不对')
    }

    // ⑤ 数值边界与宿主 schema 对齐（客户端先校验，避免整批被拒后只回一句"保存失败"）
    const numericSpecs = card.CONFIG_FIELDS.filter((spec) => spec.kind === 'number').map((spec) => spec.key)
    const missingLimits = numericSpecs.filter((key) => card.NUMBER_LIMITS[key] === undefined)
    if (missingLimits.length === 0) ok(`数值字段都配了边界（${numericSpecs.length} 个）`)
    else bad(`这些数值字段没有边界：${missingLimits.join(', ')}`)
    const drift = []
    for (const [key, limit] of Object.entries(card.NUMBER_LIMITS)) {
      const node = Config.dict[key]
      if (node?.meta?.min !== limit.min || node?.meta?.max !== limit.max) {
        drift.push(`${key}(客户端 ${limit.min}-${limit.max} / schema ${node?.meta?.min}-${node?.meta?.max})`)
      }
    }
    if (drift.length === 0) ok('客户端数值边界与宿主 schema 的 min/max 完全一致')
    else bad(`数值边界与 schema 漂移：${drift.join(', ')}`)
    if (card.invalidReason('bannerWidth', 'number', 9999) === 'invalidRange'
      && card.invalidReason('bannerWidth', 'number', 350) === undefined
      && card.invalidReason('approval', 'boolean', true) === undefined) {
      ok('字段级校验：超范围标红、合法值与布尔字段放行')
    } else {
      bad('字段级校验不对')
    }

    // ⑥ 真的注册到 plugins.bundle.config，key 用包名
    const registrations = []
    const scope = {
      slots: {
        inject: (name, callback) => { callback() },
        register: (options, component) => { registrations.push({ options, component }) },
      },
      locale: { register: () => () => {} },
      configForms: { get: (ns) => ({ namespace: ns }) },
    }
    mod.apply({ inject: (names, callback) => { if (names.includes('configForms')) callback(scope) } })
    const entry = registrations.find((row) => row.options.name === 'plugins.bundle.config')
    if (entry?.options.key === 'dsh-notify' && entry.options.locale === 'dsh-notify' && typeof entry.component === 'function') {
      ok('配置卡注册到 plugins.bundle.config（key=dsh-notify，带 locale 与组件）')
    } else {
      bad(`配置卡注册不对：${JSON.stringify(entry?.options)}`)
    }
  }
}

// --- 19. 回归：'command' 通道可用 + 探测前会等配置文件读完 -------------------
{
  // ① backend='command' 必须还在 schema 里：README「自定义命令」那条路不能被吃掉
  const configured = Config({ backend: 'command' })
  if (configured.backend.get() === 'command') ok("schema 接受 backend='command'（README 的自定义命令未被吃掉）")
  else bad(`schema 丢掉了 backend='command'：${String(configured.backend.get())}`)

  captured.length = 0
  const bench = makeCtx({ sessions: { 'session-23': { header: { cwd: '/tmp/cmd' } } } })
  apply(bench.ctx, Object.assign(Config({ backend: 'command', remindEveryMs: 0 }), { command: ['/bin/echo', '自定义命令'] }))
  await bench.call('approval/request', { agent: { id: 'session-23' }, toolName: 'bash' })
  await settle()
  if (captured.some((argv) => argv[0] === '/bin/echo' && argv.includes('自定义命令'))) {
    ok('backend=command 时真的走 config.json 的 argv 模板')
  } else {
    bad(`backend=command 没有生效：${JSON.stringify(captured.map((a) => a[0]))}`)
  }

  // ② 显式指定的通道不可用（这里是 command 没有 argv 数组）时必须回退 auto，
  //    而不是"探测失败 → backend=none → 通知静默全停"
  captured.length = 0
  const fallback = makeCtx({
    executables: { 'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    sessions: { 'session-26': { header: { cwd: 'C:\\work\\proj' } } },
  })
  await withPlatform('win32', async () => {
    // command 给字符串（truthy 但不是数组）：旧代码会认定通道可用，然后一条都发不出去
    apply(fallback.ctx, Object.assign(Config({ backend: 'command', remindEveryMs: 0 }), { command: 'notify-send {title}' }))
  })
  await fallback.call('approval/request', { agent: { id: 'session-26' }, toolName: 'bash' })
  await settle()
  const fallbackDiag = (await fallback.route(`${FEED_PATH}?since=0`))?.diag ?? {}
  if (fallbackDiag.backend === 'banner' && fallbackDiag.backendFallback === 'command') {
    ok('显式通道不可用时回退 auto（backend=banner，诊断记 backendFallback=command）')
  } else {
    bad(`显式通道没有回退：backend=${String(fallbackDiag.backend)} fallback=${String(fallbackDiag.backendFallback)}`)
  }
  if (captured.some((argv) => String(argv[0]).includes('powershell'))) ok('回退后通知真的发出去了（没有静默全停）')
  else bad('回退后仍然什么都没发')

  // ③ 通道探测必须等 config.json 读完：否则文件里的 snoretoastCommand 赶不上探测并被缓存
  const dir = tmpNotifierDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/config.json`, JSON.stringify({ snoretoastCommand: 'C:\\tools\\SnoreToast.exe' }), 'utf8')
  const race = makeCtx({ sessions: { 'session-24': { header: { cwd: 'C:\\work\\proj' } } } })
  await withPlatform('win32', async () => {
    apply(race.ctx, Config({ remindEveryMs: 0, notifierDir: dir }))
  })
  await settle()
  const diag = (await race.route(`${FEED_PATH}?since=0`))?.diag ?? {}
  if (diag.backend === 'snoretoast') ok('探测等到了 config.json：snoretoastCommand 生效（backend=snoretoast）')
  else bad(`config.json 的 snoretoastCommand 没赶上探测：backend=${String(diag.backend)}`)
}

// --- 20. 回归：通知开关是「每次事件判断」，GUI 切换立刻生效 -------------------
{
  // loader 用这个全局符号把新值写进 volatile 引用（vendor/cosmokit/src/volatile.ts）。
  // 用它来忠实模拟「在配置卡里改开关」：引用原地更新、插件不重挂。
  const WRITE = Symbol.for('cosmokit.volatile.write')
  const config = Config({ approval: true, question: true, done: true, remindEveryMs: 0, minRunMs: 0, backend: 'osascript' })
  const bench = makeCtx({ sessions: { 'session-25': { header: { cwd: '/tmp/live' } } } })
  apply(bench.ctx, config)

  captured.length = 0
  await bench.call('approval/request', { agent: { id: 'session-25' }, toolName: 'bash' })
  await settle()
  const beforeOff = captured.length
  config.approval[WRITE](false)
  await bench.call('approval/request', { agent: { id: 'session-25' }, toolName: 'bash' })
  await settle()
  if (beforeOff > 0 && captured.length === beforeOff) ok('关掉「需要审批时通知」后立刻不再发通知（不用重启）')
  else bad(`关闭审批开关没生效：before=${beforeOff} after=${captured.length}`)

  const approvalHandlers = bench.registrations('approval/request')
  if (approvalHandlers.length === 1 && approvalHandlers[0].opts?.prepend === true) {
    ok('开关关闭时观察者仍然注册（再打开即可生效，不会"永远收不到"）')
  } else {
    bad(`开关关闭时没有注册观察者：${approvalHandlers.length} 个`)
  }

  config.approval[WRITE](true)
  captured.length = 0
  await bench.call('approval/request', { agent: { id: 'session-25' }, toolName: 'bash' })
  await settle()
  if (captured.length > 0) ok('重新打开审批开关后立刻恢复通知')
  else bad('重新打开审批开关后仍然不通知')

  captured.length = 0
  config.question[WRITE](false)
  await bench.call('user-questions/request', { agent: { id: 'session-25' }, questions: [{ question: '要不要跑测试？' }] })
  await settle()
  const afterQuestionOff = captured.length
  config.question[WRITE](true)
  await bench.call('user-questions/request', { agent: { id: 'session-25' }, questions: [{ question: '要不要跑测试？' }] })
  await settle()
  if (afterQuestionOff === 0 && captured.length > 0) ok('「需要回答时通知」开关同样即时生效')
  else bad(`提问开关没即时生效：off=${afterQuestionOff} on=${captured.length}`)

  const statusListener = bench.registrations('agent/status')[0]?.listener
  if (typeof statusListener === 'function') {
    captured.length = 0
    config.done[WRITE](false)
    statusListener({ agent: { id: 'session-25' }, status: 'running' })
    statusListener({ agent: { id: 'session-25' }, status: 'idle' })
    await settle()
    const afterDoneOff = captured.length
    config.done[WRITE](true)
    statusListener({ agent: { id: 'session-25' }, status: 'running' })
    statusListener({ agent: { id: 'session-25' }, status: 'idle' })
    await settle()
    if (afterDoneOff === 0 && captured.length > 0) ok('「任务完成时通知」开关同样即时生效')
    else bad(`任务完成开关没即时生效：off=${afterDoneOff} on=${captured.length}`)
  } else {
    bad('没有注册 agent/status 监听（应该永远注册）')
  }
}

// --- 21. 回归：同一条事件的重提醒替换旧窗口，不叠罗汉 ------------------------
{
  terminated.length = 0
  captured.length = 0
  const bench = makeCtx({
    hangBanner: true,
    executables: { 'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    sessions: { 'session-27': { header: { cwd: 'C:\\work\\proj' } } },
  })
  await withPlatform('win32', async () => {
    // 15ms 提醒一次，只开自绘横幅
    apply(bench.ctx, {
      remindEveryMs: 15, maxReminders: 5, minRunMs: 0,
      backend: 'banner', windowsStyle: 'banner', bannerDurationMs: 8000,
    })
  })
  // 真机上 next() 要等审批被回答才 settle，提醒才会持续；mock 里补一个"悬而不决"的下游
  // 监听，把这段等待期模拟出来（否则提醒计划会在 next() 落地的瞬间被停掉）。
  // 真机上 next() 要等审批被回答才 settle，提醒才会持续；这里用一个可控的 gate 模拟
  // "还没被回答"的等待期，读完计数后再放行（放行后插件会自己停掉提醒计划）。
  let answer = () => {}
  const gate = new Promise((resolveGate) => { answer = resolveGate })
  bench.ctx.on('approval/request', () => gate)
  const pendingPlan = bench.call('approval/request', { agent: { id: 'session-27' }, toolName: 'bash' })
  if (typeof pendingPlan?.catch === 'function') pendingPlan.catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 90))
  if (captured.length >= 2 && terminated.length >= 1) {
    ok(`重提醒前会终止上一个同 group 的窗口（弹了 ${captured.length} 次、终止 ${terminated.length} 次）`)
  } else {
    bad(`重提醒没有替换旧窗口：弹了 ${captured.length} 次、终止 ${terminated.length} 次`)
  }
  answer('answered') // 审批被回答 → 计划停掉，不再有定时器
  await new Promise((resolve) => setTimeout(resolve, 30))
}

// 清理用例产生的临时目录（放在最后：后面的用例还会新建目录）
rmSync(resolve(root, '.smoke-tmp'), { recursive: true, force: true })

console.log('')
if (failures.length > 0) {
  console.log(`${failures.length} 项失败`)
  process.exitCode = 1
} else {
  console.log('全部通过')
}
