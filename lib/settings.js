/**
 * 使用者設定層 / the user settings layer.
 *
 * DSH's own settings model is three layers: schema defaults, the deployment's
 * composition (here: the Cordis row's `config`), then the user's document. This
 * module is that third layer for this plugin: `<dataDir>/settings.json`, written
 * by the settings page and merged over the row at mount.
 *
 * Deliberately not DSH's `ctx.settings` namespace: a namespace would gate the
 * whole page on a schemastery schema and a revision-fenced write path, and the
 * only thing this plugin needs to persist is a small, already-validated set of
 * preferences. A file keeps the blast radius at "this plugin re-reads its own
 * config" instead of "the client settings shell fails to bind".
 *
 * Secrets never come through here: no token, no password, no access token is in
 * `EDITABLE`, so a saved file cannot leak one and the page cannot be used to set
 * one.
 */

import fs from 'node:fs'
import path from 'node:path'

import { mergeConfigLayers, resolveConfig } from './config.js'
import { atomicWriteFileSync, pluginDataDir } from './store.js'

export const SETTINGS_FILENAME = 'settings.json'

/** The only keys the settings page may read or write. */
export const EDITABLE = Object.freeze([
  'transport',
  'ownerHandle',
  'allowlist',
  'replyToStrangers',
  'bridge.replyDelaySeconds.min',
  'bridge.replyDelaySeconds.max',
  'bridge.burstWindowSeconds',
  'reels.pool',
  'vision.baseUrl',
  'vision.apiKey',
  'vision.model',
  'vision.maxPerDay',
  'life.enabled',
  'life.tickSeconds',
  'life.timezone',
  'life.quietHours',
  'limits.dmPerDay',
  'limits.postsPerDay',
  'limits.commentsPerDay',
  'limits.replyCooldownSeconds',
  'unofficial.baseUrl',
  'unofficial.pollSeconds',
  'unofficial.pollJitterSeconds',
  'unofficial.sendPerDay',
  'unofficial.postPerDay',
  'unofficial.sendGapSeconds',
])

export const TRANSPORTS = Object.freeze(['dryrun', 'graph', 'unofficial'])

function settingsPath(dataDir) {
  return path.join(pluginDataDir(dataDir ?? ''), SETTINGS_FILENAME)
}

/** Absolute path of the file the settings page writes (shown in the UI). */
export function settingsFilePath(dataDir) {
  return settingsPath(dataDir)
}

/** Read the saved user layer. A corrupt file means "no overrides", never a crash. */
export function readOverlay(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(dataDir), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** The editable projection of a resolved config — the page's whole vocabulary. */
export function pickEditable(config) {
  return {
    transport: config.transport,
    ownerHandle: config.ownerHandle,
    allowlist: [...config.allowlist],
    replyToStrangers: config.replyToStrangers,
    bridge: {
      replyDelaySeconds: { ...config.bridge.replyDelaySeconds },
      burstWindowSeconds: config.bridge.burstWindowSeconds,
    },
    reels: { pool: [...(config.reels.pool ?? [])] },
    vision: {
      baseUrl: config.vision.baseUrl,
      apiKey: config.vision.apiKey,
      model: config.vision.model,
      maxPerDay: config.vision.maxPerDay,
    },
    life: {
      enabled: config.life.enabled,
      tickSeconds: config.life.tickSeconds,
      timezone: config.life.timezone,
      quietHours: config.life.quietHours,
    },
    limits: { ...config.limits },
    unofficial: {
      baseUrl: config.unofficial.baseUrl,
      pollSeconds: config.unofficial.pollSeconds,
      pollJitterSeconds: config.unofficial.pollJitterSeconds,
      sendPerDay: config.unofficial.sendPerDay,
      postPerDay: config.unofficial.postPerDay,
      sendGapSeconds: config.unofficial.sendGapSeconds,
    },
  }
}

/**
 * Validate one page submission.
 *
 * Coercion and clamping are `resolveConfig`'s job — one implementation, used by
 * both the file and the row. Only the choices it would silently "fix" (an
 * unknown transport) are refused here, because a typo should be an error, not a
 * quiet downgrade to dryrun.
 *
 * @returns {{ok: boolean, errors: string[], values?: object, warnings?: string[]}}
 */
export function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: ['body 必須是 JSON object'] }
  }
  const errors = []
  if (patch.transport !== undefined && !TRANSPORTS.includes(String(patch.transport).toLowerCase())) {
    errors.push(`transport 只可以是 ${TRANSPORTS.join(' / ')}`)
  }
  if (patch.allowlist !== undefined && !Array.isArray(patch.allowlist) && typeof patch.allowlist !== 'string') {
    errors.push('allowlist 要是字串或字串陣列')
  }
  if (patch.ownerHandle !== undefined && typeof patch.ownerHandle !== 'string') {
    errors.push('ownerHandle 要是字串')
  }
  if (errors.length) return { ok: false, errors }

  // `resolveConfig` is the one place that coerces and clamps; use it, then keep
  // only the paths this submission actually named. Saving the whole projection
  // would bake today's defaults into the user layer and wipe earlier saves.
  const { config, warnings } = resolveConfig(patch, {})
  const values = subsetOf(pickEditable(config), providedPaths(patch))
  return { ok: true, errors: [], values, warnings }
}

/** Dotted leaf paths present in a submitted patch, restricted to editable keys. */
function providedPaths(patch, prefix = '') {
  const paths = []
  for (const [key, value] of Object.entries(patch ?? {})) {
    const dotted = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...providedPaths(value, dotted))
    } else if (EDITABLE.includes(dotted)) {
      paths.push(dotted)
    }
  }
  return paths
}

/** Build a nested object holding only those dotted paths. */
function subsetOf(source, paths) {
  const target = {}
  for (const dotted of paths) {
    const keys = dotted.split('.')
    let cursor = target
    let value = source
    for (const key of keys.slice(0, -1)) {
      cursor[key] ??= {}
      cursor = cursor[key]
      value = value?.[key]
    }
    const last = keys.at(-1)
    if (value !== undefined && value !== null && value[last] !== undefined) cursor[last] = value[last]
  }
  return target
}

/** Plain deep merge used for the saved document (no defaults, no base). */
function mergePlain(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {}
      mergePlain(target[key], value)
    } else if (value !== undefined) {
      target[key] = Array.isArray(value) ? [...value] : value
    }
  }
  return target
}

/**
 * Merge a validated patch into the saved layer and persist it.
 * @returns {{ok: boolean, errors?: string[], warnings?: string[], saved?: object, changed?: string[]}}
 */
export function saveOverlay(dataDir, patch) {
  const checked = validatePatch(patch)
  if (!checked.ok) return { ok: false, errors: checked.errors }

  const previous = readOverlay(dataDir)
  const next = mergePlain(mergePlain({}, previous), checked.values)
  const changed = diffPaths(previous, checked.values)
  atomicWriteFileSync(settingsPath(dataDir), `${JSON.stringify(next, null, 2)}\n`)
  return { ok: true, saved: next, warnings: checked.warnings, changed }
}

/** Which editable paths a submission actually moved — for the "restart needed" copy. */
function diffPaths(previous, values) {
  const changed = []
  const walk = (before, after, prefix) => {
    for (const [key, value] of Object.entries(after ?? {})) {
      const dotted = prefix ? `${prefix}.${key}` : key
      const old = before?.[key]
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk(old ?? {}, value, dotted)
      } else if (JSON.stringify(old) !== JSON.stringify(value)) {
        changed.push(dotted)
      }
    }
  }
  walk(previous, values, '')
  return changed
}
