import assert from 'node:assert/strict'
import test from 'node:test'

import { describeConfig, resolveConfig } from '../lib/config.js'

test('defaults are safe: dryrun transport, no self-initiated messages', () => {
  const { config, warnings } = resolveConfig({}, {})
  assert.equal(config.enabled, true)
  assert.equal(config.transport, 'dryrun')
  assert.equal(config.life.enabled, false)
  assert.equal(config.ownerHandle, '')
  assert.equal(config.webhook.path, '/ig-life/webhook')
  assert.equal(config.bridge.replyMode, 'tool-only')
  assert.deepEqual(warnings, [])
})

test('handles and allowlists are normalised from any shape', () => {
  const { config } = resolveConfig({ ownerHandle: '@BigFish', allowlist: 'a, @B;c d' })
  assert.equal(config.ownerHandle, 'bigfish')
  assert.deepEqual(config.allowlist, ['a', 'b', 'c', 'd'])

  const fromArray = resolveConfig({ allowlist: ['@X', 'y'] }).config
  assert.deepEqual(fromArray.allowlist, ['x', 'y'])
})

test('env overrides win over the config file', () => {
  const { config } = resolveConfig(
    { transport: 'dryrun', ownerHandle: 'fromfile' },
    { IG_LIFE_TRANSPORT: 'graph', IG_LIFE_OWNER: 'FromEnv', IG_LIFE_GRAPH_TOKEN: 'tok-123' },
  )
  assert.equal(config.transport, 'graph')
  assert.equal(config.ownerHandle, 'fromenv')
  assert.equal(config.graph.accessToken, 'tok-123')
})

test('numbers are coerced and clamped', () => {
  const { config } = resolveConfig({
    limits: { dmPerDay: '9999', postsPerDay: -3, replyCooldownSeconds: 'abc' },
    life: { tickSeconds: 1 },
    memory: { keepFraction: 5 },
  })
  assert.equal(config.limits.dmPerDay, 500)
  assert.equal(config.limits.postsPerDay, 0)
  assert.equal(config.limits.replyCooldownSeconds, 20)
  assert.equal(config.life.tickSeconds, 20)
  assert.equal(config.memory.keepFraction, 1)
})

test('booleans accept common spellings', () => {
  const { config } = resolveConfig({ life: { enabled: 'yes' }, replyToStrangers: '0' })
  assert.equal(config.life.enabled, true)
  assert.equal(config.replyToStrangers, false)
})

test('unknown enums fall back with a warning instead of failing', () => {
  const { config, warnings } = resolveConfig({ transport: 'carrier-pigeon', bridge: { replyMode: 'telepathy' } })
  assert.equal(config.transport, 'dryrun')
  assert.equal(config.bridge.replyMode, 'tool-only')
  assert.ok(warnings.some((warning) => warning.includes('carrier-pigeon')))
  assert.ok(warnings.some((warning) => warning.includes('telepathy')))
})

test('graph transport without credentials warns', () => {
  const { warnings } = resolveConfig({ transport: 'graph' })
  assert.ok(warnings.some((warning) => warning.includes('accessToken')))
  assert.ok(warnings.some((warning) => warning.includes('igUserId')))
})

test('life without an owner warns', () => {
  const { warnings } = resolveConfig({ life: { enabled: true } })
  assert.ok(warnings.some((warning) => warning.includes('ownerHandle')))
})

test('webhook path is normalised', () => {
  assert.equal(resolveConfig({ webhook: { path: 'hook' } }).config.webhook.path, '/hook')
  assert.equal(resolveConfig({ webhook: { path: '/a/b/' } }).config.webhook.path, '/a/b/')
})

test('describeConfig never leaks a token', () => {
  const { config } = resolveConfig({ transport: 'graph', graph: { accessToken: 'IGAAsecretvalue123', verifyToken: 'verify-me' } })
  const described = JSON.stringify(describeConfig(config))
  assert.ok(!described.includes('IGAAsecretvalue123'))
  assert.ok(described.includes('IGAA***'))
})
