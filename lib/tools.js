/**
 * Model-facing tools.
 *
 * These are what make the agent able to *speak* on Instagram: its text output is
 * only thinking, the tool call is the action. Registration is best-effort — if
 * the host has no `tools` service (or `@deepseek-ai/dsh-tools` cannot be
 * resolved) the plugin keeps working and simply has no tools.
 */

const OBJECT_OUTPUT = { schema: { type: 'object', additionalProperties: true } }

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

export async function registerIgTools({ ctx, config, bridge, life, memory, transport, logger }) {
  const tools = ctx?.get?.('tools')
  if (!tools || typeof tools.register !== 'function') {
    return { registered: [], reason: 'tools service is not mounted in this profile' }
  }
  let defineTool
  try {
    ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  } catch (error) {
    return { registered: [], reason: `cannot import @deepseek-ai/dsh-tools: ${error?.message ?? error}` }
  }

  const registered = []
  const failures = []

  const register = (definition) => {
    try {
      tools.register(defineTool(definition))
      registered.push(definition.name)
    } catch (error) {
      failures.push(`${definition.name}: ${error?.message ?? error}`)
      logger('warn', `[ig-life] tool ${definition.name} not registered: ${error?.message ?? error}`)
    }
  }

  register({
    name: 'ig_send_dm',
    description:
      '在 Instagram 發一則私訊。這是你「開口說話」的唯一方式 —— 你的文字輸出不會自動送出。分幾條講就呼叫幾次。',
    parameters: {
      text: { type: 'string', required: true, description: '要打出去的訊息內容。短，一至兩句。' },
      threadId: { type: 'string', description: '要回覆的對話 threadId；省略則回最後一則收到的私訊。' },
    },
    output: OBJECT_OUTPUT,
    async execute(args) {
      const threadId = args.threadId || bridge.recentInbox(1)[0]?.threadId
      if (!threadId) {
        return { ok: false, code: 'IG_NO_THREAD', error: '沒有任何對話可以回覆', hint: '先用 ig_inbox 看有沒有訊息' }
      }
      return bridge.sendReply(threadId, args.text)
    },
    presentCall: (args) => ({ card: 'generic', title: 'Instagram DM', kind: 'other', rawInput: args.text }),
  })

  register({
    name: 'ig_inbox',
    description: '看最近收到的 Instagram 私訊／留言。回覆前先用這個確認對方講了什麼。',
    parameters: {
      limit: { type: 'integer', description: '最多看幾則，預設 10。' },
    },
    output: OBJECT_OUTPUT,
    async execute(args) {
      const messages = bridge.recentInbox(args.limit ?? 10)
      return { ok: true, count: messages.length, messages }
    },
  })

  register({
    name: 'ig_wait',
    description: '等對方把話說完。對方明顯還沒講完（「你知道」「等一下」「還有」）時用；最多 120 秒。',
    parameters: {
      seconds: { type: 'integer', description: '最長等幾秒，預設 30，上限 120。' },
    },
    output: OBJECT_OUTPUT,
    async execute(args, exec) {
      const seconds = Math.min(120, Math.max(1, args.seconds ?? 30))
      const result = await bridge.waitForMessages({ seconds })
      if (exec?.signal?.aborted) return { ok: false, code: 'IG_ABORTED', error: '已取消', hint: '' }
      return { ok: true, ...result }
    },
  })

  register({
    name: 'ig_mark_read',
    description: '把訊息標記為已讀（收尾用）。看完就划走，不要每輪都呼叫。',
    parameters: {
      throughExternalId: { type: 'string', description: '讀到哪一則（含）。省略則標到最新一則。' },
    },
    output: OBJECT_OUTPUT,
    async execute(args) {
      const marked = bridge.markRead(args.throughExternalId)
      return { ok: true, marked }
    },
  })

  register({
    name: 'ig_post',
    description: '在自己的 Instagram 發一篇貼文（日記，不是宣傳）。一天最多一兩篇。',
    parameters: {
      caption: { type: 'string', required: true, description: '貼文文字，一至三行。' },
      imageUrl: { type: 'string', description: '公開 HTTPS 圖片網址；省略則用設定的圖片資料夾裡的一張。' },
    },
    output: OBJECT_OUTPUT,
    async execute(args) {
      return bridge.publish({ caption: args.caption, imageUrl: args.imageUrl })
    },
    presentCall: (args) => ({ card: 'generic', title: 'Instagram 發文', kind: 'other', rawInput: args.caption }),
  })

  register({
    name: 'ig_reply_comment',
    description: '回覆某則貼文下面的留言。短，一兩句。',
    parameters: {
      commentId: { type: 'string', required: true, description: '留言的 id（webhook 事件裡的 externalId）。' },
      text: { type: 'string', required: true, description: '要回的內容。' },
    },
    output: OBJECT_OUTPUT,
    async execute(args) {
      const clean = String(args.text ?? '').trim()
      if (!clean) return { ok: false, code: 'IG_EMPTY_MESSAGE', error: '空回覆', hint: '' }
      const budget = bridge.checkBudget('comment')
      if (!budget.allowed) return { ok: false, code: 'IG_BUDGET_BLOCKED', error: budget.reason, hint: '等冷卻或調高 limits.commentsPerDay' }
      try {
        const result = await transport.replyComment({ commentId: args.commentId, text: clean })
        bridge.bumpUsage('comment')
        return { ok: true, id: result?.id ?? '' }
      } catch (error) {
        return { ok: false, code: error?.code ?? 'IG_COMMENT_FAILED', error: error?.message ?? String(error), hint: error?.hint ?? '' }
      }
    },
  })

  register({
    name: 'ig_life_status',
    description: '看自己的狀態：年齡、體力、心情、記憶分層、今日額度、是否暫停。',
    parameters: {},
    output: OBJECT_OUTPUT,
    async execute() {
      return { ok: true, transport: await transport.health(), ...bridge.status() }
    },
  })

  register({
    name: 'memory_remember',
    description: '把值得記住的事寫進長期記憶。用第一人稱，具體（人名、時間、細節），一句一件。',
    parameters: {
      content: { type: 'string', required: true, description: '要記住的事，第一人稱，80 字內最好。' },
      kind: { type: 'string', description: 'identity | fact | impression | episode | thought | reflection | plan' },
      importance: { type: 'number', description: '0 至 1；0.75 以上就永遠不會淡忘。' },
      pinned: { type: 'boolean', description: 'true = 錨點，永不淡忘。' },
    },
    output: OBJECT_OUTPUT,
    async execute(args) {
      const memoryRecord = await memory.add({
        content: args.content,
        kind: args.kind ?? 'episode',
        importance: args.importance ?? 0.55,
        pinned: Boolean(args.pinned),
        source: 'model',
      })
      return { ok: true, id: memoryRecord.id, total: memory.size }
    },
  })

  register({
    name: 'memory_recall',
    description: '搜尋自己的記憶。想撿回話題、確認對方喜好時用。',
    parameters: {
      query: { type: 'string', required: true, description: '用什麼關鍵詞找。' },
      limit: { type: 'integer', description: '最多幾條，預設 8。' },
    },
    output: OBJECT_OUTPUT,
    async execute(args) {
      const hits = memory.recall(args.query, { limit: args.limit ?? 8 })
      return {
        ok: true,
        count: hits.length,
        memories: hits.map((hit) => ({
          tier: hit.tier,
          clarity: Number(hit.clarity.toFixed(2)),
          content: hit.memory.content,
          createdAt: hit.memory.createdAt,
        })),
      }
    },
  })

  register({
    name: 'memory_forget',
    description: '刪掉一條記憶（只在主人明確要求，或記錯時用）。',
    parameters: {
      id: { type: 'string', required: true, description: '記憶 id。' },
    },
    output: OBJECT_OUTPUT,
    async execute(args) {
      const removed = await memory.forget(args.id)
      return removed ? { ok: true, id: args.id } : { ok: false, code: 'IG_MEMORY_NOT_FOUND', error: '找不到這條記憶', hint: '' }
    },
  })

  // ── 語音 ───────────────────────────────────────────────────────────────────
  if (bridge.voice) {
    register({
      name: 'voice_send',
      description:
        '用語音講一句（開口說話）。比打字親密也比打字打擾，偶爾一條就夠。只有 verified: true 才算真的發出去了；失敗就改打字，不要跟對方說你發了語音。',
      parameters: {
        text: { type: 'string', required: true, description: '要說的話。可以帶語氣標記如 [笑] [小聲] [認真]，系統會轉成語氣，不會讀出來。' },
        threadId: { type: 'string', description: '對象對話；省略則回最後一則收到的私訊。' },
        emotion: { type: 'string', description: '整體語氣，例如 溫柔 / 不耐煩。' },
      },
      output: OBJECT_OUTPUT,
      async execute(args) {
        const threadId = args.threadId || bridge.recentInbox(1)[0]?.threadId
        if (!threadId) return { ok: false, code: 'IG_NO_THREAD', error: '沒有對話可以回覆', hint: '先用 ig_inbox 看看' }
        const last = bridge.recentInbox(1)[0]
        return bridge.sendVoice({
          threadId,
          text: args.text,
          emotion: args.emotion ?? '',
          userId: last?.senderId,
          username: last?.username,
        })
      },
      presentCall: (args) => ({ card: 'generic', title: '語音訊息', kind: 'other', rawInput: args.text }),
    })
  }

  // ── 表情包 ─────────────────────────────────────────────────────────────────
  if (bridge.stickers) {
    register({
      name: 'sticker_list',
      description: '列出你收藏的表情包（有編號、情緒、描述）。想發或者想確認有咩好用時看。',
      parameters: {
        emotion: { type: 'string', description: '只看某個情緒分類。' },
        query: { type: 'string', description: '用關鍵詞搜（支援廣東話／中文）。' },
      },
      output: OBJECT_OUTPUT,
      async execute(args) {
        if (args.query || args.emotion) {
          const hits = bridge.stickers.search(args.query ?? '', { emotion: args.emotion ?? '', limit: 8 })
          return { ok: true, count: hits.length, stickers: hits }
        }
        const items = bridge.stickers.listing({ limit: 40 })
        return { ok: true, count: items.length, stickers: items, stats: bridge.stickers.stats() }
      },
    })

    register({
      name: 'sticker_send',
      description: '發一張表情包。一條訊息只能發一張，不能附文字（文字另外用 ig_send_dm）。',
      parameters: {
        id: { type: 'string', description: '表情包編號，例如 #03。' },
        query: { type: 'string', description: '或者用情境搜尋，例如「被人鬧到無語」。' },
        emotion: { type: 'string', description: '想表達的情緒。' },
        threadId: { type: 'string', description: '對象對話；省略則回最後一則私訊。' },
      },
      output: OBJECT_OUTPUT,
      async execute(args) {
        const last = bridge.recentInbox(1)[0]
        const threadId = args.threadId || last?.threadId
        if (!threadId) return { ok: false, code: 'IG_NO_THREAD', error: '沒有對話可以發', hint: '' }
        return bridge.sendSticker({
          threadId,
          id: String(args.id ?? '').replace(/^#/, ''),
          query: args.query ?? '',
          emotion: args.emotion ?? '',
          userId: last?.senderId,
          username: last?.username,
        })
      },
      presentCall: (args) => ({ card: 'generic', title: '表情包', kind: 'other', rawInput: args.id ?? args.query }),
    })

    register({
      name: 'sticker_collect',
      description: '把對方發來的圖收藏成表情包。先看清楚，再一次收藏；記得填情緒和一句「裡面是什麼、什麼時候用」。',
      parameters: {
        externalId: { type: 'string', description: '哪一則訊息（省略則用最近一張圖）。' },
        emotion: { type: 'string', description: '情緒分類。' },
        content: { type: 'string', description: '一句描述：圖裡是什麼。' },
        keywords: { type: 'string', description: '關鍵詞，用逗號分隔。' },
      },
      output: OBJECT_OUTPUT,
      async execute(args) {
        return bridge.collectSticker({
          externalId: args.externalId ?? '',
          emotion: args.emotion ?? '',
          content: args.content ?? '',
          keywords: args.keywords ?? '',
        })
      },
    })
  }

  // ── Reels ─────────────────────────────────────────────────────────────────
  if (bridge.reels) {
    register({
      name: 'reel_watch',
      description:
        '看一條 reel／貼文：拿 caption、類型、讚數，如果有 vision 就連封面都看。看不到就照直說看不到，不要編內容。',
      parameters: {
        mediaId: { type: 'string', description: '媒體 id（分享訊息會帶）。' },
        url: { type: 'string', description: '或者貼文連結；注意只有連結時通常看不到內容。' },
      },
      output: OBJECT_OUTPUT,
      async execute(args) {
        return bridge.watchReel({ mediaId: args.mediaId ?? '', url: args.url ?? '' })
      },
      presentCall: (args) => ({ card: 'generic', title: '看 reel', kind: 'other', rawInput: args.mediaId ?? args.url }),
    })

    register({
      name: 'reel_share',
      description:
        '把一條 reel／貼文傳給某人：直接傳連結就得，Instagram 會自動轉成 reel 卡片。可以順便加一句你想講嘅話。',
      parameters: {
        permalink: { type: 'string', description: 'reel／貼文網址（最常用）。' },
        mediaId: { type: 'string', description: '如果你有媒體 id。' },
        comment: { type: 'string', description: '你想講的一句（例如「呢個似你」）。' },
        threadId: { type: 'string', description: '對象對話；省略則用最後一則私訊。' },
      },
      output: OBJECT_OUTPUT,
      async execute(args) {
        const last = bridge.recentInbox(1)[0]
        const threadId = args.threadId || last?.threadId
        if (!threadId) return { ok: false, code: 'IG_NO_THREAD', error: '沒有對話可以傳', hint: '' }
        return bridge.shareReel({
          threadId,
          mediaId: args.mediaId ?? '',
          permalink: args.permalink ?? '',
          comment: args.comment ?? '',
          userId: last?.senderId,
          username: last?.username,
        })
      },
    })
  }

  // ── 潮語 ──────────────────────────────────────────────────────────────────
  if (bridge.slang) {
    register({
      name: 'slang_query',
      description: '查一個潮語／黑話。不確定又經常出現的詞，先查再用。',
      parameters: { term: { type: 'string', required: true, description: '要查的詞。' } },
      output: OBJECT_OUTPUT,
      async execute(args) {
        return bridge.slang.query(args.term)
      },
    })

    register({
      name: 'slang_submit',
      description:
        '提交一個新詞等主人批准（批准前不可以用）。只提交真的反覆出現、你又解釋得清楚的詞；不要重複提交。',
      parameters: {
        term: { type: 'string', required: true, description: '這個詞本身。' },
        meaning: { type: 'string', required: true, description: '你理解的意思。' },
        usage: { type: 'string', description: '怎麼用、什麼時候用。' },
        example: { type: 'string', description: '一個例句。' },
        context: { type: 'string', description: '你在哪裡看到它（原句）。' },
      },
      output: OBJECT_OUTPUT,
      async execute(args) {
        return bridge.slang.submit({
          term: args.term,
          meaning: args.meaning,
          usage: args.usage ?? '',
          example: args.example ?? '',
          context: args.context ?? '',
          by: 'model',
        })
      },
    })
  }

  // ── 人 ────────────────────────────────────────────────────────────────────
  if (bridge.people) {
    register({
      name: 'people_note',
      description: '記住關於某個人的具體小事（有證據的，不要空泛評價）。只可以在跟這個人自己的對話裡用。',
      parameters: {
        handle: { type: 'string', description: '對象 handle；省略則用最後一則私訊的人。' },
        note: { type: 'string', description: '一句具體細節。' },
        impression: { type: 'string', description: '你對他整體的印象（會覆蓋舊的）。' },
        topic: { type: 'string', description: '還沒講完的話題。' },
      },
      output: OBJECT_OUTPUT,
      async execute(args) {
        const handle = args.handle || bridge.recentInbox(1)[0]?.username
        if (!handle) return { ok: false, code: 'IG_NO_PERSON', error: '不知道是誰', hint: '' }
        const results = []
        if (args.impression) results.push(await bridge.people.setImpression(handle, args.impression))
        if (args.note) results.push(await bridge.people.addNote(handle, args.note))
        if (args.topic) results.push(await bridge.people.addTopic(handle, args.topic))
        if (!results.length) return { ok: false, code: 'IG_NOTHING_TO_NOTE', error: '沒有內容要記', hint: '填 note / impression / topic 其中一項' }
        return { ok: results.every((result) => result.ok), handle: String(handle).replace(/^@/, ''), results }
      },
    })

    register({
      name: 'people_list',
      description: '看看你認識哪些人、跟誰講過話、對他們的印象。',
      parameters: {},
      output: OBJECT_OUTPUT,
      async execute() {
        return { ok: true, people: bridge.people.listing({ limit: 20 }), stats: bridge.people.stats() }
      },
    })
  }

  // ── 看圖 ──────────────────────────────────────────────────────────────────
  if (bridge.vision) {
    register({
      name: 'image_describe',
      description: '看一張圖（對方面傳來的、或者 reel 封面）。沒有 vision 端點時會直接告訴你看不到。',
      parameters: {
        url: { type: 'string', description: '圖片的公開連結。' },
        externalId: { type: 'string', description: '或者指定哪一則訊息裡的圖。' },
      },
      output: OBJECT_OUTPUT,
      async execute(args) {
        let target = args.url ?? ''
        if (!target && args.externalId) {
          const attachments = bridge.attachmentsByMessage.get(args.externalId) ?? []
          target = attachments.find((attachment) => attachment.isImage && attachment.url)?.url ?? ''
        }
        if (!target) {
          const lastImage = [...bridge.inbox].reverse().find((item) => item.attachments?.some((a) => a.type === 'image' && a.url))
          target = lastImage?.attachments.find((a) => a.type === 'image' && a.url)?.url ?? ''
        }
        if (!target) return { ok: false, code: 'IG_NO_IMAGE', error: '找不到可以看的圖', hint: '' }
        return bridge.vision.describe(target)
      },
    })
  }

  return { registered, failures, reason: registered.length ? 'ok' : 'nothing registered' }
}

export { text as renderTextBlock }
