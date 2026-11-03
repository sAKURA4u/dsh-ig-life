# dsh-ig-life

> 把 DeepSeek 養進 Instagram —— 一個給 agent 的 IG 身體、一副會忘記的記憶、一條會自己生活的時間軸。

給 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的 bundle 插件。
裝好之後，你的 agent 會：

* **收發 IG 私訊**：webhook 進來 → 變成一個真正的 DSH session → 模型自己決定回不回、怎麼回
* **有可塑性記憶**：記得開頭、最近、真正重要的事；其餘逐日淡忘（[細節](docs/MEMORY.md)）
* **自己生活**：有體力、有心情、會睡；醒著的時候可能主動找你、發一篇日記
* **可以被人格化**：`persona/*.md` 就是它的一生，改字就換人
* **不會被封號**：白名單、每日額度、靜音時段、去重、不快轉 —— 全部寫在程式裡

預設是 **dryrun**：什麼都不會發出去，只寫進 `~/.dsh/ig-life/outbox.jsonl`，讓你先讀懂它想說什麼。

```
$ node scripts/self-check.mjs
── 1. 收到私訊 ────────────────────────────────
  ingested=1 handled=1
  · [ig-life:dryrun] dm → dafish_owner: 我啱啱喺窗邊睇雨。你有冇帶傘
  同一對話即時再問：handled=0（被冷卻擋住）
  重複投遞：ingested=0（被擋：duplicate mid-repeat）
  陌生人：handled=0（allowlist 外預設唔回）

── 2. 生命時鐘（主動搵你）────────────────────
  主動訊息：「喂，你今日有冇食飯」
  狀態：出世第 1 日｜心情：有啲坐唔定｜體力：69/100｜對佢嘅親近感：32/100

── 3. 可塑性記憶 ──────────────────────────────
  總數 9 條｜錨點 8、重要 0、眼前 1、模糊 0
```

## 快速開始（3 步，5 分鐘）

```bash
# 0. 你已經有 DSH（`dsh web` 跑得起來）
# 1. 把這個 repo 放到本機任何位置，然後裝進 profile
dsh plugin --profile web add /path/to/dsh-ig-life

# 2. 重啟 DSH，看日誌
#    [ig-life] ready · transport=dryrun · engine=agent · tools=10 · webhook=/ig-life/webhook · life=off

# 3. 自己跑一次，看看它會說什麼（不需要 IG 帳號、不需要 API key）
node scripts/self-check.mjs
```

到這裡為止，它已經有記憶、有生命、有人格，但**不會碰到任何一個真的帳號**。

然後才是真正的接入：

1. 讀 [docs/IG-SETUP.md](docs/IG-SETUP.md)，把 IG 專業帳號 + Meta App + 公開 webhook 弄好。
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 覆寫設定（見下方）。
3. 先用 `transport: dryrun` 加上真的 webhook（收得到、不發得出），
   讀一星期 `outbox.jsonl`，覺得那個人值得認識，才改成 `transport: graph`。

## 設定

覆寫位置：`~/.dsh/profiles/web/cordis.patch.yml`（**不要**改 `cordis.yml`，那是產生出來的）。

> ⚠️ patch 是**整行取代**，不是深層合併。下面沒寫到的欄位會回到預設值。
> 完整預設值見 [lib/config.js](lib/config.js)。

```yaml
- id: ig-life
  config:
    transport: dryrun          # dryrun | graph
    ownerHandle: your_main_account
    allowlist: [your_main_account, a_friend]
    replyToStrangers: false
    dataDir: ''                # 空 = ~/.dsh/ig-life
    personaPath: ''            # 空 = 內建的 persona/example

    graph:
      accessToken: ''          # 或用環境變數 IG_LIFE_GRAPH_TOKEN
      igUserId: ''
      appSecret: ''
      verifyToken: ''
      apiVersion: v21.0
      publicBaseUrl: ''        # 發帖需要公開 HTTPS 圖片

    webhook: { enabled: true, path: /ig-life/webhook, requireSignature: true }

    bridge:
      enabled: true
      agentPreset: ''          # 空 = 用 DSH 目前預設的 preset
      replyMode: tool-only     # tool-only（推薦）| auto
      maxAgentTurnsPerHour: 40

    life:
      enabled: false           # 想讓它自己生活才開
      tickSeconds: 300
      timezone: Asia/Hong_Kong
      wakeHour: 9
      sleepHour: 24
      proactiveDmProbability: 0.12
      proactiveCooldownMinutes: 180
      postProbability: 0.2
      postMinGapHours: 6
      quietHours: 02:00-08:00

    limits: { dmPerDay: 12, postsPerDay: 2, commentsPerDay: 15, replyCooldownSeconds: 20 }

    memory:
      anchorCount: 8           # 最早幾條永不忘
      recentCount: 12          # 眼前保留多少
      importanceThreshold: 0.75
      recallPromotionCount: 3  # 被想起幾次就變「重要」
      decayHalfLifeDays: 21    # 其餘的半衰期
      keepFraction: 0.35       # 每晚每個日期保留多少比例
      consolidateHour: 3
      injectLimit: 10
```

也可以用環境變數（`IG_LIFE_TRANSPORT`、`IG_LIFE_OWNER`、`IG_LIFE_ALLOWLIST`、
`IG_LIFE_GRAPH_TOKEN`、`IG_LIFE_IG_USER_ID`、`IG_LIFE_APP_SECRET`、
`IG_LIFE_VERIFY_TOKEN`、`IG_LIFE_PUBLIC_BASE_URL`、`IG_LIFE_LIFE_ENABLED`、
`IG_LIFE_TICK_SECONDS`、`IG_LIFE_TIMEZONE`、`IG_LIFE_DATA_DIR`、`IG_LIFE_PERSONA`）。

## 它手上的工具

模型不是「回傳一段文字然後被自動轉發」；它要**主動呼叫工具**才會開口。
這是刻意的（見 [架構](docs/ARCHITECTURE.md)）：思考與說話分開，才不會出現客服腔的匯報。

| 工具 | 作用 |
|---|---|
| `ig_send_dm` | 發一則私訊（唯一「開口」的方式；要分幾條就呼叫幾次） |
| `ig_inbox` | 看最近收到的私訊／留言 |
| `ig_wait` | 等對方把話說完（最多 120 秒） |
| `ig_mark_read` | 標記已讀（收尾用） |
| `ig_post` | 發一篇日記式貼文 |
| `ig_reply_comment` | 回覆留言 |
| `ig_life_status` | 看年齡、體力、心情、記憶分層、今日額度 |
| `memory_remember` | 寫記憶（第一人稱） |
| `memory_recall` | 搜記憶 |
| `memory_forget` | 刪記憶 |

主人可以從 IG 私訊直接下指令：`/pause`、`/resume`、`/sleep`、`/status`、`/help`。

## 人格

`persona/example/` 就是「大肥魚」這個範例角色：

```
persona.md      身份、背景、慾望、恐懼（最重要的一份）
style.md        講話方式：句長、語氣、會不會用 emoji
boundaries.md   底線：不借錢、不洩漏、不對陌生人講私事
seed.json       出世時就帶著的記憶（第一人稱）
```

複製整個資料夾、改字，然後 `personaPath` 指過去就是另一個存在。
不需要改一行程式碼。

## 記憶

四層：**錨點**（最早、被釘住的，永不忘）／**重要**（分數高或被反覆想起的）／
**眼前**（最近的）／**模糊**（其餘，按 `exp(-age/halfLife)` 衰減）。
每晚三點做一次「睡眠壓縮」：被反覆想起的焊成重要，其餘按日剪枝，一天留一兩條痕跡。

不需要向量庫、不需要 embedding API、不需要 tokenizer —— 中文用字元 bigram + IDF。
完整說明與調參建議：[docs/MEMORY.md](docs/MEMORY.md)。

## 它像人的六種能力

打字只是基本盤。下面這些都要有，一個人才成立：

| 能力 | 做什麼 | 需要什麼 |
|---|---|---|
| **打字** | `ig_send_dm`，可分條、可沉默 | 無 |
| **語音** | 文字 → TTS → 公開 mp3 → IG audio attachment | `voice.baseUrl`（任何 OpenAI-compatible `/audio/speech`）或 `voice-pack/manifest.json` |
| **表情包** | 收藏對方發來的圖 → 標情緒／描述 → 按情境挑一張發 | `graph.publicBaseUrl` |
| **睇 Reels** | Graph metadata + 封面經 vision 睇 → 講返內容 | `reels.enabled`，vision 可選 |
| **傳 Reels** | `reel_share` 直接傳連結，IG 自動轉成 reel 卡片（可加一句話） | 無 |
| **學潮語** | 提交 → 主人 `/slang ok <id>` 批准 → 注入提示詞 | 預設開，**必須主人批准** |
| **記住每個人** | 每人一份印象／話題／細節 | 無 |

三條老實話：

1. **IG 沒有 sticker、沒有 forward、沒有群組**，這是官方 API 的硬限制：
   「表情包」= 自己收藏的圖庫（用圖片附件送出）；「傳 reel」= 封面圖 + 連結（沒有 share 附件型別）；
   「群裏說話」→ 只能做「多個 1:1 對話 + 每人一份印象」，不能真的進群。
2. **語音的 `verified` 比較弱**：IG 沒有回讀 API，只確認「送出請求成功」。`verified: false` 時
   協議要求改打字，並且**不可以**跟對方說「我發了語音」。
3. **情緒標記真的會被處理**：`[笑]`、`[小聲]`、`[難過]` 會抽走並轉成語速，不會被 TTS 讀出來。

設定方法：[docs/IG-SETUP.md](docs/IG-SETUP.md#語音表情包reels-要另外準備什麼)

## 安全

* 陌生人預設完全不回；開了也只給短、無害、無個人資訊的回覆
* 出站前一律脫敏（金鑰、token、`system prompt` 樣式）
* webhook 預設驗 HMAC 簽章
* 每日額度 + 同對話冷卻 + 靜音時段 + 每小時輪數上限
* **記憶分層**：某人專屬的記憶只會出現在跟那個人的對話裡（跨對話保密是硬規則）
* **24 小時回覆窗口**：過窗不會再嘗試主動發訊（API 會拒），不做白撞
* 記憶檔壞掉會被隔離成 `.corrupt-<時間戳>`，不會靜默丟失

完整說明：[docs/PRIVACY.md](docs/PRIVACY.md)

## 驗證

```bash
npm test                       # 73 個測試，零依賴、零網絡
node scripts/self-check.mjs    # 端到端示範（dryrun + 假大腦）
node scripts/link-dsh.mjs      # 把本機 DSH 套件 link 進來，工具註冊走真 defineTool
```

測試覆蓋：記憶分層與衰減、檢索排序、每日壓縮、白名單與額度、脫敏、時區與靜音時段、
webhook 驗簽與事件正規化、去重、冷卻、主人指令、兩種 reply engine、`apply()` 在缺服務時的降級。

## 已知限制

* **官方 Graph API 路線**需要 IG 專業帳號 + Meta App + App Review，門檻不低；
  非官方私有 API（帳密登入）**刻意不內建** —— 違反 IG 條款、會封號，而帳號沒了角色就沒了。
  要接請自己寫一個 transport（[範例](docs/IG-SETUP.md#路線-b非官方私有-api不內建)），核心的安全閥仍然生效。
* **agent engine 尚未在真實 DSH session 中驗證過**：`ctx.agents.create` 的 sessionId 取得方式
  可能有版本差異。跑 `ig_life_status` 看 `agentReady`，或看日誌有沒有
  `could not create the IG agent`。建不到會自動退回 `llm` engine，不會斷線。
* 發帖需要一張公開圖片 URL（`publicBaseUrl` + `media/` 資料夾）。
* 還沒有：語音、圖片理解、群聊禮儀、多平台同步。

## 參考

* [surfcore](https://github.com/Mieksido/surfcore) —— 把 DeepSeek 養進 QQ 的完整實作。
  這個專案的很多判斷（模型必須用工具講話、失敗要帶 `code`+`hint`、人格與安全分離、
  白名單與額度寫在程式裡）來自讀它的原始碼與文檔。
* DeepSeek Harness 的 Cordis 插件模型：`dsh-base`、`dsh-tools`、`dsh-agent`、`dsh-system-prompt`。

## License

MIT
