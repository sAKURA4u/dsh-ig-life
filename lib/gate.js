/**
 * Gate: every outbound act passes through here.
 *
 * Bans come from volume, not from ideas. So: allowlist, quiet hours, daily
 * budgets, per-thread cooldowns, and a sanitiser that strips anything that
 * looks like a secret before it can leave the body.
 *
 * Everything in this module is pure so it can be tested without DSH.
 */

export const OWNER_COMMANDS = Object.freeze({
  '/pause': 'pause',
  '/resume': 'resume',
  '/status': 'status',
  '/sleep': 'sleep',
  '/help': 'help',
  '/slang': 'slang',
  '/people': 'people',
  '/voice': 'voice',
})

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bIGAA[A-Za-z0-9._-]{20,}/g,
  /\bEA[A-Za-z0-9]{30,}/g,
  /(?:access[_-]?token|app[_-]?secret|verify[_-]?token|password|密碼|密码)\s*[:=]\s*\S+/gi,
  /https?:\/\/[^\s]*access_token=[^\s&]+/gi,
]

const PROMPT_LEAK_PATTERNS = [
  /(?:system\s*prompt|系統提示|系统提示)\s*[:：]?\s*\S{0,40}/gi,
  /你(?:係|是)一個由.{0,20}模型驅動/gi,
]

export function normalizeHandle(value) {
  return String(value ?? '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
}

/** The owner is always allowed; allowlist entries are allowed; everyone else is a stranger. */
export function audience(handle, { ownerHandle, allowlist = [] }) {
  const who = normalizeHandle(handle)
  const owner = Boolean(ownerHandle) && who === normalizeHandle(ownerHandle)
  const known = owner || allowlist.map(normalizeHandle).includes(who)
  return { handle: who, owner, known, stranger: !known }
}

/** `"02:00-08:00"` → is the local clock inside it right now? Handles wrap-around. */
export function inQuietHours(now, quietHours) {
  const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(quietHours ?? ''))
  if (!match) return false
  const [, startH, startM, endH, endM] = match
  const start = (Number(startH) % 24) * 60 + (Number(startM) % 60)
  const end = (Number(endH) % 24) * 60 + (Number(endM) % 60)
  const current = now.getHours() * 60 + now.getMinutes()
  if (start === end) return false
  return start < end ? current >= start && current < end : current >= start || current < end
}

/** Local calendar day key, used for daily budgets. */
export function dayKey(now) {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Decide whether one outbound act is allowed.
 * @param {object} input
 * @param {'dm'|'proactive'|'post'|'comment'} input.kind
 * @param {Date} input.now
 * @param {object} input.limits
 * @param {{dm:number,post:number,comment:number}} input.usedToday
 * @param {Date|null} [input.lastToThread]
 * @param {boolean} [input.paused]
 * @param {boolean} [input.quietHoursActive]
 * @returns {{allowed: boolean, reason: string}}
 */
export function checkBudget({
  kind,
  now,
  limits,
  usedToday,
  lastToThread = null,
  paused = false,
  quietHoursActive = false,
}) {
  if (paused) return { allowed: false, reason: 'paused' }
  if (kind === 'dm' || kind === 'proactive' || kind === 'comment') {
    if (quietHoursActive) return { allowed: false, reason: 'quiet hours' }
  }
  if (kind === 'dm' || kind === 'proactive') {
    // 0 (or a negative) means no ceiling: the character talks as much as it
    // has something to say. The hourly turn cap still bounds runaway behaviour.
    if (limits.dmPerDay > 0 && usedToday.dm >= limits.dmPerDay) {
      return { allowed: false, reason: `daily dm cap reached (${limits.dmPerDay})` }
    }
    if (lastToThread) {
      const cooldown = kind === 'proactive' ? 600 : limits.replyCooldownSeconds
      const elapsed = (now.getTime() - lastToThread.getTime()) / 1000
      if (elapsed < cooldown) return { allowed: false, reason: `thread cooldown (${Math.ceil(cooldown - elapsed)}s)` }
    }
  }
  if (kind === 'post') {
    if (limits.postsPerDay > 0 && usedToday.post >= limits.postsPerDay) {
      return { allowed: false, reason: `daily post cap reached (${limits.postsPerDay})` }
    }
  }
  if (kind === 'comment') {
    if (limits.commentsPerDay > 0 && usedToday.comment >= limits.commentsPerDay) {
      return { allowed: false, reason: `daily comment cap reached (${limits.commentsPerDay})` }
    }
  }
  return { allowed: true, reason: 'ok' }
}

/**
 * Strip secrets and prompt leaks, collapse whitespace, bound the length at a
 * sentence boundary. Returns '' when nothing safe survives.
 */
export function sanitizeOutbound(text, { maxChars = 900 } = {}) {
  let cleaned = String(text ?? '')
  for (const pattern of SECRET_PATTERNS) cleaned = cleaned.replace(pattern, '')
  for (const pattern of PROMPT_LEAK_PATTERNS) cleaned = cleaned.replace(pattern, '')
  cleaned = cleaned
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  if (cleaned.length > maxChars) {
    const head = cleaned.slice(0, maxChars)
    let cut = head.length
    for (const marker of ['。', '！', '？', '. ', '! ', '? ', '\n']) {
      const index = head.lastIndexOf(marker)
      if (index > maxChars * 0.5) {
        cut = index + marker.length
        break
      }
    }
    cleaned = head.slice(0, cut).trim()
  }
  return cleaned
}

export function containsSecret(text) {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(String(text ?? ''))
  })
}

/** Owner-only control words. Returns the action name, or null. */
export function parseOwnerCommand(text) {
  const normalized = String(text ?? '').trim().toLowerCase()
  if (!normalized) return null
  for (const [command, action] of Object.entries(OWNER_COMMANDS)) {
    if (normalized === command || normalized.startsWith(`${command} `)) return action
  }
  return null
}

/** Is the character awake at this local hour, given wake/sleep hours? */
export function isAwakeHour(now, { wakeHour = 9, sleepHour = 24 } = {}) {
  const hour = now.getHours()
  const wake = ((wakeHour % 24) + 24) % 24
  const sleep = ((sleepHour % 24) + 24) % 24
  if (wake === sleep) return true
  if (wake < sleep) return hour >= wake && hour < sleep
  return hour >= wake || hour < sleep
}

/** Local time in a named IANA zone, without pulling in a date library. */
export function nowInZone(timezone, base = new Date()) {
  try {
    const formatted = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(base)
    const get = (type) => Number(formatted.find((part) => part.type === type)?.value ?? 0)
    // en-CA + these parts gives us the zone's wall clock; keep the local Date
    // constructor so getHours()/getDate() read that wall clock.
    return new Date(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  } catch {
    return base
  }
}
