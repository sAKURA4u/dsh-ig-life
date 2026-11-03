/**
 * Life: the part that keeps running when nobody is talking.
 *
 * An energy budget drains while awake and refills while asleep; mood drifts back
 * to a baseline; a daily reflection compresses the day's memories. When the
 * character is awake, fed and not too recently in touch, it may start a
 * conversation or publish something — that is the whole "完整的一生" mechanic,
 * and it is deliberately capped so it can never become spam.
 */

import { dayKey, inQuietHours, isAwakeHour, nowInZone } from './gate.js'
import { renderMemoryBlock, rank } from './memory.js'
import { renderIgProtocol, renderPersonaCore } from './persona.js'

const MS_PER_MINUTE = 60_000
const MAX_CATCHUP_MINUTES = 12 * 60

export function createInitialState(now = new Date()) {
  return {
    birthAt: now.toISOString(),
    energy: 72,
    valence: 0.15,
    arousal: 0.35,
    affection: 30,
    awake: true,
    asleepSince: null,
    activity: '啱啱起身，仲有啲呆',
    location: '屋企',
    lastTickAt: now.toISOString(),
    lastProactiveAt: null,
    lastPostAt: null,
    lastThoughtAt: null,
    lastReflectDay: null,
    day: dayKey(now),
    turnsToday: 0,
    turnsTotal: 0,
    paused: false,
    note: '',
  }
}

export function moodLabel(valence, arousal) {
  if (valence >= 0.55) return arousal >= 0.6 ? '雀躍' : '心入面暖暖地'
  if (valence >= 0.2) return arousal >= 0.5 ? '愉快' : '平靜而舒服'
  if (valence > -0.15) return arousal < 0.4 ? '發呆中' : '有啲坐唔定'
  if (valence > -0.45) return arousal < 0.5 ? '悶悶地' : '煩躁'
  return arousal < 0.5 ? '低落' : '心裡面好嘈'
}

export function describeState(state, now = new Date()) {
  const ageDays = Math.max(0, (now.getTime() - new Date(state.birthAt).getTime()) / 86_400_000)
  const age = ageDays < 1 ? '出世第 1 日' : ageDays < 30 ? `已經活咗 ${Math.floor(ageDays)} 日` : `已經活咗 ${Math.floor(ageDays / 30)} 個月`
  const energy = state.energy >= 80 ? '精神到彈起' : state.energy >= 55 ? '正常' : state.energy >= 30 ? '有啲攰' : '好攰'
  return `${age}｜心情：${moodLabel(state.valence, state.arousal)}｜體力：${energy}（${Math.round(state.energy)}/100）｜而家喺${state.location}，${state.activity}｜對佢嘅親近感：${Math.round(state.affection)}/100`
}

/**
 * Move the life forward by the elapsed wall-clock time.
 *
 * `now` is an instant (used for timestamps and elapsed math); the hour-of-day
 * decisions use the character's own wall clock, resolved from
 * `config.life.timezone`, so 03:00 means 03:00 where it lives and not on the
 * machine that happens to run the process.
 *
 * @returns {{state: object, events: string[]}}
 */
export function advanceState(state, { now = new Date(), config, local = null }) {
  const events = []
  const wallClock = local ?? nowInZone(config?.life?.timezone, now)
  const last = state.lastTickAt ? new Date(state.lastTickAt) : now
  const elapsedMinutes = Math.min(MAX_CATCHUP_MINUTES, Math.max(0, (now.getTime() - last.getTime()) / MS_PER_MINUTE))

  const awakeNow = isAwakeHour(wallClock, { wakeHour: config.life.wakeHour, sleepHour: config.life.sleepHour })
  if (awakeNow && !state.awake) {
    events.push('醒咗')
    state.activity = '啱啱起身，仲有啲呆'
    state.asleepSince = null
  } else if (!awakeNow && state.awake && state.energy < 95) {
    events.push('眼訓到投降，去咗訓')
    state.activity = '訓緊覺'
    state.asleepSince = now.toISOString()
  }
  state.awake = awakeNow && state.energy > 3

  if (state.awake) {
    state.energy = clamp(state.energy - 0.055 * elapsedMinutes, 0, 100)
    if (state.energy <= 4) {
      state.awake = false
      state.asleepSince = now.toISOString()
      state.activity = '體力見底，直接昏迷'
      events.push('體力見底，昏迷式睡眠')
    }
  } else {
    state.energy = clamp(state.energy + 0.145 * elapsedMinutes, 0, 100)
  }

  // mood drifts gently back to a calm baseline
  const drift = Math.min(1, 0.004 * elapsedMinutes)
  state.valence = clamp(state.valence + (0.12 - state.valence) * drift, -1, 1)
  state.arousal = clamp(state.arousal + (0.32 - state.arousal) * Math.min(1, 0.006 * elapsedMinutes), 0, 1)

  const today = dayKey(wallClock)
  if (state.day !== today) {
    state.day = today
    state.turnsToday = 0
    events.push('新嘅一日')
  }
  state.lastTickAt = now.toISOString()
  return { state, events }
}

export class Life {
  constructor({ ctx, config, store, memory, transport, llmBridge, persona, logger }) {
    this.ctx = ctx
    this.config = config
    this.store = store
    this.memory = memory
    this.transport = transport
    this.llmBridge = llmBridge
    this.persona = persona
    this.logger = logger ?? (() => {})
    this.state = createInitialState()
  }

  async load() {
    const saved = await this.store.read('state.json', null)
    if (saved && typeof saved === 'object') this.state = { ...createInitialState(), ...saved }
    return this
  }

  async save() {
    await this.store.write('state.json', this.state)
  }

  localNow(now = new Date()) {
    return nowInZone(this.config.life.timezone, now)
  }

  describe(now = new Date()) {
    return describeState(this.state, now)
  }

  /** Convenience for the tools + bridge: note that a real exchange happened. */
  async recordExchange({ owner = false, valenceDelta = 0.04 } = {}) {
    const state = this.state
    state.valence = clamp(state.valence + valenceDelta, -1, 1)
    state.arousal = clamp(state.arousal + 0.05, 0, 1)
    state.energy = clamp(state.energy - 1.5, 0, 100)
    state.affection = clamp(state.affection + (owner ? 1.6 : 0.2), 0, 100)
    state.turnsToday += 1
    state.turnsTotal += 1
    state.activity = '啱啱同人傾完偈'
    await this.save()
  }

  /**
   * One tick. Never throws: every optional step is individually guarded, because
   * a timer callback that throws repeatedly is how a process dies.
   * @returns {Promise<object>} a report (also useful in tests and logs)
   */
  async tick(now = new Date()) {
    const report = { at: now.toISOString(), events: [], proactive: null, post: null, thought: null, consolidation: null, skipped: [], errors: [] }
    const local = this.localNow(now)

    try {
      const advanced = advanceState(this.state, { now, local, config: this.config })
      this.state = advanced.state
      report.events = advanced.events
    } catch (error) {
      report.errors.push(`advance: ${error?.message ?? error}`)
    }

    await this.maybeConsolidate(local, report)
    if (this.state.paused) {
      report.skipped.push('paused')
      await this.save()
      return report
    }
    if (!this.state.awake) {
      report.skipped.push('asleep')
      await this.save()
      return report
    }

    await this.maybeThink(local, report)
    await this.maybeProactive(local, report)
    await this.maybePost(local, report)
    await this.save()
    return report
  }

  // ------------------------------------------------------------- consolidation
  async maybeConsolidate(local, report) {
    if (local.getHours() !== this.config.memory.consolidateHour) return
    const today = dayKey(local)
    if (this.state.lastReflectDay === today) return
    try {
      const result = await this.memory.consolidate({ now: new Date(), config: this.config })
      this.state.lastReflectDay = today
      report.consolidation = { before: result.before, after: result.after, pruned: result.pruned.length, promoted: result.promoted.length }
      this.logger('info', `[ig-life] 睡眠壓縮：${result.before} → ${result.after} 條記憶（剪走 ${result.pruned.length}、升級 ${result.promoted.length}）`)
    } catch (error) {
      report.errors.push(`consolidate: ${error?.message ?? error}`)
    }
  }

  // -------------------------------------------------------------------- think
  async maybeThink(local, report) {
    if (!this.llmBridge?.available) return
    const last = this.state.lastThoughtAt ? new Date(this.state.lastThoughtAt) : null
    if (last && local.getTime() - last.getTime() < 3_600_000) return
    if (Math.random() > 0.45) return
    const memories = this.memory.snapshot()
    const prompt = `你而家一個人喺${this.state.location}，${this.state.activity}。\n${describeState(this.state, new Date())}\n\n寫一兩句你腦入面浮起嘅嘢（第一人稱內心獨白，唔要解釋、唔要總結人生）。只輸出獨白本身。`
    const thought = await this.llmBridge.generate({
      system: `${renderPersonaCore(this.persona)}\n\n${renderIgProtocol({ config: this.config, persona: this.persona })}\n\n${renderMemoryBlock(rank(memories, this.state.activity, { config: this.config.memory, limit: 6 }))}`,
      prompt,
      maxTokens: 160,
      temperature: 1.15,
    })
    if (!thought) return
    await this.memory.add({ content: thought, kind: 'thought', importance: 0.3, source: 'inner' })
    this.state.lastThoughtAt = new Date().toISOString()
    this.state.energy = clamp(this.state.energy - 0.6, 0, 100)
    report.thought = thought
  }

  // ----------------------------------------------------------------- proactive
  async maybeProactive(local, report) {
    const { config } = this
    if (!config.ownerHandle) {
      report.skipped.push('no ownerHandle')
      return
    }
    if (this.state.energy < 22) {
      report.skipped.push('too tired to reach out')
      return
    }
    if (inQuietHours(local, config.life.quietHours)) {
      report.skipped.push('quiet hours')
      return
    }
    const lastProactive = this.state.lastProactiveAt ? new Date(this.state.lastProactiveAt) : null
    if (lastProactive && local.getTime() - lastProactive.getTime() < config.life.proactiveCooldownMinutes * MS_PER_MINUTE) {
      report.skipped.push('proactive cooldown')
      return
    }
    // lonelier characters reach out more
    const probability = Math.min(0.65, config.life.proactiveDmProbability * (0.6 + this.state.affection / 100) * 1.4)
    if (Math.random() > probability) {
      report.skipped.push('not this tick')
      return
    }
    if (!this.llmBridge?.available) {
      report.skipped.push('no llm for proactive message')
      return
    }
    // Instagram forbids initiating outside the reply window, so do not even ask
    // the model to compose something that cannot legally be delivered.
    if (typeof this.reachOutGate === 'function') {
      const gate = this.reachOutGate()
      if (!gate?.open) {
        report.skipped.push(`outside messaging window: ${gate?.reason ?? 'unknown'}`)
        return
      }
    }

    const memories = this.memory.snapshot()
    const ranked = rank(memories, `${this.state.activity} ${config.ownerHandle}`, { config: config.memory, limit: 8 })
    const prompt = `冇人搵你。你自己諗起 @${config.ownerHandle}。\n${describeState(this.state, new Date())}\n\n你可以選擇唔打擾佢。真正嘅人唔會每次都打字：冇嘢想講就唔好 send。\n如果 send，要似突然諗起對方：一句半句、有具體內容（見到嘅嘢、諗起嘅事、一個問題），唔好講「天氣好好」呢類廢話。\n\n只輸出 JSON：{"send": true 或 false, "text": "要打出去嘅訊息", "reason": "點解想講呢句"}`

    const raw = await this.llmBridge.generate({
      system: `${renderPersonaCore(this.persona)}\n\n${renderIgProtocol({ config, persona: this.persona })}\n\n${renderMemoryBlock(ranked)}`,
      prompt,
      maxTokens: 260,
      temperature: 1.05,
    })
    if (!raw) {
      report.skipped.push('llm returned nothing')
      return
    }
    const decision = parseJsonLoose(raw)
    if (!decision?.send || !String(decision.text ?? '').trim()) {
      report.skipped.push(`chose silence: ${String(decision?.reason ?? 'no decision').slice(0, 80)}`)
      return
    }
    try {
      const { sanitizeOutbound } = await import('./gate.js')
      const text = sanitizeOutbound(decision.text, { maxChars: 600 })
      if (!text) {
        report.skipped.push('proactive text was empty after sanitising')
        return
      }
      const sent = await this.transport.sendDm({ text, username: config.ownerHandle })
      this.state.lastProactiveAt = new Date().toISOString()
      this.state.energy = clamp(this.state.energy - 1, 0, 100)
      this.state.arousal = clamp(this.state.arousal + 0.08, 0, 1)
      await this.memory.add({
        content: `我主動搵咗 @${config.ownerHandle}：${text}`,
        kind: 'episode',
        importance: 0.55,
        source: 'proactive',
      })
      report.proactive = { text, id: sent?.id ?? '' }
    } catch (error) {
      report.errors.push(`proactive send: ${error?.message ?? error}`)
    }
  }

  // ---------------------------------------------------------------------- post
  async maybePost(local, report) {
    const { config } = this
    if (this.state.energy < 30) {
      report.skipped.push('too tired to post')
      return
    }
    const lastPost = this.state.lastPostAt ? new Date(this.state.lastPostAt) : null
    if (lastPost && local.getTime() - lastPost.getTime() < config.life.postMinGapHours * 3_600_000) return
    if (Math.random() > config.life.postProbability) return
    if (!this.llmBridge?.available) {
      report.skipped.push('no llm for a caption')
      return
    }

    const ranked = rank(this.memory.snapshot(), `${this.state.activity} ${this.state.location}`, { config: config.memory, limit: 8 })
    const prompt = `你嘅 IG 係你嘅日記，唔係營銷帳號。\n${describeState(this.state, new Date())}\n\n你想唔想留低呢一刻？caption 用角色語氣，1 至 3 行，最多一個 hashtag。\n只輸出 JSON：{"post": true 或 false, "caption": "...", "mood": "..."}`
    const raw = await this.llmBridge.generate({
      system: `${renderPersonaCore(this.persona)}\n\n${renderIgProtocol({ config, persona: this.persona })}\n\n${renderMemoryBlock(ranked)}`,
      prompt,
      maxTokens: 240,
      temperature: 1.05,
    })
    const decision = raw ? parseJsonLoose(raw) : null
    if (!decision?.post || !String(decision.caption ?? '').trim()) {
      report.skipped.push('nothing worth posting today')
      return
    }
    try {
      const { sanitizeOutbound } = await import('./gate.js')
      const caption = sanitizeOutbound(decision.caption, { maxChars: 1800 })
      const imageUrl = await this.pickImageUrl()
      const posted = await this.transport.postPhoto({ caption, imageUrl })
      this.state.lastPostAt = new Date().toISOString()
      this.state.valence = clamp(this.state.valence + 0.08, -1, 1)
      this.state.energy = clamp(this.state.energy - 2, 0, 100)
      await this.memory.add({ content: `我今日發咗一個 post：${caption}`, kind: 'episode', importance: 0.6, source: 'post' })
      report.post = { caption, mediaId: posted?.mediaId ?? '', imageUrl: imageUrl ?? null }
    } catch (error) {
      report.errors.push(`post: ${error?.message ?? error}`)
    }
  }

  /**
   * Instagram needs a public HTTPS image. We use a static file the user dropped
   * into `<dataDir>/media` (or the persona folder) and expose it through our own
   * `/ig-life/media/<file>` route when graph.publicBaseUrl is configured.
   */
  async pickImageUrl() {
    if (!this.config.graph.publicBaseUrl) return null
    const fsp = await import('node:fs/promises')
    const path = await import('node:path')
    const dir = path.join(this.store.dir, 'media')
    let entries = []
    try {
      entries = await fsp.readdir(dir)
    } catch {
      return null
    }
    const images = entries.filter((name) => /\.(jpe?g|png)$/i.test(name))
    if (!images.length) return null
    const chosen = images[Math.floor(Math.random() * images.length)]
    return `${this.config.graph.publicBaseUrl}/ig-life/media/${encodeURIComponent(chosen)}`
  }
}

export function parseJsonLoose(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const fenced = /```(?:json)?\s*([\s\S]+?)```/.exec(raw)
  const candidate = fenced ? fenced[1].trim() : raw
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

function clamp(value, low, high) {
  if (!Number.isFinite(value)) return low
  return Math.min(high, Math.max(low, value))
}
