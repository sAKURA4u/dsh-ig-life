/**
 * 網頁控制台 / web console.
 *
 * A single self-contained page served by the plugin's own `webServer` routes, so
 * it needs no client bundle, no rebuild and no DSH frontend work: open
 * `/ig-life/console` in a browser and look at the creature.
 *
 * Why not a native settings section? That path requires a prebuilt client module
 * registered into the `settings.section` slot, and a mistake there takes the
 * whole GUI down rather than 404-ing. This page gets the same information across
 * with none of that blast radius.
 *
 * Only loopback requests may read or mutate anything: the web server layer has no
 * authentication, so the guard lives here.
 */

import { EDITABLE, TRANSPORTS, pickEditable, readOverlay, saveOverlay, settingsFilePath } from './settings.js'

const HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>dsh-ig-life · 控制台</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 ui-sans-serif, system-ui, "Segoe UI", "Microsoft JhengHei", sans-serif;
         background: #0d1017; color: #e6e9ef; }
  main { max-width: 880px; margin: 0 auto; padding: 28px 20px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8b93a7; margin: 0 0 24px; }
  .card { background: #141924; border: 1px solid #232b3a; border-radius: 12px; padding: 16px 18px; margin: 0 0 14px; }
  .card h2 { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: #8b93a7; margin: 0 0 12px; font-weight: 600; }
  .row { display: flex; justify-content: space-between; gap: 16px; padding: 3px 0; }
  .row span:last-child { color: #c7cede; font-variant-numeric: tabular-nums; }
  .bars { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 6px; }
  .bar { background: #1b2230; border-radius: 8px; padding: 10px; text-align: center; }
  .bar b { display: block; font-size: 20px; }
  .bar small { color: #8b93a7; }
  button { font: inherit; padding: 7px 14px; border-radius: 8px; cursor: pointer;
           border: 1px solid #2d3852; background: #1b2230; color: #e6e9ef; }
  button:hover { background: #232b3a; }
  button.primary { background: #2b4b8f; border-color: #35599f; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; white-space: pre-wrap; color: #9aa4b8; }
  footer { color: #5f6980; font-size: 12px; margin-top: 22px; }
</style>
</head>
<body>
<main>
  <h1>dsh-ig-life 控制台</h1>
  <p class="sub">把 DeepSeek 養進 Instagram · <span id="engine">—</span></p>

  <div class="card">
    <h2>狀態</h2>
    <div class="row"><span>身體</span><span id="transport">—</span></div>
    <div class="row"><span>是否暫停</span><span id="paused">—</span></div>
    <div class="row"><span>它現在</span><span id="life">—</span></div>
    <div class="row"><span>今日用量</span><span id="usage">—</span></div>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
      <button id="pause">暫停</button>
      <button id="resume">恢復</button>
      <button class="primary" id="tick">推進一次生命時鐘</button>
      <button id="refresh">重新整理</button>
    </div>
  </div>

  <div class="card">
    <h2>記憶分層</h2>
    <div class="bars" id="tiers"></div>
  </div>

  <div class="card">
    <h2>能力</h2>
    <div class="row"><span>語音</span><span id="voice">—</span></div>
    <div class="row"><span>表情包</span><span id="stickers">—</span></div>
    <div class="row"><span>Reels</span><span id="reels">—</span></div>
    <div class="row"><span>潮語</span><span id="slang">—</span></div>
    <div class="row"><span>認識的人</span><span id="people">—</span></div>
  </div>

  <div class="card">
    <h2>最近發生什麼</h2>
    <div class="mono" id="log">載入中…</div>
  </div>

  <footer>只接受本機（loopback）請求。資料來自 ~/.dsh/ig-life。</footer>
</main>
<script>
const $ = (id) => document.getElementById(id)
const set = (id, value) => { $(id).textContent = value }

async function call(path, method = 'GET') {
  const response = await fetch(path, { method })
  return response.json()
}

function render(data) {
  set('engine', '引擎 ' + (data.engine ?? '—'))
  set('transport', (data.transport?.backend ?? '—') + (data.transport?.ok ? '' : ' (不可用)'))
  set('paused', data.paused ? '是' : '否')
  set('life', data.life ?? '（生命循環未啟動）')
  const usage = data.usageToday ?? {}
  set('usage', 'DM ' + (usage.dm ?? 0) + ' · 帖 ' + (usage.post ?? 0) + ' · 留言 ' + (usage.comment ?? 0))
  const tiers = data.memory?.tiers ?? {}
  $('tiers').innerHTML = [
    ['錨點', tiers.anchor], ['重要', tiers.important], ['眼前', tiers.recent], ['模糊', tiers.fading],
  ].map(([label, n]) => '<div class="bar"><b>' + (n ?? 0) + '</b><small>' + label + '</small></div>').join('')
  const voice = data.voice
  set('voice', voice ? (voice.enabled ? '開 · 今日 ' + voice.sentToday + '/' + voice.perDay : '關') : '未啟用')
  const stickers = data.stickers
  set('stickers', stickers ? stickers.total + ' 張' : '—')
  set('reels', data.reels?.enabled ? '開 · 呢個鐘 ' + data.reels.callsThisHour + '/' + data.reels.perHour : '關')
  const slang = data.slang
  set('slang', slang ? '已收 ' + slang.approved + ' · 待批 ' + slang.pending : '—')
  const people = data.people
  set('people', people ? people.total + ' 人（' + people.withImpression + ' 有印象）' : '—')
  $('log').textContent = JSON.stringify(data.recent ?? data, null, 2).slice(0, 2000)
}

async function refresh() {
  try { render(await call('./api/status')) } catch (error) { set('log', '載入失敗：' + error.message) }
}

$('pause').onclick = async () => { await call('./api/pause', 'POST'); refresh() }
$('resume').onclick = async () => { await call('./api/resume', 'POST'); refresh() }
$('tick').onclick = async () => { const result = await call('./api/tick', 'POST'); refresh(); console.log(result) }
$('refresh').onclick = refresh
refresh()
setInterval(refresh, 15000)
</script>
</body>
</html>`

/**
 * Write a Windows Internet Shortcut to the console, so the human never has to
 * know which port this boot landed on. The desktop app has no address bar and
 * the port drifts on every restart, so a desktop shortcut is the whole point.
 *
 * @returns {Promise<string[]>} the files written
 */
export async function writeConsoleShortcuts({ port, dirs, logger }) {
  if (!port) return []
  const fsp = await import('node:fs/promises')
  const path = await import('node:path')
  const body = `[InternetShortcut]\r\nURL=http://127.0.0.1:${port}/ig-life/console\r\n`
  const written = []
  for (const dir of dirs.filter(Boolean)) {
    const file = path.join(dir, 'ig-life-console.url')
    try {
      await fsp.access(dir) // do not invent directories
      await fsp.writeFile(file, body, 'utf8')
      written.push(file)
    } catch (error) {
      logger?.('debug', `[ig-life] could not write the console shortcut in ${dir}: ${error?.message ?? error}`)
    }
  }
  return written
}

function isLoopback(req) {
  const address = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? ''
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)
}

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * Build the console routes.
 * @returns {{kind: 'exact'|'prefix', path: string, handler: Function}[]}
 */
export function createConsole({ bridge, life, stickers, slang, people, voice, memory, transport, config, dataDir = '', logger, getAccount = null }) {
  /**
   * The account is an unofficial-transport concern, but it must be settable
   * before switching: someone filling the page starts on dryrun. So the account
   * client is resolved independently of the active transport.
   */
  async function accountClient() {
    if (typeof getAccount === 'function') return getAccount()
    return transport
  }

  async function status() {
    const base = bridge.status()
    return {
      ...base,
      transport: await transport.health(),
      recent: bridge.recentInbox(8).map((item) => ({
        at: item.at,
        from: '@' + item.username,
        text: String(item.text ?? '').slice(0, 120),
        handled: Boolean(item.handled),
      })),
      memory: memory.stats(),
      stickers: stickers?.stats() ?? null,
      voice: voice?.stats() ?? null,
      slang: slang?.stats() ?? null,
      people: people?.stats() ?? null,
    }
  }

  const guard = (req, res) => {
    if (isLoopback(req)) return true
    logger?.('warn', '[ig-life] console request refused from a non-loopback address')
    json(res, 403, { ok: false, code: 'IG_CONSOLE_LOCAL_ONLY', error: '只接受本機請求', hint: '用 127.0.0.1 開這個頁' })
    return false
  }

  async function readJsonBody(req) {
    const { readRequestBody } = await import('./webhook.js')
    const raw = await readRequestBody(req)
    try {
      return JSON.parse(raw.toString('utf8') || '{}')
    } catch {
      return null
    }
  }

  /**
   * A state-changing POST must come from this page. Loopback alone is not
   * enough: any local process can reach 127.0.0.1, and a page on another origin
   * must not be able to drive this through the browser. `Origin` plus
   * `Sec-Fetch-Site` are what a browser actually sends.
   */
  const sameOrigin = (req) => {
    const site = String(req.headers?.['sec-fetch-site'] ?? '')
    if (site && !['same-origin', 'none'].includes(site)) return false
    const origin = String(req.headers?.origin ?? '')
    if (!origin) return true
    try {
      return new URL(origin).host === String(req.headers?.host ?? '')
    } catch {
      return false
    }
  }

  return [
    {
      kind: 'exact',
      path: '/ig-life/console',
      handler: (req, res) => {
        if (!guard(req, res)) return
        res.statusCode = 200
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(HTML)
      },
    },
    {
      kind: 'exact',
      path: '/ig-life/console/api/settings',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method === 'GET') {
          json(res, 200, {
            ok: true,
            // What is running right now (already merged with the saved layer).
            effective: config ? pickEditable(config) : null,
            // What the file says, so the page can tell "saved but not applied yet".
            saved: readOverlay(dataDir),
            transports: [...TRANSPORTS],
            editable: [...EDITABLE],
            settingsFile: settingsFilePath(dataDir),
          })
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('allow', 'GET, POST')
          json(res, 405, { ok: false, code: 'IG_METHOD_NOT_ALLOWED', error: `${req.method} 不支援` })
          return
        }
        if (!sameOrigin(req)) {
          json(res, 403, { ok: false, code: 'IG_CONSOLE_ORIGIN', error: '只接受同源請求' })
          return
        }
        const body = await readJsonBody(req)
        if (body === null) {
          json(res, 400, { ok: false, code: 'IG_BAD_JSON', error: 'body 不是合法 JSON' })
          return
        }
        const result = saveOverlay(dataDir, body)
        if (!result.ok) {
          json(res, 400, { ok: false, code: 'IG_SETTINGS_INVALID', error: result.errors.join('；'), errors: result.errors })
          return
        }
        logger?.('info', `[ig-life] settings saved: ${result.changed.join(', ') || '(no change)'}`)
        json(res, 200, {
          ok: true,
          saved: result.saved,
          changed: result.changed,
          warnings: result.warnings,
          restartRequired: result.changed.length > 0,
          note: '設定已寫入 <dataDir>/settings.json；重啟 DSH 之後才會生效。',
        })
      },
    },
    {
      kind: 'exact',
      path: '/ig-life/console/api/account',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        let client = null
        let unavailable = null
        try {
          client = await accountClient()
        } catch (error) {
          unavailable = { code: error?.code ?? 'IG_ACCOUNT_UNAVAILABLE', error: error?.message ?? String(error) }
        }
        const supported = Boolean(client && typeof client.credentials === 'function' && typeof client.saveCredentials === 'function')
        const configuredTransport = config?.transport ?? null

        if (req.method === 'GET') {
          let account = null
          let health = null
          if (supported) {
            try {
              account = await client.credentials()
            } catch (error) {
              account = { ok: false, code: error?.code ?? 'IG_ACCOUNT_UNAVAILABLE', error: error?.message ?? String(error) }
            }
            try {
              health = await client.health()
            } catch (error) {
              health = { ok: false, error: String(error?.message ?? error) }
            }
          }
          json(res, 200, { ok: true, supported, configuredTransport, account, health, unavailable })
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('allow', 'GET, POST')
          json(res, 405, { ok: false, code: 'IG_METHOD_NOT_ALLOWED', error: `${req.method} 不支援` })
          return
        }
        if (!sameOrigin(req)) {
          json(res, 403, { ok: false, code: 'IG_CONSOLE_ORIGIN', error: '只接受同源請求' })
          return
        }
        if (!supported) {
          json(res, 400, {
            ok: false,
            code: 'IG_TRANSPORT_NO_ACCOUNT',
            error: '沒有可用的 sidecar 帳號客戶端',
            hint: '帳密只會存去 unofficial 的 sidecar；檢查 unofficial.baseUrl 是否正確',
          })
          return
        }
        const body = await readJsonBody(req)
        if (body === null) {
          json(res, 400, { ok: false, code: 'IG_BAD_JSON', error: 'body 不是合法 JSON' })
          return
        }
        try {
          const saved = await client.saveCredentials({ username: body.username, password: body.password })
          let login = null
          if (body.login === true && typeof client.login === 'function') login = await client.login()
          const health = await client.health().catch(() => null)
          json(res, 200, {
            ok: true,
            account: { ...saved, loggedIn: login?.loggedIn ?? null, session: login?.session ?? null },
            health,
            configuredTransport,
            note: login
              ? login?.loggedIn
                ? '已登入。之後啟動 sidecar 會自動重用 session，唔需要再登入。'
                : '帳密已儲存，但未登入成功；看 health 的錯誤碼。'
              : '帳密已儲存。按「儲存並登入」立即試一次。',
          })
        } catch (error) {
          const status = Number(error?.status) >= 400 ? Number(error.status) : 400
          json(res, status, {
            ok: false,
            code: error?.code ?? 'IG_CREDENTIALS_FAILED',
            error: error?.message ?? String(error),
            hint: error?.hint ?? '',
          })
        }
      },
    },
    {
      kind: 'exact',
      path: '/ig-life/console/api/status',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          json(res, 200, await status())
        } catch (error) {
          json(res, 500, { ok: false, code: 'IG_CONSOLE_STATUS', error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/ig-life/console/api/pause',
      handler: (req, res) => {
        if (!guard(req, res)) return
        bridge.paused = true
        if (life) life.state.paused = true
        void life?.save?.()
        json(res, 200, { ok: true, paused: true })
      },
    },
    {
      kind: 'exact',
      path: '/ig-life/console/api/resume',
      handler: (req, res) => {
        if (!guard(req, res)) return
        bridge.paused = false
        if (life) life.state.paused = false
        void life?.save?.()
        json(res, 200, { ok: true, paused: false })
      },
    },
    {
      kind: 'exact',
      path: '/ig-life/console/api/tick',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          json(res, 200, life ? await life.tick() : { ok: false, code: 'IG_NO_LIFE', error: '生命循環未啟動' })
        } catch (error) {
          json(res, 500, { ok: false, code: 'IG_CONSOLE_TICK', error: String(error?.message ?? error) })
        }
      },
    },
  ]
}
