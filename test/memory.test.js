import assert from 'node:assert/strict'
import test from 'node:test'

import { clarityOf, consolidate, createMemory, rank, tierOf, tokenize, TIER } from '../lib/memory.js'

const config = {
  anchorCount: 2,
  recentCount: 2,
  importanceThreshold: 0.75,
  recallPromotionCount: 3,
  decayHalfLifeDays: 21,
  keepFraction: 0.5,
  injectLimit: 5,
}

const daysAgo = (days) => new Date(Date.now() - days * 86_400_000)

test('createMemory normalises fields and rejects empty content', () => {
  const memory = createMemory({ content: '  我今日     好開心  ', kind: 'nonsense', importance: 5 })
  assert.equal(memory.content, '我今日 好開心')
  assert.equal(memory.kind, 'episode')
  assert.equal(memory.importance, 1)
  assert.equal(memory.recallCount, 0)
  assert.ok(memory.id)
  assert.throws(() => createMemory({ content: '   ' }), /must not be empty/)
})

test('tiers: anchors by pin/identity/age, important by score, recent by recency', () => {
  const list = [
    createMemory({ content: 'anchor one', kind: 'fact', at: daysAgo(100) }),
    createMemory({ content: 'anchor two', at: daysAgo(90) }),
    createMemory({ content: 'pinned', pinned: true, at: daysAgo(50) }),
    createMemory({ content: 'identity', kind: 'identity', at: daysAgo(40) }),
    createMemory({ content: 'very important', importance: 0.9, at: daysAgo(30) }),
    createMemory({ content: 'rehearsed', at: daysAgo(25), recallCount: 3 }),
    createMemory({ content: 'middle', at: daysAgo(10) }),
    createMemory({ content: 'newest', at: daysAgo(1) }),
  ]
  const total = list.length
  // recentCount 1 so that exactly the newest entry is "眼前" and the one before
  // it is old enough to fade — that is the boundary this test is about.
  const narrow = { ...config, recentCount: 1 }
  const tier = (index) => tierOf(list[index], { index, total, config: narrow, now: new Date() })

  assert.equal(tier(0), TIER.ANCHOR) // 最早的錨點
  assert.equal(tier(1), TIER.ANCHOR)
  assert.equal(tier(2), TIER.ANCHOR) // 被釘住
  assert.equal(tier(3), TIER.ANCHOR) // identity 永遠係核心
  assert.equal(tier(4), TIER.IMPORTANT) // importance 夠高
  assert.equal(tier(5), TIER.IMPORTANT) // 被反覆想起
  assert.equal(tier(6), TIER.FADING) // 中間、唔重要、唔新 → 會淡
  assert.equal(tier(7), TIER.RECENT) // 眼前
})

test('clarity: anchors do not fade, the tail does', () => {
  const anchor = createMemory({ content: 'core', pinned: true, at: daysAgo(400) })
  const faded = createMemory({ content: 'trivia', importance: 0.2, at: daysAgo(60) })
  const anchorClarity = clarityOf(anchor, { tier: TIER.ANCHOR, config })
  const fadedClarity = clarityOf(faded, { tier: TIER.FADING, config })
  assert.ok(anchorClarity > 0.9, `anchor clarity ${anchorClarity}`)
  assert.ok(fadedClarity < 0.2, `faded clarity ${fadedClarity}`)
  assert.ok(clarityOf(anchor, { tier: TIER.ANCHOR, config }) >= clarityOf(createMemory({ content: 'x', at: daysAgo(300) }), { tier: TIER.FADING, config }))
})

test('tokenize makes CJK bigrams and keeps latin words', () => {
  const tokens = tokenize('大肥魚 Instagram 好開心')
  assert.ok(tokens.has('大肥'))
  assert.ok(tokens.has('肥魚'))
  assert.ok(tokens.has('instagram'))
  assert.ok(tokens.has('好開'))
})

test('rank puts the relevant memory first and rehearses what it returns', () => {
  const list = [
    createMemory({ content: '我唔食辣，食辣會肚痛', kind: 'fact', importance: 0.6 }),
    createMemory({ content: '今日落雨，我企喺窗邊睇咗好耐', at: daysAgo(2) }),
    createMemory({ content: '我鍾意深夜聽歌', importance: 0.5 }),
  ]
  const hits = rank(list, '你記唔記得我食唔食辣', { config: { ...config, injectLimit: 3 }, now: new Date() })
  assert.equal(hits.length, 3)
  assert.match(hits[0].memory.content, /辣/)
  assert.equal(hits[0].memory.recallCount, 1)
  assert.ok(hits[0].score > hits.at(-1).score)
})

test('rank with touch:false leaves recall counters alone', () => {
  const list = [createMemory({ content: 'hello world' })]
  rank(list, 'hello', { config, touch: false })
  assert.equal(list[0].recallCount, 0)
})

test('consolidate promotes rehearsed memories and prunes the faded tail', () => {
  const now = new Date()
  const kept = [
    createMemory({ content: 'anchor', pinned: true, at: daysAgo(300) }),
    createMemory({ content: 'important', importance: 0.9, at: daysAgo(40) }),
  ]
  // six faded memories from the same day: only half survive
  const faded = Array.from({ length: 6 }, (_, index) =>
    createMemory({ content: `faded trivia ${index}`, importance: 0.1 + index * 0.01, at: daysAgo(90) }),
  )
  const rehearsed = createMemory({ content: 'asked about a lot', importance: 0.4, at: daysAgo(80), recallCount: 5 })

  const result = consolidate([...kept, ...faded, rehearsed], { now, config: { ...config, recentCount: 0 } })
  assert.equal(result.before, 9)
  assert.ok(result.pruned.length >= 3, `pruned ${result.pruned.length}`)
  assert.ok(result.kept.length < result.before)
  assert.equal(result.promoted.length, 1)
  assert.equal(rehearsed.importance >= 0.75, true)
  // anchors are never pruned
  assert.ok(result.kept.some((memory) => memory.content === 'anchor'))
  assert.ok(result.pruned.every((memory) => memory.recallCount < 3))
})

test('consolidate with keepFraction 1 prunes nothing', () => {
  const memories = Array.from({ length: 4 }, (_, index) => createMemory({ content: `x${index}`, at: daysAgo(100) }))
  const result = consolidate(memories, { now: new Date(), config: { ...config, keepFraction: 1 } })
  assert.equal(result.pruned.length, 0)
})
