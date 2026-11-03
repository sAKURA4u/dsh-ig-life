/**
 * A thin, defensive wrapper over the host's `llm` service.
 *
 * Two uses: the life loop (deciding whether to speak up / what to write on a
 * post) and the bridge's fallback reply engine when no DSH agent can be created.
 *
 * Everything here is optional. If `ctx.llm` is missing, or no route can be
 * resolved, `available` stays false and callers degrade instead of throwing.
 */

export async function createLlmBridge({ ctx, logger }) {
  const llm = ctx?.get?.('llm')
  if (!llm || typeof llm.stream !== 'function') {
    return { available: false, reason: 'llm service not mounted', generate: async () => null, route: null }
  }

  const route = await resolveRoute(ctx, llm, logger)
  if (!route) {
    return { available: false, reason: 'no llm provider/model route could be resolved', generate: async () => null, route: null }
  }

  let createUserMessage
  try {
    ;({ createUserMessage } = await import('@deepseek-ai/dsh-llm'))
  } catch (error) {
    return {
      available: false,
      reason: `cannot import @deepseek-ai/dsh-llm: ${error?.message ?? error}`,
      generate: async () => null,
      route,
    }
  }

  /**
   * @returns {Promise<string|null>} assistant text, or null on any failure
   */
  async function generate({ system, prompt, maxTokens = 500, temperature = 1.0, timeoutMs = 60_000 } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const messages = [createUserMessage({ content: [{ type: 'text', text: String(prompt ?? '') }] })]
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system: system ? String(system) : undefined,
        messages,
        temperature,
        maxTokens,
        signal: controller.signal,
      })
      let text = ''
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta') text += chunk.text ?? chunk.delta ?? chunk.textDelta ?? ''
        else if (chunk.type === 'text') text += chunk.text ?? ''
        if (chunk.type === 'finish') {
          const kind = chunk.kind ?? chunk.reason
          if (kind === 'error' || kind === 'aborted') {
            logger?.('warn', `[ig-life] llm finished with ${kind}: ${JSON.stringify(chunk.failure ?? {}).slice(0, 200)}`)
            return text.trim() || null
          }
        }
      }
      return text.trim() || null
    } catch (error) {
      logger?.('warn', `[ig-life] llm call failed: ${error?.message ?? error}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  return { available: true, reason: 'ok', generate, route }
}

async function resolveRoute(ctx, llm, logger) {
  const pick = (selection) =>
    selection?.provider && selection?.model ? { provider: selection.provider, model: selection.model } : null

  try {
    const defaultModel = ctx?.get?.('agentDefaultModel')
    const selection = await defaultModel?.currentSelection?.()
    const fromDefault = pick(selection)
    if (fromDefault) return fromDefault
  } catch (error) {
    logger?.('debug', `[ig-life] agentDefaultModel unavailable: ${error?.message ?? error}`)
  }

  try {
    const providers = await llm.listProviders?.()
    for (const provider of providers ?? []) {
      const key = typeof provider === 'string' ? provider : provider?.name ?? provider?.key
      if (!key) continue
      const models = await llm.listModels?.(key)
      const first = (models ?? [])[0]
      const model = typeof first === 'string' ? first : first?.id ?? first?.name
      if (model) return { provider: key, model }
    }
  } catch (error) {
    logger?.('debug', `[ig-life] cannot enumerate llm providers: ${error?.message ?? error}`)
  }
  return null
}

/**
 * Strip a config-file / markdown fence wrapper a model sometimes adds when we
 * ask it for JSON.
 */
export function extractJson(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const fenced = /```(?:json)?\s*([\s\S]+?)```/.exec(raw)
  const candidate = fenced ? fenced[1].trim() : raw
  try {
    return JSON.parse(candidate)
  } catch {
    const objectStart = candidate.indexOf('{')
    const objectEnd = candidate.lastIndexOf('}')
    if (objectStart !== -1 && objectEnd > objectStart) {
      try {
        return JSON.parse(candidate.slice(objectStart, objectEnd + 1))
      } catch {
        return null
      }
    }
    return null
  }
}
