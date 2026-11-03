/**
 * 語音 / voice.
 *
 * Two ways to produce one:
 *   1. **TTS** — any OpenAI-compatible `/audio/speech` endpoint. Text goes in,
 *      an mp3 comes out, we verify the bytes are really audio before claiming
 *      anything happened.
 *   2. **語音包** — a folder of pre-recorded clips with a `manifest.json`, used
 *      when there is no TTS endpoint or when a specific line should always sound
 *      the same.
 *
 * The lesson taken from surfcore, written into the code: **never claim a voice
 * message was sent when the file was not verified**. `synthesize()` returns
 * `verified: false` on any doubt, and the caller must fall back to text.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { sniffAudio } from './stickers.js'

/** Emotion markers the model may put in `[ ]` → a small prosody nudge. */
export const EMOTION_PROSODY = Object.freeze({
  笑: 1.08,
  開心: 1.06,
  开心: 1.06,
  溫柔: 0.94,
  温柔: 0.94,
  小聲: 0.9,
  小声: 0.9,
  不耐煩: 1.1,
  不耐烦: 1.1,
  認真: 0.98,
  认真: 0.98,
  驚訝: 1.12,
  惊讶: 1.12,
  嘆氣: 0.85,
  叹气: 0.85,
  難過: 0.88,
  难过: 0.88,
  平靜: 1.0,
  平静: 1.0,
})

const MARKER = /\[([^\]\n]{1,6})\]/g

/** Pull `[笑]` style markers out of the text. */
export function extractMarkers(text) {
  const emotions = []
  const clean = String(text ?? '').replace(MARKER, (match, inner) => {
    const key = String(inner).trim()
    if (EMOTION_PROSODY[key] !== undefined) {
      emotions.push(key)
      return ''
    }
    return match
  })
  return { text: clean.replace(/\s{2,}/g, ' ').trim(), emotions }
}

export function prosodyFor(emotions) {
  if (!emotions?.length) return 1.0
  const values = emotions.map((emotion) => EMOTION_PROSODY[emotion]).filter((value) => value !== undefined)
  if (!values.length) return 1.0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

const MIN_AUDIO_BYTES = 1200

export class Voice {
  constructor({ config, store, logger, fetchImpl = globalThis.fetch }) {
    this.config = config
    this.store = store
    this.logger = logger ?? (() => {})
    this.fetchImpl = fetchImpl
    this.dir = path.join(store.dir, 'voice')
    this.packDir = config.voice.packDir ? path.resolve(config.voice.packDir) : path.join(store.dir, 'voice-pack')
    this.lastSentAt = null
    this.sentToday = { day: '', count: 0 }
  }

  get enabled() {
    return Boolean(this.config.voice.enabled)
  }

  get hasTts() {
    return Boolean(this.config.voice.baseUrl)
  }

  get available() {
    return this.enabled && (this.hasTts || this.hasPack)
  }

  get hasPack() {
    // reading the manifest is async; this flag is refreshed by loadPack()
    return Boolean(this.packManifest?.length)
  }

  async loadPack() {
    try {
      const raw = await fsp.readFile(path.join(this.packDir, 'manifest.json'), 'utf8')
      const parsed = JSON.parse(raw)
      this.packManifest = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.clips) ? parsed.clips : []
    } catch {
      this.packManifest = []
    }
    return this.packManifest
  }

  /** Daily / cooldown gate. Voice is the most intrusive thing the character can do. */
  gate(now = new Date()) {
    if (!this.enabled) return { ok: false, code: 'IG_VOICE_DISABLED', error: '語音未開啟', hint: '設定 voice.enabled: true' }
    if (!this.available) {
      return {
        ok: false,
        code: 'IG_VOICE_UNAVAILABLE',
        error: '沒有 TTS 端點，也沒有語音包',
        hint: '設定 voice.baseUrl（OpenAI-compatible /audio/speech）或放入語音包 manifest.json',
      }
    }
    const day = now.toISOString().slice(0, 10)
    if (this.sentToday.day !== day) this.sentToday = { day, count: 0 }
    if (this.sentToday.count >= this.config.voice.perDay) {
      return { ok: false, code: 'IG_VOICE_QUOTA', error: `今日已發 ${this.sentToday.count} 條語音`, hint: '調高 voice.perDay，或改為打字' }
    }
    if (this.lastSentAt) {
      const minutes = (now.getTime() - this.lastSentAt.getTime()) / 60_000
      if (minutes < this.config.voice.cooldownMinutes) {
        return {
          ok: false,
          code: 'IG_VOICE_COOLDOWN',
          error: `距離上次語音 ${minutes.toFixed(0)} 分鐘`,
          hint: `要再等 ${Math.ceil(this.config.voice.cooldownMinutes - minutes)} 分鐘；或者打字`,
        }
      }
    }
    return { ok: true }
  }

  /**
   * Synthesize one clip. Returns `verified: false` when the bytes are not
   * audio — the caller must then send text instead of pretending.
   */
  async synthesize(text, { emotionText = '' } = {}) {
    const gate = this.gate()
    if (!gate.ok) return gate
    if (!this.hasTts) {
      return { ok: false, code: 'IG_VOICE_NO_TTS', error: '沒有 TTS 端點', hint: '改用語音包，或設定 voice.baseUrl' }
    }

    const { text: cleanText, emotions } = extractMarkers(text)
    const spoken = cleanText.slice(0, this.config.voice.maxChars)
    if (!spoken.trim()) {
      return { ok: false, code: 'IG_VOICE_EMPTY', error: '沒有可以讀出來的內容', hint: '' }
    }
    const speed = clamp(this.config.voice.speed * prosodyFor(emotions.length ? emotions : extractMarkers(emotionText).emotions), 0.5, 2)

    const body = {
      model: this.config.voice.model || undefined,
      input: spoken,
      voice: this.config.voice.voice || undefined,
      response_format: this.config.voice.format || 'mp3',
      speed,
    }
    Object.keys(body).forEach((key) => body[key] === undefined && delete body[key])

    let response
    try {
      response = await this.fetchImpl(`${this.config.voice.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.voice.apiKey ? { authorization: `Bearer ${this.config.voice.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      })
    } catch (error) {
      return {
        ok: false,
        code: 'IG_VOICE_NETWORK',
        error: `TTS 端點連不上：${error?.message ?? error}`,
        hint: '檢查 voice.baseUrl 與網絡；失敗時應該打字，不要假裝發了語音',
      }
    }

    if (!response.ok) {
      const detail = await safeText(response)
      return {
        ok: false,
        code: 'IG_VOICE_TTS_FAILED',
        error: `TTS 回應 ${response.status}: ${detail.slice(0, 200)}`,
        hint: '檢查 voice.model / voice.voice 是否存在；仍失敗就打字',
      }
    }

    let buffer
    try {
      buffer = Buffer.from(await response.arrayBuffer())
    } catch (error) {
      return { ok: false, code: 'IG_VOICE_BAD_BODY', error: `TTS 回應無法讀取：${error?.message ?? error}`, hint: '' }
    }

    await fsp.mkdir(this.dir, { recursive: true })
    const format = sniffAudio(buffer) ?? (buffer.length ? 'unknown' : 'empty')
    const file = path.join(this.dir, `v-${Date.now().toString(36)}.${format === 'unknown' ? 'bin' : format}`)
    await fsp.writeFile(file, buffer)

    const verified = buffer.length >= MIN_AUDIO_BYTES && format !== 'unknown' && format !== 'empty'
    if (!verified) {
      return {
        ok: false,
        code: 'IG_VOICE_UNVERIFIED',
        error: `產生出來的檔案不像音頻（${buffer.length} bytes, ${format}）`,
        hint: 'TTS 可能回了錯誤頁或空檔；這種情況一定要改為打字',
        path: file,
      }
    }
    return { ok: true, path: file, format, bytes: buffer.length, verified: true, seconds: estimateSeconds(spoken), text: spoken, speed }
  }

  /** Pick a pre-recorded clip, preferring one whose text/emotion matches. */
  async pickPackClip({ text = '', emotion = '' } = {}) {
    if (!this.packManifest?.length) await this.loadPack()
    const clips = this.packManifest ?? []
    if (!clips.length) {
      return { ok: false, code: 'IG_VOICE_NO_PACK', error: '沒有語音包', hint: '放入 manifest.json，或設定 TTS' }
    }
    const needle = `${text} ${emotion}`.trim()
    const scored = clips.map((clip) => {
      let score = 0
      if (emotion && clip.emotion === emotion) score += 0.5
      if (needle && clip.text && String(clip.text).includes(needle.slice(0, 6))) score += 0.6
      return { clip, score }
    })
    scored.sort((a, b) => b.score - a.score)
    const chosen = scored[0]?.clip
    if (!chosen) return { ok: false, code: 'IG_VOICE_NO_PACK', error: '沒有語音包', hint: '' }
    const file = path.join(this.packDir, chosen.file)
    let bytes = 0
    try {
      bytes = (await fsp.stat(file)).size
    } catch {
      return { ok: false, code: 'IG_VOICE_PACK_MISSING', error: `語音包檔案不存在：${chosen.file}`, hint: `檢查 ${this.packDir}` }
    }
    const verified = bytes >= MIN_AUDIO_BYTES
    if (!verified) {
      return { ok: false, code: 'IG_VOICE_UNVERIFIED', error: `語音包檔案太細（${bytes} bytes）`, hint: '重新放一個正常的音頻檔' }
    }
    return { ok: true, path: file, verified: true, text: String(chosen.text ?? ''), emotion: String(chosen.emotion ?? ''), bytes }
  }

  noteSent(now = new Date()) {
    this.lastSentAt = now
    const day = now.toISOString().slice(0, 10)
    if (this.sentToday.day !== day) this.sentToday = { day, count: 0 }
    this.sentToday.count += 1
  }

  listPack() {
    return (this.packManifest ?? []).map((clip) => ({ id: clip.id, text: clip.text, emotion: clip.emotion, file: clip.file }))
  }

  stats() {
    return {
      enabled: this.enabled,
      hasTts: this.hasTts,
      packClips: this.packManifest?.length ?? 0,
      sentToday: this.sentToday.count,
      perDay: this.config.voice.perDay,
      maxChars: this.config.voice.maxChars,
    }
  }
}

/** Very rough duration estimate from character count (only used for logging). */
function estimateSeconds(text) {
  const cjk = (String(text).match(/[\u3400-\u9fff]/g) ?? []).length
  const others = String(text).length - cjk
  return Math.round((cjk / 4.2 + others / 3) * 10) / 10
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

async function safeText(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}
