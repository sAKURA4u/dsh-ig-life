/**
 * MemoryBook — the persistent half of the plastic memory.
 *
 * `memory.js` decides what is clear and what has faded; this class owns the
 * file (`memory.json`), replay-safe writes, seeding, and the nightly
 * consolidation that actually deletes the faded tail.
 */

import { consolidate, createMemory, rank, tierOf, TIER } from './memory.js'
import { seedPayloads } from './persona.js'

const DOCUMENT = 'memory.json'

export class MemoryBook {
  constructor({ store, config, logger, persona = null }) {
    this.store = store
    this.config = config
    this.logger = logger ?? (() => {})
    this.persona = persona
    this.memories = []
  }

  async load() {
    const saved = await this.store.read(DOCUMENT, null)
    if (saved && Array.isArray(saved.memories)) this.memories = saved.memories
    await this.seed()
    return this
  }

  /** Seed the persona's birth memories exactly once. */
  async seed() {
    if (!this.persona) return 0
    const flag = await this.store.read('flags.json', {})
    if (flag.seededPersona === this.persona.dir) return 0
    const payloads = seedPayloads(this.persona)
    if (!payloads.length) {
      await this.store.write('flags.json', { ...flag, seededPersona: this.persona.dir })
      return 0
    }
    for (const payload of payloads) this.memories.push(createMemory(payload))
    await this.save()
    await this.store.write('flags.json', { ...flag, seededPersona: this.persona.dir })
    this.logger('info', `[ig-life] seeded ${payloads.length} birth memories`)
    return payloads.length
  }

  async save() {
    await this.store.write(DOCUMENT, { version: 1, memories: this.memories })
  }

  snapshot() {
    return this.memories
  }

  get size() {
    return this.memories.length
  }

  /** Add one memory. Returns the stored record. */
  async add(payload) {
    const memory = createMemory(payload)
    this.memories.push(memory)
    await this.save()
    return memory
  }

  async addMany(payloads) {
    const created = []
    for (const payload of payloads ?? []) {
      if (!payload?.content) continue
      created.push(createMemory(payload))
    }
    if (!created.length) return []
    this.memories.push(...created)
    await this.save()
    return created
  }

  /** Rank + rehearse (recallCount++). Returns enriched entries. */
  recall(query, { limit, touch = true, now = new Date() } = {}) {
    return rank(this.memories, query, {
      config: this.config.memory,
      limit: limit ?? this.config.memory.injectLimit,
      touch,
      now,
    })
  }

  /** How many memories sit in each tier right now — used by `ig_life_status`. */
  tiers(now = new Date()) {
    const total = this.memories.length
    const counts = { [TIER.ANCHOR]: 0, [TIER.IMPORTANT]: 0, [TIER.RECENT]: 0, [TIER.FADING]: 0 }
    this.memories.forEach((memory, index) => {
      counts[tierOf(memory, { index, total, config: this.config.memory, now })] += 1
    })
    return counts
  }

  /** Nightly compression: promote the rehearsed, cut the faded tail. */
  async consolidate({ now = new Date() } = {}) {
    const result = consolidate(this.memories, { now, config: this.config.memory })
    this.memories = result.kept
    await this.save()
    return result
  }

  async forget(id) {
    const before = this.memories.length
    this.memories = this.memories.filter((memory) => memory.id !== id)
    if (this.memories.length !== before) await this.save()
    return before !== this.memories.length
  }

  stats(now = new Date()) {
    return {
      total: this.memories.length,
      tiers: this.tiers(now),
      oldest: this.memories[0]?.createdAt ?? null,
      newest: this.memories.at(-1)?.createdAt ?? null,
    }
  }
}
