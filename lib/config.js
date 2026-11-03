/**
 * Configuration: defaults, env overrides and validation — hand-rolled.
 *
 * Why not schemastery? A bundle that cannot resolve its own dependencies
 * fails to load, and a plugin that fails to load can abort the whole DSH boot
 * audit. This module has zero imports so the plugin always loads; the values
 * are validated here instead of by the loader.
 */

export const DEFAULTS = Object.freeze({
  enabled: true,
  /** dryrun | graph | unofficial */
  transport: 'dryrun',
  ownerHandle: '',
  allowlist: [],
  /** Reply to handles that are not in the allowlist. */
  replyToStrangers: false,
  /** What strangers get: a short, harmless, non-personal reply. */
  strangerSafeMode: true,
  /** Where state lives. Empty = $DSH_HOME/ig-life (default ~/.dsh/ig-life). */
  dataDir: '',
  /** Persona folder. Empty = the example persona shipped with this package. */
  personaPath: '',

  graph: {
    accessToken: '',
    igUserId: '',
    appSecret: '',
    verifyToken: '',
    apiVersion: 'v21.0',
    publicBaseUrl: '',
  },

  /**
   * The unofficial transport (a personal IG account, like the QQ project).
   *
   * It is only an HTTP client: the actual logged-in session lives in a local
   * Python sidecar (`src/ig_bridge.py`, instagrapi). That split is deliberate —
   * a password or a session cookie must never enter this process, its config,
   * its logs or an LLM prompt. The sidecar listens on 127.0.0.1 and demands a
   * shared token.
   */
  unofficial: {
    baseUrl: 'http://127.0.0.1:8737',
    /** Shared secret for the localhost API. Empty = read <dataDir>/sidecar-token. */
    token: '',
    /** Seconds between inbound polls. Below 10 is refused: that is how accounts get flagged. */
    pollSeconds: 20,
    /** Extra random delay (0..N seconds) on every poll, so the cadence is not a metronome. */
    pollJitterSeconds: 6,
    /** Hard local ceiling enforced in the transport, under the bridge's own limits. */
    sendPerDay: 30,
    postPerDay: 2,
    /** Minimum gap between two outbound messages, in seconds. */
    sendGapSeconds: 8,
    /** HTTP timeout for a sidecar call (login and media upload can be slow). */
    requestTimeoutSeconds: 45,
  },

  webhook: {
    enabled: true,
    path: '/ig-life/webhook',
    /** Reject unsigned POSTs. Keep true unless you are debugging locally. */
    requireSignature: true,
  },

  bridge: {
    enabled: true,
    /** Agent preset used for the IG conversation (meta.agentPreset). */
    agentPreset: '',
    /** tool-only = the model must speak through ig_send_dm (recommended); auto = forward assistant text too. */
    replyMode: 'tool-only',
    /** Hard cap on agent turns started per hour, across all threads. */
    maxAgentTurnsPerHour: 40,
    /** Ignore inbound messages older than this (seconds) on first contact. */
    maxInboundAgeSeconds: 3600,
    /** Instagram's reply window: how many hours after their last message we may send. */
    messagingWindowHours: 24,
  },

  life: {
    enabled: false,
    tickSeconds: 300,
    timezone: 'Asia/Hong_Kong',
    wakeHour: 9,
    sleepHour: 24,
    /** Chance per eligible tick that it speaks first. */
    proactiveDmProbability: 0.12,
    proactiveCooldownMinutes: 180,
    /** Chance per eligible tick that it publishes something. */
    postProbability: 0.2,
    postMinGapHours: 6,
    quietHours: '02:00-08:00',
  },

  limits: {
    dmPerDay: 12,
    postsPerDay: 2,
    commentsPerDay: 15,
    replyCooldownSeconds: 20,
  },

  memory: {
    /** 最早的錨點：前 N 條記憶永不忘。 */
    anchorCount: 8,
    /** 最近 N 條永遠在上下文裡。 */
    recentCount: 12,
    /** 重要度門檻：過了就是「重要」，不淡忘。 */
    importanceThreshold: 0.75,
    /** 被想起幾次就自動升級成「重要」。 */
    recallPromotionCount: 3,
    /** 其餘記憶的半衰期（日）。 */
    decayHalfLifeDays: 21,
    /** 每晚壓縮時，保留分數高於此比例的「其餘」記憶。 */
    keepFraction: 0.35,
    /** 每晚壓縮的小時（本地時間）；不在這個小時就跳過。 */
    consolidateHour: 3,
    /** 每次回覆最多注入幾條記憶。 */
    injectLimit: 10,
  },

  /** 語音：需要任何 OpenAI-compatible /audio/speech TTS 端點 */
  voice: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    /** TTS 的聲音名稱（供應商自訂，例如 alloy / zh-CN-XiaoxiaoNeural） */
    voice: '',
    format: 'mp3',
    /** 一條語音最多幾個字；超過就打字或分次 */
    maxChars: 120,
    speed: 1.0,
    /** 語音包資料夾（放了 manifest.json）；空 = <dataDir>/voice-pack */
    packDir: '',
    /** 每次發語音最少間隔幾分鐘（防騷擾） */
    cooldownMinutes: 10,
    /** 一天最多幾條語音 */
    perDay: 8,
  },

  /** 表情包／貼圖圖庫 */
  stickers: {
    enabled: true,
    /** 陌生人發來的圖也可以收藏（預設只收 allowlist 的） */
    collectFromStrangers: false,
    maxItems: 300,
    maxBytes: 2_000_000,
    /** 回覆時自動附上最貼合的一張（只在模型要求時才真的發） */
    suggest: true,
    suggestThreshold: 0.55,
  },

  /** 睇 reel / 分享 reel */
  reels: {
    enabled: true,
    /** 一小時最多睇幾條（每條要打一次 Graph API） */
    perHour: 20,
    /** 分享時額外傳一張封面圖。IG 本身會把連結轉成 reel 卡片，所以預設唔需要 */
    attachCover: false,
  },

  /** 潮語學習 */
  slang: {
    enabled: true,
    /** 必須主人批准才進入詞庫；不要關掉 */
    requireApproval: true,
    maxTerms: 500,
    maxPending: 12,
    /** 注入提示詞的條數 */
    injectLimit: 6,
    /** 一天最多提交幾個新詞 */
    submitsPerDay: 5,
  },

  /** 每個人一個檔案：印象、話題、稱呼 */
  people: {
    enabled: true,
    maxPeople: 200,
    impressionLength: 200,
  },

  /** 看圖（reel 封面、訊息裡的圖）用的 vision 端點，可選 */
  vision: {
    baseUrl: '',
    apiKey: '',
    model: '',
    maxPerDay: 60,
  },
});

const BOOL = (value, fallback) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on', 'y'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off', 'n'].includes(normalized)) return false
  }
  return fallback
}

const NUM = (value, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

const STR = (value, fallback = '') => (value === undefined || value === null ? fallback : String(value).trim())

const HANDLE = (value) => STR(value).replace(/^@+/, '').toLowerCase()

const HANDLE_LIST = (value) => {
  if (Array.isArray(value)) return value.map(HANDLE).filter(Boolean)
  return STR(value)
    .split(/[,;\s]+/)
    .map(HANDLE)
    .filter(Boolean)
}

const ENV_MAP = {
  IG_LIFE_TRANSPORT: ['transport'],
  IG_LIFE_OWNER: ['ownerHandle'],
  IG_LIFE_ALLOWLIST: ['allowlist'],
  IG_LIFE_DATA_DIR: ['dataDir'],
  IG_LIFE_PERSONA: ['personaPath'],
  IG_LIFE_GRAPH_TOKEN: ['graph', 'accessToken'],
  IG_LIFE_IG_USER_ID: ['graph', 'igUserId'],
  IG_LIFE_APP_SECRET: ['graph', 'appSecret'],
  IG_LIFE_VERIFY_TOKEN: ['graph', 'verifyToken'],
  IG_LIFE_PUBLIC_BASE_URL: ['graph', 'publicBaseUrl'],
  IG_LIFE_UNOFFICIAL_URL: ['unofficial', 'baseUrl'],
  IG_LIFE_UNOFFICIAL_TOKEN: ['unofficial', 'token'],
  IG_LIFE_UNOFFICIAL_POLL_SECONDS: ['unofficial', 'pollSeconds'],
  IG_LIFE_LIFE_ENABLED: ['life', 'enabled'],
  IG_LIFE_TICK_SECONDS: ['life', 'tickSeconds'],
  IG_LIFE_TIMEZONE: ['life', 'timezone'],
  IG_LIFE_VOICE_ENABLED: ['voice', 'enabled'],
  IG_LIFE_TTS_BASE_URL: ['voice', 'baseUrl'],
  IG_LIFE_TTS_API_KEY: ['voice', 'apiKey'],
  IG_LIFE_TTS_MODEL: ['voice', 'model'],
  IG_LIFE_TTS_VOICE: ['voice', 'voice'],
  IG_LIFE_VISION_BASE_URL: ['vision', 'baseUrl'],
  IG_LIFE_VISION_API_KEY: ['vision', 'apiKey'],
  IG_LIFE_VISION_MODEL: ['vision', 'model'],
}

function setPath(target, path, value) {
  let cursor = target
  for (const key of path.slice(0, -1)) {
    cursor[key] ??= {}
    cursor = cursor[key]
  }
  cursor[path.at(-1)] = value
}

/**
 * Merge user config over defaults, apply env overrides, coerce and validate.
 * @returns {{ config: typeof DEFAULTS, warnings: string[] }}
 */
export function resolveConfig(raw = {}, env = globalThis.process?.env ?? {}) {
  const merged = structuredCloneish(DEFAULTS)
  deepMerge(merged, raw)
  for (const [envKey, path] of Object.entries(ENV_MAP)) {
    const value = env[envKey]
    if (value !== undefined && value !== '') setPath(merged, path, value)
  }

  const warnings = []
  const transport = STR(merged.transport, 'dryrun').toLowerCase()
  if (!['dryrun', 'graph', 'unofficial'].includes(transport)) {
    warnings.push(`unknown transport "${transport}", falling back to dryrun`)
  }
  const replyMode = STR(merged.bridge?.replyMode, 'tool-only').toLowerCase()
  if (!['tool-only', 'auto'].includes(replyMode)) {
    warnings.push(`unknown bridge.replyMode "${replyMode}", falling back to tool-only`)
  }

  const config = {
    enabled: BOOL(merged.enabled, true),
    transport: ['dryrun', 'graph', 'unofficial'].includes(transport) ? transport : 'dryrun',
    ownerHandle: HANDLE(merged.ownerHandle),
    allowlist: HANDLE_LIST(merged.allowlist),
    replyToStrangers: BOOL(merged.replyToStrangers, false),
    strangerSafeMode: BOOL(merged.strangerSafeMode, true),
    dataDir: STR(merged.dataDir),
    personaPath: STR(merged.personaPath),
    graph: {
      accessToken: STR(merged.graph?.accessToken),
      igUserId: STR(merged.graph?.igUserId),
      appSecret: STR(merged.graph?.appSecret),
      verifyToken: STR(merged.graph?.verifyToken),
      apiVersion: STR(merged.graph?.apiVersion, 'v21.0') || 'v21.0',
      publicBaseUrl: STR(merged.graph?.publicBaseUrl).replace(/\/+$/, ''),
    },
    unofficial: {
      baseUrl: (STR(merged.unofficial?.baseUrl, 'http://127.0.0.1:8737') || 'http://127.0.0.1:8737').replace(/\/+$/, ''),
      token: STR(merged.unofficial?.token),
      // The floor of 10 seconds is a safety valve, not a preference: a poller
      // that hits the private API harder than a human app does is the fastest
      // way to lose the account.
      pollSeconds: NUM(merged.unofficial?.pollSeconds, 20, { min: 10, max: 3600 }),
      pollJitterSeconds: NUM(merged.unofficial?.pollJitterSeconds, 6, { min: 0, max: 120 }),
      sendPerDay: NUM(merged.unofficial?.sendPerDay, 30, { min: 0, max: 200 }),
      postPerDay: NUM(merged.unofficial?.postPerDay, 2, { min: 0, max: 20 }),
      sendGapSeconds: NUM(merged.unofficial?.sendGapSeconds, 8, { min: 0, max: 600 }),
      requestTimeoutSeconds: NUM(merged.unofficial?.requestTimeoutSeconds, 45, { min: 5, max: 300 }),
    },
    webhook: {
      enabled: BOOL(merged.webhook?.enabled, true),
      path: normalizePath(merged.webhook?.path, '/ig-life/webhook'),
      requireSignature: BOOL(merged.webhook?.requireSignature, true),
    },
    bridge: {
      enabled: BOOL(merged.bridge?.enabled, true),
      agentPreset: STR(merged.bridge?.agentPreset),
      replyMode: ['tool-only', 'auto'].includes(replyMode) ? replyMode : 'tool-only',
      maxAgentTurnsPerHour: NUM(merged.bridge?.maxAgentTurnsPerHour, 40, { min: 1, max: 500 }),
      maxInboundAgeSeconds: NUM(merged.bridge?.maxInboundAgeSeconds, 3600, { min: 0 }),
      messagingWindowHours: NUM(merged.bridge?.messagingWindowHours, 24, { min: 1, max: 168 }),
    },
    life: {
      enabled: BOOL(merged.life?.enabled, false),
      tickSeconds: NUM(merged.life?.tickSeconds, 300, { min: 20, max: 86_400 }),
      timezone: STR(merged.life?.timezone, 'Asia/Hong_Kong') || 'Asia/Hong_Kong',
      wakeHour: NUM(merged.life?.wakeHour, 9, { min: 0, max: 23 }),
      sleepHour: NUM(merged.life?.sleepHour, 24, { min: 0, max: 24 }),
      proactiveDmProbability: NUM(merged.life?.proactiveDmProbability, 0.12, { min: 0, max: 1 }),
      proactiveCooldownMinutes: NUM(merged.life?.proactiveCooldownMinutes, 180, { min: 0 }),
      postProbability: NUM(merged.life?.postProbability, 0.2, { min: 0, max: 1 }),
      postMinGapHours: NUM(merged.life?.postMinGapHours, 6, { min: 0 }),
      quietHours: STR(merged.life?.quietHours, '02:00-08:00'),
    },
    limits: {
      dmPerDay: NUM(merged.limits?.dmPerDay, 12, { min: 0, max: 500 }),
      postsPerDay: NUM(merged.limits?.postsPerDay, 2, { min: 0, max: 50 }),
      commentsPerDay: NUM(merged.limits?.commentsPerDay, 15, { min: 0, max: 500 }),
      replyCooldownSeconds: NUM(merged.limits?.replyCooldownSeconds, 20, { min: 0 }),
    },
    memory: {
      anchorCount: NUM(merged.memory?.anchorCount, 8, { min: 0, max: 200 }),
      recentCount: NUM(merged.memory?.recentCount, 12, { min: 0, max: 500 }),
      importanceThreshold: NUM(merged.memory?.importanceThreshold, 0.75, { min: 0, max: 1 }),
      recallPromotionCount: NUM(merged.memory?.recallPromotionCount, 3, { min: 1, max: 50 }),
      decayHalfLifeDays: NUM(merged.memory?.decayHalfLifeDays, 21, { min: 0.5 }),
      keepFraction: NUM(merged.memory?.keepFraction, 0.35, { min: 0, max: 1 }),
      consolidateHour: NUM(merged.memory?.consolidateHour, 3, { min: 0, max: 23 }),
      injectLimit: NUM(merged.memory?.injectLimit, 10, { min: 1, max: 60 }),
    },
    voice: {
      enabled: BOOL(merged.voice?.enabled, false),
      baseUrl: STR(merged.voice?.baseUrl).replace(/\/+$/, ''),
      apiKey: STR(merged.voice?.apiKey),
      model: STR(merged.voice?.model),
      voice: STR(merged.voice?.voice),
      format: STR(merged.voice?.format, 'mp3') || 'mp3',
      maxChars: NUM(merged.voice?.maxChars, 120, { min: 1, max: 2000 }),
      speed: NUM(merged.voice?.speed, 1, { min: 0.5, max: 2 }),
      packDir: STR(merged.voice?.packDir),
      cooldownMinutes: NUM(merged.voice?.cooldownMinutes, 10, { min: 0 }),
      perDay: NUM(merged.voice?.perDay, 8, { min: 0, max: 200 }),
    },
    stickers: {
      enabled: BOOL(merged.stickers?.enabled, true),
      collectFromStrangers: BOOL(merged.stickers?.collectFromStrangers, false),
      maxItems: NUM(merged.stickers?.maxItems, 300, { min: 0, max: 5000 }),
      maxBytes: NUM(merged.stickers?.maxBytes, 2_000_000, { min: 1024 }),
      suggest: BOOL(merged.stickers?.suggest, true),
      suggestThreshold: NUM(merged.stickers?.suggestThreshold, 0.55, { min: 0, max: 1 }),
    },
    reels: {
      enabled: BOOL(merged.reels?.enabled, true),
      perHour: NUM(merged.reels?.perHour, 20, { min: 1, max: 500 }),
      attachCover: BOOL(merged.reels?.attachCover, false),
    },
    slang: {
      enabled: BOOL(merged.slang?.enabled, true),
      requireApproval: BOOL(merged.slang?.requireApproval, true),
      maxTerms: NUM(merged.slang?.maxTerms, 500, { min: 0, max: 10_000 }),
      maxPending: NUM(merged.slang?.maxPending, 12, { min: 0, max: 200 }),
      injectLimit: NUM(merged.slang?.injectLimit, 6, { min: 0, max: 50 }),
      submitsPerDay: NUM(merged.slang?.submitsPerDay, 5, { min: 0, max: 100 }),
    },
    people: {
      enabled: BOOL(merged.people?.enabled, true),
      maxPeople: NUM(merged.people?.maxPeople, 200, { min: 0, max: 5000 }),
      impressionLength: NUM(merged.people?.impressionLength, 200, { min: 20, max: 1000 }),
    },
    vision: {
      baseUrl: STR(merged.vision?.baseUrl).replace(/\/+$/, ''),
      apiKey: STR(merged.vision?.apiKey),
      model: STR(merged.vision?.model),
      maxPerDay: NUM(merged.vision?.maxPerDay, 60, { min: 0, max: 10_000 }),
    },
  }

  if (config.transport === 'graph') {
    if (!config.graph.accessToken) warnings.push('transport=graph but graph.accessToken is empty')
    if (!config.graph.igUserId) warnings.push('transport=graph but graph.igUserId is empty')
  }
  if (config.transport === 'unofficial') {
    if (!/^https?:\/\//.test(config.unofficial.baseUrl)) {
      warnings.push(`unofficial.baseUrl "${config.unofficial.baseUrl}" is not an http(s) URL`)
    }
    if (!/(^http:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(config.unofficial.baseUrl)) {
      warnings.push('unofficial.baseUrl is not loopback — the sidecar holds a logged-in session and must stay local')
    }
    if (config.webhook.enabled) {
      warnings.push('transport=unofficial does not receive webhook events: DMs are polled, comments are not delivered')
    }
  }
  if (config.ownerHandle && config.allowlist.length && !config.allowlist.includes(config.ownerHandle)) {
    warnings.push('ownerHandle is not in allowlist — the owner is always allowed, but add it for clarity')
  }
  if (config.life.enabled && !config.ownerHandle) {
    warnings.push('life.enabled is true but ownerHandle is empty — proactive messages have no target')
  }
  return { config, warnings }
}

/** Safe, loggable snapshot (never contains tokens). */
export function describeConfig(config) {
  const mask = (value) => (value ? `${String(value).slice(0, 4)}***` : '<unset>')
  return {
    enabled: config.enabled,
    transport: config.transport,
    ownerHandle: config.ownerHandle || '<unset>',
    allowlist: config.allowlist,
    dataDir: config.dataDir || '<default>',
    personaPath: config.personaPath || '<bundled example>',
    graph: {
      accessToken: mask(config.graph.accessToken),
      igUserId: config.graph.igUserId || '<unset>',
      verifyToken: mask(config.graph.verifyToken),
      apiVersion: config.graph.apiVersion,
      publicBaseUrl: config.graph.publicBaseUrl || '<unset>',
    },
    unofficial: {
      baseUrl: config.unofficial.baseUrl,
      token: mask(config.unofficial.token),
      pollSeconds: config.unofficial.pollSeconds,
      pollJitterSeconds: config.unofficial.pollJitterSeconds,
      sendPerDay: config.unofficial.sendPerDay,
      postPerDay: config.unofficial.postPerDay,
      sendGapSeconds: config.unofficial.sendGapSeconds,
      requestTimeoutSeconds: config.unofficial.requestTimeoutSeconds,
    },
    webhook: config.webhook,
    bridge: config.bridge,
    life: config.life,
    limits: config.limits,
    memory: config.memory,
    voice: {
      enabled: config.voice.enabled,
      baseUrl: config.voice.baseUrl || '<unset>',
      apiKey: mask(config.voice.apiKey),
      model: config.voice.model || '<unset>',
      perDay: config.voice.perDay,
    },
    vision: {
      baseUrl: config.vision.baseUrl || '<unset>',
      apiKey: mask(config.vision.apiKey),
      model: config.vision.model || '<unset>',
    },
    stickers: config.stickers,
    reels: config.reels,
    slang: config.slang,
    people: config.people,
  }
}

function normalizePath(value, fallback) {
  const raw = STR(value, fallback) || fallback
  return raw.startsWith('/') ? raw : `/${raw}`
}

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {}
      deepMerge(target[key], value)
    } else if (value !== undefined) {
      target[key] = value
    }
  }
  return target
}

function structuredCloneish(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * Merge a user-editable overlay over the row config.
 *
 * The settings page writes `<dataDir>/settings.json`; that file is the user's
 * layer, so it wins over the Cordis row (`base`) exactly as DSH's own settings
 * do — schema defaults, then the composition, then the user document.
 * Arrays are replaced, not concatenated, so clearing the allowlist works.
 */
export function mergeConfigLayers(base = {}, overlay = {}) {
  return deepMerge(deepMerge(structuredCloneish(DEFAULTS), structuredCloneish(base)), structuredCloneish(overlay))
}

