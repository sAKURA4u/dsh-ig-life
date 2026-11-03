import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import { makeConfig } from './helpers.js'
import { createWebhookHandler, parseWebhookEvents, verifyMetaSignature } from '../lib/webhook.js'

function fakeReq({ method = 'GET', url = '/ig-life/webhook', body = '', headers = {} } = {}) {
  const buffers = body ? [Buffer.from(body, 'utf8')] : []
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const buffer of buffers) yield buffer
    },
  }
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    end(chunk) {
      this.body = chunk ?? ''
    },
  }
}

const config = makeConfig({
  webhook: { enabled: true, path: '/ig-life/webhook', requireSignature: true },
  graph: { appSecret: 'topsecret', verifyToken: 'verify-me', accessToken: 'tok', igUserId: '178414' },
})

const sign = (body, secret = 'topsecret') =>
  `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`

test('verifyMetaSignature accepts a real signature and rejects everything else', () => {
  const body = Buffer.from('{"a":1}')
  assert.equal(verifyMetaSignature(body, sign(body), 'topsecret'), true)
  assert.equal(verifyMetaSignature(body, sign(body, 'wrong'), 'topsecret'), false)
  assert.equal(verifyMetaSignature(body, 'sha1=abc', 'topsecret'), false)
  assert.equal(verifyMetaSignature(body, undefined, 'topsecret'), false)
  assert.equal(verifyMetaSignature(body, sign(body), ''), false)
})

test('parseWebhookEvents normalises DMs and comments, skipping echoes', () => {
  const payload = {
    object: 'instagram',
    entry: [
      {
        id: '178414',
        messaging: [
          {
            sender: { id: 'igsid-1', username: 'owner' },
            recipient: { id: '178414' },
            timestamp: 1_767_000_000_000,
            message: { mid: 'mid-1', text: '你今日做咩', thread_id: 'thread-1' },
          },
          {
            sender: { id: '178414' },
            message: { mid: 'mid-echo', text: '我覆咗', is_echo: true },
          },
        ],
        changes: [
          {
            field: 'comments',
            value: {
              id: 'comment-1',
              text: '好靚',
              from: { id: 'igsid-2', username: 'friend' },
              media: { id: 'media-1' },
              created_time: '2026-01-01T08:00:00+0000',
            },
          },
        ],
      },
    ],
  }
  const events = parseWebhookEvents(payload)
  assert.equal(events.length, 2)
  assert.deepEqual(
    events.map((event) => [event.kind, event.username, event.text, event.externalId]),
    [
      ['dm', 'owner', '你今日做咩', 'mid-1'],
      ['comment', 'friend', '好靚', 'comment-1'],
    ],
  )
  assert.equal(events[0].threadId, 'thread-1')
  assert.equal(events[1].mediaId, 'media-1')
  assert.ok(events[0].at instanceof Date)
})

test('GET handshake echoes the challenge when the token matches', async () => {
  const handler = createWebhookHandler({ config, onEvents: () => {} })
  const ok = fakeRes()
  await handler(fakeReq({ method: 'GET', url: '/ig-life/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345' }), ok)
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.body, '12345')

  const bad = fakeRes()
  await handler(fakeReq({ method: 'GET', url: '/ig-life/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345' }), bad)
  assert.equal(bad.statusCode, 403)
  assert.ok(bad.body.includes('IG_WEBHOOK_VERIFY'))
})

test('POST with a valid signature reaches onEvents and answers 200', async () => {
  const received = []
  const handler = createWebhookHandler({ config, onEvents: (events) => received.push(...events) })
  const body = JSON.stringify({
    object: 'instagram',
    entry: [{ messaging: [{ sender: { id: 'igsid-1', username: 'owner' }, message: { mid: 'm1', text: 'hi', thread_id: 't1' } }] }],
  })
  const res = fakeRes()
  await handler(fakeReq({ method: 'POST', body, headers: { 'x-hub-signature-256': sign(body) } }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(received.length, 1)
  assert.equal(received[0].text, 'hi')
})

test('POST with a bad signature is rejected and nothing is processed', async () => {
  const received = []
  const handler = createWebhookHandler({ config, onEvents: (events) => received.push(...events) })
  const body = '{"entry":[]}'
  const res = fakeRes()
  await handler(fakeReq({ method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=deadbeef' } }), res)
  assert.equal(res.statusCode, 403)
  assert.ok(res.body.includes('IG_BAD_SIGNATURE'))
  assert.equal(received.length, 0)
})

test('unsigned POSTs are allowed only when requireSignature is false', async () => {
  const received = []
  const loose = { ...config, webhook: { ...config.webhook, requireSignature: false } }
  const handler = createWebhookHandler({ config: loose, onEvents: (events) => received.push(...events) })
  const body = JSON.stringify({ entry: [{ messaging: [{ sender: { id: 's' }, message: { mid: 'm2', text: 'hey', thread_id: 't' } }] }] })
  const res = fakeRes()
  await handler(fakeReq({ method: 'POST', body }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(received.length, 1)
})

test('a throwing onEvents handler still answers 200 (so Meta does not retry)', async () => {
  const handler = createWebhookHandler({
    config,
    onEvents: () => {
      throw new Error('boom')
    },
  })
  const body = JSON.stringify({ entry: [{ messaging: [{ sender: { id: 's' }, message: { mid: 'm3', text: 'x', thread_id: 't' } }] }] })
  const res = fakeRes()
  await handler(fakeReq({ method: 'POST', body, headers: { 'x-hub-signature-256': sign(body) } }), res)
  assert.equal(res.statusCode, 200)
})

test('other methods get 405', async () => {
  const handler = createWebhookHandler({ config, onEvents: () => {} })
  const res = fakeRes()
  await handler(fakeReq({ method: 'DELETE' }), res)
  assert.equal(res.statusCode, 405)
})
