/**
 * dsh-ig-life — 把 DeepSeek 養進 Instagram。
 *
 * A DSH bundle with one row. What it does, in the order it matters:
 *
 *   1. gives an agent an Instagram body  (webhook in → DSH turn → ig_send_dm out)
 *   2. gives it a plastic memory         (anchors / important / recent / fading)
 *   3. gives it a daily rhythm           (energy, mood, proactive messages, posts)
 *   4. never lets volume become a ban    (allowlist, quiet hours, daily caps)
 *
 * Design constraints that shaped this file:
 *   · `inject` is only ['timer'] — every other service is read with ctx.get(),
 *     because an inactive row aborts the DSH boot audit;
 *   · nothing throws out of apply(): a channel that fails should report itself,
 *     not take the harness down;
 *   · every registration is an effect, so unmount leaves no residue.
 */

import { resolveConfig, describeConfig } from './config.js'
import { MemoryBook } from './book.js'
import { Bridge } from './bridge.js'
import { Life } from './life.js'
import { createLlmBridge } from './llm.js'
import { createConsole } from './console.js'
import { createMedia } from './media.js'
import { People } from './people.js'
import { createReels } from './reels.js'
import { Lexicon } from './slang.js'
import { StickerLibrary } from './stickers.js'
import { createVision } from './vision.js'
import { Voice } from './voice.js'
import { loadPersona, resolvePersonaDir } from './persona.js'
import { JsonStore, pluginDataDir } from './store.js'
import { createTransport } from './transport/index.js'
import { createWebhookHandler } from './webhook.js'
import { registerIgTools } from './tools.js'

/** Loader / diagnostic name. Keep it equal to the row id in cordis.patch.yml. */
export const name = 'ig-life'

/**
 * Only `timer` is a hard dependency: it is mounted by dsh-base in every
 * profile. `tools`, `agents`, `sessions`, `llm`, `systemPrompt`, `webServer` are
 * all optional and probed at runtime.
 */
export const inject = ['timer']

/** Marker so a reader can tell at a glance this plugin has no config schema. */
export const configSchema = null

/**
 * The most recently mounted handle — for tests and console debugging.
 *
 * `apply()` must never *return* it: a Cordis fiber rejects any non-function,
 * non-nullable plugin return value with `TypeError: Invalid effect`, which
 * aborts the whole profile boot.
 */
let currentInstance = null
export function instance() {
  return currentInstance
}

/**
 * Mount and hand back the handle. For tests, console debugging and scripts only —
 * the loader itself must call `apply`, because a fiber rejects a returned object.
 */
export async function mount(ctx, rawConfig = {}) {
  await apply(ctx, rawConfig)
  return currentInstance
}

export async function apply(ctx, rawConfig = {}) {
  currentInstance = null
  const logger = makeLogger(ctx)
  const { config, warnings } = resolveConfig(rawConfig)
  for (const warning of warnings) logger('warn', `[ig-life] config: ${warning}`)

  if (!config.enabled) {
    logger('info', '[ig-life] disabled by config; nothing mounted')
    return
  }

  const store = await new JsonStore(pluginDataDir(config.dataDir), { logger }).init()
  const persona = await loadPersona(resolvePersonaDir(config.personaPath))
  if (persona.missing.length) logger('warn', `[ig-life] persona incomplete: ${persona.missing.join(', ')}`)

  const memory = await new MemoryBook({ store, config, logger, persona }).load()

  // Capability layer. Every one of these is optional and degrades quietly; the
  // character can always fall back to plain typing.
  const media = createMedia({ config, store, logger })
  const vision = createVision({ config, store, logger })
  const stickers = await new StickerLibrary({ store, config, logger }).load()
  const voice = new Voice({ config, store, logger })
  await voice.loadPack()
  const reels = createReels({ config, store, logger, vision, media })
  const slang = await new Lexicon({ store, config, logger }).load()
  const people = await new People({ store, config, logger }).load()

  const transport = await createTransport({ config, store, logger, media })
  const llmBridge = await createLlmBridge({ ctx, logger })
  const life = await new Life({ ctx, config, store, memory, transport, llmBridge, persona, logger }).load()
  const bridge = await new Bridge({
    ctx,
    config,
    store,
    memory,
    transport,
    llmBridge,
    persona,
    life,
    logger,
    stickers,
    voice,
    reels,
    slang,
    people,
    vision,
    media,
  }).start()

  // The life loop must not try to start a conversation outside Instagram's reply
  // window: the API would reject it, and a "failed to reach out" every five
  // minutes is noise, not personality.
  life.reachOutGate = () => {
    const threadId = bridge.recentInbox(1)[0]?.threadId ?? store.kvOwnerThread ?? null
    if (!threadId) return { open: false, reason: '未有對話記錄（對方要先私訊你一次）' }
    return bridge.messagingWindow(threadId)
  }

  // ── tools (best effort) ────────────────────────────────────────────────────
  const capabilities = {
    voice: Boolean(voice.available),
    stickers: stickers.size > 0 || config.stickers.enabled,
    reels: config.reels.enabled,
    slang: config.slang.enabled,
    people: config.people.enabled,
    vision: vision.available,
  }
  bridge.capabilities = capabilities
  const toolReport = await registerIgTools({ ctx, config, bridge, life, memory, transport, logger })

  // ── webhook (only when a web server exists in this profile) ────────────────
  const webServer = ctx.get('webServer')
  let webhookMounted = false
  if (webServer && typeof webServer.register === 'function' && config.webhook.enabled) {
    const handler = createWebhookHandler({
      config,
      logger,
      onEvents: (events) => bridge.ingest(events),
    })
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: config.webhook.path,
          handler: (req, res) =>
            Promise.resolve(handler(req, res)).catch((error) => {
              logger('error', `[ig-life] webhook crashed: ${error?.stack ?? error}`)
              try {
                res.statusCode = 500
                res.end(JSON.stringify({ ok: false, code: 'IG_WEBHOOK_CRASH', error: String(error?.message ?? error) }))
              } catch {}
            }),
        }),
      'ig-life.webhook()',
    )
    // The human-facing console: one page, no client bundle, no rebuild.
    for (const route of createConsole({ bridge, life, stickers, slang, people, voice, memory, transport, logger })) {
      ctx.effect(
        () =>
          webServer.register({
            kind: route.kind,
            path: route.path,
            handler: (req, res) =>
              Promise.resolve(route.handler(req, res)).catch((error) => {
                logger('error', `[ig-life] console route ${route.path} crashed: ${error?.stack ?? error}`)
                try {
                  res.statusCode = 500
                  res.end(JSON.stringify({ ok: false, code: 'IG_CONSOLE_CRASH', error: String(error?.message ?? error) }))
                } catch {}
              }),
          }),
        `ig-life.console(${route.path})`,
      )
    }

    ctx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: '/ig-life/media',
          handler: (req, res) => serveMedia({ req, res, dir: store.path('media'), logger }),
        }),
      'ig-life.media()',
    )
    webhookMounted = true
  } else if (config.transport === 'graph') {
    logger('warn', '[ig-life] transport=graph but no webServer in this profile — inbound DMs will never arrive')
  }

  // ── the life tick ──────────────────────────────────────────────────────────
  let tickTimer = null
  if (config.life.enabled && typeof ctx.interval !== 'function') {
    logger('warn', '[ig-life] life.enabled but ctx.interval is unavailable; the tick will not start')
  } else if (config.life.enabled) {
    const intervalMs = Math.max(20, config.life.tickSeconds) * 1000
    ctx.effect(
      () => {
        const dispose = ctx.interval(() => {
          life
            .tick()
            .then((report) => {
              const bits = [`tick`]
              if (report.events?.length) bits.push(`events=${report.events.join('/')}`)
              if (report.proactive) bits.push('proactive=yes')
              if (report.post) bits.push('posted')
              if (report.thought) bits.push('thought')
              if (report.consolidation) bits.push(`consolidated ${report.consolidation.before}→${report.consolidation.after}`)
              if (report.skipped?.length) bits.push(`skipped=${report.skipped.join('; ')}`)
              if (report.errors?.length) bits.push(`errors=${report.errors.join('; ')}`)
              logger('debug', `[ig-life] ${bits.join(' | ')}`)
            })
            .catch((error) => logger('error', `[ig-life] tick failed: ${error?.stack ?? error}`))
        }, intervalMs)
        tickTimer = dispose
        return () => {
          tickTimer = null
          if (typeof dispose === 'function') dispose()
        }
      },
      'ig-life.tick()',
    )
  }

  // ── teardown ───────────────────────────────────────────────────────────────
  ctx.effect(
    () => async () => {
      if (typeof tickTimer === 'function') {
        try {
          tickTimer()
        } catch {}
      }
      await bridge.close()
      await transport.close?.()
      await life.save().catch(() => {})
    },
    'ig-life.teardown()',
  )

  logger(
    'info',
    `[ig-life] ready · transport=${config.transport} · engine=${bridge.engine} · tools=${toolReport.registered.length} · webhook=${webhookMounted ? config.webhook.path : 'off'} · life=${config.life.enabled ? `${config.life.tickSeconds}s` : 'off'} · memory=${memory.size}`,
  )
  logger('debug', `[ig-life] config: ${JSON.stringify(describeConfig(config))}`)

  // Keep the debug handle OFF the return channel: returning it makes the Cordis
  // fiber throw `TypeError: Invalid effect` and takes the whole profile down.
  currentInstance = {
    name,
    config,
    store,
    persona,
    memory,
    transport,
    life,
    bridge,
    stickers,
    voice,
    reels,
    slang,
    people,
    vision,
    media,
    tools: toolReport,
    capabilities,
    webhookPath: webhookMounted ? config.webhook.path : null,
  }
  return undefined
}

/**
 * Safe disposal for effects that own async resources.
 *
 * Cordis validates the value an effect *returns*: a plain function is a
 * disposer, `null`/`undefined` is fine, anything else is `Invalid effect`. An
 * `async` disposer is still a function, but awaiting it later is not something
 * the fiber does, so we return a sync wrapper that fires the async work and
 * swallows its rejection.
 */
function fireAndForget(work) {
  return () => {
    try {
      const result = work()
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch {
      /* teardown must never throw */
    }
  }
}

/** Serve `data/media/*` so the Graph API can fetch a public image URL. */
async function serveMedia({ req, res, dir, logger }) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const raw = decodeURIComponent(url.pathname.replace(/^\/ig-life\/media\/?/, ''))
  const file = raw.replace(/\\/g, '/').split('/').filter((part) => part && part !== '..').join('/')
  if (!file || !/\.(jpe?g|png)$/i.test(file)) {
    res.statusCode = 404
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, code: 'IG_MEDIA_NOT_FOUND', error: 'only .jpg/.jpeg/.png are served', hint: `把圖片放進 ${dir}` }))
    return
  }
  const fsp = await import('node:fs/promises')
  const path = await import('node:path')
  const full = path.join(dir, file)
  try {
    const buffer = await fsp.readFile(full)
    res.statusCode = 200
    res.setHeader('content-type', file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg')
    res.setHeader('cache-control', 'public, max-age=300')
    res.end(buffer)
  } catch (error) {
    logger('debug', `[ig-life] media miss ${file}: ${error?.message ?? error}`)
    res.statusCode = 404
    res.end(JSON.stringify({ ok: false, code: 'IG_MEDIA_NOT_FOUND', error: 'not found' }))
  }
}

/** Log through the host logger when it exists, otherwise console. */
function makeLogger(ctx) {
  let hostLogger = null
  try {
    if (typeof ctx?.logger === 'function') hostLogger = ctx.logger('ig-life')
  } catch {
    hostLogger = null
  }
  return (level, message) => {
    const method = level === 'debug' ? 'debug' : level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info'
    const fn = hostLogger?.[method] ?? hostLogger?.log
    if (typeof fn === 'function') {
      try {
        fn.call(hostLogger, message)
        return
      } catch {
        /* fall through to console */
      }
    }
    if (method === 'debug') return
    const consoleFn = method === 'error' ? console.error : method === 'warn' ? console.warn : console.log
    consoleFn(message)
  }
}
