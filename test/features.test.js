/**
 * Persona editing + the reply-pace setting.
 *
 * The rule the tests pin: the bundled example persona is never written to.
 * The first edit copies it beside the data dir and every later edit lands
 * there — a folder with only style.md must never become the active persona.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import {
  BUNDLED_PERSONA_DIR,
  PERSONA_FILES,
  editablePersonaDir,
  ensurePersonaDir,
  loadPersona,
  readPersonaFiles,
  resolvePersonaDir,
  writePersonaFile,
} from '../lib/persona.js'
import { pickEditable, readOverlay, saveOverlay } from '../lib/settings.js'
import { dmEvent, makeWorld, tempDir } from './helpers.js'

test('the bundled persona is the default until someone edits', () => {
  const dataDir = path.join(tempDir(), 'data')
  assert.equal(resolvePersonaDir(''), BUNDLED_PERSONA_DIR)
  assert.equal(resolvePersonaDir('', dataDir), BUNDLED_PERSONA_DIR)
  fs.mkdirSync(path.join(dataDir, 'persona'), { recursive: true })
  assert.equal(resolvePersonaDir('', dataDir), path.join(dataDir, 'persona'))
})

test('an explicit personaPath always wins', () => {
  const own = tempDir('ig-life-persona-')
  assert.equal(resolvePersonaDir(own, tempDir()), own)
})

test('the first edit materialises all three files, so none goes missing', async () => {
  const dataDir = tempDir('ig-life-edit-')
  const target = editablePersonaDir({ dataDir })
  const active = resolvePersonaDir('', dataDir)
  const files = await readPersonaFiles(active)

  await ensurePersonaDir(target, files)
  for (const name of PERSONA_FILES) {
    if (files[name]) assert.ok(fs.existsSync(path.join(target, name)), `${name} should be copied`)
  }

  await writePersonaFile(target, 'style.md', '講嘢短，唔用 emoji。')
  const loaded = await loadPersona(resolvePersonaDir('', dataDir))
  assert.equal(loaded.style.trim(), '講嘢短，唔用 emoji。')
  assert.ok(loaded.identity.length > 0, 'the copied identity must still be there')
  assert.ok(!loaded.missing.length, `nothing should be missing: ${loaded.missing.join(', ')}`)
})

test('only the three known persona files can be written', async () => {
  const dir = tempDir('ig-life-guard-')
  await assert.rejects(() => writePersonaFile(dir, 'seed.json', '[]'))
  await assert.rejects(() => writePersonaFile(dir, '../escape.md', 'x'))
})

test('the bundled example is never modified', async () => {
  const before = fs.readFileSync(path.join(BUNDLED_PERSONA_DIR, 'persona.md'), 'utf8')
  const dataDir = tempDir('ig-life-safety-')
  const target = editablePersonaDir({ dataDir })
  await ensurePersonaDir(target, await readPersonaFiles(BUNDLED_PERSONA_DIR))
  await writePersonaFile(target, 'persona.md', '新的身份')
  const after = fs.readFileSync(path.join(BUNDLED_PERSONA_DIR, 'persona.md'), 'utf8')
  assert.equal(after, before)
})

test('the reply delay is part of the editable settings', () => {
  const { config } = resolveConfig({ transport: 'dryrun' })
  const editable = pickEditable(config)
  assert.deepEqual(editable.bridge.replyDelaySeconds, { min: 2, max: 12 })

  const dir = tempDir('ig-life-delay-')
  const saved = saveOverlay(dir, { bridge: { replyDelaySeconds: { min: 4, max: 9 } } })
  assert.equal(saved.ok, true)
  assert.equal(readOverlay(dir).bridge.replyDelaySeconds.min, 4)

  const { config: reloaded } = resolveConfig({ transport: 'dryrun', ...readOverlay(dir) })
  assert.deepEqual(reloaded.bridge.replyDelaySeconds, { min: 4, max: 9 })
})

test('a negative or inverted delay is clamped, not trusted', () => {
  const { config } = resolveConfig({ bridge: { replyDelaySeconds: { min: -5, max: 9999 } } })
  assert.equal(config.bridge.replyDelaySeconds.min, 0)
  assert.equal(config.bridge.replyDelaySeconds.max, 600)
})


test('two quick messages are understood as one turn, not two', async () => {
  const { bridge, store } = await makeWorld({
    configOverrides: { bridge: { burstWindowSeconds: 0.05, burstMaxWaitSeconds: 0.2 } },
  })
  const seen = []
  const original = bridge.handle.bind(bridge)
  bridge.handle = async (event) => {
    seen.push(event)
    return original(event)
  }

  await bridge.ingest([dmEvent({ externalId: 'burst-1', text: 'hi' })])
  await bridge.ingest([dmEvent({ externalId: 'burst-2', text: '你能 send reels 嗎' })])
  await new Promise((resolve) => setTimeout(resolve, 150))

  assert.equal(seen.length, 1, 'one turn for a burst')
  assert.equal(seen[0].text, 'hi\n你能 send reels 嗎')
  assert.equal(seen[0].burst, 2)
  assert.ok(store)
})

test('flushPending answers a waiting burst immediately', async () => {
  const { bridge } = await makeWorld({
    configOverrides: { bridge: { burstWindowSeconds: 5, burstMaxWaitSeconds: 10 } },
  })
  const seen = []
  bridge.handle = async (event) => {
    seen.push(event)
    return true
  }
  await bridge.ingest([dmEvent({ externalId: 'flush-1', text: '喂' })])
  assert.equal(seen.length, 0, 'nothing is answered while the window is open')
  await bridge.flushPending()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].text, '喂')
})

test('with the window at 0 the message is answered at once', async () => {
  const { bridge } = await makeWorld({ configOverrides: { bridge: { burstWindowSeconds: 0 } } })
  const seen = []
  bridge.handle = async (event) => {
    seen.push(event)
    return true
  }
  await bridge.ingest([dmEvent({ externalId: 'now-1', text: 'hi' })])
  assert.equal(seen.length, 1)
})

test('the burst window is editable and clamped', () => {
  const { config } = resolveConfig({ transport: 'dryrun' })
  assert.equal(pickEditable(config).bridge.burstWindowSeconds, 6)
  assert.equal(resolveConfig({ bridge: { burstWindowSeconds: 9999 } }).config.bridge.burstWindowSeconds, 120)
  assert.equal(resolveConfig({ bridge: { burstWindowSeconds: -1 } }).config.bridge.burstWindowSeconds, 0)
})
