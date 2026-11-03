/** Shared fixtures: a temp store, a recording transport, a scripted brain. */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MemoryBook } from '../lib/book.js'
import { Bridge } from '../lib/bridge.js'
import { resolveConfig } from '../lib/config.js'
import { Life } from '../lib/life.js'
import { createMedia } from '../lib/media.js'
import { People } from '../lib/people.js'
import { loadPersona } from '../lib/persona.js'
import { createReels } from '../lib/reels.js'
import { Lexicon } from '../lib/slang.js'
import { StickerLibrary } from '../lib/stickers.js'
import { JsonStore } from '../lib/store.js'
import { createVision } from '../lib/vision.js'
import { Voice } from '../lib/voice.js'

export function tempDir(prefix = 'ig-life-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export async function makeStore() {
  return new JsonStore(tempDir()).init()
}

/** A config with the time-dependent knobs pinned, so tests never flake. */
export function makeConfig(overrides = {}) {
  const { config } = resolveConfig({
    transport: 'dryrun',
    ownerHandle: 'owner',
    allowlist: ['owner', 'friend'],
    life: { timezone: 'UTC', quietHours: '', wakeHour: 0, sleepHour: 24, ...(overrides.life ?? {}) },
    bridge: { ...(overrides.bridge ?? {}) },
    limits: { ...(overrides.limits ?? {}) },
    memory: { ...(overrides.memory ?? {}) },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['life', 'bridge', 'limits', 'memory'].includes(key))),
  })
  return config
}

export function fakeTransport() {
  const sent = []
  return {
    name: 'fake',
    sent,
    async sendDm(payload) {
      sent.push({ kind: 'dm', ...payload })
      return { id: `sent-${sent.length}` }
    },
    async postPhoto(payload) {
      sent.push({ kind: 'post', ...payload })
      return { mediaId: `media-${sent.length}` }
    },
    async replyComment(payload) {
      sent.push({ kind: 'comment', ...payload })
      return { id: `comment-${sent.length}` }
    },
    async health() {
      return { backend: 'fake', ok: true }
    },
    async close() {},
  }
}

/** A scripted brain. `script` is an array of replies, or a function of the call. */
export function fakeLlm(script = []) {
  const calls = []
  return {
    available: true,
    reason: 'ok',
    route: { provider: 'fake', model: 'fake-1' },
    calls,
    async generate(options) {
      calls.push(options)
      const next = typeof script === 'function' ? script(options) : script.shift()
      return next ?? null
    },
  }
}

/** Build a fully wired world without DSH: store + memory + life + bridge. */
export async function makeWorld({ configOverrides = {}, llm = fakeLlm(), transport = fakeTransport(), persona = null } = {}) {
  const config = makeConfig(configOverrides)
  const store = await makeStore()
  const loadedPersona = persona ?? (await loadPersona())
  const memory = await new MemoryBook({ store, config, persona: loadedPersona }).load()
  const life = await new Life({ config, store, memory, transport, llmBridge: llm, persona: loadedPersona }).load()

  // The optional capability layer, wired the same way index.js does it.
  const media = createMedia({ config, store, fetchImpl: undefined })
  const vision = createVision({ config, store })
  const stickers = await new StickerLibrary({ store, config }).load()
  const voice = new Voice({ config, store })
  await voice.loadPack()
  const reels = createReels({ config, store, vision, media })
  const slang = await new Lexicon({ store, config }).load()
  const people = await new People({ store, config }).load()

  const bridge = await new Bridge({
    ctx: null,
    config,
    store,
    memory,
    transport,
    llmBridge: llm,
    persona: loadedPersona,
    life,
    stickers,
    voice,
    reels,
    slang,
    people,
    vision,
    media,
  }).start()
  return { config, store, persona: loadedPersona, memory, transport, llm, life, bridge, stickers, voice, reels, slang, people, vision, media }
}

export function dmEvent(overrides = {}) {
  return {
    kind: 'dm',
    threadId: 'thread-1',
    senderId: 'igsid-1',
    username: 'owner',
    text: '你今日做咩',
    externalId: `mid-${Math.random().toString(36).slice(2)}`,
    at: new Date('2026-01-01T12:00:00Z'),
    mediaId: '',
    ...overrides,
  }
}
