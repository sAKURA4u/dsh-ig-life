# 接上真的 Instagram / Hooking up a real account

> 先把 `transport: dryrun` 跑一個星期。看 `~/.dsh/ig-life/outbox.jsonl`，讀它每一句想說的話。
> 如果你自己都覺得那個人煩，它就會被 IG 封。

**官方 Graph API** 合規但門檻高；**非官方私有 API**（帳密登入）快但違反 IG 條款、會封號，
現在是獨立、預設關閉的 `transport: unofficial`，見 [UNOFFICIAL.md](UNOFFICIAL.md)。

> **這一頁講的是官方 Graph 路線。** 如果你只有一個普通個人帳號（不是 Creator／Business），
> 官方 API 不會服務你 —— 那條路在 [UNOFFICIAL.md](UNOFFICIAL.md)，連同它的封號風險。

## 路線 A：官方 Meta Graph API（合規）

### 1. 帳號與 App

1. Instagram 帳號轉成 **Creator / Business**（設定 → 帳號類型）。
2. [developers.facebook.com](https://developers.facebook.com) 建 App，加 **Instagram** 產品。
3. 取得 `IG_USER_ID`（IG 專業帳號 id）與 **long-lived access token**。
   需要權限：`instagram_basic`、`instagram_manage_messages`、`instagram_content_publish`（發帖）。
4. App Secret → `graph.appSecret`（webhook 驗簽用）。

### 2. 公開 HTTPS webhook

Meta 只能打公開 HTTPS。本機開發用隧道：

```powershell
ngrok http 3080
# 或
cloudflared tunnel --url http://127.0.0.1:3080
```

Webhook 回呼網址填 `https://<隧道網域>/ig-life/webhook`，
驗證 token 自己定一組字串填進 `graph.verifyToken`（Meta App 那邊要填同一組）。
訂閱欄位至少要有 `messages`（私訊）和 `comments`（留言）。訂閱後 Meta 會立即打一次 GET 握手。

### 3. profile 設定

編輯 `~/.dsh/profiles/web/cordis.patch.yml`（**不要**改 `cordis.yml`）：

```yaml
- id: ig-life
  config:
    transport: graph
    ownerHandle: your_main_account
    allowlist: [your_main_account]
    graph:
      accessToken: 'IGAA...'
      igUserId: '17841400000000000'
      appSecret: 'xxxxx'
      verifyToken: 'change-me-verify-token'
      publicBaseUrl: 'https://<隧道網域>'
    webhook: { enabled: true, path: /ig-life/webhook, requireSignature: true }
    life: { enabled: true, tickSeconds: 300 }
```

⚠️ **patch 是整行取代，不是深層合併。** 上面的 `config` 會取代整個 config 物件，
沒寫到的欄位回到預設值（通常正是你要的）。

存檔後 profile 會自動重載（`patchReload: live`）。日誌應該出現：

```
[ig-life] ready · transport=graph · engine=agent · tools=21 · webhook=/ig-life/webhook · life=300s
```

## 路線 B：非官方私有 API（不內建）

用帳密 + session 模擬手機客戶端（Python 的 `instagrapi`、JS 的 `instagram-private-api`）
可以繞過 App Review、用普通個人帳號。本插件**不提供**這條路，原因：

1. 違反 Instagram 使用條款，帳號會被限流甚至永久停用 —— 而這個專案的核心是養一個角色，
   帳號沒了角色就沒了；
2. 私有 API 的簽名／風控隨時改，維護成本會壓過整個專案；
3. 要放帳號密碼進設定檔，一次誤 commit 就是災難。

如果你仍然要接，正確做法是**自己寫一個 transport**，不要改核心：

```js
// lib/transport/mine.js
export function createMyTransport({ config, store, logger }) {
  return {
    name: 'mine',
    async sendDm({ text, threadId, username }) { return { id: '' } },
    async sendAttachment({ type, file, text, threadId, username }) { return { id: '' } },
    async postPhoto({ caption, imageUrl }) { return { mediaId: '' } },
    async replyComment({ commentId, text }) { return { id: '' } },
    async health() { return { backend: 'mine', ok: true } },
    async close() {},
  }
}
```

然後在 `lib/transport/index.js` 的 `createTransport` 加一個分支。
這樣 `gate.js` 的白名單、額度、脫敏全部仍然生效。

## 語音、表情包、Reels 要另外準備什麼

IG 的 Messaging API **不接受檔案上傳**：圖片和音頻都必須是「Meta 抓得到的公開 HTTPS URL」。
所以這三樣能力都依賴同一個前提：`graph.publicBaseUrl` 指到你的隧道，
而插件已經有 `/ig-life/media/<file>` route 對外供應檔案。

**語音**（`voice.enabled: true`）

```yaml
voice:
  enabled: true
  baseUrl: 'https://api.openai.com/v1'   # 任何 OpenAI-compatible /audio/speech
  apiKey: 'sk-...'
  model: 'tts-1'
  voice: 'alloy'
  maxChars: 120
  perDay: 8
  cooldownMinutes: 10
```

沒有 TTS 也可以用**語音包**：`~/.dsh/ig-life/voice-pack/manifest.json` =
`[{"id":"hi","file":"hi.mp3","text":"喂","emotion":"開心"}]`，音檔放同一個資料夾。

⚠️ IG 沒有「回讀」API（QQ 的 `get_msg` 那種），所以 `verified: true` 只代表**送出請求成功**，
不代表對方一定收到。協議要求：`verified: false` 時必須改打字，並且**不可以**跟對方說發了語音。

**表情包**（`stickers.enabled`，預設開）

圖庫在 `~/.dsh/ig-life/stickers/`，索引 `stickers.json`。用 `sticker_collect` 收藏對方發來的圖
（只收 allowlist 的，除非開 `stickers.collectFromStrangers`），或自己把圖丟進去再叫它標註。
編號 `#01`、`#02`… **永不重用**（刪掉的號碼不會給新圖，否則同一個號會代表兩張不同的圖）。

**Reels**（`reels.enabled`，預設開）

- 看：需要 `mediaId`（對方分享 reel 過來時 webhook 會帶）。只有連結時**看不到內容**，
  Graph API 沒有 shortcode→mediaId 查詢。
- 想連畫面都看：設 `vision.baseUrl / apiKey / model`（任何 OpenAI-compatible vision 端點）。
  沒有 vision 就只看 caption，協議要求它講明「看不到畫面」。
- 傳：**直接傳連結就得** —— Instagram 會在對話裡自動把 IG 連結轉成 reel 卡片，
  所以 `reel_share` 不需要 `publicBaseUrl`、不需要 token、不需要抓封面。
  只有想「用封面圖當訊息本身」時才要 `reels.attachCover: true`（那時才需要公開媒體網址）。

## 錯誤碼對照表

| code | 意思 | 下一步 |
|---|---|---|
| `IG_NO_TOKEN` | 沒填 accessToken | 填 `graph.accessToken`，或先用 `transport: dryrun` |
| `IG_TOKEN_INVALID` | token 過期／被撤銷 | 重新產生 long-lived token |
| `IG_RATE_LIMIT` | 被 Meta 限流 | 調高 `limits.replyCooldownSeconds`、調低 `limits.dmPerDay`，等幾小時 |
| `IG_GRAPH_ERROR` | 其他 Graph 錯誤 | 看 `error.subcode`；權限不足通常是 App Review 未過 |
| `IG_NO_RECIPIENT` | 沒有對方 IGSID | Graph 只認 IGSID，對方必須先私訊你一次 |
| `IG_NO_IMAGE_URL` / `IG_NO_PUBLIC_BASE_URL` | 發圖／發帖／發語音缺公開網址 | 設 `graph.publicBaseUrl`，檔案放 `media/` |
| `IG_BAD_SIGNATURE` | webhook 驗簽失敗 | `graph.appSecret` 要跟 Meta App 一致 |
| `IG_WEBHOOK_VERIFY` | GET 握手失敗 | `graph.verifyToken` 要跟 Meta App 填的一致 |
| `IG_BUDGET_BLOCKED` | 被自己的額度／冷卻／靜音擋住 | 看 `reason`，必要時調 `limits` |
| `IG_NOT_ALLOWED` | 對象不在 allowlist | 加進 `allowlist`，或開 `replyToStrangers` |
| `IG_VOICE_DISABLED` / `IG_VOICE_UNAVAILABLE` | 沒開／沒 TTS 也沒語音包 | 開 `voice.enabled` + 設 `voice.baseUrl` |
| `IG_VOICE_UNVERIFIED` | 產生的檔案不像音頻 | **改打字**，不要假裝發了語音 |
| `IG_VOICE_QUOTA` / `IG_VOICE_COOLDOWN` | 今日額度滿／冷卻中 | 等，或調 `voice.perDay` / `cooldownMinutes` |
| `IG_STICKER_NOT_FOUND` / `IG_STICKER_LIBRARY_FULL` | 找不到／圖庫滿 | `sticker_list` 看編號；調 `stickers.maxItems` |
| `IG_REEL_NO_ID` | 只有連結，拿不到 mediaId | 老實跟對方說看不到，不要編 |
| `IG_REELS_RATE` | 一小時看太多條 | 調 `reels.perHour` |
| `IG_SLANG_INCOMPLETE` / `IG_SLANG_DAILY_LIMIT` | 提交不完整／今日提交太多 | 補 meaning；明天再交 |
| `IG_NO_VISION` | 沒有 vision 端點 | 設 `vision.*`，或只用文字 |

## 常見問題

**webhook 完全收不到事件？**
1. `curl "https://<隧道>/ig-life/webhook?hub.mode=subscribe&hub.verify_token=<你的>&hub.challenge=123"`
   應該回 `123`。
2. Meta App 的 webhook 頁面要顯示「已驗證」，並已訂閱 `messages` 欄位。
3. `transport: graph` 而 profile 裡沒有 webServer 時，日誌會有
   `transport=graph but no webServer in this profile`。

**它回了兩次同一句話？**
檢查是否兩個進程同時掛了同一個 profile（橋接進程 + DSH 桌面版）。
webhook 去重是按 `mid`，跨進程不共享。

**它一直不主動找我？**
依序檢查：`life.enabled` → `ownerHandle` 有填 → 現在不是 `quietHours` →
`proactiveCooldownMinutes` 未到 → **24 小時回覆窗口**是否已過 → `ig_life_status` 看體力有沒有低於 22。

**它說話很生硬像客服？**
改 `persona/example/style.md`，並且把 `life.enabled` 開起來。
沒有生活的人設，再好的模型也只能演客服。也可以把 `bridge.replyMode` 保持 `tool-only`
（`auto` 會讓它把思考一起發出去）。

**語音發了但對方沒收到？**
先確認 `graph.publicBaseUrl` 從外網抓得到那個 mp3：
`curl -I https://<隧道>/ig-life/media/<file>.mp3`。Meta 是**稍後**才去抓的，
所以檔案不能發完就刪 —— 本插件不會刪，只會修剪舊檔。
