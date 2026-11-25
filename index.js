/**
 * Host half of dsh-reading-desk.
 *
 * Serves the reading-desk UI from `assets/` and proxies the read-only WeChat
 * Reading gateway calls the page makes, so the browser never talks to the
 * gateway directly (it only allows weread.qq.com as origin).
 * @module dsh-reading-desk
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, normalize } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(HERE, 'assets')
const PREFIX = '/plugin/reading-desk'
const GATEWAY = 'https://i.weread.qq.com/api/agent/gateway'

/** API Key 只存宿主：$DSH_HOME/storages/dsh-reading-desk/config.json（600 权限） */
const STORE_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'dsh-reading-desk')
const CONFIG_FILE = join(STORE_DIR, 'config.json')
const KEY_RE = /^wrk-[A-Za-z0-9_-]{6,}$/

async function readStoredKey() {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8')
    const value = JSON.parse(raw)
    return typeof value.apiKey === 'string' ? value.apiKey : ''
  } catch {
    return ''
  }
}

async function writeStoredKey(key) {
  await mkdir(STORE_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, JSON.stringify({ apiKey: key, updatedAt: Date.now() }, null, 2), { mode: 0o600 })
}

async function clearStoredKey() {
  await rm(CONFIG_FILE, { force: true }).catch(() => {})
}

const maskKey = key => (KEY_RE.test(key) ? `wrk-****${key.slice(-4)}` : '')

/** Only the read-only endpoints the page actually calls. */
const ALLOWED = new Set([
  '/shelf/sync', '/readdata/detail', '/book/getprogress',
  '/user/notebooks', '/review/list/mine', '/book/bookmarklist', '/store/search',
])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

export const name = 'dsh-reading-desk'
export const inject = ['webServer']

/**
 * 可选依赖：connection。存在时用它校验 Host/Origin 与浏览器鉴权，
 * 避免浏览器里任意网页直接调用本插件的 HTTP 路由。
 */
export const optional = ['connection']

async function serveAsset(request) {
  const url = new URL(request.url)
  let rel = decodeURIComponent(url.pathname.slice(PREFIX.length)) || '/'
  if (rel.endsWith('/')) rel += 'index.html'
  const file = normalize(join(ASSETS, rel))
  if (!file.startsWith(ASSETS)) return new Response('forbidden', { status: 403 })
  try {
    const body = await readFile(file)
    return new Response(body, {
      headers: {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      },
    })
  } catch {
    return new Response('not found', { status: 404 })
  }
}

async function proxyWeread(request) {
  if (request.method !== 'POST') return json({ errmsg: 'method not allowed' }, 405)
  const auth = request.headers.get('authorization') ?? ''
  if (!/^Bearer wrk-[A-Za-z0-9_-]{6,}$/.test(auth)) return json({ errmsg: 'API Key 格式不对' }, 401)
  const body = await request.text()
  if (body.length > 4096) return json({ errmsg: '请求太大' }, 413)
  let payload
  try { payload = JSON.parse(body) } catch { return json({ errmsg: '请求格式不对' }, 400) }
  if (!payload || !ALLOWED.has(payload.api_name)) return json({ errmsg: '不支持的接口' }, 400)
  const upstream = await fetch(GATEWAY, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body,
  })
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Register the two routes this bundle owns.
 * @param ctx - the host plugin context.
 */
export function apply(ctx) {
  const server = ctx.webServer
  if (server === undefined) return
  ctx.effect(() => server.register({ kind: 'prefix', path: PREFIX, resource: serveAsset }), 'reading-desk: assets')
  /** 路由统一入口：能用 connection 校验时先校验，拒绝即 401/403。 */
  const guard = fn => (req, res) => {
    const rejection = rejectUntrusted(ctx, req)
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ errmsg: rejection === 401 ? 'unauthorized' : 'forbidden' }))
      return
    }
    return fn(req, res)
  }
  ctx.effect(() => server.register({ kind: 'exact', path: PREFIX + '/weread', handler: guard(proxyHandler) }), 'reading-desk: weread')
  ctx.effect(() => server.register({ kind: 'exact', path: PREFIX + '/config', handler: guard(configRoute) }), 'reading-desk: config')
  ctx.effect(() => server.register({ kind: 'exact', path: PREFIX + '/sync-config', handler: guard(syncConfigRoute) }), 'reading-desk: sync config')
  ctx.effect(() => server.register({ kind: 'exact', path: PREFIX + '/push/flomo', handler: guard(pushRoute) }), 'reading-desk: push flomo')
  ctx.effect(() => server.register({ kind: 'exact', path: PREFIX + '/push/getnotes', handler: guard(pushRoute) }), 'reading-desk: push getnotes')
  ctx.effect(() => server.register({ kind: 'exact', path: PREFIX + '/ai/chat', handler: guard((req, res) => aiChat(ctx, req, res)) }), 'reading-desk: ai chat')
  ctx.effect(() => server.register({ kind: 'exact', path: PREFIX + '/ai/one-liner', handler: guard((req, res) => aiOneLiner(ctx, req, res)) }), 'reading-desk: ai one-liner')
  ctx.effect(() => server.register({ kind: 'exact', path: PREFIX + '/ai/model', handler: guard((req, res) => aiModel(ctx, res)) }), 'reading-desk: ai model')
  ctx.effect(() => server.register({ kind: 'exact', path: PREFIX + '/ai/curator', handler: guard((req, res) => aiCurator(ctx, req, res)) }), 'reading-desk: ai curator')
  ctx.effect(() => server.register({ kind: 'exact', path: PREFIX + '/ai/summarize', handler: guard((req, res) => aiSummarize(ctx, req, res)) }), 'reading-desk: ai summarize')
}

/* ---------------- AI（宿主侧统一走 ctx.llm，Key 不出宿主） ---------------- */

/**
 * 拒绝来自其它站点网页的调用。
 *
 * 背景：这些路由由 ctx.webServer 注册，不走 DSH 的 /api 鉴权层，浏览器里任何网页
 * 都能向 127.0.0.1 发 POST。因此逐个请求校验来源：
 *   - Origin 必须是本机回环（浏览器无法伪造 Origin）；
 *   - 没有 Origin 时退一步看 Referer，同样要求本机回环且来自本插件页面；
 *   - 两者都没有（直连脚本）一律拒绝。
 * 面板自身是本机同源页面，因此不受影响。
 */
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost'
}

function callAllowed(req) {
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') return LOOPBACK_ORIGIN.test(origin)
  const referer = req.headers.referer
  if (typeof referer === 'string' && referer !== '') {
    try {
      const url = new URL(referer)
      return isLoopbackHost(url.hostname) && url.pathname.startsWith(PREFIX + '/')
    } catch {
      return false
    }
  }
  return false
}

function rejectUntrusted(ctx, req) {
  if (callAllowed(req)) return undefined
  const connection = ctx.get?.('connection')
  if (connection !== undefined && typeof connection.requestRejection === 'function') {
    return connection.requestRejection({ headers: req.headers })
  }
  return 403
}

function modelOf(ctx) {
  const llm = ctx.get?.('llm')
  const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.()
  if (!llm || !sel || typeof llm.stream !== 'function') return null
  return { llm, provider: sel.provider, model: sel.model }
}

function bookSystem(book) {
  return [
    '你是读书台里的读书助手，和用户讨论他正在读的书。',
    book?.title ? `当前书：《${book.title}》${book.author ? ' · ' + book.author : ''}` : '',
    book?.theme ? `分类：${book.theme}` : '',
    '规则：用中文；回答控制在 200 字内；不要把没读过的内容说成书里原文；不编页码和引文；',
    '可以给一个具体可做的小建议（回去翻哪一章、记一条什么笔记）。',
    '直接给答案：不要复述任务要求，不要写「用户问…」「需要…」这类自我分析。',
  ].filter(Boolean).join('\n')
}

async function readJson(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) return null
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return null }
}

async function aiChat(ctx, req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { errmsg: 'method not allowed' })
  const model = modelOf(ctx)
  if (model === null) return sendJson(res, 503, { errmsg: 'AI 未配置：宿主里没有可用的 llm 服务或默认模型' })

  const body = await readJson(req, 64 * 1024)
  if (body === null) return sendJson(res, 400, { errmsg: '请求格式不对' })
  const question = String(body.question || '').slice(0, 2000)
  if (!question) return sendJson(res, 400, { errmsg: '问题为空' })
  const history = Array.isArray(body.history) ? body.history.slice(-6) : []
  const transcript = history
    .map(m => (m.who === 'me' ? '用户：' : '助手：') + String(m.text || '').slice(0, 600))
    .join('\n')

  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  })

  let raw = '', opened = false, sent = 0, closed = false
  let emitted = false
  const push = (text) => { if (text.length > sent) { res.write(text.slice(sent)); sent = text.length; emitted = true } }

  try {
    const stream = model.llm.stream({
      provider: model.provider,
      model: model.model,
      system: bookSystem(body.book) + '\n把最终回答放在 <final> 与 </final> 之间；标记之外不要输出任何文字。',
      messages: [{ role: 'user', content: [{ type: 'text', text: (transcript ? transcript + '\n' : '') + '用户：' + question }] }],
    })
    for await (const chunk of stream) {
      const text = chunk?.text ?? chunk?.delta ?? ''
      if (typeof text === 'string' && text !== '') {
        raw += text
        if (!opened) {
          const at = raw.indexOf('<final>')
          if (at >= 0) { opened = true; raw = raw.slice(at + 7); sent = 0; push(raw) }
        } else if (!closed) {
          const end = raw.indexOf('</final>')
          if (end >= 0) { closed = true; push(raw.slice(0, end)) }
          else push(raw.slice(0, Math.max(0, raw.length - 8)))   // 末尾可能是半个闭合标记，先压住
        }
      }
      if (chunk?.type === 'finish' && chunk?.reason?.kind === 'error') { res.write('\n\n[模型返回错误]'); break }
    }
  } catch (error) {
    res.write('\n\n[AI 出错：' + String(error?.message ?? error).slice(0, 120) + ']')
  }
  if (opened) push(raw.split('</final')[0])
  if (!emitted) {
    const tail = String(raw || '').split(/\n+/).map(s => s.trim()).filter(Boolean).slice(-1)[0] || '（模型没有返回内容）'
    res.write(tail.replace(/<\/?final>/g, ''))
  }
  res.end()
}


/** 一次性收集模型输出（非流式路由共用），只取 <final> 里的内容。 */
async function collect(ctx, system, prompt) {
  const model = modelOf(ctx)
  if (model === null) return null
  let raw = ''
  try {
    const stream = model.llm.stream({
      provider: model.provider,
      model: model.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    })
    for await (const chunk of stream) {
      const piece = chunk?.text ?? chunk?.delta ?? ''
      if (typeof piece === 'string') raw += piece
      if (chunk?.type === 'finish' && chunk?.reason?.kind === 'error') break
    }
  } catch (error) {
    ctx.logger?.('dsh-reading-desk')?.warn?.('ai collect failed: ' + String(error?.message ?? error))
    return null
  }
  const all = [...raw.matchAll(/<final>([\s\S]*?)<\/final>/g)].map(m => m[1].trim()).filter(Boolean)
  if (all.length > 0) return all[all.length - 1]      // 模型可能先给草稿，取最后一个
  const opened = raw.includes('<final>') ? raw.split('<final>').pop() : raw
  const cleaned = opened.replace(/<\/?final>/g, '').trim()
  if (cleaned) return cleaned
  const lines = raw.split(/\n+/).map(s => s.trim()).filter(Boolean)
  return lines[lines.length - 1] || ''
}


/** 面板要显示的模型：可用时给出 provider/model，不可用时说明原因。 */
async function aiModel(ctx, res) {
  const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.()
  const llm = ctx.get?.('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    return sendJson(res, 200, { available: false, reason: '宿主没有 llm 服务' })
  }
  if (!sel || !sel.provider || !sel.model) {
    return sendJson(res, 200, { available: false, reason: '没有默认模型' })
  }
  return sendJson(res, 200, {
    available: true,
    provider: sel.provider,
    model: sel.model,
    reasoning: sel.reasoningEffort ?? null,
  })
}

async function aiCurator(ctx, req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { errmsg: 'method not allowed' })
  const body = await readJson(req, 32 * 1024)
  if (body === null) return sendJson(res, 400, { errmsg: '请求格式不对' })
  const cats = (body.cats || []).slice(0, 5).map(c => `${c.name} ${c.hours} 小时`).join('，')
  const titles = (body.titles || []).slice(0, 12).join('、')
  const text = await collect(
    ctx,
    '你是策展人，为一个月的阅读记录写展签。中文，克制，不写鸡汤，不用感叹号。',
    [
      `月份：${body.month || ''}，读完 ${body.done ?? '?'} 本，共 ${body.hours ?? '?'} 小时。`,
      cats ? `时间分布：${cats}。` : '',
      titles ? `读过的书：${titles}。` : '',
      '请给出：主题（6-10 字，具体，不空泛）与副标题（20-30 字，一句，能让人想读）。',
      '格式：主题｜副标题，整段放在 <final> 与 </final> 之间，不要别的文字。',
    ].filter(Boolean).join('\n'),
  )
  if (!text) return sendJson(res, 502, { errmsg: 'AI 不可用' })
  let [title, sub] = text.split(/[｜|]/).map(s => s.trim())
  if (!title) {
    const parts = text.split(/\n+/).map(s => s.trim()).filter(Boolean)
    title = (parts[0] || '').replace(/^主题[:：]?/, '').slice(0, 20)
    sub = (parts[1] || '').replace(/^副标题[:：]?/, '').slice(0, 60)
  }
  if (!title) return sendJson(res, 502, { errmsg: '格式不对' })
  return sendJson(res, 200, { title: title.slice(0, 20), sub: (sub || '').slice(0, 60) })
}

async function aiSummarize(ctx, req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { errmsg: 'method not allowed' })
  const body = await readJson(req, 64 * 1024)
  if (body === null) return sendJson(res, 400, { errmsg: '请求格式不对' })
  const book = body.book?.title ? `《${body.book.title}》` : '这本书'
  const msgs = (body.msgs || []).slice(-12)
    .map(m => (m.who === 'me' ? '用户：' : '助手：') + String(m.text || '').slice(0, 800))
    .join('\n')
  if (!msgs) return sendJson(res, 400, { errmsg: '没有可整理的内容' })
  const text = await collect(
    ctx,
    '你把一段读书讨论整理成一条读书笔记。中文，第一人称，只保留结论与可执行的动作，不要客套。',
    [`书：${book}`, '讨论：', msgs, '整理成 2-4 句，放在 <final> 与 </final> 之间。'].join('\n'),
  )
  if (!text) return sendJson(res, 502, { errmsg: 'AI 不可用' })
  return sendJson(res, 200, { text: text.slice(0, 600) })
}

async function aiOneLiner(ctx, req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { errmsg: 'method not allowed' })
  const model = modelOf(ctx)
  if (model === null) return sendJson(res, 503, { errmsg: 'AI 未配置' })
  const body = await readJson(req, 16 * 1024)
  if (body === null) return sendJson(res, 400, { errmsg: '请求格式不对' })
  const stats = body.stats ?? {}
  const prompt = [
    '根据这些阅读数据，写一句 20 字以内的吐槽式评语，像朋友调侃，不要鸡汤、不要夸人、不要感叹号。',
    `人格：${stats.name || '未知'}（${(stats.code || []).join('·') || '—'}）`,
    `今年翻过 ${stats.books ?? '?'} 本，日均 ${stats.daily ?? '?'} 小时，完读率 ${stats.rate ?? '?'}%`,
    `五维：${(stats.dims || []).map(d => `${d.k} ${d.v}`).join('，')}`,
    '把这一句放在 <final> 与 </final> 之间；标记之外不要输出任何文字。',
  ].join('\n')

  let raw = ''
  try {
    const stream = model.llm.stream({
      provider: model.provider,
      model: model.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    })
    for await (const chunk of stream) {
      const delta = chunk?.text ?? chunk?.delta ?? ''
      if (typeof delta === 'string') raw += delta
      if (chunk?.type === 'finish' && chunk?.reason?.kind === 'error') break
    }
  } catch (error) {
    return sendJson(res, 502, { errmsg: String(error?.message ?? error).slice(0, 160) })
  }

  // 1) 取最后一个闭合的 <final>；2) 只有开标记（被截断）时取开标记之后；3) 否则从草稿里挑最像答案的一句
  const closed = [...raw.matchAll(/<final>([\s\S]*?)<\/final>/g)].map(m => m[1].trim()).filter(Boolean)
  let text = ''
  if (closed.length > 0) text = closed[closed.length - 1]
  else if (raw.includes('<final>')) text = raw.split('<final>').pop().replace(/<\/?final>/g, '')
  else {
    const lines = raw.split(/\n+/).map(s => s.trim()).filter(Boolean)
    const draftish = /要求|用户|输出|规则|复述|字数|需要|数据|人格：|五维|写一句/
    const cand = lines.filter(s => !draftish.test(s) && s.length >= 6)
    text = cand.length > 0 ? cand[cand.length - 1] : ''
  }
  text = text.replace(/<\/?final>/g, '').replace(/^["“「]|["”」]$/g, '').trim()
  text = (text.split(/\n/)[0] || '').slice(0, 80)
  if (text.length < 4) return sendJson(res, 502, { errmsg: '模型没有给出可用的一句' })
  return sendJson(res, 200, { text })
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** Raw handler: `/api/*` sits behind the connection auth layer, this path does not. */

/** GET 返回是否已配置与掩码；POST 存 Key；DELETE 清除。 */
/** 笔记推送：flomo incoming webhook 与 得到大脑（Get 笔记）开放 API。 */

const FLOMO_PREFIX = 'https://flomoapp.com/iwh/'
const BIJI_SAVE = 'https://openapi.biji.com/open/api/v1/resource/note/save'

/** 读取 sync 相关配置（存在 config.json 的 extra 段）。 */
async function readSyncConfig() {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8')
    const v = JSON.parse(raw)
    return v.sync && typeof v.sync === 'object' ? v.sync : {}
  } catch {
    return {}
  }
}

/** 合并写入 sync 配置，保留 WeRead Key 等其它字段。 */
async function writeSyncConfig(patch) {
  let current = {}
  try { current = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) } catch { current = {} }
  const sync = { ...(current.sync || {}), ...patch }
  current.sync = sync
  await mkdir(STORE_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, JSON.stringify(current, null, 2), { mode: 0o600 })
  return sync
}

/** GET 返回各目标是否已配置（不回传原文）。 */
async function syncStatus(res) {
  const s = await readSyncConfig()
  const flomo = s.flomo || {}
  const getnote = s.getnote || {}
  return sendJson(res, 200, {
    flomo: { configured: FLOMO_PREFIX.startsWith((flomo.hook || '').slice(0, FLOMO_PREFIX.length)) && (flomo.hook || '').length > FLOMO_PREFIX.length },
    getnote: { configured: /^gk_/.test(getnote.token || '') && /^cli_/.test(getnote.client || '') },
  })
}

/** POST {target, title, content} → 推送到对应服务。 */
async function pushRoute(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { errmsg: 'method not allowed' })
  const body = await readJson(req, 32 * 1024)
  if (body === null) return sendJson(res, 400, { errmsg: '请求格式不对' })
  const content = String(body.content || '').trim()
  if (!content) return sendJson(res, 400, { errmsg: '内容为空' })
  const s = await readSyncConfig()

  if (body.target === 'flomo') {
    const hook = String((s.flomo || {}).hook || '')
    if (!hook.startsWith(FLOMO_PREFIX)) return sendJson(res, 400, { errmsg: '还没有配置 flomo webhook' })
    // 只允许 flomoapp.com，防 SSRF
    let parsed
    try { parsed = new URL(hook) } catch { return sendJson(res, 400, { errmsg: 'webhook 地址不合法' }) }
    if (parsed.hostname !== 'flomoapp.com') return sendJson(res, 400, { errmsg: 'webhook 必须是 flomoapp.com' })
    const r = await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    const text = (await r.text()).slice(0, 200)
    if (!r.ok) return sendJson(res, 502, { errmsg: `flomo 返回 ${r.status}`, detail: text })
    return sendJson(res, 200, { ok: true, detail: text })
  }

  if (body.target === 'getnotes') {
    const token = String((s.getnote || {}).token || '')
    const client = String((s.getnote || {}).client || '')
    if (!/^gk_/.test(token) || !/^cli_/.test(client)) {
      return sendJson(res, 400, { errmsg: '还没有配置 Get 笔记 的 Key 与 Client ID' })
    }
    const r = await fetch(BIJI_SAVE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: token,
        'X-Client-ID': client,
      },
      body: JSON.stringify({
        note_type: 'plain_text',
        title: String(body.title || '').slice(0, 120) || '读书台笔记',
        content,
      }),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || (typeof j.code === 'number' && j.code !== 0)) {
      return sendJson(res, 502, { errmsg: j.msg || j.message || `Get 笔记 返回 ${r.status}`, detail: JSON.stringify(j).slice(0, 200) })
    }
    return sendJson(res, 200, { ok: true, noteId: j.data && (j.data.note_id || j.data.id) || null })
  }

  return sendJson(res, 400, { errmsg: '未知的同步目标' })
}

/** POST {flomo?:{hook}, getnote?:{token,client}} → 保存并返回状态。 */
async function syncConfigRoute(req, res) {
  if (req.method === 'GET') return syncStatus(res)
  if (req.method !== 'POST') return sendJson(res, 405, { errmsg: 'method not allowed' })
  const body = await readJson(req, 8 * 1024)
  if (body === null) return sendJson(res, 400, { errmsg: '请求格式不对' })
  const patch = {}
  if (body.flomo && typeof body.flomo === 'object') {
    const hook = String(body.flomo.hook || '').trim()
    if (hook && !hook.startsWith(FLOMO_PREFIX)) return sendJson(res, 400, { errmsg: 'flomo webhook 必须以 https://flomoapp.com/iwh/ 开头' })
    patch.flomo = { hook }
  }
  if (body.getnote && typeof body.getnote === 'object') {
    const token = String(body.getnote.token || '').trim()
    const client = String(body.getnote.client || '').trim()
    if (token && !/^gk_/.test(token)) return sendJson(res, 400, { errmsg: 'Get 笔记 API Key 应以 gk_ 开头' })
    if (client && !/^cli_/.test(client)) return sendJson(res, 400, { errmsg: 'Get 笔记 Client ID 应以 cli_ 开头' })
    patch.getnote = { token, client }
  }
  await writeSyncConfig(patch)
  return syncStatus(res)
}

async function configRoute(req, res) {
  if (req.method === 'GET') {
    const key = await readStoredKey()
    return sendJson(res, 200, { configured: key !== '', masked: maskKey(key) })
  }
  if (req.method === 'POST') {
    const body = await readJson(req, 4096)
    if (body === null) return sendJson(res, 400, { errmsg: '请求格式不对' })
    const key = String(body.key || '').trim()
    if (!KEY_RE.test(key)) return sendJson(res, 400, { errmsg: 'API Key 格式不对' })
    await writeStoredKey(key)
    return sendJson(res, 200, { configured: true, masked: maskKey(key) })
  }
  if (req.method === 'DELETE') {
    await clearStoredKey()
    return sendJson(res, 200, { configured: false, masked: '' })
  }
  return sendJson(res, 405, { errmsg: 'method not allowed' })
}

async function proxyHandler(req, res) {
  const send = (status, value) => {
    const body = Buffer.from(JSON.stringify(value), 'utf8')
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }
  if (req.method !== 'POST') return send(405, { errmsg: 'method not allowed' })
  const origin = req.headers.origin
  if (origin !== undefined && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    return send(403, { errmsg: 'forbidden' })
  }
  let auth = req.headers.authorization ?? ''
  if (!/^Bearer wrk-[A-Za-z0-9_-]{6,}$/.test(auth)) {
    // 浏览器没带 Key 时用宿主保存的（插件形态下 Key 不下发到页面）
    const stored = await readStoredKey()
    if (stored === '') return send(401, { errmsg: '还没有配置 API Key' })
    auth = 'Bearer ' + stored
  }

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 4096) return send(413, { errmsg: '请求太大' })
    chunks.push(chunk)
  }
  let payload
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return send(400, { errmsg: '请求格式不对' }) }
  if (!payload || !ALLOWED.has(payload.api_name)) return send(400, { errmsg: '不支持的接口' })

  const upstream = await fetch(GATEWAY, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: Buffer.concat(chunks),
  })
  const bytes = Buffer.from(await upstream.arrayBuffer())
  res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(bytes)
}
