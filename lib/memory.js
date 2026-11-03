/**
 * Plastic memory. 可塑性記憶。
 *
 * The model of memory this implements, in the words of the diagram it came from:
 *
 *   只記得開頭、最近，和真正重要的事 —— 其餘逐日淡忘。
 *
 * Four tiers, decided per recall:
 *
 *   anchor   最早的錨點（pinned / identity / 最早期嘅前 N 條）——永遠最清楚，唔會被淡忘
 *   important 重要（importance 高，或被反覆想起到一定次數）——不但不忘，還會越來越牢
 *   recent   眼前（最近 N 條）——剛發生的事全都在，細節最全
 *   fading   其餘——按 exp(-age/halfLife) 慢慢變淡，每晚壓縮時被剪走
 *
 * Recall is a hybrid lexical scorer (CJK character bigrams + Latin words, IDF
 * weighted) so Chinese works with no tokenizer, no embeddings, no network.
 * Every recall is a rehearsal: touched memories gain recallCount, which is how a
 * memory promotes itself into "important" by being used.
 */

export const KINDS = Object.freeze(['identity', 'fact', 'impression', 'episode', 'thought', 'reflection', 'plan'])

export const TIER = Object.freeze({
  ANCHOR: 'anchor',
  IMPORTANT: 'important',
  RECENT: 'recent',
  FADING: 'fading',
})

const MS_PER_DAY = 86_400_000
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g
const LATIN = /[a-z0-9_']{2,}/g

let sequence = 0
export function nextMemoryId(prefix = 'm') {
  sequence += 1
  return `${prefix}_${Date.now().toString(36)}_${sequence.toString(36)}`
}

/**
 * @returns {object} a memory record (plain JSON — it goes straight into storage)
 */
export function createMemory({
  content,
  kind = 'episode',
  importance = 0.55,
  valence = 0,
  subject = 'self',
  source = 'manual',
  pinned = false,
  at = new Date(),
  id,
  recallCount = 0,
  lastRecalledAt = null,
}) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim()
  if (!text) throw new Error('memory content must not be empty')
  const created = at instanceof Date ? at : new Date(at)
  return {
    id: id ?? nextMemoryId(),
    kind: KINDS.includes(kind) ? kind : 'episode',
    content: text.slice(0, 400),
    subject: String(subject || 'self'),
    source: String(source || 'manual'),
    importance: clamp(Number(importance) || 0.55, 0, 1),
    valence: clamp(Number(valence) || 0, -1, 1),
    pinned: Boolean(pinned),
    createdAt: created.toISOString(),
    lastRecalledAt: lastRecalledAt ?? null,
    recallCount: Math.max(0, Math.floor(Number(recallCount) || 0)),
  }
}

/** Which of the four tiers this memory belongs to right now. */
export function tierOf(memory, { index = -1, total = 0, config, now = new Date() }) {
  const anchors = config?.anchorCount ?? 8
  const recent = config?.recentCount ?? 12
  const promoteAt = config?.recallPromotionCount ?? 3
  const importanceThreshold = config?.importanceThreshold ?? 0.75

  if (memory.pinned || memory.kind === 'identity') return TIER.ANCHOR
  if (index >= 0 && index < anchors) return TIER.ANCHOR
  if ((memory.importance ?? 0) >= importanceThreshold) return TIER.IMPORTANT
  if ((memory.recallCount ?? 0) >= promoteAt) return TIER.IMPORTANT
  if (index >= 0 && index >= total - recent) return TIER.RECENT
  return TIER.FADING
}

/**
 * 記憶清晰度 0..1 — how legible this memory still is.
 * Anchors do not fade, recent things are crisp, everything else decays.
 */
export function clarityOf(memory, { tier, now = new Date(), config }) {
  const halfLife = config?.decayHalfLifeDays ?? 21
  const ageDays = Math.max(0, (now.getTime() - new Date(memory.createdAt).getTime()) / MS_PER_DAY)
  const recallBoost = Math.min(0.15, 0.03 * (memory.recallCount ?? 0))
  const importance = memory.importance ?? 0.55

  switch (tier) {
    case TIER.ANCHOR:
      return clamp(0.95 + recallBoost, 0, 1)
    case TIER.IMPORTANT:
      return clamp(0.8 + recallBoost, 0, 1)
    case TIER.RECENT:
      // still crisp, loses a little edge across the recent window
      return clamp(0.92 - Math.min(0.25, ageDays * 0.02) + recallBoost, 0, 1)
    default: {
      const decay = Math.exp(-ageDays / Math.max(0.5, halfLife))
      return clamp(decay * (0.35 + 0.65 * importance) + recallBoost * decay, 0, 1)
    }
  }
}

/** Mixed CJK-bigram / Latin token set. */
export function tokenize(text) {
  const lowered = String(text ?? '').toLowerCase()
  const tokens = new Set(lowered.match(LATIN) ?? [])
  for (const run of lowered.match(CJK) ?? []) {
    if (run.length === 1) {
      tokens.add(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2))
  }
  return tokens
}

function idfTable(documents) {
  const documentFrequency = new Map()
  for (const tokens of documents) {
    for (const token of tokens) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
  }
  const total = Math.max(1, documents.length)
  const idf = new Map()
  for (const [token, count] of documentFrequency) idf.set(token, Math.log(1 + total / (1 + count)))
  return { idf, unknown: Math.log(1 + total) }
}

/**
 * Rank memories against a free-text query.
 * @param {object[]} memories
 * @param {string} query
 * @param {{now?: Date, limit?: number, config?: object, touch?: boolean}} [options]
 * @returns {{memory: object, score: number, clarity: number, tier: string, similarity: number}[]}
 */
export function rank(memories, query, options = {}) {
  const now = options.now ?? new Date()
  const config = options.config ?? {}
  const limit = options.limit ?? config.injectLimit ?? 10
  const list = Array.isArray(memories) ? memories : []
  if (!list.length) return []

  const total = list.length
  const documents = list.map((memory) => tokenize(`${memory.subject ?? ''} ${memory.content ?? ''}`))
  const queryTokens = tokenize(query)
  const { idf, unknown } = idfTable(documents)
  const weightOf = (token) => idf.get(token) ?? unknown
  const queryWeight = [...queryTokens].reduce((sum, token) => sum + weightOf(token), 0) || 1

  const scored = list.map((memory, index) => {
    const tier = tierOf(memory, { index, total, config, now })
    const clarity = clarityOf(memory, { tier, now, config })
    const tokens = documents[index]
    let shared = 0
    for (const token of queryTokens) if (tokens.has(token)) shared += weightOf(token)
    const documentWeight = [...tokens].reduce((sum, token) => sum + weightOf(token), 0) || 1
    const similarity = shared / Math.sqrt(queryWeight * documentWeight)
    const recallWeight = Math.min(1, (memory.recallCount ?? 0) / 5)

    const score =
      0.50 * similarity +
      0.22 * clarity +
      0.16 * (memory.importance ?? 0.5) +
      0.07 * recallWeight +
      (tier === TIER.ANCHOR ? 0.05 : 0)

    return { memory, score, clarity, tier, similarity }
  })

  scored.sort((a, b) => b.score - a.score || new Date(b.memory.createdAt) - new Date(a.memory.createdAt))
  const top = scored.slice(0, Math.max(0, limit))
  if (options.touch !== false) {
    const stamp = now.toISOString()
    for (const entry of top) {
      entry.memory.recallCount = (entry.memory.recallCount ?? 0) + 1
      entry.memory.lastRecalledAt = stamp
    }
  }
  return top
}

/**
 * Nightly consolidation — 睡眠壓縮.
 *
 * 1. memories that were recalled often enough get their importance *baked in*
 *    at the threshold, so the promotion survives even if the counters are later
 *    trimmed (被反覆用到就唔會忘)
 * 2. the faded tail is cut, keeping only the best-scored fraction of each day
 *    (so a day is not erased entirely — it is compressed into a trace)
 * 3. returns everything that changed so the caller can log/report it
 */
export function consolidate(memories, { now = new Date(), config = {} } = {}) {
  const list = Array.isArray(memories) ? memories.slice() : []
  const promoteAt = config.recallPromotionCount ?? 3
  const importanceThreshold = config.importanceThreshold ?? 0.75
  const keepFraction = config.keepFraction ?? 0.35
  const total = list.length

  const promoted = []
  const byDay = new Map()
  const pruned = []
  const kept = []

  list.forEach((memory, index) => {
    const tier = tierOf(memory, { index, total, config, now })
    if (tier === TIER.IMPORTANT && (memory.recallCount ?? 0) >= promoteAt && (memory.importance ?? 0) < importanceThreshold) {
      memory.importance = importanceThreshold
      memory.promotedAt = now.toISOString()
      promoted.push(memory)
    }
    if (tier !== TIER.FADING) {
      kept.push(memory)
      return
    }
    const day = String(memory.createdAt).slice(0, 10)
    const bucket = byDay.get(day) ?? []
    bucket.push({ memory, clarity: clarityOf(memory, { tier, now, config }) })
    byDay.set(day, bucket)
  })

  for (const [, bucket] of byDay) {
    bucket.sort((a, b) => b.clarity - a.clarity || (b.memory.importance ?? 0) - (a.memory.importance ?? 0))
    const keepCount = Math.max(0, Math.ceil(bucket.length * keepFraction))
    bucket.forEach((entry, index) => {
      if (index < keepCount) kept.push(entry.memory)
      else pruned.push(entry.memory)
    })
  }

  kept.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  return { kept, pruned, promoted, before: total, after: kept.length }
}

/** Render memories for a prompt — oldest first, tier visible to the model. */
export function renderMemoryBlock(memories, { title = '你記得嘅事 / MEMORY' } = {}) {
  if (!memories?.length) return `## ${title}\n（暫時冇特別相關嘅記憶）`
  const label = { anchor: '錨點', important: '重要', recent: '眼前', fading: '模糊' }
  const lines = memories.map((memory) => {
    const tier = memory.tier ?? TIER.RECENT
    return `- (${label[tier] ?? tier}) ${String(memory.content ?? '').slice(0, 220)}`
  })
  return `## ${title}（由你自己嘅角度記落嚟）\n${lines.join('\n')}`
}

function clamp(value, low, high) {
  if (!Number.isFinite(value)) return low
  return Math.min(high, Math.max(low, value))
}
