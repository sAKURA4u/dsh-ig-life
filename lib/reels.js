/**
 * 睇 reel / 分享 reel —— "watch this, then talk about it".
 *
 * What the official API actually allows, and therefore what this does:
 *
 *   · **read** a media object you are allowed to see:
 *     `GET /{ig-media-id}?fields=caption,media_type,media_url,thumbnail_url,permalink,timestamp`
 *   · **look** at its cover: download `thumbnail_url`, then describe it with the
 *     vision endpoint, so the character can react to the picture and not only
 *     to the caption;
 *   · **send it on**: grab the cover, host it, send it as an image attachment,
 *     then send the permalink. There is no "share a reel" attachment type for
 *     Instagram, so a link plus a comment is the honest implementation.
 *
 * It cannot resolve a permalink to a media id (no public lookup by shortcode),
 * so if you only have a URL, sharing degrades to sending the link — and the
 * character is told to say so rather than pretend it watched it.
 */

const FIELDS = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,username'

export function createReels({ config, store, logger, fetchImpl = globalThis.fetch, vision, media }) {
  const calls = []

  function gate(now = new Date()) {
    if (!config.reels.enabled) return { ok: false, code: 'IG_REELS_DISABLED', error: '睇 reel 已關閉', hint: '設定 reels.enabled: true' }
    const cutoff = now.getTime() - 3_600_000
    while (calls.length && calls[0] < cutoff) calls.shift()
    if (calls.length >= config.reels.perHour) {
      return { ok: false, code: 'IG_REELS_RATE', error: `呢個鐘已經睇咗 ${calls.length} 條`, hint: `上限 ${config.reels.perHour}/小時` }
    }
    return { ok: true }
  }

  async function graphGet(mediaId) {
    const token = config.graph.accessToken
    if (!token) {
      return { ok: false, code: 'IG_NO_TOKEN', error: '沒有 graph.accessToken', hint: '睇 reel 需要 Graph API token' }
    }
    const url = new URL(`https://graph.facebook.com/${config.graph.apiVersion}/${encodeURIComponent(mediaId)}`)
    url.searchParams.set('fields', FIELDS)
    url.searchParams.set('access_token', token)
    let response
    try {
      response = await fetchImpl(url, { method: 'GET' })
    } catch (error) {
      return { ok: false, code: 'IG_NETWORK', error: `Graph 連不上：${error?.message ?? error}`, hint: '' }
    }
    const payload = await safeJson(response)
    if (!response.ok) {
      const code = Number(payload?.error?.code ?? response.status)
      const message = String(payload?.error?.message ?? `HTTP ${response.status}`)
      if ([190, 102].includes(code)) return { ok: false, code: 'IG_TOKEN_INVALID', error: `token 失效：${message}`, hint: '重新產生 long-lived token' }
      if ([4, 17, 32, 613].includes(code)) return { ok: false, code: 'IG_RATE_LIMIT', error: `被限流：${message}`, hint: '等一陣再試' }
      return {
        ok: false,
        code: 'IG_REEL_FETCH_FAILED',
        error: `拎唔到媒體資料：${message}`,
        hint: '只可以睇你有權限睇嘅貼文／reel（自己帳號或被分享過的）',
      }
    }
    return { ok: true, reel: normalise(payload) }
  }

  /** Metadata only. */
  async function fetchMeta(mediaId) {
    const gateResult = gate()
    if (!gateResult.ok) return gateResult
    if (!mediaId) return { ok: false, code: 'IG_NO_MEDIA_ID', error: '要有 mediaId 才可以睇', hint: '對方分享 reel 過來時 webhook 會帶 mediaId' }
    calls.push(Date.now())
    const result = await graphGet(String(mediaId))
    if (!result.ok) return result
    return { ok: true, reel: result.reel }
  }

  /**
   * Metadata + (if a vision endpoint exists) a description of the cover.
   * @returns {Promise<{ok: boolean, reel?: object, description?: string, noticed?: string}>}
   */
  async function watch(mediaId) {
    const meta = await fetchMeta(mediaId)
    if (!meta.ok) return meta
    const reel = meta.reel
    if (!vision?.available) {
      return { ok: true, reel, noticed: '（你只有文字資料，睇唔到畫面；唔好假裝睇過。）' }
    }
    const coverUrl = reel.thumbnailUrl || (reel.mediaType === 'IMAGE' ? reel.mediaUrl : '')
    if (!coverUrl) return { ok: true, reel, noticed: '（冇封面可以睇。）' }
    const saved = await media.saveRemoteImage(coverUrl, { prefix: `reel-${reel.id}`, dir: media.publicDir })
    if (!saved.ok) return { ok: true, reel, noticed: `（封面抓唔到：${saved.error}）` }
    const described = await vision.describe(saved.path, {
      prompt: '呢個係一條 Instagram reel 的封面。講：畫面發生咩事、有咩字、氣氛、你估係咩類型。兩三句就夠。',
    })
    if (!described.ok) return { ok: true, reel, noticed: `（睇唔到封面：${described.error}）` }
    return { ok: true, reel, description: described.text, coverPath: saved.path }
  }

  /**
   * Prepare to send a reel to somebody.
   *
   * Instagram renders an Instagram link inside a DM as a rich reel/post card by
   * itself, so the whole job is "send the link, plus whatever you wanted to say
   * about it". No Graph call, no token, no public image host needed.
   *
   * `reels.attachCover: true` additionally sends the cover as an image first —
   * only useful if you want the picture to be the message rather than a card.
   */
  async function prepareShare({ mediaId = '', permalink = '', comment = '' }) {
    if (!permalink && !mediaId) {
      return { ok: false, code: 'IG_NO_MEDIA_ID', error: '要有 mediaId 或 permalink', hint: '' }
    }

    // Link-only fast path: nothing to fetch.
    if (permalink && !attachCoverEnabled()) {
      return { ok: true, text: [comment, permalink].filter(Boolean).join('\n'), coverPath: null, note: '' }
    }

    const meta = mediaId ? await fetchMeta(mediaId) : { ok: false, error: '只有連結' }
    const reel = meta.ok ? meta.reel : null
    const link = permalink || reel?.permalink || ''
    const text = [comment, link || mediaId].filter(Boolean).join('\n')
    if (!attachCoverEnabled()) {
      return { ok: true, text, coverPath: null, reel, note: '' }
    }
    const coverUrl = reel?.thumbnailUrl || ''
    if (!coverUrl) {
      return { ok: true, text, coverPath: null, reel, note: '冇封面可以傳，只傳連結。' }
    }
    const saved = await media.saveRemoteImage(coverUrl, { prefix: `share-${reel.id}`, dir: media.publicDir })
    return { ok: true, text, coverPath: saved.ok ? saved.path : null, reel, note: saved.ok ? '' : '封面抓唔到，只傳連結。' }
  }

  function attachCoverEnabled() {
    return Boolean(config.reels.attachCover)
  }

  return {
    enabled: config.reels.enabled,
    gate,
    fetchMeta,
    watch,
    prepareShare,
    stats: () => ({ enabled: config.reels.enabled, callsThisHour: calls.length, perHour: config.reels.perHour }),
  }
}

function normalise(payload) {
  return {
    id: String(payload.id ?? ''),
    caption: String(payload.caption ?? ''),
    mediaType: String(payload.media_type ?? ''),
    mediaUrl: String(payload.media_url ?? ''),
    thumbnailUrl: String(payload.thumbnail_url ?? ''),
    permalink: String(payload.permalink ?? ''),
    username: String(payload.username ?? ''),
    timestamp: String(payload.timestamp ?? ''),
    likeCount: Number(payload.like_count ?? 0),
    commentsCount: Number(payload.comments_count ?? 0),
  }
}

async function safeJson(response) {
  try {
    return await response.json()
  } catch {
    return {}
  }
}
