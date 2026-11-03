/**
 * Sidecar 監護 / sidecar supervisor.
 *
 * The unofficial transport needs a local Python process. Asking every person who
 * installs this plugin to keep a terminal open is what makes it hard to hand to
 * someone else, so the plugin starts it, adopts an already-running one, and
 * reports its state to the settings page.
 *
 * The supervisor never reads the sidecar's files: it only calls `/health` with
 * the shared token and spawns the script. Credentials stay where they were.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveSidecarToken } from './transport/unofficial.js'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
/** Repository root — the directory that holds `src/ig_bridge.py`. */
export const PLUGIN_ROOT = path.resolve(MODULE_DIR, '..')

export function createSidecarSupervisor({
  config,
  store,
  logger,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  platform = process.platform,
  pluginRoot = PLUGIN_ROOT,
  now = () => Date.now(),
}) {
  const settings = config.unofficial
  const python = settings.pythonPath || (platform === 'win32' ? 'python' : 'python3')
  const script = path.join(pluginRoot, 'src', 'ig_bridge.py')
  const logFile = path.join(store.dir, 'sidecar.log')
  const port = portOf(settings.baseUrl)

  let child = null
  let adopted = false
  let stopping = false
  let lastError = ''
  let pythonMissing = false
  let deps = null

  function appendLog(chunk) {
    try {
      fs.appendFileSync(logFile, chunk)
    } catch {
      /* logging must never be the thing that breaks */
    }
  }

  function tokenHeader() {
    const token = resolveSidecarToken(config, store)
    return token ? { 'x-ig-life-token': token } : {}
  }

  async function isUp() {
    try {
      const response = await fetchImpl(`${settings.baseUrl}/health`, { headers: tokenHeader() })
      return Boolean(response?.ok)
    } catch {
      return false
    }
  }

  async function status() {
    const running = await isUp()
    return {
      running,
      managed: Boolean(child) && !adopted,
      adopted,
      python,
      script,
      port,
      logFile,
      pid: child?.pid ?? null,
      pythonMissing,
      deps,
      lastError,
    }
  }

  /** Is `instagrapi` importable by that Python? Slow, so only on demand. */
  function checkDeps() {
    try {
      const result = spawnSyncImpl(python, ['-c', 'import instagrapi'], { windowsHide: true, timeout: 20_000 })
      deps = result?.status === 0
      if (deps) pythonMissing = false
      else if (result?.error?.code === 'ENOENT') pythonMissing = true
      return deps
    } catch (error) {
      deps = false
      lastError = String(error?.message ?? error)
      return false
    }
  }

  /**
   * Run `pip install -r src/requirements.txt` on the user's behalf.
   *
   * Only ever from an explicit click on the settings page: installing software
   * is the user's decision, not a side effect of opening a page.
   */
  async function installDeps({ timeoutMs = 300_000 } = {}) {
    const requirements = path.join(pluginRoot, 'src', 'requirements.txt')
    if (!fs.existsSync(requirements)) {
      return { ok: false, code: 'IG_DEPS_FILE', error: `找不到 ${requirements}` }
    }
    return await new Promise((resolve) => {
      let output = ''
      let settled = false
      let childRef = null
      let timer = null
      const append = (chunk) => {
        output = (output + String(chunk)).slice(-8000)
      }
      const finish = (result) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (result.ok) deps = true
        resolve({ ...result, output: output.trim() })
      }
      try {
        childRef = spawnImpl(python, ['-m', 'pip', 'install', '-r', requirements], {
          cwd: pluginRoot,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        finish({ ok: false, code: 'IG_DEPS_SPAWN', error: String(error?.message ?? error) })
        return
      }
      childRef?.stdout?.on?.('data', append)
      childRef?.stderr?.on?.('data', append)
      timer = setTimeout(() => {
        try {
          childRef?.kill?.()
        } catch {
          /* already gone */
        }
        finish({ ok: false, code: 'IG_DEPS_TIMEOUT', error: `pip 超過 ${Math.round(timeoutMs / 1000)} 秒` })
      }, timeoutMs)
      childRef?.on?.('error', (error) => finish({ ok: false, code: 'IG_DEPS_SPAWN', error: String(error?.message ?? error) }))
      childRef?.on?.('exit', (code) => {
        if (code === 0) finish({ ok: true })
        else finish({ ok: false, code: 'IG_DEPS_FAILED', error: `pip 結束碼 ${code ?? '?'}` })
      })
    })
  }

  async function start() {
    if (await isUp()) {
      adopted = true
      return status()
    }
    adopted = false
    pythonMissing = false
    lastError = ''
    try {
      fs.mkdirSync(store.dir, { recursive: true })
    } catch {
      /* the spawn will report its own failure */
    }

    let spawned
    try {
      // `--data-dir` is not optional: the sidecar must read the same
      // `sidecar-token` and session files as the plugin, including when the
      // user pointed `dataDir` somewhere other than the default.
      spawned = spawnImpl(python, [script, '--serve', '--port', String(port), '--data-dir', store.dir], {
        cwd: pluginRoot,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      lastError = String(error?.message ?? error)
      return status()
    }

    child = spawned
    spawned?.stdout?.on?.('data', appendLog)
    spawned?.stderr?.on?.('data', appendLog)
    spawned?.on?.('error', (error) => {
      lastError = String(error?.message ?? error)
      if (error?.code === 'ENOENT') pythonMissing = true
      child = null
    })
    spawned?.on?.('exit', (code, signal) => {
      if (!stopping) lastError = `sidecar 結束了（code ${code ?? '?'}${signal ? `, ${signal}` : ''}）—— 看 ${logFile}`
      child = null
    })

    const deadline = now() + settings.startTimeoutSeconds * 1000
    while (now() < deadline) {
      if (await isUp()) return status()
      if (pythonMissing) return status()
      await sleep(400)
    }
    if (!lastError) lastError = `sidecar 啟動超時（看 ${logFile}）`
    return status()
  }

  function stop() {
    stopping = true
    if (child) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      child = null
    }
    return { stopped: true }
  }

  /** Start only if needed; used at mount when `unofficial.autoStart` is on. */
  async function ensure() {
    if (await isUp()) {
      adopted = true
      logger?.('debug', '[ig-life] sidecar 已經在跑，直接接管')
      return status()
    }
    if (!settings.autoStart) return status()
    logger?.('info', '[ig-life] 啟動 sidecar…')
    return start()
  }

  return {
    ensure,
    start: async () => {
      stopping = false
      return start()
    },
    stop,
    status,
    checkDeps,
    installDeps,
    isUp,
    logFile,
  }
}

function portOf(baseUrl) {
  try {
    return new URL(baseUrl).port || '8737'
  } catch {
    return '8737'
  }
}
