/**
 * Dry-run transport — the default, and the one you should live on for a week
 * before touching a real account.
 *
 * Nothing leaves the machine. Every would-be DM and post is written to
 * `outbox.jsonl` and logged, so you can read the character's behaviour as a
 * transcript and decide whether it is someone you would actually talk to.
 */

import { TransportError } from './index.js'

export function createDryRunTransport({ config, store, logger }) {
  let counter = 0
  const record = async (entry) => {
    counter += 1
    const payload = { at: new Date().toISOString(), ...entry, id: `dry-${counter}` }
    await store.append('outbox.jsonl', payload)
    logger?.('info', `[ig-life:dryrun] ${entry.kind} → ${entry.to ?? 'timeline'}: ${String(entry.text ?? entry.caption ?? '').slice(0, 120)}`)
    return payload
  }

  return {
    name: 'dryrun',
    async sendDm({ text, threadId, userId, username }) {
      if (!text) throw new TransportError('empty message', { code: 'IG_EMPTY_MESSAGE' })
      const payload = await record({
        kind: 'dm',
        threadId: threadId ?? null,
        userId: userId ?? null,
        to: username ?? userId ?? threadId ?? 'unknown',
        text,
      })
      return { id: payload.id }
    },
    async postPhoto({ caption, imageUrl }) {
      if (!caption) throw new TransportError('empty caption', { code: 'IG_EMPTY_CAPTION' })
      const payload = await record({ kind: 'post', caption, imageUrl: imageUrl ?? null })
      return { mediaId: payload.id, permalink: '' }
    },
    async replyComment({ commentId, text }) {
      const payload = await record({ kind: 'comment_reply', commentId, to: commentId, text })
      return { id: payload.id }
    },
    async sendAttachment({ type, file, text = '', threadId, userId, username }) {
      const payload = await record({
        kind: type,
        file,
        text,
        threadId: threadId ?? null,
        to: username ?? userId ?? threadId ?? 'unknown',
      })
      return { id: payload.id, url: `file://${file}` }
    },
    async sendImage(payload) {
      return this.sendAttachment({ ...payload, type: 'image' })
    },
    async sendAudio(payload) {
      return this.sendAttachment({ ...payload, type: 'audio' })
    },
    async health() {
      return { backend: 'dryrun', ok: true, note: 'nothing is sent to Instagram', owner: config.ownerHandle || null }
    },
    async close() {},
  }
}
