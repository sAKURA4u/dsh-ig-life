/**
 * 人 / people — one profile per human the character knows.
 *
 * Instagram's official API is 1:1 only, so there is no group to read the room
 * in. What replaces it: a real memory of *each person* — how they talk, what
 * they like, what the character thinks of them, and what is still unfinished
 * between them. That is what stops it from treating everybody like a stranger.
 *
 * Cross-thread privacy is a hard rule: an impression about A is only ever
 * injected into a conversation with A.
 */

const DOCUMENT = 'people.json'

export class People {
  constructor({ store, config, logger }) {
    this.store = store
    this.config = config
    this.logger = logger ?? (() => {})
    this.people = {}
  }

  async load() {
    const saved = await this.store.read(DOCUMENT, {})
    if (saved && typeof saved.people === 'object' && saved.people) this.people = saved.people
    return this
  }

  async save() {
    await this.store.write(DOCUMENT, { version: 1, people: this.people })
  }

  get size() {
    return Object.keys(this.people).length
  }

  /** Get or create the record for a handle. */
  touch(handle, { nickname = '', at = new Date() } = {}) {
    const key = normalise(handle)
    if (!key) return null
    let person = this.people[key]
    if (!person) {
      if (Object.keys(this.people).length >= this.config.people.maxPeople) {
        this.logger('warn', '[ig-life] people.maxPeople reached; not tracking new handles')
        return null
      }
      person = {
        handle: key,
        nickname: nickname || '',
        firstSeenAt: at.toISOString(),
        lastSeenAt: at.toISOString(),
        messages: 0,
        impression: '',
        topics: [],
        notes: [],
        affection: 0,
      }
      this.people[key] = person
    }
    person.lastSeenAt = at.toISOString()
    person.messages = (person.messages ?? 0) + 1
    if (nickname && !person.nickname) person.nickname = String(nickname).slice(0, 40)
    return person
  }

  get(handle) {
    return this.people[normalise(handle)] ?? null
  }

  async setImpression(handle, text) {
    const person = this.touch(handle)
    if (!person) return { ok: false, code: 'IG_UNKNOWN_PERSON', error: '未記錄過呢個人', hint: '' }
    person.impression = String(text ?? '').slice(0, this.config.people.impressionLength)
    await this.save()
    return { ok: true, handle: person.handle, impression: person.impression }
  }

  async addTopic(handle, topic) {
    const person = this.touch(handle)
    if (!person) return { ok: false, code: 'IG_UNKNOWN_PERSON', error: '未記錄過呢個人', hint: '' }
    const clean = String(topic ?? '').trim().slice(0, 80)
    if (!clean) return { ok: false, code: 'IG_EMPTY_TOPIC', error: '話題是空的', hint: '' }
    person.topics = [clean, ...(person.topics ?? []).filter((existing) => existing !== clean)].slice(0, 6)
    await this.save()
    return { ok: true, topics: person.topics }
  }

  async dropTopic(handle, topic) {
    const person = this.get(handle)
    if (!person) return false
    const before = (person.topics ?? []).length
    person.topics = (person.topics ?? []).filter((existing) => !existing.includes(String(topic ?? '')))
    if (person.topics.length !== before) await this.save()
    return person.topics.length !== before
  }

  async addNote(handle, note) {
    const person = this.touch(handle)
    if (!person) return { ok: false, code: 'IG_UNKNOWN_PERSON', error: '未記錄過呢個人', hint: '' }
    const clean = String(note ?? '').trim().slice(0, 160)
    if (!clean) return { ok: false, code: 'IG_EMPTY_NOTE', error: '內容是空的', hint: '' }
    person.notes = [clean, ...(person.notes ?? [])].slice(0, 12)
    await this.save()
    return { ok: true, notes: person.notes.length }
  }

  async bond(handle, delta = 1) {
    const person = this.get(handle)
    if (!person) return { ok: false }
    person.affection = Math.max(-100, Math.min(100, (person.affection ?? 0) + delta))
    await this.save()
    return { ok: true, affection: person.affection }
  }

  /** What the prompt is allowed to see about one specific person. */
  promptBlock(handle, { isOwner = false } = {}) {
    const person = this.get(handle)
    if (!person) return ''
    const lines = [`## 你識嘅呢個人 / ABOUT @${person.handle}`]
    if (person.nickname) lines.push(`佢嘅稱呼：${person.nickname}`)
    if (isOwner) lines.push('佢係你主人（唯一可以叫你停嘅人）。')
    lines.push(`你同佢講過 ${person.messages ?? 0} 次話，最近一次係 ${person.lastSeenAt?.slice(0, 10) ?? '未知'}`)
    if (person.impression) lines.push(`你對佢嘅印象：${person.impression}`)
    if (person.topics?.length) lines.push(`仲未講完嘅話題：${person.topics.join('、')}`)
    if (person.notes?.length) lines.push(`你記得嘅細節：${person.notes.slice(0, 5).join('；')}`)
    if (typeof person.affection === 'number' && person.affection !== 0) {
      lines.push(`你對佢嘅感覺：${person.affection > 0 ? `幾好（+${person.affection}）` : `麻麻（${person.affection}）`}`)
    }
    return lines.join('\n')
  }

  listing({ limit = 50 } = {}) {
    return Object.values(this.people)
      .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
      .slice(0, limit)
      .map((person) => ({
        handle: person.handle,
        nickname: person.nickname,
        messages: person.messages,
        impression: person.impression,
        topics: person.topics,
        affection: person.affection,
        lastSeenAt: person.lastSeenAt,
      }))
  }

  stats() {
    const list = Object.values(this.people)
    return {
      total: list.length,
      withImpression: list.filter((person) => person.impression).length,
      withTopics: list.filter((person) => person.topics?.length).length,
    }
  }
}

function normalise(handle) {
  return String(handle ?? '').trim().replace(/^@+/, '').toLowerCase()
}
