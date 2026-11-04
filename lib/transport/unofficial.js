/**
 * Unofficial transport — a personal Instagram account, through a local sidecar.
 *
 * Why this file is only an HTTP client:
 *
 *   · the private API needs a password and a real session cookie. Neither may
 *     ever enter this process, its config, its logs or a prompt — so they live
 *     in `src/ig_bridge.py`, which runs on the same machine, listens only on
 *     127.0.0.1 and demands a shared token;
 *   · that sidecar owns everything account-risky: session reuse, the private
 *     API's own signing, and the pace at which Instagram is touched.
 *
 * What this layer still owns (belt and braces — the gate above is not enough,
 * because `life.js` sends proactive messages without going through it):
 *
 *   · a hard daily ceiling on messages and posts;
 *   · a minimum gap between outbound messages;
 *   · no such thing as "retry into a rate limit": every failure is an error
 *     with a code and a next step.
 *
 * ⚠️ Using this violates Instagram's terms. The account can be banned. Use a
 * throwaway account. See docs/UNOFFICIAL.md.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { dayKey } from '../gate.js'
import { parseAttachments } from '../webhook.js'
import { TransportError } from './index.js'

const TOKEN_FILE = 'sidecar-token'
const USAGE_FILE = 'unofficial-usage.json'
const DELIVERED_MEMORY = 800

/**
 * The shared secret for the localhost API, from the first place that has one:
 * config, environment, then the file the sidecar provisions itself.
 */
export function resolveSidecarToken(config, store) {
  const fromConfig = String(config?.unofficial?.token ?? '').trim()
  if (fromConfig) return fromConfig
  const fromEnv = String(globalThis.process?.env?.IG_LIFE_SIDECAR_TOKEN ?? '').trim()
  if (fromEnv) return fromEnv
  try {
    return fs.readFileSync(path.join(store.dir, TOKEN_FILE), 'utf8').trim()
  } catch {
    /* not provisioned yet — the 401 will explain what to do */
    return ''
  }
}

export function createUnofficialTransport({
  config,
  store,
  logger,
  media = null,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const settings = config.unofficial
  const baseUrl = String(settings.baseUrl).replace(/\/+$/, '')

  let cachedToken = null
  let usage = null
  let queue = Promise.resolve()

  /** Deliveries already handed to the bridge, so a replayed cursor cannot double-ingest. */
  const delivered = new Set()

  // ---------------------------------------------------------------- plumbing
  /** Serialise the read-modify-write of the usage file across concurrent tool calls. */
  function withLock(work) {
    const run = queue.then(() => work())
    queue = run.catch(() => {})
    return run
  }

  /**
   * The sidecar generates `<dataDir>/sidecar-token` on first start. Reading the
   * same file means the two processes share a secret without a copy-paste step.
   * Exported because the supervisor needs it before any transport exists.
   */
  function resolveToken() {
    if (cachedToken !== null) return cachedToken
    cachedToken = resolveSidecarToken(config, store)
    return cachedToken
  }

  function mapFailure(status, payload) {
    const code = String(payload?.code ?? '') || 'IG_SIDECAR_ERROR'
    const message = String(payload?.error ?? payload?.message ?? `sidecar HTTP ${status}`)
    let hint = String(payload?.hint ?? '')
    if (status === 401 && code !== 'IG_SIDECAR_TOKEN_INVALID') {
      hint ||= '重新登入：python src/ig_bridge.py --login（會先重用 session，唔會亂 login）'
    }
    if (status === 429 && !hint) {
      hint = '降頻：調高 unofficial.pollSeconds / sendGapSeconds，或者等幾小時'
    }
    return new TransportError(message, { code, hint, status })
  }

  async function call(method, route, { body, timeout } = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timeoutMs = timeout ?? settings.requestTimeoutSeconds * 1000
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    const token = resolveToken()
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (token) headers['x-ig-life-token'] = token

    let response
    try {
      response = await fetchImpl(`${baseUrl}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal,
      })
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new TransportError(`sidecar 超過 ${Math.round(timeoutMs / 1000)} 秒沒有回應`, {
          code: 'IG_SIDECAR_TIMEOUT',
          hint: 'sidecar 可能卡在登入／IG 風控；看它的終端輸出，再重啟',
        })
      }
      const cause = String(error?.cause?.code ?? error?.code ?? '')
      if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|EACCES/.test(cause) || /fetch failed/i.test(String(error?.message ?? ''))) {
        throw new TransportError(`連不上 sidecar：${baseUrl}`, {
          code: 'IG_SIDECAR_DOWN',
          hint: `先啟動 sidecar：python src/ig_bridge.py --serve（預設 ${baseUrl}）；細節見 docs/UNOFFICIAL.md`,
        })
      }
      throw new TransportError(`sidecar 網絡錯誤：${error?.message ?? error}`, {
        code: 'IG_SIDECAR_NETWORK',
        hint: 'sidecar 只應該喺 127.0.0.1；檢查 unofficial.baseUrl',
      })
    } finally {
      if (timer) clearTimeout(timer)
    }

    let payload = {}
    try {
      const text = await response.text()
      payload = text ? JSON.parse(text) : {}
    } catch {
      payload = {}
    }
    if (response.ok && payload?.ok !== false) return payload
    throw mapFailure(response.status, payload)
  }

  // ------------------------------------------------------------------- limits
  async function loadUsage() {
    if (usage) return usage
    const saved = await store.read(USAGE_FILE, null)
    usage = {
      day: String(saved?.day ?? ''),
      sent: Math.max(0, Number(saved?.sent ?? 0) || 0),
      post: Math.max(0, Number(saved?.post ?? 0) || 0),
      lastAt: Math.max(0, Number(saved?.lastAt ?? 0) || 0),
    }
    return usage
  }

  /**
   * Reserve one outbound slot.
   *
   * Attempts are counted, not successes: a request that timed out may still
   * have been delivered, and this ceiling exists to survive exactly that kind
   * of uncertainty. Nothing here can be raised above `sendPerDay` / `postPerDay`.
   */
  async function guardOutbound(kind) {
    return withLock(async () => {
      const state = await loadUsage()
      const today = dayKey(new Date(now()))
      if (state.day !== today) {
        state.day = today
        state.sent = 0
        state.post = 0
      }
      if (kind === 'post') {
        if (state.post >= settings.postPerDay) {
          throw new TransportError(`今日已發 ${state.post} 篇帖（非官方帳號上限 ${settings.postPerDay}）`, {
            code: 'IG_UNOFFICIAL_CAP',
            hint: '調高 unofficial.postPerDay 有風險；IG 對新帳號突然活躍很敏感',
          })
        }
      } else if (state.sent >= settings.sendPerDay) {
        throw new TransportError(`今日已發 ${state.sent} 則訊息（非官方帳號上限 ${settings.sendPerDay}）`, {
          code: 'IG_UNOFFICIAL_CAP',
          hint: '非官方帳號最忌密集發訊；等明日，或調高 unofficial.sendPerDay（風險自負）',
        })
      }
      if (kind !== 'post' && state.lastAt) {
        const gap = settings.sendGapSeconds * 1000
        const waited = now() - state.lastAt
        if (gap > 0 && waited >= 0 && waited < gap) {
          const remaining = gap - waited
          logger?.('debug', `[ig-life:unofficial] pacing ${Math.round(remaining / 1000)}s before the next message`)
          await sleep(remaining)
        }
      }
      state.lastAt = now()
      if (kind === 'post') state.post += 1
      else state.sent += 1
      await store.write(USAGE_FILE, state)
    })
  }

  // ------------------------------------------------------------------ helpers
  async function existingFile(candidate, { code, hint }) {
    const full = path.resolve(String(candidate ?? ''))
    try {
      const stat = await fsp.stat(full)
      if (stat.isFile()) return full
    } catch {
      /* fall through to the structured error */
    }
    throw new TransportError(`檔案找不到：${candidate}`, { code, hint })
  }

  /**
   * A post needs a local file, not a public URL — which is one genuine
   * advantage of this transport. We still accept the URLs the rest of the
   * project hands us: our own `/ig-life/media/<file>` maps straight onto disk,
   * anything else is downloaded first.
   */
  async function resolveLocalImage({ imagePath, imageUrl }) {
    if (String(imagePath ?? '').trim()) {
      return existingFile(imagePath, {
        code: 'IG_MEDIA_NOT_FOUND',
        hint: 'imagePath 要指向本機的 jpg/png',
      })
    }
    const url = String(imageUrl ?? '').trim()
    if (!url) {
      throw new TransportError('發帖需要一張圖', {
        code: 'IG_NO_IMAGE',
        hint: '給 imagePath（本機檔案），或把圖放進 <dataDir>/media 並設定 graph.publicBaseUrl',
      })
    }
    const prefix = config.graph.publicBaseUrl ? `${config.graph.publicBaseUrl}/ig-life/media/` : ''
    if (prefix && url.startsWith(prefix)) {
      const name = path.basename(decodeURIComponent(url.slice(prefix.length).split('?')[0]))
      return existingFile(path.join(store.dir, 'media', name), {
        code: 'IG_MEDIA_NOT_FOUND',
        hint: `把圖片放進 ${path.join(store.dir, 'media')}，再發一次`,
      })
    }
    if (!media) {
      throw new TransportError('this transport was built without a media helper', { code: 'IG_NO_MEDIA_HELPER' })
    }
    const saved = await media.saveRemoteImage(url, { prefix: 'post' })
    if (!saved.ok) throw new TransportError(saved.error, { code: saved.code, hint: saved.hint })
    return saved.path
  }

  function remember(id) {
    delivered.add(id)
    if (delivered.size > DELIVERED_MEMORY) {
      const iterator = delivered.values()
      for (let index = 0; index < 200; index += 1) {
        const next = iterator.next()
        if (next.done) break
        delivered.delete(next.value)
      }
    }
  }

  // ------------------------------------------------------------------ transport
  return {
    name: 'unofficial',
    /** The bridge learns about inbound DMs by polling this, not from a webhook. */
    pollsInbound: true,

    async sendDm({ text, threadId, userId, username }) {
      const clean = String(text ?? '').trim()
      if (!clean) throw new TransportError('empty message', { code: 'IG_EMPTY_MESSAGE', hint: '寫點東西再發' })
      await guardOutbound('dm')
      const result = await call('POST', '/send', {
        body: { text: clean, threadId, userId, username },
      })
      await store.append('outbox.jsonl', {
        at: new Date().toISOString(),
        kind: 'dm',
        transport: 'unofficial',
        threadId: threadId ?? result?.threadId ?? null,
        to: username ?? result?.username ?? threadId ?? 'unknown',
        text: clean,
        id: String(result?.id ?? ''),
      })
      return { id: String(result?.id ?? ''), threadId: result?.threadId ?? threadId ?? null }
    },

    async sendAttachment({ type, file, text = '', threadId, userId, username }) {
      if (!['image', 'audio', 'video', 'file'].includes(type)) {
        throw new TransportError(`unsupported attachment type "${type}"`, { code: 'IG_BAD_ATTACHMENT_TYPE' })
      }
      const full = await existingFile(file, {
        code: 'IG_MEDIA_NOT_FOUND',
        hint: '附件要先落成本機檔案（語音／表情包本來就在 <dataDir>）',
      })
      await guardOutbound('media')
      const sent = await call('POST', '/send_media', {
        body: { path: full, type, text: String(text ?? '').trim() || undefined, threadId, userId, username },
      })
      const payload = {
        at: new Date().toISOString(),
        kind: type,
        transport: 'unofficial',
        threadId: threadId ?? sent?.threadId ?? null,
        to: username ?? threadId ?? 'unknown',
        path: full,
        text: text ? String(text).trim() : '',
        id: String(sent?.id ?? ''),
      }
      await store.append('outbox.jsonl', payload)
      return { id: String(sent?.id ?? ''), textId: String(sent?.textId ?? ''), mode: String(sent?.mode ?? type) }
    },

    async sendImage(payload) {
      return this.sendAttachment({ ...payload, type: 'image' })
    },

    async sendAudio(payload) {
      return this.sendAttachment({ ...payload, type: 'audio' })
    },

    async postPhoto({ caption, imageUrl, imagePath }) {
      const clean = String(caption ?? '').trim()
      if (!clean) throw new TransportError('empty caption', { code: 'IG_EMPTY_CAPTION' })
      const localPath = await resolveLocalImage({ imagePath, imageUrl })
      await guardOutbound('post')
      const result = await call('POST', '/post', {
        body: { caption: clean, imagePath: localPath },
        // Uploading a photo is slower than a DM; give it room.
        timeout: Math.max(settings.requestTimeoutSeconds, 90) * 1000,
      })
      await store.append('outbox.jsonl', {
        at: new Date().toISOString(),
        kind: 'post',
        transport: 'unofficial',
        caption: clean,
        imagePath: localPath,
        id: String(result?.mediaId ?? ''),
      })
      return { mediaId: String(result?.mediaId ?? ''), permalink: String(result?.permalink ?? '') }
    },

    async postStory({ imageUrl, imagePath, caption }) {
      const localPath = await resolveLocalImage({ imagePath, imageUrl })
      await guardOutbound('post')
      const result = await call('POST', '/story', {
        body: { imagePath: localPath, caption: String(caption ?? '').trim() },
        timeout: Math.max(settings.requestTimeoutSeconds, 90) * 1000,
      })
      await store.append('outbox.jsonl', {
        at: new Date().toISOString(),
        kind: 'story',
        transport: 'unofficial',
        caption: String(caption ?? '').trim(),
        imagePath: localPath,
        id: String(result?.mediaId ?? ''),
      })
      return { mediaId: String(result?.mediaId ?? ''), permalink: String(result?.permalink ?? '') }
    },

    /** Edit the character's own profile. IG caps the bio at 150 characters. */
    async updateProfile({ name, biography, photoPath }) {
      const body = {}
      if (name !== undefined && name !== null) body.name = String(name)
      if (biography !== undefined && biography !== null) body.biography = String(biography).slice(0, 150)
      if (photoPath) {
        body.photoPath = await existingFile(photoPath, {
          code: 'IG_MEDIA_NOT_FOUND',
          hint: '頭像要是本機 jpg/png',
        })
      }
      if (!body.name && !body.biography && !body.photoPath) {
        throw new TransportError('沒有要改的東西', { code: 'IG_EMPTY_PROFILE', hint: '給 name、biography 或 photoPath' })
      }
      const result = await call('POST', '/profile', { body, timeout: Math.max(settings.requestTimeoutSeconds, 90) * 1000 })
      return { ok: true, name: result?.name ?? null, biography: result?.biography ?? null, avatar: Boolean(result?.avatar) }
    },

    async replyComment({ commentId, mediaId, text }) {
      const clean = String(text ?? '').trim()
      if (!clean) throw new TransportError('empty reply', { code: 'IG_EMPTY_MESSAGE', hint: '' })
      if (!commentId) throw new TransportError('commentId is required', { code: 'IG_NO_COMMENT_ID' })
      if (!mediaId) {
        throw new TransportError('非官方 transport 回覆留言需要 mediaId', {
          code: 'IG_COMMENT_NEEDS_MEDIA',
          hint: '私有 API 要 media_id 才回得到；unofficial 模式收不到留言事件，所以只有你手上有 media id 時才用得到',
        })
      }
      const result = await call('POST', '/reply_comment', { body: { commentId, mediaId, text: clean } })
      return { id: String(result?.id ?? '') }
    },

    /**
     * Drain new inbound DMs.
     * @returns {Promise<object[]>} events in exactly the shape the webhook
     *   normaliser produces, so `bridge.ingest()` needs no special case.
     */
    async poll() {
      const payload = await call('GET', '/messages', { timeout: Math.max(20, settings.requestTimeoutSeconds) * 1000 })
      const events = []
      for (const raw of Array.isArray(payload?.messages) ? payload.messages : []) {
        const id = String(raw?.id ?? '').trim()
        if (!id) continue
        if (raw?.isEcho || raw?.fromMe) continue
        if (delivered.has(id)) continue
        const attachments = parseAttachments(raw?.attachments)
        const text = String(raw?.text ?? '')
        if (!text.trim() && !attachments.length) continue

        const at = raw?.at ? new Date(raw.at) : new Date()
        const senderId = String(raw?.senderId ?? raw?.userId ?? '')
        remember(id)
        events.push({
          kind: 'dm',
          threadId: String(raw?.threadId ?? senderId ?? ''),
          senderId,
          username: String(raw?.username ?? ''),
          text,
          externalId: id,
          at: Number.isNaN(at.getTime()) ? new Date() : at,
          mediaId: '',
          attachments,
          replyTo: String(raw?.replyTo ?? ''),
        })
      }
      if (payload?.throttled) logger?.('debug', '[ig-life:unofficial] poll throttled by the sidecar')
      return events
    },

    async health() {
      try {
        const result = await call('GET', '/health', { timeout: Math.min(10_000, settings.requestTimeoutSeconds * 1000) })
        return {
          backend: 'unofficial',
          ok: result?.ok !== false && result?.loggedIn !== false,
          baseUrl,
          username: result?.username ?? null,
          userId: result?.userId ?? null,
          session: result?.session ?? null,
          loggedIn: result?.loggedIn ?? null,
          needsLogin: Boolean(result?.needsLogin),
          hint: result?.hint ?? '',
          sentToday: result?.sentToday ?? null,
          postToday: result?.postToday ?? null,
          pollSeconds: result?.pollSeconds ?? settings.pollSeconds,
        }
      } catch (error) {
        return {
          backend: 'unofficial',
          ok: false,
          baseUrl,
          code: error?.code ?? 'IG_ERROR',
          error: error?.message ?? String(error),
          hint: error?.hint ?? '',
        }
      }
    },

    /**
     * The account section: does a password exist, and which username?
     * The sidecar never returns the password itself, and this client never
     * asks for it.
     */
    async credentials() {
      const result = await call('GET', '/credentials', { timeout: Math.min(10_000, settings.requestTimeoutSeconds * 1000) })
      return {
        ok: true,
        hasCredentials: Boolean(result?.hasCredentials),
        hasPassword: Boolean(result?.hasPassword),
        hasSessionid: Boolean(result?.hasSessionid),
        username: result?.username ?? null,
        file: result?.file ?? null,
      }
    },

    /**
     * Store the account in the sidecar's 0600 file.
     *
     * Two ways in: a password, or an already-logged-in `sessionid` cookie.
     * Instagram no longer serves the password-encryption key instagrapi needs,
     * so the sessionid is the reliable one right now. Either secret passes
     * through this process on its way to the only process allowed to keep it:
     * never logged, never written here, never echoed back. Empty means "keep
     * the stored one".
     */
    async saveCredentials({ username, password, sessionid }) {
      const cleanUser = String(username ?? '').trim().replace(/^@+/, '')
      const cleanSid = String(sessionid ?? '').trim()
      if (!cleanUser && !cleanSid) {
        throw new TransportError('username 不能空白', {
          code: 'IG_NO_CREDENTIALS',
          hint: '填小號的 IG 使用者名稱（不用 @），或者直接給 sessionid',
        })
      }
      const result = await call('POST', '/credentials', {
        body: { username: cleanUser, password: String(password ?? ''), sessionid: cleanSid },
      })
      return {
        ok: true,
        username: result?.username ?? cleanUser,
        hasCredentials: true,
        hasPassword: Boolean(result?.hasPassword),
        hasSessionid: Boolean(result?.hasSessionid),
      }
    },

    /** Caption/type/cover for one post or reel (the Graph token is not needed). */
    async mediaInfo(mediaId) {
      const id = String(mediaId ?? '').trim()
      if (!id) {
        throw new TransportError('mediaId 不能空白', { code: 'IG_NO_MEDIA_ID', hint: '對方分享 reel 過來時會帶 mediaId' })
      }
      const result = await call('GET', `/media?mediaId=${encodeURIComponent(id)}`)
      return result?.media ?? null
    },

    async follow({ username, action = 'follow' }) {
      const handle = String(username ?? '').trim().replace(/^@+/, '')
      if (!handle) throw new TransportError('要一個 username', { code: 'IG_NO_USERNAME' })
      const result = await call('POST', '/follow', { body: { username: handle, action } })
      return { ok: Boolean(result?.ok), username: result?.username ?? handle, action: result?.action ?? action }
    },

    async followRequests() {
      const result = await call('GET', '/follow-requests')
      return { ok: true, requests: Array.isArray(result?.requests) ? result.requests : [] }
    },

    async followRequest({ username, action = 'approve' }) {
      const handle = String(username ?? '').trim().replace(/^@+/, '')
      if (!handle) throw new TransportError('要一個 username', { code: 'IG_NO_USERNAME' })
      const result = await call('POST', '/follow-request', { body: { username: handle, action } })
      return { ok: Boolean(result?.ok), username: result?.username ?? handle, action: result?.action ?? action }
    },

    /** Open a conversation with somebody by username. */
    async dmUser({ username, text }) {
      const handle = String(username ?? '').trim().replace(/^@+/, '')
      const body = String(text ?? '').trim()
      if (!handle) throw new TransportError('要一個 username', { code: 'IG_NO_USERNAME' })
      if (!body) throw new TransportError('空訊息', { code: 'IG_EMPTY_MESSAGE' })
      const result = await call('POST', '/dm-user', { body: { username: handle, text: body }, timeout: Math.max(settings.requestTimeoutSeconds, 60) * 1000 })
      return { ok: true, username: result?.username ?? handle, threadId: result?.threadId ?? '', messageId: result?.messageId ?? '' }
    },

    /** Name, bio, avatar and private/public for the account itself. */
    async updateAccount({ name, biography, photoPath, privacy }) {
      const body = {}
      if (name !== undefined && name !== null) body.name = String(name)
      if (biography !== undefined && biography !== null) body.biography = String(biography).slice(0, 150)
      if (photoPath) body.photoPath = await existingFile(photoPath, { code: 'IG_MEDIA_NOT_FOUND', hint: '頭像要是本機 jpg/png' })
      if (privacy === 'private' || privacy === 'public') body.privacy = privacy
      if (!Object.keys(body).length) {
        throw new TransportError('沒有要改的東西', { code: 'IG_EMPTY_ACCOUNT', hint: '給 name、biography、photoPath 或 privacy' })
      }
      const result = await call('POST', '/account', { body, timeout: Math.max(settings.requestTimeoutSeconds, 90) * 1000 })
      return { ok: true, name: result?.name ?? null, biography: result?.biography ?? null, avatar: Boolean(result?.avatar), privacy: result?.privacy ?? null }
    },

    /** Log in now (session first, password only if the session is gone). */
    async login() {
      const result = await call('POST', '/login', { timeout: Math.max(60, settings.requestTimeoutSeconds) * 1000 })
      return { ok: result?.ok !== false, loggedIn: result?.loggedIn ?? null, username: result?.username ?? null, session: result?.session ?? null }
    },

    async close() {
      /* HTTP only: nothing to tear down, no timer of our own. */
    },

    logger,
  }
}
