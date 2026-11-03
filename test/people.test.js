import assert from 'node:assert/strict'
import test from 'node:test'

import { People } from '../lib/people.js'
import { makeConfig, makeStore } from './helpers.js'

async function makePeople(overrides = {}, logger = null) {
  const store = await makeStore()
  const config = makeConfig(overrides)
  const people = await new People({ store, config, logger: logger ?? (() => {}) }).load()
  return { store, config, people }
}

test('touch normalises the handle, creates the record and counts messages', async () => {
  const { people } = await makePeople()
  const at = new Date('2026-01-01T12:00:00Z')
  const person = people.touch('@BigFish', { nickname: '大魚', at })

  assert.equal(person.handle, 'bigfish')
  assert.equal(people.get('BIGFISH'), person)
  assert.equal(people.get(' @bigfish '), person)
  assert.equal(person.messages, 1)
  assert.equal(person.firstSeenAt, at.toISOString())

  people.touch('@bigfish', { nickname: '改咗嘅名', at: new Date('2026-01-02T12:00:00Z') })
  assert.equal(person.messages, 2)
  assert.equal(person.lastSeenAt, new Date('2026-01-02T12:00:00Z').toISOString())
  // a nickname is only ever filled once
  assert.equal(person.nickname, '大魚')

  // an empty handle is not a person
  assert.equal(people.touch('   '), null)
  assert.equal(people.size, 1)
})

test('setImpression truncates to people.impressionLength', async () => {
  const { config, people } = await makePeople()
  people.touch('friend')
  const result = await people.setImpression('friend', '好'.repeat(500))
  assert.equal(result.ok, true)
  assert.equal(result.impression.length, config.people.impressionLength)
  assert.equal(people.get('friend').impression, result.impression)

  // an unknown handle can be created on the way, but only through a real write
  const fresh = await makePeople({ people: { impressionLength: 20 } })
  const narrow = await fresh.people.setImpression('@New', '字'.repeat(80))
  assert.equal(narrow.impression.length, 20)
})

test('addTopic de-dupes, keeps the newest first and caps at six', async () => {
  const { people } = await makePeople()
  people.touch('friend')

  assert.deepEqual((await people.addTopic('friend', '旅行')).topics, ['旅行'])
  // the same topic moves to the front instead of duplicating
  assert.deepEqual((await people.addTopic('friend', '旅行')).topics, ['旅行'])

  for (const topic of ['a', 'b', 'c', 'd', 'e', 'f']) await people.addTopic('friend', topic)
  const { topics } = people.get('friend')
  assert.equal(topics.length, 6)
  assert.equal(topics[0], 'f')
  assert.ok(!topics.includes('旅行'), 'the oldest topic is pushed out')

  const empty = await people.addTopic('friend', '  ')
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'IG_EMPTY_TOPIC')
})

test('dropTopic removes a matching topic and reports whether it did', async () => {
  const { people } = await makePeople()
  people.touch('friend')
  await people.addTopic('friend', '旅行')
  await people.addTopic('friend', '工作')

  assert.equal(await people.dropTopic('friend', '旅行'), true)
  assert.deepEqual(people.get('friend').topics, ['工作'])
  assert.equal(await people.dropTopic('friend', '旅行'), false)
  assert.equal(await people.dropTopic('nobody', '旅行'), false)
})

test('addNote caps at twelve and keeps the newest first', async () => {
  const { people } = await makePeople()
  people.touch('friend')
  for (let index = 0; index < 15; index += 1) {
    const result = await people.addNote('friend', `細節 ${index}`)
    assert.equal(result.ok, true)
  }
  const { notes } = people.get('friend')
  assert.equal(notes.length, 12)
  assert.equal(notes[0], '細節 14')
  assert.ok(!notes.includes('細節 2'))

  const empty = await people.addNote('friend', '   ')
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'IG_EMPTY_NOTE')
})

test('bond clamps affection between -100 and 100', async () => {
  const { people } = await makePeople()
  people.touch('friend')

  assert.deepEqual(await people.bond('friend', 30), { ok: true, affection: 30 })
  assert.deepEqual(await people.bond('friend', 500), { ok: true, affection: 100 })
  assert.deepEqual(await people.bond('friend', -1000), { ok: true, affection: -100 })
  assert.deepEqual(await people.bond('nobody', 1), { ok: false })
})

test('promptBlock carries handle, count, impression and topics', async () => {
  const { people } = await makePeople()
  people.touch('friend')
  await people.setImpression('friend', '講嘢好直接，鍾意深夜傾偈')
  await people.addTopic('friend', '未講完嘅旅行')
  await people.addNote('friend', '怕凍')

  const block = people.promptBlock('friend')
  assert.match(block, /@friend/)
  // touch + setImpression + addTopic + addNote: every write path counts as seeing them
  assert.match(block, /你同佢講過 4 次話/)
  assert.match(block, /講嘢好直接，鍾意深夜傾偈/)
  assert.match(block, /未講完嘅旅行/)
  assert.match(block, /怕凍/)
  // the owner line is only there for the owner
  assert.ok(!block.includes('你主人'))
  assert.match(people.promptBlock('friend', { isOwner: true }), /你主人/)
})

test('promptBlock is empty for a handle nobody has seen', async () => {
  const { people } = await makePeople()
  people.touch('friend')
  assert.equal(people.promptBlock('stranger'), '')
  assert.equal(people.promptBlock(''), '')
})

test('an impression about one person never leaks into another', async () => {
  const { people } = await makePeople()
  people.touch('a')
  people.touch('b')
  await people.setImpression('a', '佢好鍾意食辣，一食辣就肚痛')
  await people.addTopic('a', '秘密話題')

  const aboutB = people.promptBlock('b')
  assert.ok(!aboutB.includes('辣'))
  assert.ok(!aboutB.includes('秘密話題'))
  assert.match(aboutB, /@b/)

  const aboutA = people.promptBlock('a')
  assert.match(aboutA, /辣/)
  assert.match(aboutA, /秘密話題/)
})

test('listing sorts by most recent lastSeenAt', async () => {
  const { people } = await makePeople()
  people.touch('old', { at: new Date('2026-01-01T00:00:00Z') })
  people.touch('newest', { at: new Date('2026-03-01T00:00:00Z') })
  people.touch('middle', { at: new Date('2026-02-01T00:00:00Z') })

  assert.deepEqual(
    people.listing().map((person) => person.handle),
    ['newest', 'middle', 'old'],
  )
  assert.equal(people.listing({ limit: 2 }).length, 2)
})

test('stats counts people with an impression and with topics', async () => {
  const { people } = await makePeople()
  people.touch('a')
  people.touch('b')
  people.touch('c')
  await people.setImpression('a', '幾好人')
  await people.addTopic('b', '旅行')

  assert.deepEqual(people.stats(), { total: 3, withImpression: 1, withTopics: 1 })
})

test('people.maxPeople is enforced without throwing', async () => {
  const logged = []
  const { people } = await makePeople({ people: { maxPeople: 1 } }, (level, message) => logged.push(`${level}:${message}`))

  assert.ok(people.touch('first'))
  // over the cap: a documented null instead of an exception
  assert.equal(people.touch('second'), null)
  assert.equal(people.size, 1)
  assert.ok(logged.some((line) => line.startsWith('warn:') && line.includes('maxPeople')))
  // the existing person keeps working
  assert.equal(people.touch('first').messages, 2)
})
