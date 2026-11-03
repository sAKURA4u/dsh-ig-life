/**
 * 潮語 / 黑話詞庫 —— how the character learns new slang and then uses it well.
 *
 * The rule that matters, taken from surfcore's hard-won experience: an AI that
 * inserts jargon eagerly sounds worse than one that never uses it. So the loop
 * is deliberately slow:
 *
 *   sees an unknown term → `slang_query` (miss) → maybe `slang_submit` (pending)
 *   → the OWNER approves or rejects over DM → only approved terms are injected
 *   → and only `injectLimit` of them, with an explicit "don't over-use" rule.
 *
 * Nothing is auto-approved, ever.
 */

import { tokenize } from './memory.js'

const DOCUMENT = 'slang.json'

export class Lexicon {
  constructor({ store, config, logger }) {
    this.store = store
    this.config = config
    this.logger = logger ?? (() => {})
    this.terms = []
  }

  async load() {
    const saved = await this.store.read(DOCUMENT, null)
    if (saved && Array.isArray(saved.terms)) this.terms = saved.terms
    return this
  }

  async save() {
    await this.store.write(DOCUMENT, { version: 1, terms: this.terms })
  }

  get approved() {
    return this.terms.filter((term) => term.status === 'approved')
  }

  get pending() {
    return this.terms.filter((term) => term.status === 'pending')
  }

  /** Exact-ish lookup: normalised term equality, then a token overlap fallback. */
  query(term) {
    const needle = normalise(term)
    if (!needle) return { ok: false, code: 'IG_SLANG_EMPTY', error: '查詢是空的', hint: '' }
    const exact = this.terms.find((entry) => normalise(entry.term) === needle)
    if (exact) {
      if (exact.status === 'approved') return { ok: true, found: true, term: view(exact), status: 'approved' }
      return {
        ok: true,
        found: false,
        status: exact.status,
        hint: exact.status === 'pending' ? '呢個詞我提交咗，等主人批准' : '主人拒絕過呢個詞，唔好用',
      }
    }
    const queryTokens = tokenize(needle)
    const near = this.terms
      .map((entry) => {
        const tokens = tokenize(`${entry.term} ${entry.meaning ?? ''}`)
        let shared = 0
        for (const token of queryTokens) if (tokens.has(token)) shared += 1
        return { entry, shared }
      })
      .filter((candidate) => candidate.shared > 0)
      .sort((a, b) => b.shared - a.shared)
      .slice(0, 3)
      .map((candidate) => view(candidate.entry))
    return { ok: true, found: false, near, hint: near.length ? '可能係呢幾個，唔肯定就唔好用' : '未收錄；真係經常出現先提交' }
  }

  /** Submit a candidate. Always pending; duplicates collapse into one. */
  async submit({ term, meaning, usage = '', example = '', context = '', by = 'self' }) {
    const config = this.config.slang
    if (!config.enabled) return { ok: false, code: 'IG_SLANG_DISABLED', error: '潮語學習已關閉', hint: '設定 slang.enabled: true' }
    const cleanTerm = String(term ?? '').trim().slice(0, 40)
    const cleanMeaning = String(meaning ?? '').trim().slice(0, 200)
    if (!cleanTerm || !cleanMeaning) {
      return { ok: false, code: 'IG_SLANG_INCOMPLETE', error: 'term 同 meaning 都要填', hint: '解釋清楚先提交，唔好交白卷' }
    }
    // Duplicate first: re-submitting a term we already know must answer
    // "already have it", never "the queue is full" — otherwise the model reads a
    // full queue as "I should try again later" and retries forever.
    const existing = this.terms.find((entry) => normalise(entry.term) === normalise(cleanTerm))
    if (existing) {
      return { ok: true, id: existing.id, duplicate: true, status: existing.status, hint: '已經有記錄，唔需要重複提交' }
    }
    if (this.pending.length >= config.maxPending) {
      return { ok: false, code: 'IG_SLANG_QUEUE_FULL', error: `仲有 ${this.pending.length} 個等緊批准`, hint: '等主人處理完再提交' }
    }
    const today = new Date().toISOString().slice(0, 10)
    const submittedToday = this.terms.filter((entry) => String(entry.submittedAt ?? '').slice(0, 10) === today).length
    if (submittedToday >= config.submitsPerDay) {
      return {
        ok: false,
        code: 'IG_SLANG_DAILY_LIMIT',
        error: `今日已提交 ${submittedToday} 個詞`,
        hint: `上限 ${config.submitsPerDay}/日；真係重要嘅等明日，或者請主人手動加`,
      }
    }
    if (this.terms.length >= config.maxTerms) {
      return { ok: false, code: 'IG_SLANG_FULL', error: `詞庫滿了（${this.terms.length}）`, hint: '調高 slang.maxTerms 或清理' }
    }
    const entry = {
      id: `k${Date.now().toString(36)}${Math.floor(Math.random() * 100)}`,
      term: cleanTerm,
      meaning: cleanMeaning,
      usage: String(usage ?? '').slice(0, 200),
      example: String(example ?? '').slice(0, 200),
      context: String(context ?? '').slice(0, 200),
      by: String(by ?? 'self'),
      status: 'pending',
      submittedAt: new Date().toISOString(),
      decidedAt: null,
      hits: 0,
    }
    this.terms.push(entry)
    await this.save()
    this.logger('info', `[ig-life] 提交咗潮語「${entry.term}」等批准（pending ${this.pending.length}）`)
    return { ok: true, id: entry.id, status: 'pending', pending: this.pending.length }
  }

  async decide(id, decision, { by = 'owner' } = {}) {
    const entry = this.terms.find((item) => item.id === id || normalise(item.term) === normalise(id))
    if (!entry) return { ok: false, code: 'IG_SLANG_NOT_FOUND', error: `沒有 ${id}`, hint: '用 /slang 看清單' }
    if (!['approve', 'reject'].includes(decision)) {
      return { ok: false, code: 'IG_SLANG_BAD_DECISION', error: `decision 只可以係 approve 或 reject`, hint: '' }
    }
    entry.status = decision === 'approve' ? 'approved' : 'rejected'
    entry.decidedAt = new Date().toISOString()
    entry.decidedBy = by
    await this.save()
    return { ok: true, term: view(entry) }
  }

  async markUsed(term) {
    const needle = normalise(term)
    const entry = this.terms.find((item) => normalise(item.term) === needle && item.status === 'approved')
    if (!entry) return
    entry.hits = (entry.hits ?? 0) + 1
    entry.lastUsedAt = new Date().toISOString()
    await this.save()
  }

  /** A short block for the prompt: only approved terms, few, with usage context. */
  promptBlock({ limit = null } = {}) {
    const cap = limit ?? this.config.slang.injectLimit
    const approved = this.approved
    if (!approved.length) return ''
    const chosen = approved
      .slice()
      .sort((a, b) => (b.hits ?? 0) - (a.hits ?? 0) || String(b.decidedAt).localeCompare(String(a.decidedAt)))
      .slice(0, cap)
    const lines = chosen.map((entry) => {
      const parts = [`「${entry.term}」= ${entry.meaning}`]
      if (entry.usage) parts.push(`點用：${entry.usage}`)
      if (entry.example) parts.push(`例：${entry.example}`)
      return `- ${parts.join('｜')}`
    })
    return [
      '## 最近學識嘅講法 / SLANG（用啱語境先用，唔好硬塞）',
      ...lines,
      '唔肯定語境就唔好用。用得密過頭反而似機器。',
    ].join('\n')
  }

  stats() {
    return {
      total: this.terms.length,
      approved: this.approved.length,
      pending: this.pending.length,
      rejected: this.terms.filter((term) => term.status === 'rejected').length,
      top: this.approved
        .slice()
        .sort((a, b) => (b.hits ?? 0) - (a.hits ?? 0))
        .slice(0, 5)
        .map((term) => `${term.term}(${term.hits ?? 0})`),
    }
  }

  pendingList() {
    return this.pending.map(view)
  }
}

function normalise(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^#+/, '')
}

function view(entry) {
  return {
    id: entry.id,
    term: entry.term,
    meaning: entry.meaning,
    usage: entry.usage,
    example: entry.example,
    status: entry.status,
    hits: entry.hits ?? 0,
  }
}
