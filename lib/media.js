/**
 * 媒體檔的處理：下載進來的附件、準備要送出去的圖片／音頻。
 *
 * Instagram 的 Messaging API **不接受檔案上傳**：圖片與音頻都只能是
 * 「Meta 抓得到的公開 HTTPS URL」。所以任何要送出去的檔案都必須先落在
 * `<dataDir>/media/`，再由插件的 `/ig-life/media/<file>` route 對外供應
 * （前面要掛 ngrok / cloudflared）。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { sniffImage } from './stickers.js'

export function createMedia({ config, store, logger, fetchImpl = globalThis.fetch }) {
  const publicDir = path.join(store.dir, 'media')

  /** Can Instagram actually fetch our files? */
  function hostingAvailable() {
    return Boolean(config.graph.publicBaseUrl)
  }

  function publicUrlFor(name) {
    if (!hostingAvailable()) return null
    return `${config.graph.publicBaseUrl}/ig-life/media/${encodeURIComponent(name)}`
  }

  /**
   * Copy a file into the public media folder (idempotent) and return its URL.
   * @returns {Promise<{ok: boolean, name?: string, url?: string, code?: string, hint?: string}>}
   */
  async function stage(localPath) {
    if (!hostingAvailable()) {
      return {
        ok: false,
        code: 'IG_NO_PUBLIC_BASE_URL',
        error: '沒有設定 graph.publicBaseUrl，Instagram 抓不到我們的檔案',
        hint: '設定 graph.publicBaseUrl 指向你的 HTTPS 隧道（例如 https://xxxx.ngrok-free.app）',
      }
    }
    await fsp.mkdir(publicDir, { recursive: true })
    const base = path.basename(localPath)
    const target = path.join(publicDir, base)
    if (path.resolve(localPath) !== path.resolve(target)) {
      await fsp.copyFile(localPath, target)
    }
    return { ok: true, name: base, url: publicUrlFor(base), path: target }
  }

  /** Download a remote URL into a buffer with a size cap. */
  async function download(url, { maxBytes = 8_000_000 } = {}) {
    let response
    try {
      response = await fetchImpl(url, { redirect: 'follow' })
    } catch (error) {
      return { ok: false, code: 'IG_DOWNLOAD_FAILED', error: `下載失敗：${error?.message ?? error}`, hint: '' }
    }
    if (!response.ok) {
      return { ok: false, code: 'IG_DOWNLOAD_STATUS', error: `下載回應 ${response.status}`, hint: '' }
    }
    const length = Number(response.headers?.get?.('content-length') ?? 0)
    if (length && length > maxBytes) {
      return { ok: false, code: 'IG_DOWNLOAD_TOO_BIG', error: `檔案 ${length} bytes 超過上限 ${maxBytes}`, hint: '不要收藏這麼大的檔案' }
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) {
      return { ok: false, code: 'IG_DOWNLOAD_TOO_BIG', error: `檔案 ${buffer.length} bytes 超過上限 ${maxBytes}`, hint: '' }
    }
    return { ok: true, buffer, contentType: response.headers?.get?.('content-type') ?? '' }
  }

  /** Download and keep a remote image, verifying it really is an image. */
  async function saveRemoteImage(url, { prefix = 'img', maxBytes = 8_000_000, dir = null } = {}) {
    const downloaded = await download(url, { maxBytes })
    if (!downloaded.ok) return downloaded
    const format = sniffImage(downloaded.buffer)
    if (!format) {
      return { ok: false, code: 'IG_NOT_AN_IMAGE', error: '抓回來的內容不是圖片', hint: '對方的附件可能已過期或需要登入' }
    }
    const targetDir = dir ?? path.join(store.dir, 'cache')
    await fsp.mkdir(targetDir, { recursive: true })
    const file = path.join(targetDir, `${prefix}-${Date.now().toString(36)}.${format}`)
    await fsp.writeFile(file, downloaded.buffer)
    return { ok: true, path: file, buffer: downloaded.buffer, format }
  }

  return {
    publicDir,
    hostingAvailable,
    publicUrlFor,
    stage,
    download,
    saveRemoteImage,
    stats: () => ({ publicDir, hostingAvailable: hostingAvailable(), publicBaseUrl: config.graph.publicBaseUrl || null }),
  }
}
