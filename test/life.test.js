import assert from 'node:assert/strict'
import test from 'node:test'

import { advanceState, createInitialState, describeState, Life, moodLabel } from '../lib/life.js'
import { fakeLlm, makeConfig, makeStore } from './helpers.js'
import { MemoryBook } from '../lib/book.js'
import { loadPersona } from '../lib/persona.js'
import { fakeTransport } from './helpers.js'

/** Pin Math.random so a probabilistic step is testable. */
async function withRandom(value, run) {
  const original = Math.random
  Math.random = () => value
  try {
    return await run()
  } finally {
    Math.random = original
  }
}

const NOON = new Date('2026-01-01T12:00:00Z')
const MIDNIGHT = new Date('2026-01-01T03:00:00Z')

test('advanceState drains energy while awake and refills it while asleep', () => {
  const awakeConfig = makeConfig()
  const hour = 60 * 60_000
  const awake = createInitialState(new Date(NOON.getTime() - hour))
  const drained = advanceState(awake, { now: NOON, config: awakeConfig })
  assert.ok(drained.state.energy < 72, 'energy should drain over an awake hour')

  // 03:00 local with a 09:00–23:00 day means it is asleep and should recover.
  const nightConfig = makeConfig({ life: { wakeHour: 9, sleepHour: 23 } })
  const nightNow = new Date('2026-01-02T03:00:00Z')
  const asleep = { ...createInitialState(new Date(nightNow.getTime() - hour)), energy: 20, awake: false }
  const refilled = advanceState(asleep, { now: nightNow, config: nightConfig })
  assert.ok(refilled.state.energy > 20, `energy should refill over an asleep hour, got ${refilled.state.energy}`)
  assert.equal(refilled.state.awake, false)
})

test('advanceState reports waking up, falling asleep and a new day', () => {
  const config = makeConfig({ life: { wakeHour: 9, sleepHour: 23 } })
  const nightOwl = { ...createInitialState(), awake: true, energy: 60 }
  nightOwl.lastTickAt = new Date('2026-01-01T22:30:00Z').toISOString()
  const night = advanceState(nightOwl, { now: new Date('2026-01-01T23:30:00Z'), config })
  assert.ok(night.events.includes('眼訓到投降，去咗訓'))
  assert.equal(night.state.awake, false)

  const morning = advanceState({ ...night.state }, { now: new Date('2026-01-02T09:30:00Z'), config })
  assert.ok(morning.events.includes('醒咗'))
  assert.ok(morning.events.includes('新嘅一日'))
  assert.equal(morning.state.awake, true)
  assert.equal(morning.state.turnsToday, 0)
})

test('moodLabel turns two numbers into a word a character could use', () => {
  assert.equal(moodLabel(0.9, 0.9), '雀躍')
  assert.equal(moodLabel(0.9, 0.1), '心入面暖暖地')
  assert.equal(moodLabel(0, 0.1), '發呆中')
  assert.equal(moodLabel(-0.9, 0.9), '心裡面好嘈')
})

test('describeState is human readable and mentions the age', () => {
  const text = describeState(createInitialState(NOON), NOON)
  assert.match(text, /出世第 1 日/)
  assert.match(text, /體力/)
  assert.match(text, /親近感/)
})

async function makeLife({ configOverrides = {}, llm }) {
  const config = makeConfig(configOverrides)
  const store = await makeStore()
  const persona = await loadPersona()
  const memory = await new MemoryBook({ store, config, persona }).load()
  const transport = fakeTransport()
  const life = await new Life({ config, store, memory, transport, llmBridge: llm, persona }).load()
  return { config, store, persona, memory, transport, life }
}

test('tick does nothing while asleep', async () => {
  const llm = fakeLlm(['唔應該叫醒'])
  const { life, transport } = await makeLife({ configOverrides: { life: { wakeHour: 9, sleepHour: 23 } }, llm })
  const report = await withRandom(0.1, () => life.tick(MIDNIGHT))
  assert.ok(report.skipped.includes('asleep'))
  assert.equal(transport.sent.length, 0)
  assert.equal(llm.calls.length, 0)
})

test('tick can start a conversation on its own', async () => {
  const llm = fakeLlm((options) => {
    if (options.prompt.includes('冇人搵你')) return JSON.stringify({ send: true, text: '喂，你做緊咩', reason: '想起佢' })
    if (options.prompt.includes('內心獨白')) return '窗外冇人。'
    return 'x'
  })
  const { life, transport, memory } = await makeLife({
    configOverrides: { life: { proactiveDmProbability: 1, proactiveCooldownMinutes: 0, postProbability: 0 } },
    llm,
  })
  const before = memory.size
  const report = await withRandom(0.1, () => life.tick(NOON))

  assert.ok(report.proactive, `expected a proactive message, got ${JSON.stringify(report)}`)
  const dm = transport.sent.filter((item) => item.kind === 'dm')
  assert.equal(dm.length, 1)
  assert.equal(dm[0].text, '喂，你做緊咩')
  assert.equal(dm[0].username, 'owner')
  assert.ok(life.state.lastProactiveAt)
  assert.ok(memory.size > before)
})

test('tick stays silent when the character chooses not to reach out', async () => {
  const llm = fakeLlm((options) => {
    if (options.prompt.includes('冇人搵你')) return JSON.stringify({ send: false, text: '', reason: '唔想煩佢' })
    return '嗯'
  })
  const { life, transport } = await makeLife({
    configOverrides: { life: { proactiveDmProbability: 1, proactiveCooldownMinutes: 0, postProbability: 0 } },
    llm,
  })
  const report = await withRandom(0.1, () => life.tick(NOON))
  assert.equal(report.proactive, null)
  assert.equal(transport.sent.length, 0)
})

test('proactive cooldown prevents a second unprompted message', async () => {
  const llm = fakeLlm((options) =>
    options.prompt.includes('冇人搵你') ? JSON.stringify({ send: true, text: '又係我' }) : '嗯',
  )
  const { life, transport } = await makeLife({
    configOverrides: { life: { proactiveDmProbability: 1, proactiveCooldownMinutes: 180, postProbability: 0 } },
    llm,
  })
  await withRandom(0.1, () => life.tick(NOON))
  await withRandom(0.1, () => life.tick(new Date(NOON.getTime() + 60_000)))
  assert.equal(transport.sent.filter((item) => item.kind === 'dm').length, 1)
})

test('tick declines to post when the character has nothing worth keeping', async () => {
  const llm = fakeLlm((options) => {
    if (options.prompt.includes('留低呢一刻')) return JSON.stringify({ post: false, caption: '' })
    return '嗯'
  })
  const { life, transport } = await makeLife({
    configOverrides: { life: { proactiveDmProbability: 0, postProbability: 1, postMinGapHours: 0 } },
    llm,
  })
  const report = await withRandom(0.9, () => life.tick(NOON))
  assert.equal(report.post, null)
  assert.equal(transport.sent.filter((item) => item.kind === 'post').length, 0)
})

test('nightly consolidation runs once per day', async () => {
  const hour = NOON.getUTCHours()
  const llm = fakeLlm(['嗯'])
  const { life, memory } = await makeLife({
    configOverrides: { memory: { consolidateHour: hour }, life: { proactiveDmProbability: 0, postProbability: 0 } },
    llm,
  })
  // make one memory certainly faded and disposable
  await memory.add({ content: '一件唔重要嘅舊事', importance: 0.05, at: new Date(NOON.getTime() - 200 * 86_400_000) })

  const first = await withRandom(0.9, () => life.tick(NOON))
  assert.ok(first.consolidation, 'expected an evening consolidation')
  const second = await withRandom(0.9, () => life.tick(NOON))
  assert.equal(second.consolidation, null, 'must not consolidate twice in one day')
  assert.equal(life.state.lastReflectDay, '2026-01-01')
})

test('tick never throws when the brain is unavailable', async () => {
  const broken = { available: false, reason: 'no llm', generate: async () => null }
  const { life, transport } = await makeLife({
    configOverrides: { life: { proactiveDmProbability: 1, postProbability: 1, postMinGapHours: 0 } },
    llm: broken,
  })
  const report = await withRandom(0.1, () => life.tick(NOON))
  assert.deepEqual(report.errors, [])
  assert.equal(transport.sent.length, 0)
})
