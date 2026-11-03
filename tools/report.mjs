#!/usr/bin/env node
/**
 * 狀態報告產生器 / offline status report.
 *
 * Reads the plugin's own data files and writes a self-contained `report.html`,
 * then you just open it. No DSH, no web server, no port to discover — which is
 * exactly why it exists: the desktop app has no address bar and its port drifts
 * on every restart.
 *
 *   node tools/report.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { tierOf, TIER, clarityOf } from '../lib/memory.js'
import { resolveConfig } from '../lib/config.js'

const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const dataDir = path.join(home, 'ig-life')
const out = path.join(import.meta.dirname, '..', 'report.html')

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'))
  } catch {
    return fallback
  }
}

function readLines(name, limit = 12) {
  try {
    return fs
      .readFileSync(path.join(dataDir, name), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

const { config } = resolveConfig({})
const memory = readJson('memory.json', { memories: [] })
const state = readJson('state.json', {})
const bridge = readJson('bridge.json', {})
const stickers = readJson('stickers.json', { items: [] })
const slang = readJson('slang.json', { terms: [] })
const people = readJson('people.json', { people: {} })
const outbox = readLines('outbox.jsonl', 15)

const memories = Array.isArray(memory.memories) ? memory.memories : []
const tiers = { anchor: 0, important: 0, recent: 0, fading: 0 }
const now = new Date()
memories.forEach((m, index) => {
  const tier = tierOf(m, { index, total: memories.length, config: config.memory, now })
  tiers[tier] += 1
})
const top = memories
  .map((m, index) => ({ m, index }))
  .map(({ m, index }) => {
    const tier = tierOf(m, { index, total: memories.length, config: config.memory, now })
    return { tier, clarity: clarityOf(m, { tier, now, config: config.memory }), content: m.content, createdAt: m.createdAt }
  })
  .sort((a, b) => b.clarity - a.clarity)
  .slice(0, 8)

const pending = (slang.terms ?? []).filter((t) => t.status === 'pending')
const approved = (slang.terms ?? []).filter((t) => t.status === 'approved')
const unread = (bridge.inbox ?? []).filter((i) => !i.read)

const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const row = (label, value) => `<div class="row"><span>${esc(label)}</span><span>${esc(value)}</span></div>`

const generated = new Date().toLocaleString('zh-HK')
const alive = state.birthAt ? '有' : '未見過'

const html = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><title>大肥魚狀態</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;font:14px/1.65 ui-sans-serif,system-ui,"Segoe UI","Microsoft JhengHei",sans-serif;background:#0d1017;color:#e6e9ef}
main{max-width:820px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:20px;margin:0 0 2px}.sub{color:#8b93a7;margin:0 0 22px}
.card{background:#141924;border:1px solid #232b3a;border-radius:12px;padding:16px 18px;margin:0 0 14px}
.card h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8b93a7;margin:0 0 12px}
.row{display:flex;justify-content:space-between;gap:16px;padding:3px 0}.row span:last-child{color:#c7cede}
.bars{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.bar{background:#1b2230;border-radius:8px;padding:10px;text-align:center}
.bar b{display:block;font-size:20px}.bar small{color:#8b93a7}
ul{margin:6px 0 0;padding-left:18px}li{padding:2px 0;color:#c7cede}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#9aa4b8;white-space:pre-wrap}
.note{color:#5f6980;font-size:12px;margin-top:20px}
</style></head><body><main>
<h1>大肥魚 · 狀態報告</h1>
<p class="sub">產生時間 ${esc(generated)} · 資料來源 <code>${esc(dataDir)}</code></p>

<div class="card"><h2>身體</h2>
${row('插件有冇寫過資料', alive)}
${row('出世', state.birthAt ? new Date(state.birthAt).toLocaleString('zh-HK') : '—')}
${row('體力', state.energy != null ? Math.round(state.energy) + '/100' : '—')}
${row('心情', state.valence != null ? state.valence.toFixed(2) + ' / ' + state.arousal.toFixed(2) : '—')}
${row('而家', state.activity ?? '—')}
${row('是否暫停', state.paused ? '是' : '否')}
${row('今日用量', 'DM ' + (bridge.usage?.dm ?? 0) + ' · 帖 ' + (bridge.usage?.post ?? 0) + ' · 留言 ' + (bridge.usage?.comment ?? 0))}
</div>

<div class="card"><h2>記憶分層（共 ${memories.length} 條）</h2>
<div class="bars">
<div class="bar"><b>${tiers.anchor}</b><small>錨點</small></div>
<div class="bar"><b>${tiers.important}</b><small>重要</small></div>
<div class="bar"><b>${tiers.recent}</b><small>眼前</small></div>
<div class="bar"><b>${tiers.fading}</b><small>模糊</small></div>
</div>
<ul>${top.map((t) => `<li><small>[${esc(t.tier)} ${t.clarity.toFixed(2)}]</small> ${esc(String(t.content).slice(0, 80))}</li>`).join('') || '<li>（未有記憶）</li>'}</ul>
</div>

<div class="card"><h2>能力</h2>
${row('表情包', (stickers.items?.length ?? 0) + ' 張')}
${row('潮語', '已收 ' + approved.length + ' · 待批 ' + pending.length)}
${row('認識的人', Object.keys(people.people ?? {}).length + ' 人')}
${row('未讀訊息', String(unread.length))}
</div>

${pending.length ? `<div class="card"><h2>等你批准嘅潮語</h2><ul>${pending.map((t) => `<li>#${esc(t.id)}「${esc(t.term)}」= ${esc(t.meaning)}</li>`).join('')}</ul><p class="note">在 IG 私訊回「/slang ok &lt;id&gt;」批准。</p></div>` : ''}

<div class="card"><h2>最近發出去嘅（outbox）</h2>
<ul>${outbox.slice().reverse().map((e) => `<li>[${esc(e.kind)}] → ${esc(e.to ?? 'timeline')}：${esc(String(e.text ?? e.caption ?? '').slice(0, 90))}</li>`).join('') || '<li>（未有紀錄）</li>'}</ul>
</div>

<p class="note">這是直接讀檔的靜態報告：沒有連線、沒有 port、也沒有發送任何東西。</p>
</main></body></html>`

fs.writeFileSync(out, html, 'utf8')
console.log(`報告已寫入：${out}`)
console.log(`記憶 ${memories.length} 條（錨點 ${tiers.anchor} / 重要 ${tiers.important} / 眼前 ${tiers.recent} / 模糊 ${tiers.fading}）`)
if (!state.birthAt && !memories.length) {
  console.log('⚠ 未見到插件寫入過資料 —— 代表插件在這部機仍未成功掛載（與報告本身無關）。')
}
