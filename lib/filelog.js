/**
 * A small append-only log for the plugin itself.
 *
 * The host logger writes to the app's console, which is not readable after the
 * fact — so "why did it not answer" was pure guesswork. This keeps the same
 * lines in `<dataDir>/bridge.log`, with a size cap and one rotated file.
 *
 * Rules:
 *   · best effort — a logging failure must never break a turn;
 *   · 0600, because paths and handles end up in here;
 *   · secrets are redacted before they touch the disk.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

const DEFAULTS = { maxBytes: 2 * 1024 * 1024, keep: 1 }

const SECRET = /((?:sessionid|password|token|api[_-]?key|authorization)\s*[=:]\s*)([^\s&"']+)/gi

export function redact(line) {
  return String(line ?? '').replace(SECRET, '$1[redacted]')
}

/**
 * @param {object} options
 * @param {string} options.dir      data dir (created if missing)
 * @param {string} [options.name]   file name, default bridge.log
 * @param {number} [options.maxBytes]
 * @param {number} [options.keep]   rotated files to keep
 * @param {(level: string, message: string) => void} [options.host]  still called
 */
export function createFileLogger({ dir, name = 'bridge.log', maxBytes = DEFAULTS.maxBytes, keep = DEFAULTS.keep, host } = {}) {
  const file = dir ? path.join(dir, name) : ''
  let queue = Promise.resolve()

  async function rotate() {
    const stat = await fsp.stat(file).catch(() => null)
    if (!stat || stat.size < maxBytes) return
    for (let index = keep; index >= 1; index -= 1) {
      const from = index === 1 ? file : `${file}.${index - 1}`
      const to = `${file}.${index}`
      await fsp.rename(from, to).catch(() => {})
    }
  }

  function append(line) {
    if (!file) return
    queue = queue
      .then(async () => {
        await fsp.mkdir(path.dirname(file), { recursive: true })
        await rotate()
        await fsp.appendFile(file, line + '\n', { mode: 0o600 })
      })
      .catch(() => {})
  }

  const log = (level, message) => {
    const text = redact(message)
    if (typeof host === 'function') {
      try {
        host(level, message)
      } catch {
        /* the host logger is not allowed to take the plugin down */
      }
    }
    append(`[${new Date().toISOString()}] ${String(level ?? 'info').toUpperCase()} ${text}`)
  }
  /** Wait for the queued writes (tests, shutdown). */
  log.flush = () => queue
  return log
}
