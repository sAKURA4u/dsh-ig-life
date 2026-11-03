import assert from 'node:assert/strict'
import test from 'node:test'

import { Lexicon } from '../lib/slang.js'
import { makeConfig, makeStore } from './helpers.js'

async function makeLexicon(overrides = {}) {
  const store = await makeStore()
  const config = makeConfig(overrides)
  const lexicon = await new Lexicon({ store, config }).load()
  return { store, config, lexicon }
}

const bulletLines = (block) => block.split('\n').filter((line) => line.startsWith('- '))

test('submit needs both a term and a meaning', async () => {
  const { lexicon } = await makeLexicon()
  const noMeaning = await lexicon.submit({ term: '好正', meaning: '  ' })
  assert.equal(noMeaning.ok, false)
  assert.equal(noMeaning.code, 'IG_SLANG_INCOMPLETE')

  const noTerm = await lexicon.submit({ term: '', meaning: '好正嘅意思' })
  assert.equal(noTerm.ok, false)
  assert.equal(noTerm.code, 'IG_SLANG_INCOMPLETE')

  assert.equal(lexicon.terms.length, 0)
})

test('submit always lands as pending — nothing is auto-approved', async () => {
  const { lexicon } = await makeLexicon()
  const result = await lexicon.submit({ term: '好正', meaning: '好正嘅意思', usage: '回應讚美', example: '好正呀' })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'pending')
  assert.equal(result.pending, 1)
  assert.equal(lexicon.approved.length, 0)
  assert.equal(lexicon.pending.length, 1)
})

test('submitting the same term twice collapses into one record', async () => {
  const { lexicon } = await makeLexicon()
  const first = await lexicon.submit({ term: '好正', meaning: '好正嘅意思' })
  const second = await lexicon.submit({ term: ' 好正 ', meaning: '另一個解釋' })
  assert.equal(second.ok, true)
  assert.equal(second.duplicate, true)
  assert.equal(second.id, first.id)
  assert.equal(lexicon.terms.length, 1)
  // the original meaning is kept
  assert.equal(lexicon.terms[0].meaning, '好正嘅意思')
})

test('submit respects slang.maxPending', async () => {
  const { lexicon } = await makeLexicon({ slang: { maxPending: 1 } })
  assert.equal((await lexicon.submit({ term: '好正', meaning: '好正嘅意思' })).ok, true)
  const full = await lexicon.submit({ term: '勁chill', meaning: '好放鬆' })
  assert.equal(full.ok, false)
  assert.equal(full.code, 'IG_SLANG_QUEUE_FULL')
  assert.equal(lexicon.terms.length, 1)
})

test('submit is refused when slang.enabled is false', async () => {
  const { lexicon } = await makeLexicon({ slang: { enabled: false } })
  const result = await lexicon.submit({ term: '好正', meaning: '好正嘅意思' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_SLANG_DISABLED')
  assert.equal(lexicon.terms.length, 0)
  assert.deepEqual(lexicon.pendingList(), [])
})

test('query finds an approved term', async () => {
  const { lexicon } = await makeLexicon()
  const submitted = await lexicon.submit({ term: '好正', meaning: '好正嘅意思' })
  await lexicon.decide(submitted.id, 'approve')

  const found = lexicon.query('好正')
  assert.equal(found.ok, true)
  assert.equal(found.found, true)
  assert.equal(found.status, 'approved')
  assert.equal(found.term.term, '好正')
  assert.equal(found.term.meaning, '好正嘅意思')
})

test('query reports a pending term with a hint and no answer', async () => {
  const { lexicon } = await makeLexicon()
  await lexicon.submit({ term: '好正', meaning: '好正嘅意思' })

  const pending = lexicon.query('好正')
  assert.equal(pending.ok, true)
  assert.equal(pending.found, false)
  assert.equal(pending.status, 'pending')
  assert.match(pending.hint, /主人批准/)
  assert.equal(pending.term, undefined)
})

test('query offers near candidates for a partial match', async () => {
  const { lexicon } = await makeLexicon()
  await lexicon.submit({ term: '報復式旅行', meaning: '一次過玩盡' })

  const near = lexicon.query('旅行')
  assert.equal(near.ok, true)
  assert.equal(near.found, false)
  assert.equal(near.status, undefined)
  assert.equal(near.near.length, 1)
  assert.equal(near.near[0].term, '報復式旅行')
})

test('query with an empty string is an error, not a miss', async () => {
  const { lexicon } = await makeLexicon()
  const result = lexicon.query('   ')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_SLANG_EMPTY')
})

test('decide promotes by id and by term string', async () => {
  const { lexicon } = await makeLexicon()
  const byId = await lexicon.submit({ term: '好正', meaning: '好正嘅意思' })
  await lexicon.submit({ term: '勁chill', meaning: '好放鬆' })

  const promoted = await lexicon.decide(byId.id, 'approve')
  assert.equal(promoted.ok, true)
  assert.equal(promoted.term.status, 'approved')
  assert.equal(lexicon.approved.length, 1)

  const byTerm = await lexicon.decide('勁chill', 'approve')
  assert.equal(byTerm.ok, true)
  assert.equal(byTerm.term.status, 'approved')
  assert.equal(lexicon.approved.length, 2)
})

test('decide reject keeps a term out of the approved pool', async () => {
  const { lexicon } = await makeLexicon()
  const submitted = await lexicon.submit({ term: '好正', meaning: '好正嘅意思' })

  const rejected = await lexicon.decide(submitted.id, 'reject')
  assert.equal(rejected.ok, true)
  assert.equal(rejected.term.status, 'rejected')
  assert.equal(lexicon.approved.length, 0)
  assert.equal(lexicon.pending.length, 0)
  assert.equal(lexicon.stats().rejected, 1)
  // a rejected term is never injected
  assert.equal(lexicon.promptBlock(), '')
  // and query tells the model not to use it
  const answer = lexicon.query('好正')
  assert.equal(answer.found, false)
  assert.equal(answer.status, 'rejected')
  assert.match(answer.hint, /唔好用/)
})

test('decide on an unknown id reports IG_SLANG_NOT_FOUND', async () => {
  const { lexicon } = await makeLexicon()
  const result = await lexicon.decide('nope', 'approve')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IG_SLANG_NOT_FOUND')
})

test('promptBlock is empty until something is approved', async () => {
  const { lexicon } = await makeLexicon()
  assert.equal(lexicon.promptBlock(), '')
  await lexicon.submit({ term: '好正', meaning: '好正嘅意思' })
  assert.equal(lexicon.promptBlock(), '')
})

test('promptBlock carries the approved terms and the do-not-force-it rule', async () => {
  const { lexicon } = await makeLexicon()
  const first = await lexicon.submit({ term: '好正', meaning: '好正嘅意思', usage: '回應讚美' })
  const second = await lexicon.submit({ term: '勁chill', meaning: '好放鬆' })
  await lexicon.decide(first.id, 'approve')
  await lexicon.decide(second.id, 'approve')

  const block = lexicon.promptBlock()
  assert.match(block, /好正/)
  assert.match(block, /勁chill/)
  assert.match(block, /唔好硬塞/)
  assert.equal(bulletLines(block).length, 2)

  const narrow = lexicon.promptBlock({ limit: 1 })
  assert.equal(bulletLines(narrow).length, 1)
})

test('markUsed bumps hits and stats reports the top terms', async () => {
  const { lexicon } = await makeLexicon()
  const submitted = await lexicon.submit({ term: '好正', meaning: '好正嘅意思' })
  await lexicon.decide(submitted.id, 'approve')
  assert.equal(lexicon.terms[0].hits, 0)

  await lexicon.markUsed('好正')
  await lexicon.markUsed('好正')
  assert.equal(lexicon.terms[0].hits, 2)
  assert.ok(!Number.isNaN(Date.parse(lexicon.terms[0].lastUsedAt)))

  // unapproved or unknown terms are not counted
  await lexicon.markUsed('未收錄')
  assert.equal(lexicon.terms[0].hits, 2)

  const stats = lexicon.stats()
  assert.equal(stats.total, 1)
  assert.equal(stats.approved, 1)
  assert.equal(stats.pending, 0)
  assert.deepEqual(stats.top, ['好正(2)'])
})

test('stats and pendingList have the documented shapes', async () => {
  const { lexicon } = await makeLexicon()
  await lexicon.submit({ term: '好正', meaning: '好正嘅意思' })
  const pending = await lexicon.submit({ term: '勁chill', meaning: '好放鬆' })

  const stats = lexicon.stats()
  assert.deepEqual(Object.keys(stats).sort(), ['approved', 'pending', 'rejected', 'top', 'total'])
  assert.equal(stats.total, 2)
  assert.equal(stats.pending, 2)
  assert.deepEqual(stats.top, [])

  const list = lexicon.pendingList()
  assert.equal(list.length, 2)
  assert.deepEqual(Object.keys(list[0]).sort(), ['example', 'hits', 'id', 'meaning', 'status', 'term', 'usage'])
  assert.equal(list[0].status, 'pending')
  assert.ok(list.some((entry) => entry.id === pending.id && entry.term === '勁chill'))
})
