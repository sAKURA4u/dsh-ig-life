# 架構 / Architecture

## 這是什麼

`dsh-ig-life` 是一個 **DSH bundle**（Cordis plugin package）。裝進 profile 之後，它給 DSH 的 agent 一副 Instagram 身體：

```
                 ┌─────────────────────────── DSH 進程 ───────────────────────────┐
  Meta webhook   │  webServer /ig-life/webhook                                     │
  (IG DM / 留言) │      │                                                          │
       ─────────▶│      ▼                                                          │
                 │  webhook.js  驗簽章 → 正規化事件                                 │
                 │      │                                                          │
                 │      ▼                                                          │
                 │  bridge.js   去重 → 白名單 → 額度/靜音/冷卻 → 召回記憶            │
                 │      │                                                          │
                 │      ├── engine=agent ─▶ ctx.agents.create + agent.followup()   │
                 │      │                     └─ 模型自己呼叫 ig_send_dm 工具        │
                 │      └── engine=llm   ─▶ ctx.llm.stream(...) → 我們代發          │
                 │                                                        │        │
                 │  transport (graph | unofficial | dryrun) ◀─────────────┘        │
                 └─────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                            Instagram / outbox.jsonl
```

另一副身體（`transport: unofficial`）只是換掉「入站」那一行 —— 沒有 webhook，改用拉的：

```
sidecar 127.0.0.1:8737 ◀── poll.js 每 20 秒 ± 隨機 ──▶ transport.poll()
                                                          │
                              與 webhook 正規化後同一個形狀 ▼
                                                    bridge.ingest()
```

同時，`life.js` 每一 tick 推進一次「身體狀態」（體力、心情、清醒），在合適的時候自己找你講話或發帖；`book.js` + `memory.js` 負責記憶的分層與遺忘。

## 為什麼是「插件」而不是「外部橋接」

參考實作 surfcore（把 DeepSeek 養進 QQ）走的是：**外部橋接進程 + MCP 工具 + 專用人格 preset**。那條路在 DSH 早期是唯一可行的（插件 API 不夠用），代價是要維護一個獨立進程、一堆 MCP 設定、以及一份要人手同步的 preset。

DSH 0.2 之後 `ctx.agents` / `ctx.llm` / `ctx.storage` / `ctx.webServer` / `ctx.tools` 都齊了，所以這裡選另一條：

| | 外部橋接（surfcore 式） | 本插件 |
|---|---|---|
| 進程 | 2 個（橋接 + DSH） | 1 個 |
| 接入方式 | MCP server + 工具協議 | 原生 `ctx.tools` + `ctx.agents` |
| 人格 | 一份 preset YAML，升級要人手抄 | 插件注入到那個 agent 的 prompt section |
| 對話記錄 | 橋接自己存 | 就是 DSH session（可用 `/compact`、看得到 trajectory） |
| 依賴 | `@modelcontextprotocol/sdk`、`zod`… | **零 runtime 依賴** |
| 風險 | DSH 升級要同步橋接 | 只用 stable 服務，缺服務會降級 |

反過來，本插件**沒有**做 surfcore 做過的一些事：語音條、表情包、圖片理解、黑話學習、群聊禮儀。那些留給之後。

## 掛載模型

`cordis.patch.yml` 只有一行：

```yaml
- insert:
    - id: ig-life
      name: dsh-ig-life
      config: {}
```

* `inject: ['timer']` —— **只**硬依賴 timer（`dsh-base` 一定有）。這是刻意的：
  row 若等待一個不存在的服務，DSH 的 boot audit 會直接判定 `N row(s) did not activate` 並中止啟動。
* 其餘服務全部 `ctx.get()` 試探，缺了就降級：

| 服務 | 缺了會怎樣 |
|---|---|
| `tools` | 沒有任何工具 → 模型無法發言（會用 llm engine 代發，若可用） |
| `agents` | 不用 agent engine，退回 `llm` engine |
| `llm` | 生命循環只剩時鐘，不主動說話；回覆靠 agent engine |
| `webServer` | webhook 不掛 → 收不到私訊（Graph 模式會 warn） |
| `systemPrompt` | 人格改用每輪訊息前綴注入 |

沒有一個缺失會讓插件拋錯或讓 DSH 起不來。

## 檔案

| 檔案 | 職責 |
|---|---|
| `lib/index.js` | `apply()`：接線、掛 webhook / console / poll / tick、回傳除錯 handle |
| `lib/config.js` | 零依賴的預設值 + 驗證 + 環境變數覆寫 + 三層合併 |
| `lib/settings.js` | 使用者設定層：白名單欄位、驗證、最小寫入 `<dataDir>/settings.json` |
| `lib/client.js` | 瀏覽器那一半：手寫 DSH client bundle，登記 `settings.section`「Instagram 人生」 |
| `lib/console.js` | 控制台頁 + 設定 REST（`/ig-life/console/api/settings`） |
| `lib/gate.js` | 純函式安全閥：白名單、靜音時段、額度、脫敏、主人指令 |
| `lib/memory.js` | 純函式記憶模型：分層、清晰度衰減、檢索評分、壓縮 |
| `lib/book.js` | 記憶的持久化 + 播種 + 每晚壓縮 |
| `lib/persona.js` | 讀人格 markdown、產生 Instagram 協議、播種記憶 |
| `lib/bridge.js` | 收訊 → DSH turn → 發訊；兩個 reply engine |
| `lib/life.js` | 狀態推進、主動私訊、自發發帖、內心獨白 |
| `lib/tools.js` | 21 個模型工具（`defineTool`） |
| `lib/webhook.js` | Meta 握手、HMAC 驗簽、事件正規化 |
| `lib/poll.js` | 沒有 webhook 的身體：去抖、隨機、退避的入站輪詢 |
| `lib/transport/*` | `graph`（官方 API）/ `unofficial`（本機 sidecar + 私有 API）/ `dryrun`（什麼都不發） |
| `src/ig_bridge.py` | 非官方 sidecar：唯一持有 IG session 的進程，只看 127.0.0.1 |
| `lib/store.js` | 原子寫入的 JSON + JSONL 日誌 |

## 非官方 transport：把手機交給 sidecar

`unofficial` 不是「另一個 API client」，而是**兩層**：

```
lib/transport/unofficial.js      只管 HTTP + 本地安全閥（額度、間隔、錯誤碼）
        │  127.0.0.1 + x-ig-life-token
        ▼
src/ig_bridge.py                 唯一持有密碼與 session 的進程；決定 IG 的實際節奏
```

三條規則決定了這個切法：

1. **密碼與 cookie 不進 Node**。Config、log、崩潰報告、提示詞都不會碰到它們。
2. **sidecar 決定節奏**。最少 10 秒一次讀取、instagrapi 內建隨機延遲、自己再擋一次每日額度。
   Node 那邊設定錯了，也不會直接打到 IG。
3. **入站是拉的**。`transport.poll()` 回傳的 event 跟 webhook 正規化後**同一個形狀**，
   所以 `bridge.ingest()` 完全不需要知道訊息是推進來還是拉回來。

代價：私有協議隨時會變，這條路不保證一直可用。風險與完整設定見
[UNOFFICIAL.md](UNOFFICIAL.md)。

## 兩種 reply engine

**agent（首選）**：`ctx.agents.create()` 建一個專屬 session，把私訊用 `agent.followup(createUserMessage(...))` 餵進去。人格與協議透過 `setup(agentCtx)` 期間的 `systemPrompt.section()` 注入，**只影響這一個 agent**。模型要講話就呼叫 `ig_send_dm`。

為什麼要模型主動呼叫工具、而不是把 assistant 文字自動轉發？因為「思考」與「說話」是兩件事。一旦自動轉發，模型會開始寫「我已經回覆了……」這種匯報式廢話，也會把 tool call 前後的推理一起發出去。surfcore 的 preset 明文寫死這條規則，這裡照抄那個教訓。

**llm（降級）**：建不到 agent 時，直接用 `ctx.llm.stream()` 生成一句，我們代發。功能少但不會斷線。

## 生命循環

```
tick（預設 300 秒）
 ├─ advanceState：按經過的時間加減體力、心情回歸基線、跨日重置
 ├─ 每晚一次（consolidateHour）：睡眠壓縮記憶
 ├─ 睡著 → 什麼都不做（除非主人來訊叫醒）
 ├─ maybeThink    ：約一小時一次內心獨白 → 寫進記憶（不發出去）
 ├─ maybeProactive：機率 × 親近感 × 冷卻 → 決定要不要先開口
 └─ maybePost     ：機率 + 最小間隔 → 決定要不要發一篇日記
```

所有機率都可以設 0，所有輸出都要過 `gate.js`。

## 驗證

```bash
npm test                       # 199 個測試，零依賴、零網絡
python src/test_ig_bridge.py   # sidecar 的測試（34 個，只用標準庫）
node scripts/self-check.mjs    # 端到端示範（dryrun + 假大腦）
node scripts/link-dsh.mjs      # 把本機 DSH 套件 link 進來，讓工具註冊走真 defineTool
```

## 已知未驗證

* **agent engine 從未在真實 DSH session 中跑過**：`ctx.agents.create({ sessionId, meta, setup })`
  的 `sessionId` 我們是先 `ctx.sessions.create()` 取得 id，失敗才退回自行生成的 uuid。
  不同 DSH 版本對 session id 格式的要求可能不同。跑 `ig_life_status` 看 `agentReady`，
  再看日誌有沒有 `could not create the IG agent`。
* **`session/event` 的 `assistant/message` 形狀**：只在 `bridge.replyMode: 'auto'` 時用到，
  取文字用寬鬆提取器（三種候選路徑），取不到就靜靜放棄，不影響 `tool-only` 模式。
* **Graph 發帖需要公開圖片 URL**：本插件只提供 `/ig-life/media/<file>` 這個 route，
  你在 profile 前面掛的 HTTPS 反向代理（ngrok / cloudflared）要指到 DSH 的 port。
