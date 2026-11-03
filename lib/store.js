/**
 * Storage: crash-safe JSON documents plus append-only JSONL event logs.
 *
 * Deliberately dependency-free (`node:fs` only) and deliberately boring:
 *  · every write goes to `<name>.tmp` then `rename()` — a killed process never
 *    leaves a half-written state file;
 *  · writes for one file are serialized through a promise chain, so concurrent
 *    tool calls cannot interleave;
 *  · JSONL logs are append-only and capped by the reader, never rewritten while
 *    running.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** $DSH_HOME (or ~/.dsh) — the same anchor DSH itself uses. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/** Where this plugin keeps its own files. */
export function pluginDataDir(configured) {
  if (configured && configured.trim()) return path.resolve(configured.trim())
  return path.join(dshHome(), 'ig-life')
}

export class JsonStore {
  /**
   * @param {string} dir  directory that holds the documents
   * @param {{ logger?: (level: string, message: string) => void }} [options]
   */
  constructor(dir, options = {}) {
    this.dir = dir
    this.logger = options.logger ?? (() => {})
    this._queues = new Map()
    this._cache = new Map()
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true })
    return this
  }

  path(name) {
    return path.join(this.dir, name)
  }

  /**
   * Read a JSON document, returning `fallback` when it is missing or corrupt.
   * Corrupt files are renamed aside instead of deleted — that is a memory, and
   * losing it silently would be worse than a warning.
   */
  async read(name, fallback) {
    if (this._cache.has(name)) return structuredCloneSafe(this._cache.get(name))
    const file = this.path(name)
    try {
      const raw = await fsp.readFile(file, 'utf8')
      const parsed = JSON.parse(raw)
      this._cache.set(name, parsed)
      return structuredCloneSafe(parsed)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this._cache.set(name, fallback)
        return structuredCloneSafe(fallback)
      }
      const quarantine = `${file}.corrupt-${Date.now()}`
      try {
        await fsp.rename(file, quarantine)
        this.logger('warn', `[ig-life] ${name} was unreadable (${error?.message}); moved to ${quarantine}`)
      } catch {
        this.logger('warn', `[ig-life] ${name} was unreadable (${error?.message})`)
      }
      this._cache.set(name, fallback)
      return structuredCloneSafe(fallback)
    }
  }

  /** Atomically persist a JSON document. Resolves after the rename. */
  async write(name, value) {
    const previous = this._queues.get(name) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        await fsp.mkdir(this.dir, { recursive: true })
        const file = this.path(name)
        const tmp = `${file}.${process.pid}.tmp`
        const text = `${JSON.stringify(value, null, 2)}\n`
        await fsp.writeFile(tmp, text, 'utf8')
        await fsp.rename(tmp, file)
        this._cache.set(name, value)
      })
    this._queues.set(name, next)
    return next
  }

  /** Drop the in-memory copy so the next read hits disk (used by tests). */
  forget(name) {
    this._cache.delete(name)
  }

  /** Append one line to a JSONL log. */
  async append(name, record) {
    await fsp.mkdir(this.dir, { recursive: true })
    await fsp.appendFile(this.path(name), `${JSON.stringify(record)}\n`, 'utf8')
  }

  /** Read the newest `limit` lines of a JSONL log, oldest-first. */
  async readLines(name, limit = 50) {
    let raw
    try {
      raw = await fsp.readFile(this.path(name), 'utf8')
    } catch {
      return []
    }
    const lines = raw.split('\n').filter((line) => line.trim())
    const tail = limit > 0 ? lines.slice(-limit) : lines
    return tail.flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  }

  /** Byte size of a log, so callers can rotate before it grows forever. */
  async size(name) {
    try {
      const stat = await fsp.stat(this.path(name))
      return stat.size
    } catch {
      return 0
    }
  }
}

/** Synchronous atomic write, for the rare caller outside a promise chain. */
export function atomicWriteFileSync(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

function structuredCloneSafe(value) {
  if (value === undefined) return value
  try {
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))
  } catch {
    return JSON.parse(JSON.stringify(value))
  }
}
