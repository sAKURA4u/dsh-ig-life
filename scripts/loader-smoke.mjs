#!/usr/bin/env node
/**
 * Load the plugin under the **real Cordis runtime**, not a mock.
 *
 * This exists because a mock context happily accepts anything — including an
 * `apply()` that returns an object — while a real Cordis fiber rejects it with
 * `TypeError: Invalid effect` and takes the entire profile down with it. That
 * exact bug shipped once. Never again.
 *
 *   node scripts/loader-smoke.mjs
 */

const calls = { routes: [], tools: [], intervals: 0 }

const cordis = await import('@deepseek-ai/cordis')
const app = new cordis.Context()

app.provide('timer', {
  interval: () => {
    calls.intervals += 1
    return () => {}
  },
  timeout: () => () => {},
})
app.provide('webServer', {
  register: ({ path }) => {
    calls.routes.push(path)
    return () => {}
  },
})
app.provide('tools', {
  register: (definition) => {
    calls.tools.push(definition.name)
    return () => {}
  },
})
app.provide('llm', {
  async *stream() {
    yield { type: 'finish', kind: 'ok' }
  },
  listProviders: async () => ['fake'],
  listModels: async () => ['fake-1'],
})

const mod = await import('../lib/index.js')

const dataDir = `${process.env.TEMP ?? '/tmp'}/ig-life-loader-smoke-${Date.now()}`
const returned = await mod.apply(app, {
  dataDir,
  transport: 'dryrun',
  webhook: { enabled: true },
  // The real timer mixin is a Service plugin; a plain provide() cannot supply
  // ctx.interval, so the tick path is covered by the unit suite instead.
  life: { enabled: false },
})

const problems = []
if (returned !== undefined) problems.push(`apply() returned ${typeof returned} — a Cordis fiber only accepts undefined or a disposer`)
const handle = mod.instance()
if (!handle) problems.push('instance() is empty after a successful mount')
if (handle && handle.tools.registered.length !== calls.tools.length) {
  problems.push(`tool count mismatch: instance=${handle.tools.registered.length} registered=${calls.tools.length}`)
}
if (!calls.routes.includes('/ig-life/webhook')) problems.push('webhook route was not registered')

if (problems.length) {
  console.error('✖ loader smoke failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`✔ loaded under real Cordis: ${handle.name} · tools=${calls.tools.length} · routes=${calls.routes.join(', ')} `)
console.log(`  transport=${handle.transport.name} · engine=${handle.bridge.engine} · memory=${handle.memory.size}`)
