/**
 * Transport contract + factory.
 *
 * A transport is the only thing that can touch Instagram. Everything above it
 * (bridge, life, tools) speaks in plain objects, so the same code runs against
 * a dry-run body, the official Graph API, or a local sidecar that drives the
 * private API of a personal account.
 *
 *   sendDm({ text, threadId?, userId?, username? }) -> { id }
 *   sendAttachment({ type, file, text?, threadId?, userId?, username? })
 *                                                    -> { id, url? }
 *   postPhoto({ caption, imageUrl?, imagePath? })    -> { mediaId, permalink? }
 *   replyComment({ commentId, mediaId?, text })       -> { id }
 *   health()                                         -> plain object
 *   close()                                          -> void
 *
 * Optional, whichever transport owns the inbound side:
 *
 *   poll() -> events[]   // the same shape the webhook normaliser produces
 *
 * `dryrun` is the default and sends nothing. `graph` is the official Meta API.
 * `unofficial` is a personal account through a local Python sidecar; it is not
 * official, it violates Instagram's terms, and the account can be banned.
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
  if (config.transport === 'unofficial') {
    const { createUnofficialTransport } = await import('./unofficial.js')
    return createUnofficialTransport({ config, store, logger, media })
  }
  const { createDryRunTransport } = await import('./dryrun.js')
  return createDryRunTransport({ config, store, logger })
}
