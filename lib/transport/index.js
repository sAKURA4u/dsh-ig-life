/**
 * Transport contract + factory.
 *
 * A transport is the only thing that can touch Instagram. Everything above it
 * (bridge, life, tools) speaks in plain objects, so the same code runs against
 * a dry-run body and against the real Graph API.
 *
 *   sendDm({ text, threadId?, userId?, username? }) -> { id }
 *   postPhoto({ caption, imageUrl })                 -> { mediaId, permalink? }
 *   replyComment({ commentId, text })                -> { id }
 *   health()                                         -> plain object
 *   close()                                          -> void
 */

export class TransportError extends Error {
  constructor(message, { code = 'IG_ERROR', hint = '', status = 0 } = {}) {
    super(message)
    this.name = 'TransportError'
    this.code = code
    this.hint = hint
    this.status = status
  }

  /** Structured failure — the shape every failure in this project uses. */
  toJSON() {
    return { ok: false, code: this.code, error: this.message, hint: this.hint }
  }
}

export async function createTransport({ config, store, logger, media = null }) {
  if (config.transport === 'graph') {
    const { createGraphTransport } = await import('./graph.js')
    return createGraphTransport({ config, store, logger, media })
  }
  const { createDryRunTransport } = await import('./dryrun.js')
  return createDryRunTransport({ config, store, logger })
}
