/**
 * 看圖 / vision — an optional OpenAI-compatible vision endpoint.
 *
 * Used for three things: describing a reel's cover so the character can talk
 * about it, reading an image someone sent in a DM, and auto-annotating a
 * collected sticker. Everything is optional; with no endpoint configured the
 * character is told plainly that it cannot see the image.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

const PROMPT = `用兩三句描述呢張圖：畫面內容、有咩字、氣氛係點。如果係表情包，講清楚入面嘅情緒同可以用嚟回應咩情況。唔要評價好唔好，只描述。`

export function createVision({ config, store, logger, fetchImpl = globalThis.fetch }) {
  const state = { day: '', count: 0 }

  function consumeQuota(now = new Date()) {
    const day = now.toISOString().slice(0, 10)
    if (state.day !== day) {
      state.day = day
      state.count = 0
    }
    if (state.count >= config.vision.maxPerDay) return false
    state.count += 1
    return true
  }

  async function describe(source, { prompt = PROMPT, timeoutMs = 60_000 } = {}) {
    if (!config.vision.baseUrl) {
      return { ok: false, code: 'IG_NO_VISION', error: '沒有設定 vision 端點', hint: '設定 vision.baseUrl / apiKey / model，或者請對方用文字講' }
    }
    if (!consumeQuota()) {
      return { ok: false, code: 'IG_VISION_QUOTA', error: `今日看圖已達上限（${config.vision.maxPerDay}）`, hint: '調高 vision.maxPerDay' }
    }

    let dataUrl
    try {
      dataUrl = await toDataUrl(source, store)
    } catch (error) {
      return { ok: false, code: 'IG_VISION_SOURCE', error: `讀不到圖片：${error?.message ?? error}`, hint: '' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${config.vision.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.vision.apiKey ? { authorization: `Bearer ${config.vision.apiKey}` } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: config.vision.model || 'gpt-4o-mini',
          temperature: 0.2,
          max_tokens: 300,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200)
        return { ok: false, code: 'IG_VISION_FAILED', error: `vision 端點回應 ${response.status}: ${detail}`, hint: '檢查 vision.model' }
      }
      const payload = await response.json()
      const text = String(payload?.choices?.[0]?.message?.content ?? '').trim()
      if (!text) return { ok: false, code: 'IG_VISION_EMPTY', error: 'vision 沒有回內容', hint: '' }
      return { ok: true, text }
    } catch (error) {
      return { ok: false, code: 'IG_VISION_NETWORK', error: `vision 呼叫失敗：${error?.message ?? error}`, hint: '看不到就直接講看不到，不要編' }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    available: Boolean(config.vision.baseUrl),
    describe,
    stats: () => ({ available: Boolean(config.vision.baseUrl), usedToday: state.count, maxPerDay: config.vision.maxPerDay }),
  }
}

async function toDataUrl(source, store) {
  if (typeof source === 'string' && source.startsWith('data:')) return source
  if (typeof source === 'string' && /^https?:/i.test(source)) return source
  const file = typeof source === 'string' ? source : path.join(store.dir, 'tmp-image')
  const buffer = Buffer.isBuffer(source) ? source : await fsp.readFile(file)
  const ext = path.extname(file).toLowerCase().replace('.', '') || 'jpeg'
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
  return `data:${mime};base64,${buffer.toString('base64')}`
}
