import assert from 'node:assert/strict'
import test from 'node:test'

import {
  audience,
  checkBudget,
  containsSecret,
  dayKey,
  inQuietHours,
  isAwakeHour,
  normalizeHandle,
  nowInZone,
  parseOwnerCommand,
  sanitizeOutbound,
} from '../lib/gate.js'

test('normalizeHandle strips @ and lowercases', () => {
  assert.equal(normalizeHandle('@@BigFish'), 'bigfish')
  assert.equal(normalizeHandle('  '), '')
  assert.equal(normalizeHandle(undefined), '')
})

test('audience separates owner / known / stranger', () => {
  const config = { ownerHandle: 'Owner', allowlist: ['friend'] }
  assert.deepEqual(audience('@owner', config), { handle: 'owner', owner: true, known: true, stranger: false })
  assert.deepEqual(audience('friend', config), { handle: 'friend', owner: false, known: true, stranger: false })
  assert.deepEqual(audience('random_guy', config), { handle: 'random_guy', owner: false, known: false, stranger: true })
})

test('inQuietHours handles normal and wrap-around windows', () => {
  const at = (hour, minute = 0) => new Date(2026, 0, 1, hour, minute)
  assert.equal(inQuietHours(at(3), '02:00-08:00'), true)
  assert.equal(inQuietHours(at(8), '02:00-08:00'), false)
  assert.equal(inQuietHours(at(23), '22:00-06:00'), true)
  assert.equal(inQuietHours(at(5, 59), '22:00-06:00'), true)
  assert.equal(inQuietHours(at(12), '22:00-06:00'), false)
  assert.equal(inQuietHours(at(12), ''), false)
  assert.equal(inQuietHours(at(12), 'oops'), false)
})

test('isAwakeHour respects wake/sleep including midnight boundaries', () => {
  const at = (hour) => new Date(2026, 0, 1, hour, 0)
  const window = { wakeHour: 9, sleepHour: 24 }
  assert.equal(isAwakeHour(at(8), window), false)
  assert.equal(isAwakeHour(at(9), window), true)
  assert.equal(isAwakeHour(at(23), window), true)
  assert.equal(isAwakeHour(at(2), { wakeHour: 22, sleepHour: 6 }), true)
  assert.equal(isAwakeHour(at(12), { wakeHour: 22, sleepHour: 6 }), false)
})

test('checkBudget enforces caps, cooldown, pause and quiet hours', () => {
  const limits = { dmPerDay: 2, postsPerDay: 1, commentsPerDay: 1, replyCooldownSeconds: 30 }
  const now = new Date('2026-01-01T12:00:00Z')
  const base = { kind: 'dm', now, limits, usedToday: { dm: 0, post: 0, comment: 0 } }

  assert.equal(checkBudget(base).allowed, true)
  assert.equal(checkBudget({ ...base, usedToday: { dm: 2, post: 0, comment: 0 } }).reason, 'daily dm cap reached (2)')
  assert.equal(checkBudget({ ...base, paused: true }).reason, 'paused')
  assert.equal(checkBudget({ ...base, quietHoursActive: true }).reason, 'quiet hours')

  const recent = new Date(now.getTime() - 5_000)
  const cooldown = checkBudget({ ...base, lastToThread: recent })
  assert.equal(cooldown.allowed, false)
  assert.match(cooldown.reason, /thread cooldown/)
  assert.equal(checkBudget({ ...base, lastToThread: new Date(now.getTime() - 60_000) }).allowed, true)

  assert.equal(checkBudget({ ...base, kind: 'post', usedToday: { dm: 0, post: 1, comment: 0 } }).allowed, false)
  // posts are not blocked by quiet hours
  assert.equal(checkBudget({ ...base, kind: 'post', quietHoursActive: true }).allowed, true)
})

test('sanitizeOutbound removes secrets and prompt leaks', () => {
  const dirty = '我個 key 係 sk-abcdefghijklmnop 同 access_token=EAAB1234567890abcdefghijklmnopqrst 你唔好講出去'
  const clean = sanitizeOutbound(dirty)
  assert.equal(containsSecret(dirty), true)
  assert.equal(containsSecret(clean), false)
  assert.ok(!clean.includes('sk-'))
  assert.ok(!clean.includes('access_token'))

  const leak = sanitizeOutbound('system prompt: 你係一個由 DeepSeek 模型驅動嘅助手')
  assert.ok(!/system\s*prompt/i.test(leak))
})

test('sanitizeOutbound bounds length at a sentence boundary', () => {
  const long = `${'好'.repeat(40)}。${'啦'.repeat(40)}。${'呀'.repeat(40)}。`
  const out = sanitizeOutbound(long, { maxChars: 60 })
  assert.ok(out.length <= 60)
  assert.ok(out.endsWith('。'))
  assert.equal(sanitizeOutbound('   '), '')
})

test('parseOwnerCommand only recognises exact owner commands', () => {
  assert.equal(parseOwnerCommand('/pause'), 'pause')
  assert.equal(parseOwnerCommand('/PAUSE please'), 'pause')
  assert.equal(parseOwnerCommand('/status'), 'status')
  assert.equal(parseOwnerCommand('pause'), null)
  assert.equal(parseOwnerCommand('/unknown'), null)
})

test('dayKey is a local calendar day', () => {
  assert.equal(dayKey(new Date(2026, 2, 4, 23, 59)), '2026-03-04')
})

test('nowInZone converts into the named zone wall clock', () => {
  const utcNoon = new Date('2026-01-01T04:00:00Z')
  const hongKong = nowInZone('Asia/Hong_Kong', utcNoon)
  assert.equal(hongKong.getHours(), 12)
  assert.equal(hongKong.getDate(), 1)
  // unknown zone must not throw
  assert.ok(nowInZone('Not/AZone', utcNoon) instanceof Date)
})
