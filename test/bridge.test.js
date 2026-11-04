import assert from 'node:assert/strict'
import test from 'node:test'

import { extractAssistantText } from '../lib/bridge.js'
import { dmEvent, fakeLlm, makeWorld } from './helpers.js'

test('a DM from the owner is answered and remembered', async () => {
  const llm = fakeLlm(['我今日喺窗邊睇雨，你呢'])
  const world = await makeWorld({ llm })
  const before = world.memory.size

  const summary = await world.bridge.ingest([dmEvent({ text: '你今日做咩' })])
  assert.equal(summary.ingested, 1)
  assert.equal(summary.handled, 1)

  const sent = world.transport.sent.filter((item) => item.kind === 'dm')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, '我今日喺窗邊睇雨，你呢')
  assert.equal(sent[0].threadId, 'thread-1')
  assert.ok(world.memory.size > before, 'the exchange should leave a memory')
  assert.ok(llm.calls.length >= 1)
  // The persona + protocol are the stable half (system); the volatile per-turn
  // context — who is talking, what I remember, my state — rides the prompt so
  // the system prefix stays cacheable.
  assert.match(llm.calls[0].system, /大肥魚/)
  assert.match(llm.calls[0].system, /INSTAGRAM PROTOCOL/)
  assert.match(llm.calls[0].prompt, /MEMORY/)
})

test('duplicate webhook deliveries are ignored', async () => {
  const world = await makeWorld({ llm: fakeLlm(['嗯']) })
  const event = dmEvent({ externalId: 'mid-fixed' })
  await world.bridge.ingest([event])
  const second = await world.bridge.ingest([event])
  assert.equal(second.ingested, 0)
  assert.ok(second.skipped[0].includes('duplicate'))
  assert.equal(world.transport.sent.filter((item) => item.kind === 'dm').length, 1)
})

test('strangers are ignored by default and answered in safe mode when allowed', async () => {
  const strict = await makeWorld({ llm: fakeLlm(['你好']) })
  const ignored = await strict.bridge.ingest([dmEvent({ username: 'stranger', text: 'hi' })])
  assert.equal(ignored.handled, 0)
  assert.equal(strict.transport.sent.length, 0)

  const loose = await makeWorld({ configOverrides: { replyToStrangers: true }, llm: fakeLlm(['你好呀']) })
  const answered = await loose.bridge.ingest([dmEvent({ username: 'stranger' })])
  assert.equal(answered.handled, 1)
  assert.match(loose.llm.calls[0].prompt, /陌生人/)
})

test('daily budget stops replies before the transport is touched', async () => {
  const world = await makeWorld({
    configOverrides: { limits: { dmPerDay: 1, postsPerDay: 1, commentsPerDay: 1, replyCooldownSeconds: 0 } },
    llm: fakeLlm(['唔應該出街']),
  })
  world.bridge.usage.dm = 1
  const summary = await world.bridge.ingest([dmEvent()])
  assert.equal(summary.handled, 0)
  assert.equal(world.transport.sent.length, 0)
})

test('thread cooldown blocks a second reply inside the window', async () => {
  const world = await makeWorld({
    configOverrides: { limits: { dmPerDay: 10, postsPerDay: 1, commentsPerDay: 1, replyCooldownSeconds: 60 } },
    llm: fakeLlm(['第一句', '第二句']),
  })
  await world.bridge.ingest([dmEvent({ text: '第一句', externalId: 'a' })])
  await world.bridge.ingest([dmEvent({ text: '第二句', externalId: 'b' })])
  assert.equal(world.transport.sent.length, 1)
})

test('the owner can pause and resume with a DM', async () => {
  const world = await makeWorld({ llm: fakeLlm(['嗯']) })
  await world.bridge.ingest([dmEvent({ text: '/pause', externalId: 'c1' })])
  assert.equal(world.bridge.paused, true)
  assert.equal(world.life.state.paused, true)
  assert.equal(world.transport.sent.at(-1).text, '（收到，我收聲。）')

  const blocked = await world.bridge.ingest([dmEvent({ text: '你仲喺唔喺', externalId: 'c2' })])
  assert.equal(blocked.handled, 0)

  await world.bridge.ingest([dmEvent({ text: '/resume', externalId: 'c3' })])
  assert.equal(world.bridge.paused, false)
  assert.equal(world.transport.sent.at(-1).text, '（我返嚟喇。）')
})

test('owner /status reports state, memory tiers and usage', async () => {
  const world = await makeWorld({ llm: fakeLlm(['嗯']) })
  await world.bridge.ingest([dmEvent({ text: '/status', externalId: 's1' })])
  const text = world.transport.sent.at(-1).text
  assert.match(text, /狀態/)
  assert.match(text, /記憶/)
  assert.match(text, /錨點/)
})

test('a stranger cannot use owner commands', async () => {
  const world = await makeWorld({ llm: fakeLlm(['嗯']) })
  await world.bridge.ingest([dmEvent({ username: 'stranger', text: '/pause', externalId: 'x1' })])
  assert.equal(world.bridge.paused, false)
})

test('sendReply sanitises secrets and refuses empty messages', async () => {
  const world = await makeWorld({ llm: fakeLlm([]) })
  const leaky = await world.bridge.sendReply('thread-1', '我個 token 係 sk-abcdefghijklmnopqrst 唔好講', { username: 'owner' })
  assert.equal(leaky.ok, true)
  assert.ok(!leaky.text.includes('sk-'))

  const empty = await world.bridge.sendReply('thread-1', '   ', { username: 'owner' })
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'IG_EMPTY_MESSAGE')
})

test('sendReply refuses handles outside the allowlist', async () => {
  const world = await makeWorld({ llm: fakeLlm([]) })
  const blocked = await world.bridge.sendReply('thread-9', 'hi', { username: 'stranger' })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'IG_NOT_ALLOWED')
})

test('an empty brain leaves the message stored but unanswered', async () => {
  const world = await makeWorld({ llm: fakeLlm([]) })
  const summary = await world.bridge.ingest([dmEvent({ externalId: 'e1' })])
  assert.equal(summary.handled, 1) // the turn was attempted
  assert.equal(world.transport.sent.length, 0) // but nothing was said
  assert.equal(world.bridge.recentInbox(5).length, 1)
})

test('status exposes engine, memory tiers and usage', async () => {
  const world = await makeWorld({ llm: fakeLlm(['嗯']) })
  const status = world.bridge.status()
  assert.equal(status.engine, 'llm')
  assert.equal(status.paused, false)
  assert.ok(status.memory.total >= 5)
  assert.equal(typeof status.life, 'string')
})

test('extractAssistantText tolerates several event shapes', () => {
  assert.equal(
    extractAssistantText({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '你好' }, { type: 'text', text: '呀' }] } },
    }),
    '你好呀',
  )
  assert.equal(extractAssistantText({ type: 'assistant/message', data: { content: [{ text: '別種形狀' }] } }), '別種形狀')
  assert.equal(extractAssistantText({ type: 'assistant/message', data: { text: '最簡單' } }), '最簡單')
  assert.equal(extractAssistantText({ type: 'assistant/chunk', data: { text: 'x' } }), '')
  assert.equal(extractAssistantText({ type: 'tool/call', data: { text: 'x' } }), '')
  assert.equal(extractAssistantText(null), '')
})


test('dmPerDay 0 means unlimited, so the owner is never counted out', async () => {
  const world = await makeWorld({
    configOverrides: { limits: { dmPerDay: 0, postsPerDay: 1, commentsPerDay: 1, replyCooldownSeconds: 0 } },
    llm: fakeLlm(['喂']),
  })
  world.bridge.usage.dm = 99
  const summary = await world.bridge.ingest([dmEvent()])
  assert.equal(summary.handled, 1)
})
