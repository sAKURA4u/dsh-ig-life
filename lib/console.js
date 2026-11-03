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
      await fsp.mkdir(dir, { recursive: true })
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
export function createConsole({ bridge, life, stickers, slang, people, voice, memory, transport, logger }) {
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
