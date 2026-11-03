#!/usr/bin/env node
/**
 * Link the locally installed DSH packages into ./node_modules so `npm test` can
 * exercise the real `defineTool` / `createUserMessage` code paths instead of
 * skipping them.
 *
 * This is a developer convenience only: at runtime DSH resolves these peers from
 * its own installation (the profile's pnpm has `autoInstallPeers: false` and
 * falls back to the installation's flat module tree). Nothing here is shipped.
 *
 * Usage:
 *   node scripts/link-dsh.mjs                 # auto-detect the DSH installation
 *   node scripts/link-dsh.mjs <dsh-node_modules>   # explicit path
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const NEEDED = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/schemastery',
  'zod',
]

function candidateRoots() {
  const roots = []
  if (process.env.DSH_NODE_MODULES) roots.push(process.env.DSH_NODE_MODULES)
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).trim()
    roots.push(path.join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules'))
    roots.push(path.join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  } catch {
    /* npm not available — rely on the explicit argument */
  }
  return roots
}

const explicit = process.argv[2]
const roots = explicit ? [explicit, ...candidateRoots()] : candidateRoots()

const source = roots.find((root) => {
  if (!root) return false
  return (
    fs.existsSync(path.join(root, '@deepseek-ai', 'dsh-tools', 'package.json')) ||
    fs.existsSync(path.join(root, 'dsh-tools', 'package.json'))
  )
})

if (!source) {
  console.error('✖ cannot find the DSH installation. Pass its node_modules directory explicitly:')
  console.error('    node scripts/link-dsh.mjs "C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules"')
  process.exit(1)
}

const projectRoot = path.resolve(import.meta.dirname, '..')
const target = path.join(projectRoot, 'node_modules')

const resolvePackage = (name) => {
  const flat = path.join(source, name)
  if (fs.existsSync(path.join(flat, 'package.json'))) return flat
  const nested = path.join(source, '@deepseek-ai', name.replace(/^@deepseek-ai\//, ''))
  if (fs.existsSync(path.join(nested, 'package.json'))) return nested
  return null
}

let linked = 0
const missing = []
for (const name of NEEDED) {
  const from = resolvePackage(name)
  if (!from) {
    missing.push(name)
    continue
  }
  const to = path.join(target, name)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  if (fs.existsSync(to) || isLink(to)) {
    try {
      fs.rmSync(to, { recursive: true, force: true })
    } catch {
      /* leave it */
    }
  }
  try {
    fs.symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir')
    linked += 1
  } catch (error) {
    console.warn(`! could not link ${name}: ${error.message}`)
  }
}

console.log(`DSH install: ${source}`)
console.log(`linked ${linked}/${NEEDED.length} packages into ${target}`)
if (missing.length) console.log(`missing (optional, tests will skip them): ${missing.join(', ')}`)

function isLink(target_) {
  try {
    return fs.lstatSync(target_).isSymbolicLink()
  } catch {
    return false
  }
}
