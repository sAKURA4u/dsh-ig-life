/**
 * Meta webhook: verification, signature checking, and event normalisation.
 *
 * No DSH types here on purpose — `createWebhookHandler` returns a plain
 * `(req, res)` handler, which is exactly what `ctx.webServer.register()` wants
 * and exactly what a node:test can call with fake objects.
 */

import crypto from 'node:crypto'

const MAX_BODY_BYTES = 1024 * 1024

/** Meta sends `x-hub-signature-256: sha256=<hex>`. */
export function verifyMetaSignature(rawBody, header, appSecret) {
  if (!appSecret) return false
  const provided = String(header ?? '')
  if (!provided.startsWith('sha256=')) return false
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export async function readRequestBody(req, { limit = MAX_BODY_BYTES } = {}) {
  if (Buffer.isBuffer(req.body)) return req.body
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error(`request body too large (>${limit} bytes)`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** `https://www.instagram.com/reel/Cxyz123/` → `Cxyz123` */
export function shortcodeFromUrl(url) {
  const match = /(?:reels?|p|tv)\/([A-Za-z0-9_-]{5,})/.exec(String(url ?? ''))
  return match ? match[1] : ''
}

/**
 * Normalise one `attachments` array into what the bridge understands.
 * Instagram only documents image/video/audio/share for DMs; anything else is
 * kept as `type: <raw>` so the model can at least know something was there.
 */
export function parseAttachments(raw) {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((attachment) => {
    const type = String(attachment?.type ?? '').toLowerCase()
    const payload = attachment?.payload ?? {}
    const url = String(payload.url ?? payload.media_url ?? '')
    const mediaId = String(payload.media_id ?? payload.ig_media_id ?? payload.id ?? '')
    if (!type && !url) return []
    return [
      {
        type: type || 'unknown',
        url,
        mediaId,
        shortcode: shortcodeFromUrl(url),
        isShare: ['share', 'ig_reel', 'reel'].includes(type),
        isImage: type === 'image' || type === 'sticker' || type === 'emoji',
        isAudio: type === 'audio',
        isVideo: type === 'video',
      },
    ]
  })
}

/**
 * Normalise a Meta webhook payload into the shapes the bridge understands.
 * Unknown shapes are skipped rather than guessed at.
 * @returns {Array<{kind:'dm'|'comment', threadId:string, senderId:string, username:string,
 *   text:string, externalId:string, at:Date, mediaId:string, attachments:object[], replyTo:string}>}
 */
export function parseWebhookEvents(payload) {
  const events = []
  for (const entry of payload?.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      const message = messaging.message
      if (!message || message.is_echo || message.is_deleted) continue
      const senderId = String(messaging.sender?.id ?? '')
      const attachments = parseAttachments(message.attachments)
      events.push({
        kind: 'dm',
        threadId: String(message.thread_id ?? senderId),
        senderId,
        username: String(messaging.sender?.username ?? ''),
        text: String(message.text ?? (attachments.length ? '' : '')),
        externalId: String(message.mid ?? ''),
        at: new Date(Number(messaging.timestamp ?? Date.now())),
        mediaId: '',
        attachments,
        replyTo: String(message.reply_to?.mid ?? ''),
      })
    }
    for (const change of entry.changes ?? []) {
      const value = change?.value
      if (!value || !(change.field === 'comments' || change.field === 'live_comments')) continue
      const mediaId = String(value.media?.id ?? value.post_id ?? '')
      events.push({
        kind: 'comment',
        threadId: mediaId,
        senderId: String(value.from?.id ?? ''),
        username: String(value.from?.username ?? ''),
        text: String(value.text ?? ''),
        externalId: String(value.id ?? ''),
        at: new Date(Number(value.created_time ? Date.parse(value.created_time) : Date.now()) || Date.now()),
        mediaId,
        attachments: [],
        replyTo: String(value.parent_id ?? ''),
      })
    }
  }
  // A message that is only an attachment has no text; do not drop it.
  return events.filter((event) => event.externalId && (event.text || event.attachments.length))
}

/**
 * Build the HTTP handler.
 * @param {{config: object, onEvents: (events: object[]) => Promise<void>|void,
 *   logger?: Function, projectVersion?: string}} options
 */
export function createWebhookHandler({ config, onEvents, logger, projectVersion = '0.1.0' }) {
  return async function handleWebhook(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.statusCode = status
      res.setHeader('content-type', type)
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    }

    // 1. Meta's subscription handshake.
    if (req.method === 'GET') {
      const mode = url.searchParams.get('hub.mode')
      const token = url.searchParams.get('hub.verify_token')
      const challenge = url.searchParams.get('hub.challenge')
      if (mode === 'subscribe' && token && token === config.graph.verifyToken) {
        logger?.('info', '[ig-life] webhook verified by Meta')
        return send(200, challenge ?? '', 'text/plain; charset=utf-8')
      }
      return send(403, { ok: false, code: 'IG_WEBHOOK_VERIFY', error: 'verification failed', hint: 'graph.verifyToken 要和 Meta App 裡填的一致' })
    }

    if (req.method !== 'POST') {
      res.setHeader('allow', 'GET, POST')
      return send(405, { ok: false, code: 'IG_METHOD_NOT_ALLOWED', error: `method ${req.method} not allowed`, hint: 'Webhook 只有 GET(驗證) 和 POST(事件)' })
    }

    // 2. Read + authenticate the raw body before parsing anything.
    let raw
    try {
      raw = await readRequestBody(req)
    } catch (error) {
      return send(413, { ok: false, code: 'IG_BODY_TOO_LARGE', error: String(error?.message ?? error), hint: '正常 webhook 好細；大 body 通常唔係 Meta 發嘅' })
    }

    if (config.webhook.requireSignature) {
      const signature = req.headers?.['x-hub-signature-256'] ?? req.headers?.['X-Hub-Signature-256']
      if (!verifyMetaSignature(raw, signature, config.graph.appSecret)) {
        logger?.('warn', '[ig-life] rejected a webhook POST with a bad or missing signature')
        return send(403, {
          ok: false,
          code: 'IG_BAD_SIGNATURE',
          error: 'signature check failed',
          hint: 'graph.appSecret 必須係 Meta App 的 App Secret；本機測試可設 webhook.requireSignature: false',
        })
      }
    }

    // 3. Parse, hand off, answer fast — Meta retries on non-2xx.
    let payload
    try {
      payload = JSON.parse(raw.toString('utf8') || '{}')
    } catch {
      return send(400, { ok: false, code: 'IG_BAD_JSON', error: 'body is not JSON', hint: '檢查代理或中間件有冇改寫 body' })
    }

    const events = parseWebhookEvents(payload)
    if (events.length) {
      logger?.('info', `[ig-life] webhook: ${events.length} event(s) (v${projectVersion})`)
      try {
        await onEvents(events)
      } catch (error) {
        // Never 500: Meta would retry and we would double-send.
        logger?.('error', `[ig-life] webhook handler failed: ${error?.stack ?? error}`)
      }
    }
    return send(200, { ok: true, accepted: events.length })
  }
}
