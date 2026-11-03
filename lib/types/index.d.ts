import type { Context } from '@deepseek-ai/cordis'

/** Loader / diagnostic name; equals the row id in cordis.patch.yml. */
export declare const name: 'ig-life'

/** Only `timer` is required. Everything else is probed with `ctx.get()`. */
export declare const inject: readonly ['timer']

/** This plugin validates its own config; it publishes no schemastery schema. */
export declare const configSchema: null

export interface IgLifeConfig {
  enabled?: boolean
  /**
   * `dryrun` sends nothing anywhere; `graph` is the official Meta API;
   * `unofficial` drives a personal account through the local Python sidecar
   * (violates Instagram's terms — see docs/UNOFFICIAL.md).
   */
  transport?: 'dryrun' | 'graph' | 'unofficial'
  ownerHandle?: string
  allowlist?: string[]
  replyToStrangers?: boolean
  strangerSafeMode?: boolean
  dataDir?: string
  personaPath?: string
  graph?: {
    accessToken?: string
    igUserId?: string
    appSecret?: string
    verifyToken?: string
    apiVersion?: string
    publicBaseUrl?: string
  }
  webhook?: { enabled?: boolean; path?: string; requireSignature?: boolean }
  /**
   * The unofficial transport's only contact with the account: a local HTTP
   * sidecar that holds the session. No password ever reaches this process.
   */
  unofficial?: {
    baseUrl?: string
    /** Empty = read <dataDir>/sidecar-token. */
    token?: string
    /** Seconds between polls; the floor is 10 and cannot be configured away. */
    pollSeconds?: number
    pollJitterSeconds?: number
    sendPerDay?: number
    postPerDay?: number
    sendGapSeconds?: number
    requestTimeoutSeconds?: number
  }
  bridge?: {
    enabled?: boolean
    agentPreset?: string
    replyMode?: 'tool-only' | 'auto'
    maxAgentTurnsPerHour?: number
    maxInboundAgeSeconds?: number
  }
  life?: {
    enabled?: boolean
    tickSeconds?: number
    timezone?: string
    wakeHour?: number
    sleepHour?: number
    proactiveDmProbability?: number
    proactiveCooldownMinutes?: number
    postProbability?: number
    postMinGapHours?: number
    quietHours?: string
  }
  limits?: { dmPerDay?: number; postsPerDay?: number; commentsPerDay?: number; replyCooldownSeconds?: number }
  memory?: {
    anchorCount?: number
    recentCount?: number
    importanceThreshold?: number
    recallPromotionCount?: number
    decayHalfLifeDays?: number
    keepFraction?: number
    consolidateHour?: number
    injectLimit?: number
  }
}

/**
 * Mounted handle, returned from `apply()` for console debugging. Not a service:
 * nothing else should depend on it.
 */
export interface IgLifeHandle {
  name: 'ig-life'
  config: Required<IgLifeConfig>
  store: { dir: string }
  persona: { name: string; handle: string; dir: string; seed: object[] }
  memory: { size: number; stats(): object }
  transport: { name: string; health(): Promise<object>; close(): Promise<void> }
  life: { tick(): Promise<object>; describe(): string; state: Record<string, unknown> }
  bridge: { engine: string; ingest(events: object[]): Promise<object>; status(): object }
  tools: { registered: string[]; failures?: string[]; reason: string }
  webhookPath: string | null
  /** Present only when the transport polls for inbound messages. */
  poll: { start(): unknown; stop(): unknown; stats(): object } | null
}

export declare function apply(ctx: Context, config?: IgLifeConfig): Promise<IgLifeHandle | undefined>
