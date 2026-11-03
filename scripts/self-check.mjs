#!/usr/bin/env node
/**
 * End-to-end self check — no DSH, no Instagram account, no API key.
 *
 * It mounts the real plugin (`apply()`) against a mock Cordis context and a
 * scripted brain, feeds it a couple of DMs, runs one life tick, and prints what
 * the character would have said. Use it to verify an install, to see the memory
 * model working, and as a template for your own experiments.
 *
 *   node scripts/self-check.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { mount as apply } from '../lib/index.js'

const lines = []
const say = (text = '') => {
  lines.push(text)
  console.log(text)
}

const FAKE_BRAIN = {
  dm: [
    '我啱啱喺窗邊睇雨。你有冇帶傘',
    '唔想講嘢，但見到你問我就想答吓。',
  ],
  proactive: JSON.stringify({ send: true, text: '喂，你今日有冇食飯', reason: '突然諗起你' }),
  thought: '窗外面嗰條街濕咗，冇人收衫。',
  post: JSON.stringify({ post: false, caption: '', mood: '發呆' }),
}

function scriptedBrain() {
  let dmIndex = 0
  return async function* stream(options) {
    const prompt = options.messages?.map((message) => JSON.stringify(message.content ?? '')).join(' ') ?? ''
    const system = options.system ?? ''
    const haystack = `${system} ${prompt}`
    let reply = '嗯。'
    if (haystack.includes('冇人搵你')) reply = FAKE_BRAIN.proactive
    else if (haystack.includes('內心獨白')) reply = FAKE_BRAIN.thought
    else if (haystack.includes('留低呢一刻')) reply = FAKE_BRAIN.post
    else if (haystack.includes('Instagram 私訊')) reply = FAKE_BRAIN.dm[Math.min(dmIndex++, FAKE_BRAIN.dm.length - 1)]
    // stream it the way a real adapter would
    for (const chunk of reply.match(/[\s\S]{1,12}/g) ?? []) {
      yield { type: 'text-delta', text: chunk }
    }
    yield { type: 'finish', kind: 'ok' }
  }
}

function mockCtx(registeredTools) {
  const services = {
    llm: {
      stream: scriptedBrain(),
      async listProviders() {
        return ['fake']
      },
      async listModels() {
        return ['fake-1']
      },
    },
    tools: {
      register(definition) {
        registeredTools.push(definition.name)
        return () => {}
      },
    },
    webServer: {
      register({ path: routePath }) {
        return () => {
          void routePath
        }
      },
    },
  }
  return {
    get: (key) => services[key],
    effect: (run) => run(),
    interval: () => () => {},
    on: () => () => {},
    logger: () => ({
      info: (message) => say(`  · ${message}`),
      warn: (message) => say(`  ! ${message}`),
      error: (message) => say(`  ✖ ${message}`),
      debug: () => {},
    }),
  }
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-life-selfcheck-'))
const registeredTools = []

say('═'.repeat(72))
say(' dsh-ig-life self check —— 用 dryrun 身體 + 假大腦，唔會發任何真嘢')
say('═'.repeat(72))
say(`資料夾：${dataDir}`)
say()

const handle = await apply(mockCtx(registeredTools), {
  transport: 'dryrun',
  ownerHandle: 'dafish_owner',
  allowlist: ['dafish_owner', 'old_friend'],
  dataDir,
  memory: { consolidateHour: 99 }, // keep the tick from consolidating mid-demo
  life: { enabled: false, timezone: 'Asia/Hong_Kong', quietHours: '', proactiveDmProbability: 1, proactiveCooldownMinutes: 0, postProbability: 0 },
  bridge: { replyMode: 'tool-only' },
})

say(`引擎：${handle.bridge.engine}｜工具：${handle.tools.registered.length} 個 ${handle.tools.registered.length ? `(${handle.tools.registered.join(', ')})` : ''}`)
say(`人格：${handle.persona.name}｜出世記憶：${handle.memory.size} 條`)
say()

// ── 1. 一段對話 ─────────────────────────────────────────────────────────────
say('── 1. 收到私訊 ────────────────────────────────────────────────')
const dm = (overrides) => ({
  kind: 'dm',
  threadId: 'thread-owner',
  senderId: 'igsid-owner',
  username: 'dafish_owner',
  text: '你今日做咩',
  externalId: `mid-${Math.random().toString(36).slice(2, 8)}`,
  at: new Date(),
  mediaId: '',
  ...overrides,
})

const first = await handle.bridge.ingest([dm({ text: '你今日做咩' })])
say(`  ingested=${first.ingested} handled=${first.handled}`)

// a second message straight away: the per-thread cooldown should hold it back
const tooSoon = await handle.bridge.ingest([dm({ text: '喂，答我', externalId: 'mid-too-soon' })])
say(`  同一對話即時再問：handled=${tooSoon.handled}（${tooSoon.handled ? '有回' : '被冷卻擋住'}）`)

// the same webhook delivered twice: Meta retries, we must not answer twice
await handle.bridge.ingest([dm({ text: '你今日做咩', externalId: 'mid-repeat' })])
const replay = await handle.bridge.ingest([dm({ text: '你今日做咩', externalId: 'mid-repeat' })])
say(`  重複投遞：ingested=${replay.ingested}（被擋：${replay.skipped[0] ?? '無'}）`)

const stranger = await handle.bridge.ingest([dm({ username: 'some_stranger', text: 'hi 你係邊個', externalId: 'mid-stranger' })])
say(`  陌生人：handled=${stranger.handled}（allowlist 外預設唔回）`)

// ── 2. 生命時鐘 ─────────────────────────────────────────────────────────────
say()
say('── 2. 生命時鐘（主動搵你）────────────────────────────────────')
// A real deployment ticks every few minutes; here we fast-forward a handful of
// ticks so the probabilistic "reach out" step gets its chance.
let tickReport = null
let proactive = null
for (let i = 0; i < 12 && !proactive; i += 1) {
  tickReport = await handle.life.tick(new Date(Date.now() + i * 5 * 60_000))
  proactive = tickReport.proactive
}
say(`  跑了 ${tickReport ? 12 : 0} 次 tick；事件：${tickReport?.events.join('、') || '無'}`)
if (proactive) say(`  主動訊息：「${proactive.text}」`)
else say(`  12 次 tick 都冇主動（機率／冷卻／靜音時段任一項擋住，屬正常）`)
if (tickReport?.thought) say(`  內心獨白：「${tickReport.thought}」`)
say(`  狀態：${handle.life.describe()}`)

// ── 3. 記憶 ─────────────────────────────────────────────────────────────────
say()
say('── 3. 可塑性記憶 ────────────────────────────────────────────────')
const stats = handle.memory.stats()
say(`  總數 ${stats.total} 條｜錨點 ${stats.tiers.anchor}、重要 ${stats.tiers.important}、眼前 ${stats.tiers.recent}、模糊 ${stats.tiers.fading}`)
const recalled = handle.memory.recall('我唔想變成工具', { limit: 3 })
for (const hit of recalled) {
  say(`  · [${hit.tier}] 清晰度 ${hit.clarity.toFixed(2)} — ${hit.memory.content.slice(0, 40)}`)
}

// ── 4. 實際會發出的東西 ─────────────────────────────────────────────────────
say()
say('── 4. outbox（dryrun 實際寫出的東西）────────────────────────────')
const outbox = fs
  .readFileSync(path.join(dataDir, 'outbox.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
for (const entry of outbox) {
  say(`  [${entry.kind}] → ${entry.to ?? 'timeline'}：${entry.text ?? entry.caption}`)
}
say()
say(`共 ${outbox.length} 條。全部只寫在 ${path.join(dataDir, 'outbox.jsonl')}，冇任何一個字去過 Instagram。`)
say('═'.repeat(72))

// leave a machine-readable summary next to the transcript
fs.writeFileSync(
  path.join(dataDir, 'self-check-summary.json'),
  `${JSON.stringify({ outbox, memory: stats, tick: tickReport, tools: handle.tools.registered }, null, 2)}\n`,
)
console.log(`summary: ${path.join(dataDir, 'self-check-summary.json')}`)
