/**
 * Graph transport — the official Meta Instagram API.
 *
 * What this path needs, and what it will not do:
 *
 *   · an Instagram **Creator/Business** account, a Meta app with
 *     `instagram_manage_messages` (DMs) and `instagram_content_publish` (posts),
 *     a public HTTPS webhook, and App Review for anything beyond your testers;
 *   · it will NOT log in with a password, will NOT scrape, and will NOT retry
 *     into a rate limit. Every failure carries a code and a next step.
 *
 * Endpoints used:
 *   POST /{ig-user-id}/messages        { recipient:{id}, message:{text} }
 *   POST /{ig-user-id}/media           { image_url, caption }  → creation id
 *   POST /{ig-user-id}/media_publish   { creation_id }
 *   POST /{comment-id}/replies         { message }
 */

import { TransportError } from './index.js'

export function createGraphTransport({ config, store, logger, media, fetchImpl = globalThis.fetch }) {
  const { accessToken, igUserId, apiVersion } = config.graph
  const root = `https://graph.facebook.com/${apiVersion}`

  async function call(method, path, { query = {}, body } = {}) {
    if (!accessToken) {
      throw new TransportError('graph.accessToken is empty', {
        code: 'IG_NO_TOKEN',
        hint: '設定 graph.accessToken（Meta App 的 long-lived token），或先用 transport: dryrun',
      })
    }
    const url = new URL(path.startsWith('http') ? path : `${root}/${String(path).replace(/^\/+/, '')}`)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
    url.searchParams.set('access_token', accessToken)

    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (error) {
      throw new TransportError(`Graph network error: ${error?.message ?? error}`, {
        code: 'IG_NETWORK',
        hint: '檢查網絡／代理；Graph API 需要外網 HTTPS',
      })
    }

    let payload = {}
    try {
      payload = await response.json()
    } catch {
      payload = {}
    }
    if (response.ok) return payload

    const error = payload?.error ?? {}
    const code = Number(error.code ?? response.status)
    const message = String(error.message ?? `HTTP ${response.status}`)
    if ([190, 102, 463, 467].includes(code)) {
      throw new TransportError(`Graph token invalid or expired: ${message}`, {
        code: 'IG_TOKEN_INVALID',
        status: response.status,
        hint: '到 Meta App 重新產生 long-lived token，然後更新 graph.accessToken',
      })
    }
    if ([4, 17, 32, 613, 80004].includes(code)) {
      throw new TransportError(`Graph rate limit: ${message}`, {
        code: 'IG_RATE_LIMIT',
        status: response.status,
        hint: '降頻：調高 limits.replyCooldownSeconds、調低 limits.dmPerDay，然後等幾小時',
      })
    }
    throw new TransportError(`Graph error ${code}: ${message}`, {
      code: 'IG_GRAPH_ERROR',
      status: response.status,
      hint: '看 Graph API 回傳的 error.subcode；權限不足通常是 App Review 未過',
    })
  }

  return {
    name: 'graph',

    async sendDm({ text, threadId, userId, username }) {
      if (!igUserId) {
        throw new TransportError('graph.igUserId is empty', {
          code: 'IG_NO_IG_USER_ID',
          hint: '填 graph.igUserId（IG 專業帳號的 id），或先用 transport: dryrun',
        })
      }
      const recipient = userId ?? threadId
      if (!recipient) {
        throw new TransportError(`cannot resolve an IGSID for @${username ?? 'unknown'}`, {
          code: 'IG_NO_RECIPIENT',
          hint: 'Graph API 只接受 IGSID；對方必須先私訊你一次，我們才會由 webhook 學到佢嘅 id',
        })
      }
      const result = await call('POST', `${igUserId}/messages`, {
        body: { recipient: { id: String(recipient) }, message: { text } },
      })
      await store?.append('outbox.jsonl', {
        at: new Date().toISOString(),
        kind: 'dm',
        transport: 'graph',
        threadId: threadId ?? null,
        to: username ?? recipient,
        text,
        id: result.message_id ?? '',
      })
      return { id: String(result.message_id ?? '') }
    },

    async postPhoto({ caption, imageUrl }) {
      if (!imageUrl) {
        throw new TransportError('posting needs a public image URL', {
          code: 'IG_NO_IMAGE_URL',
          hint: 'Instagram 只接受公開 HTTPS 圖片：設定 graph.publicBaseUrl，並讓 DSH 對外服務該檔案',
        })
      }
      if (!igUserId) {
        throw new TransportError('graph.igUserId is empty', { code: 'IG_NO_IG_USER_ID' })
      }
      const created = await call('POST', `${igUserId}/media`, { body: { image_url: imageUrl, caption } })
      const creationId = created.id
      if (!creationId) {
        throw new TransportError('media container was not created', { code: 'IG_MEDIA_CONTAINER' })
      }
      // A container is not instant forever: give Instagram a moment, then publish.
      await new Promise((resolve) => setTimeout(resolve, 3000))
      const published = await call('POST', `${igUserId}/media_publish`, { body: { creation_id: creationId } })
      await store?.append('outbox.jsonl', {
        at: new Date().toISOString(),
        kind: 'post',
        transport: 'graph',
        caption,
        imageUrl,
        id: published.id ?? '',
      })
      return { mediaId: String(published.id ?? ''), permalink: '' }
    },

    async replyComment({ commentId, text }) {
      if (!commentId) {
        throw new TransportError('commentId is required', { code: 'IG_NO_COMMENT_ID' })
      }
      const result = await call('POST', `${commentId}/replies`, { body: { message: text } })
      return { id: String(result.id ?? '') }
    },

    /**
     * Send an image or an audio clip as a DM attachment.
     *
     * The Instagram messaging API has no upload endpoint: the attachment must be
     * a URL Meta can fetch. So the file is staged into our public media folder
     * first, and the failure is explicit when `graph.publicBaseUrl` is missing.
     *
     * Text is sent as a separate message afterwards — `message` carries either
     * text or an attachment, not both.
     */
    async sendAttachment({ type, file, text = '', threadId, userId, username }) {
      if (!media) {
        throw new TransportError('this transport was built without a media helper', { code: 'IG_NO_MEDIA_HELPER' })
      }
      if (!['image', 'audio', 'video', 'file'].includes(type)) {
        throw new TransportError(`unsupported attachment type "${type}"`, { code: 'IG_BAD_ATTACHMENT_TYPE' })
      }
      const recipient = userId ?? threadId
      if (!recipient) {
        throw new TransportError(`cannot resolve an IGSID for @${username ?? 'unknown'}`, {
          code: 'IG_NO_RECIPIENT',
          hint: '對方要先私訊你一次，我們才會由 webhook 得到佢嘅 IGSID',
        })
      }
      const staged = await media.stage(file)
      if (!staged.ok) {
        throw new TransportError(staged.error, { code: staged.code, hint: staged.hint })
      }
      const sent = await call('POST', `${igUserId}/messages`, {
        body: { recipient: { id: String(recipient) }, message: { attachment: { type, payload: { url: staged.url } } } },
      })
      let textId = ''
      if (String(text ?? '').trim()) {
        const textResult = await call('POST', `${igUserId}/messages`, {
          body: { recipient: { id: String(recipient) }, message: { text: String(text).trim() } },
        })
        textId = String(textResult.message_id ?? '')
      }
      await store?.append('outbox.jsonl', {
        at: new Date().toISOString(),
        kind: type,
        transport: 'graph',
        threadId: threadId ?? null,
        to: username ?? recipient,
        url: staged.url,
        text: text || '',
        id: String(sent.message_id ?? ''),
      })
      return { id: String(sent.message_id ?? ''), textId, url: staged.url }
    },

    async sendImage(payload) {
      return this.sendAttachment({ ...payload, type: 'image' })
    },

    async sendAudio(payload) {
      return this.sendAttachment({ ...payload, type: 'audio' })
    },

    async health() {
      try {
        const me = await call('GET', igUserId || 'me', { query: { fields: 'id,username' } })
        return { backend: 'graph', ok: true, igUserId: me.id ?? igUserId, username: me.username ?? null }
      } catch (error) {
        return { backend: 'graph', ok: false, code: error?.code ?? 'IG_ERROR', error: error?.message ?? String(error) }
      }
    },

    async close() {},
    logger,
  }
}
