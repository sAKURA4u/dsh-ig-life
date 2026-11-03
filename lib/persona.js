/**
 * Persona: who the character is, loaded from plain markdown files.
 *
 * A persona folder contains:
 *
 *   persona.md     身份、背景、慾望、恐懼（最重要）
 *   style.md       講話方式：語言、句長、語氣、口頭禪
 *   boundaries.md  底線：唔講咩、唔做咩
 *   seed.json      出世時就帶著的記憶（陣列）
 *
 * Files are optional — a missing file is simply skipped, so a minimal persona
 * is one markdown file.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const BUNDLED_PERSONA_DIR = path.join(HERE, '..', 'persona', 'example')

/** Resolve the active persona folder. */
export function resolvePersonaDir(configured) {
  if (configured && String(configured).trim()) return path.resolve(String(configured).trim())
  return BUNDLED_PERSONA_DIR
}

async function readOptional(dir, name) {
  try {
    return await fsp.readFile(path.join(dir, name), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

/**
 * Load a persona folder.
 * @returns {Promise<{dir: string, name: string, handle: string, identity: string,
 *   style: string, boundaries: string, seed: object[], missing: string[]}>}
 */
export async function loadPersona(dir = BUNDLED_PERSONA_DIR) {
  const [identity, style, boundaries, seedRaw] = await Promise.all([
    readOptional(dir, 'persona.md'),
    readOptional(dir, 'style.md'),
    readOptional(dir, 'boundaries.md'),
    readOptional(dir, 'seed.json'),
  ])

  const missing = []
  if (!identity) missing.push('persona.md')

  let seed = []
  if (seedRaw.trim()) {
    try {
      const parsed = JSON.parse(seedRaw)
      seed = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.memories) ? parsed.memories : []
    } catch {
      missing.push('seed.json (invalid JSON, ignored)')
    }
  }

  const header = parseHeader(identity)
  return {
    dir,
    name: header.name || 'unnamed',
    handle: header.handle || '',
    identity: identity.trim(),
    style: style.trim(),
    boundaries: boundaries.trim(),
    seed,
    missing,
  }
}

/** `persona.md` may start with a tiny `key: value` header block. */
function parseHeader(identity) {
  const result = {}
  for (const line of String(identity ?? '').split('\n').slice(0, 12)) {
    const match = /^\s*(?:name|handle)\s*[:：]\s*(.+)$/i.exec(line)
    if (!match) continue
    const key = line.trim().split(/[:：]/)[0].trim().toLowerCase()
    result[key] = match[1].trim().replace(/^@/, '')
  }
  return result
}

/**
 * The static half of the system prompt. Written to be dropped into a DSH
 * prompt section or into an agent preset's `prefix`.
 */
export function renderPersonaCore(persona) {
  const parts = []
  if (persona.identity) parts.push(`# 你是誰 / WHO YOU ARE\n${persona.identity}`)
  if (persona.style) parts.push(`# 講話方式 / STYLE\n${persona.style}`)
  if (persona.boundaries) parts.push(`# 底線 / BOUNDARIES\n${persona.boundaries}`)
  return parts.join('\n\n')
}

/**
 * The IG-specific protocol block lives in `prompts.js` (it is long enough to
 * deserve its own file). Re-exported here so callers keep one import site.
 */
export { renderIgProtocol } from './prompts.js'

/** Turn the seed array into addable memory payloads. */
export function seedPayloads(persona) {
  return (persona?.seed ?? []).flatMap((item) => {
    if (typeof item === 'string') return [{ content: item, kind: 'fact', importance: 0.7, source: 'seed' }]
    if (!item || typeof item !== 'object' || !item.content) return []
    return [
      {
        content: String(item.content),
        kind: String(item.kind ?? 'fact'),
        importance: Number(item.importance ?? 0.7),
        valence: Number(item.valence ?? 0),
        pinned: Boolean(item.pinned),
        subject: String(item.subject ?? 'self'),
        source: 'seed',
      },
    ]
  })
}
