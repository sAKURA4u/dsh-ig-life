# 私隱與界線 / Privacy, boundaries, and what never leaves

這個專案要處理的是「一個會講話的存在」，所以界線必須寫死在程式裡，不能只寫在提示詞。

## 一、資料存在哪

只有一個資料夾：`${DSH_HOME:-~/.dsh}/ig-life/`（可用 `dataDir` 改）。

| 檔案 | 內容 | 敏感度 |
|---|---|---|
| `memory.json` | 它自己的記憶（第一人稱） | 高（含對話摘要） |
| `state.json` | 體力、心情、親近感 | 中 |
| `bridge.json` | 已處理的訊息 id、最近 200 條 inbox 快取、今日用量 | 高（含對話原文） |
| `outbox.jsonl` | 實際發出去的所有東西 | 高 |
| `media/` | 發帖圖片 | 低 |

**沒有**寫入任何全域位置，**沒有**上傳到任何第三方，**沒有**遙測。
刪掉這個資料夾就等於讓它失憶（連同你的人格設定一起，`persona/` 在專案目錄，不受影響）。

## 二、絕對不會流出的東西

`lib/gate.js` 的 `sanitizeOutbound()` 在**每一條**出站訊息送出前執行：

1. 刪掉看起來像金鑰的字串：`sk-…`、`IGAA…`、`EA…`（Meta token 開頭）、
   `access_token=…`、`app_secret=…`、`password=…`、`密碼=…`
2. 刪掉提示詞洩漏樣式：`system prompt:`、`你是一個由…模型驅動`
3. 摺疊空白、截斷在句子邊界（預設 900 字）

`containsSecret()` 是對應的偵測函式，測試 `test/gate.test.js` 釘住它。

**注意**：這是防護，不是萬能。真正的界線是 persona 的 `boundaries.md` ——
模型不該先產生那些內容。

## 三、誰可以跟它講話

三層：

1. **owner**（`ownerHandle`）—— 永遠允許，且是唯一能用控制指令的人。
2. **allowlist** —— 允許，但沒有控制權。
3. **陌生人** —— 預設完全不回（`replyToStrangers: false`）。開了之後也只能拿到
   短、無害、不涉及個人資訊的回覆（`strangerSafeMode`）。

`audience()` 是唯一的判定入口，測試釘住 owner/known/stranger 三態。

## 四、主人控制指令

從 owner 的 IG 私訊直接打：

| 指令 | 效果 |
|---|---|
| `/pause` | 立刻停止一切出站行為（連生命循環都停） |
| `/resume` | 恢復 |
| `/sleep` | 叫它去睡（不回應，直到醒來時間） |
| `/status` | 回報狀態、記憶分層、今日用量、是否暫停 |
| `/help` | 列出指令 |

這些指令**只認 `ownerHandle`**；陌生人打 `/pause` 完全無效（有測試）。

## 五、防封號（這是對「平台」的界線）

| 機制 | 作用 |
|---|---|
| `limits.dmPerDay` | 每日私訊上限（預設 12） |
| `limits.postsPerDay` | 每日發帖上限（預設 2） |
| `limits.commentsPerDay` | 每日留言上限（預設 15） |
| `limits.replyCooldownSeconds` | 同一對話的冷卻（預設 20 秒） |
| `life.quietHours` | 靜音時段（預設 02:00–08:00），期間不主動、不回陌生人 |
| `bridge.maxAgentTurnsPerHour` | 每小時最多啟動幾輪 agent（預設 40，硬上限 40） |
| webhook 去重 | 同一個 `mid` 只處理一次（Meta 會重試） |
| 失敗不快轉 | Graph 限流回 `IG_RATE_LIMIT`，不會自動重試硬撞 |

所有上限都是**每天**重置、本地時區計算。

## 六、關於「假裝真人」

`boundaries.md` 的預設立場：不主動自稱 AI，但**不會**為了騙取信任或金錢而編造人生、
不會借錢、不會代收款、不會應承線下見面。

這是刻意的選擇，也是這個專案跟「自動引流機器人」的分界。如果你 fork 之後要拿去做商業
引流，那是你的責任，但請至少保留 `boundaries.md` 的拒絕條款。

## 七、風險登記

| 風險 | 影響 | 現有緩解 |
|---|---|---|
| IG 帳號被限流／停用 | 角色失去身體 | 額度、靜音、去重、不快轉；先跑一星期 dryrun |
| Graph token 洩漏 | 別人可以代你發訊 | token 只在 config；`describeConfig()` 一律遮罩；`.gitignore` 擋 `.env` |
| webhook 被偽造 | 假訊息餵進角色 | `requireSignature` 預設 true，HMAC-SHA256 驗簽 |
| 記憶檔損壞 | 角色失憶 | 原子寫入 + 損壞檔隔離不刪除 |
| 提示詞注入（陌生人叫它洩漏設定） | 洩漏系統提示 | `sanitizeOutbound` + `boundaries.md` + 陌生人預設不回 |
| 模型幻覺發帖 | 公開發布錯誤內容 | `limits.postsPerDay`、`postMinGapHours`、先 dryrun 讀 outbox |
