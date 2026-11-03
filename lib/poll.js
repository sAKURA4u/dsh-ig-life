/**
 * Inbound polling — for a transport that has no webhook to receive.
 *
 * The unofficial body is a personal account reached through a sidecar, so the
 * only way to learn that someone wrote to us is to ask. This module owns that
 * cadence and nothing else:
 *
 *   · one poll at a time — a slow poll never stacks up behind itself;
 *   · a randomised delay, because a perfectly periodic client is a fingerprint;
 *   · exponential backoff while failing, so a dead sidecar is not hammered;
 *   · every timer is disposable, so unmounting the plugin leaves nothing behind.
 *
 * Timers are injected (`timers.setTimeout` / `timers.clearTimeout`) so tests can
 * drive it without waiting.
 */

export function createInboundPoll({
  poll,
  onEvents,
  intervalMs,
  jitterMs = 0,
  logger,
  timers = { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (handle) => globalThis.clearTimeout(handle) },
  random = Math.random,
  maxBackoffMs = 300_000,
}) {
  if (typeof poll !== 'function') throw new TypeError('createInboundPoll needs a poll() function')
  const base = Math.max(1, Number(intervalMs) || 1)
  let timer = null
  let running = false
  let stopped = true
  let failures = 0
  const stats = { polls: 0, ok: 0, failed: 0, lastOkAt: null, lastErrorAt: null, lastError: null, events: 0 }

  /** Delay before the next attempt: fixed interval + jitter, or backoff after failures. */
  function nextDelay() {
    if (failures > 0) return Math.min(maxBackoffMs, base * 2 ** Math.min(failures, 6))
    const jitter = Math.max(0, Number(jitterMs) || 0)
    return base + (jitter > 0 ? Math.floor(random() * jitter) : 0)
  }

  function schedule(delay = nextDelay()) {
    if (stopped) return
    if (timer) timers.clearTimeout(timer)
    timer = timers.setTimeout(() => {
      timer = null
      void tick()
    }, delay)
    // Never hold a test runner (or a short-lived script) open.
    if (typeof timer?.unref === 'function') timer.unref()
  }

  async function tick() {
    if (stopped) return { skipped: 'stopped' }
    if (running) return { skipped: 'already running' }
    running = true
    stats.polls += 1
    try {
      const events = await poll()
      const list = Array.isArray(events) ? events : []
      if (list.length && typeof onEvents === 'function') {
        await onEvents(list)
        stats.events += list.length
      }
      failures = 0
      stats.ok += 1
      stats.lastOkAt = new Date().toISOString()
      stats.lastError = null
      return { events: list.length }
    } catch (error) {
      failures += 1
      stats.failed += 1
      stats.lastErrorAt = new Date().toISOString()
      stats.lastError = { code: error?.code ?? 'IG_POLL_FAILED', message: error?.message ?? String(error), hint: error?.hint ?? '' }
      // One line per new failure, then quiet until it recovers: a dead sidecar
      // must not fill the log with the same sentence every twenty seconds.
      const level = failures === 1 ? 'warn' : 'debug'
      logger?.(level, `[ig-life] inbound poll failed (${failures}×): ${error?.code ?? ''} ${error?.message ?? error}${error?.hint ? ` — ${error.hint}` : ''}`)
      return { error: stats.lastError }
    } finally {
      running = false
      schedule()
    }
  }

  return {
    start() {
      if (!stopped) return this
      stopped = false
      schedule(base)
      return this
    },
    stop() {
      stopped = true
      if (timer) {
        timers.clearTimeout(timer)
        timer = null
      }
      return this
    },
    tick,
    stats() {
      return { ...stats, failures, running, stopped, intervalMs: base, jitterMs }
    },
  }
}
