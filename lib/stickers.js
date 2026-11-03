/**
 * 表情包 / 貼圖圖庫 —— the Instagram version of a sticker collection.
 *
 * Instagram has no sticker API, so a "sticker" here is just an image the
 * character owns: collected from a DM someone sent, or dropped into the media
 * folder by you. It is indexed with an emotion, a description and free keywords
 * so it can be retrieved by meaning later ("something to answer being scolded").
 *
 * Retrieval is the same dependency-free lexical scoring used for memory: CJK
 * character bigrams + Latin words, IDF weighted, plus an emotion bonus and a
 * penalty for repeating what was used recently. That last part matters — a
 * person does not send the same sticker four times in a row.
 */

import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { tokenize } from './memory.js'

export const EMOTIONS = Object.freeze([
  '開心',
  '委屈',
  '無語',
  '嘲諷',
  '撒嬌',
  '擺爛',
  '鼓勵',
  '驚訝',
  '心痛',
  '尷尬',
  '唔理你',
  '認真',
])

/** Cheap, format-agnostic sniff so we never store a HTML error page as a sticker. */
export function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buffer.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif'
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return null
}

export function sniffAudio(buffer) {
  if (!buffer || buffer.length < 4) return null
  if (buffer.subarray(0, 3).toString('latin1') === 'ID3') return 'mp3'
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'mp3'
  if (buffer.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg'
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') return 'm4a'
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WAVE') return 'wav'
  return null
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

const DOCUMENT = 'stickers.json'

/**
 * Sticker annotations are injected into every thread's prompt, so they are a
 * cross-conversation text channel. Anything a stranger could influence gets
 * flattened to one line, stripped of control/zero-width characters, and capped.
 */
export function sanitizeLabel(value, max = 120) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export class StickerLibrary {
  constructor({ store, config, logger }) {
    this.store = store
    this.config = config
    this.logger = logger ?? (() => {})
    this.items = []
    /** `#NN` numbers are identity and gaps are never reused. */
    this.nextNo = 1
    this.dir = path.join(store.dir, 'stickers')
  }

  async load() {
    const saved = await this.store.read(DOCUMENT, null)
    if (saved && Array.isArray(saved.items)) this.items = saved.items
    const highest = this.items.reduce((max, item) => Math.max(max, Number(item.no ?? 0)), 0)
    this.nextNo = Math.max(Number(saved?.nextNo ?? 1), highest + 1, 1)
    return this
  }

  async save() {
    await this.store.write(DOCUMENT, { version: 1, nextNo: this.nextNo, items: this.items })
  }

  get size() {
    return this.items.length
  }

  /**
   * Save an image into the library. Rejects anything that is not really an
   * image, anything too large, and exact duplicates (by content hash).
   */
  async collect({ buffer, emotion = '', content = '', keywords = [], from = '', source = 'dm' }) {
    const limits = this.config.stickers
    const format = sniffImage(buffer)
    if (!format) {
      return { ok: false, code: 'IG_NOT_AN_IMAGE', error: '這個位元組流不是圖片', hint: '只接受 jpg/png/gif/webp' }
    }
    if (buffer.length > limits.maxBytes) {
      return { ok: false, code: 'IG_STICKER_TOO_BIG', error: `圖片 ${buffer.length} bytes 超過上限`, hint: `調高 stickers.maxBytes（目前 ${limits.maxBytes}）` }
    }
    const hash = sha256(buffer)
    const existing = this.items.find((item) => item.hash === hash)
    if (existing) return { ok: true, id: existing.id, duplicate: true }

    if (this.items.length >= limits.maxItems) {
      return { ok: false, code: 'IG_STICKER_LIBRARY_FULL', error: `圖庫已有 ${this.items.length} 張`, hint: '刪掉一些，或調高 stickers.maxItems' }
    }

    await fsp.mkdir(this.dir, { recursive: true })
    const no = this.nextNo
    this.nextNo += 1
    const id = `s${String(no).padStart(2, '0')}`
    const file = `${id}.${format}`
    await fsp.writeFile(path.join(this.dir, file), buffer)

    const item = {
      id,
      no,
      file,
      hash,
      emotion: EMOTIONS.includes(emotion) ? emotion : '',
      content: sanitizeLabel(content, 120),
      keywords: (Array.isArray(keywords) ? keywords : String(keywords || '').split(/[,，\s]+/))
        .map((word) => sanitizeLabel(word, 24))
        .filter(Boolean)
        .slice(0, 8),
      from: sanitizeLabel(from, 40),
      source: sanitizeLabel(source, 20),
      addedAt: new Date().toISOString(),
      uses: 0,
      lastUsedAt: null,
    }
    this.items.push(item)
    await this.save()
    this.logger('info', `[ig-life] 收藏咗一張圖 ${id}（${item.emotion || '未分類'}，來自 ${from || source}）`)
    return { ok: true, id, file: path.join(this.dir, file), duplicate: false }
  }

  /** Fill in / fix the annotation after the fact (the model looked at it again). */
  async annotate(id, { emotion, content, keywords }) {
    const item = this.items.find((entry) => entry.id === id)
    if (!item) return { ok: false, code: 'IG_STICKER_NOT_FOUND', error: `沒有 #${id}`, hint: '先用 sticker_list 看編號' }
    if (emotion && EMOTIONS.includes(emotion)) item.emotion = emotion
    if (content !== undefined) item.content = sanitizeLabel(content, 120)
    if (keywords !== undefined) {
      item.keywords = (Array.isArray(keywords) ? keywords : String(keywords).split(/[,，\s]+/))
        .map((word) => sanitizeLabel(word, 24))
        .filter(Boolean)
        .slice(0, 8)
    }
    await this.save()
    return { ok: true, item: publicView(item) }
  }

  async remove(id) {
    const index = this.items.findIndex((entry) => entry.id === id)
    if (index < 0) return false
    const [item] = this.items.splice(index, 1)
    try {
      await fsp.unlink(path.join(this.dir, item.file))
    } catch {
      /* file already gone */
    }
    await this.save()
    return true
  }

  pathOf(id) {
    const item = this.items.find((entry) => entry.id === id)
    return item ? path.join(this.dir, item.file) : null
  }

  /**
   * Find the stickers that fit a situation.
   * @param {string} query  free text, e.g. "被人鬧到無語"
   * @param {{emotion?: string, limit?: number, excludeRecent?: boolean}} [options]
   */
  search(query = '', { emotion = '', limit = 3, excludeRecent = true } = {}) {
    if (!this.items.length) return []
    const queryTokens = tokenize(`${query} ${emotion}`)
    const documents = this.items.map((item) => tokenize(`${item.emotion} ${item.content} ${item.keywords.join(' ')}`))

    const documentFrequency = new Map()
    for (const tokens of documents) for (const token of tokens) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    const total = this.items.length
    const weight = (token) => Math.log(1 + total / (1 + (documentFrequency.get(token) ?? 0)))
    const queryWeight = [...queryTokens].reduce((sum, token) => sum + weight(token), 0) || 1

    const scored = this.items.map((item, index) => {
      const tokens = documents[index]
      let shared = 0
      for (const token of queryTokens) if (tokens.has(token)) shared += weight(token)
      const tokensWeight = [...tokens].reduce((sum, token) => sum + weight(token), 0) || 1
      let score = shared / Math.sqrt(queryWeight * tokensWeight)
      if (emotion && item.emotion === emotion) score += 0.35
      if (!item.emotion) score -= 0.1 // unannotated is a weaker match
      if (excludeRecent && item.lastUsedAt && Date.now() - Date.parse(item.lastUsedAt) < 3 * 3_600_000) score -= 0.5
      score -= Math.min(0.3, (item.uses ?? 0) * 0.02)
      return { item, score }
    })

    return scored
      .filter((entry) => entry.score > 0.02)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, limit))
      .map((entry) => ({ ...publicView(entry.item), score: Number(entry.score.toFixed(3)), path: path.join(this.dir, entry.item.file) }))
  }

  async markUsed(id) {
    const item = this.items.find((entry) => entry.id === id)
    if (!item) return
    item.uses = (item.uses ?? 0) + 1
    item.lastUsedAt = new Date().toISOString()
    await this.save()
  }

  listing({ limit = 40 } = {}) {
    return this.items.slice(-limit).map(publicView)
  }

  stats() {
    const byEmotion = {}
    for (const item of this.items) {
      const key = item.emotion || '未分類'
      byEmotion[key] = (byEmotion[key] ?? 0) + 1
    }
    return { total: this.items.length, byEmotion, dir: this.dir }
  }
}

function publicView(item) {
  return {
    id: item.id,
    no: item.no,
    emotion: item.emotion,
    content: item.content,
    keywords: item.keywords,
    from: item.from,
    uses: item.uses ?? 0,
  }
}
