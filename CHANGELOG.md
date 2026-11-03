# 更新日記 / Changelog

值得記下來的改動都在這裡。格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號用 [SemVer](https://semver.org/lang/zh-TW/)。

---

## [0.4.0] — 未發佈

### 修正

- **整個插件 mount 回滾（設定頁 404 的真正原因）** — `ctx.interval` 在 `inject` 沒有
  `timer` 時會拋 `cannot get property "timer" without inject`，而只要 `life.enabled: true`
  就會踩到。插件一 rollback，所有路由（連 console API）都消失，只剩靜態 client bundle，
  畫面就變成「HTTP 404」或空白。現在改用免 inject 的 `ctx.get('timer')` 取 timer 服務，
  而且 tick 外層有 try/catch：timer 真的缺席時只會 warning，不會再拖死整個插件。


### 新增

- **連續訊息合併** — `bridge.burstWindowSeconds`（預設 6 秒）：同一個人短時間內連傳幾條，
  會先按住，等窗口靜止再一次過理解、只回一次。每條之間會保留換行；`burstMaxWaitSeconds`
  防止有人不停打字時無限延遲。0 = 關閉。
- **分段回覆寫入提示** — 明確告訴模型：可以分 2–3 條短訊息回（系統會自動拉開間隔），
  但連續訊息要當一段理解，不要逐條答。
- **隨機回覆延遲** — `bridge.replyDelaySeconds {min,max}`（預設 2–12 秒），收到訊息後先等一段隨機時間才開始想回覆；
  設定頁可改。人可以一兩秒回，也可以隔幾分鐘才回，但唔會每次同一個節奏。
- **Story** — `ig_story` 工具 + sidecar `POST /story`（`photo_upload_to_story`）。它可以發限時動態，
  caption 可留空；計入每日發帖額度。
- **改自己的 profile** — `ig_profile` 工具 + sidecar `POST /profile`：顯示名稱、bio（IG 上限 150 字）、頭像。
  出站照樣過 `sanitizeOutbound`。
- **人格可以在 GUI 改** — `/ig-life/console` 新增「人格」卡：`persona.md` / `style.md` / `boundaries.md`
  三個 textarea。第一次編輯會把目前的人格複製到 `<dataDir>/persona/`，之後只改這份；
  **打包附帶的範例人格永遠唔會被寫入**。存檔後重啟生效。
- **console 修正** — 頁面內的 API 呼叫由相對路徑改成絕對路徑（頁面在 `/ig-life/console`，
  相對路徑會打到 `/ig-life/api/*`），所以按鈕終於真的叫到後端。

### 已知限制

- Story 只支援圖片（`photo_upload_to_story`）；影片 story 未接。
- `ig_profile` 改不到 username（IG 唔准經 API 改）。
- 人格編輯要重啟 DSH 才生效（prompt 在 mount 時組好）。

---

## [0.3.0] — 2026-11-04

第二副身體：**普通 IG 帳號**。官方 Graph API 只服務 Creator／Business 帳號，所以「像 QQ 那樣用
一個普通帳號養 agent」只有非官方私有 API 一條路。這一版把它做成獨立、預設關閉的 transport。

### 新增

- **非官方 transport（`transport: unofficial`）** — `lib/transport/unofficial.js` 經本機
  Python sidecar（`src/ig_bridge.py`，instagrapi）收發私訊、傳圖、傳語音、發帖、回留言。
  與 `graph` 同一介面，上面所有安全閥照樣生效。
- **密碼與 session 只留在 sidecar** — `ig-secrets.json`、`ig-session.json` 由 sidecar 以 0600
  寫入；Node 進程只是一個 HTTP client，帶 `x-ig-life-token`，只連 127.0.0.1。密碼不會出現在
  config、log、提示詞或測試裡。
- **session 重用優先，加登入退避** — 每次啟動先重用舊 session；10 分鐘內拒絕第二次全新登入。
  崩潰重啟迴圈變成「不停登入」是最快的封號方式，這條路直接斬斷它。
- **入站輪詢（`lib/poll.js`）** — 沒有 webhook 的身體用拉的：地板 10 秒、隨機 jitter、
  失敗指數退避、同一時間只有一個 poll、unmount 時自動停。
- **兩層每日額度** — Node 的 `unofficial.sendPerDay` / `postPerDay` / `sendGapSeconds`，加上
  sidecar 自己的 `--send-per-day` / `--post-per-day`。生命時鐘的主動訊息也計入，
  所以沒有一條路可以繞過上限。
- **sidecar 媒體白名單** — 只准上傳 `--media-root`（預設 `<dataDir>`）之內的檔案，
  避免有人（或一個 bug）把整部機的檔案傳上去。
- **`--set-credentials`** — 互動輸入小號帳密（不回顯、不進 shell 歷史），sidecar 以 0600 寫入；
  同時容忍 Windows PowerShell 寫出的 UTF-8 BOM（以前會令密碼檔「讀不到」而被隔離）。
- **GUI 設定頁** — **DSH → 設定 → Instagram 人生**：帳號（IG 使用者名稱／密碼 + 儲存並登入）、
  身體、主人、白名單、生命節奏、額度、sidecar 位址；**每個選項都有一句說明**。
  存 `<dataDir>/settings.json`（只寫白名單欄位，永遠冇 token），重啟後生效。
  客戶端 bundle（`lib/client.js`）是手寫的 lazy-CJS、沒有 build step；整頁包在自己的 error
  boundary 裡，註冊或 render 失敗只影響這一頁。
- **帳密可以在 GUI 設定** — 頁面 POST 去 `/ig-life/console/api/account`，插件轉去 sidecar 的
  `/credentials`；只有 sidecar 會寫 `<dataDir>/ig-secrets.json`（0600）。密碼唔會寫 log、
  唔會存喺插件這一邊、唔會回傳；存檔後欄位即清空，空密碼＝沿用舊的。同時加 `POST /login`
  俾「儲存並登入」用（session 先，失效才用密碼），之後啟動自動重用 session。
- **同源檢查** — 所有會改狀態的 POST 都要求 `Origin`／`Sec-Fetch-Site` 同源，單靠 loopback
  唔夠（本機任何程式都連得到 127.0.0.1，瀏覽器又可能被其他網站驅動）。
- **帳密可以先填、後轉 transport** — 設定頁用一個獨立的 sidecar 客戶端（唔借現行的
  transport），所以 `transport: dryrun` 都存得到帳密；頁面會提示「目前係 dryrun，要改為
  unofficial 才會用」，並有一個「改用 unofficial」按鈕一鍵改＋存。之前會回
  `IG_TRANSPORT_NO_ACCOUNT`，因為 dryrun 的 transport 根本冇帳號概念。
- **設定層三層合併** — 預設值 → Cordis row（部署）→ `<dataDir>/settings.json`（使用者），
  同 DSH 自己的設定模型一致；`lib/settings.js` 負責驗證與最小寫入（只寫使用者改過的 path，
  不會把今日的預設值烙進檔案）。
- **console 唔再依附 webhook** — `/ig-life/console` 與 `/ig-life/media` 只要有 webServer 就掛，
  即使 `webhook.enabled: false`；只有 Meta 的 webhook 路由跟嗰個開關走。
- **插件自己管 sidecar** — `unofficial.autoStart`（預設開）：掛載時 `/health` 冇回應就自動 spawn
  `src/ig_bridge.py --serve --data-dir <dataDir>`，已有人在跑就直接接管；列出 Python／依賴狀態，
  設定頁有「啟動／重新啟動／檢查依賴」。裝好之後唔需要再開終端。子進程只讀同一個 dataDir
  （包括 `sidecar-token`），所以自訂 dataDir 都唔會撞 401。
- **sessionid 登入** — IG 已經唔再提供密碼加密金鑰（`password_publickeys()` 會 `int(None)`），
  密碼登入實質被封。sidecar 支援 `{"sessionid": "..."}`（同 `login_by_sessionid()`），
  設定頁加「sessionid」欄；session 重用改用 `login_by_sessionid` 驗證，唔會再誤入密碼流程。
  `instagrapi` 升級到 `>=3.2,<4`。
- **「安裝依賴」按鈕** — 設定頁一按就跑 `python -m pip install -r src/requirements.txt`（非阻塞、
  5 分鐘上限、輸出回傳）；只有用戶明確按下去才會裝東西。對外派發時，對方只剩「裝 Python」
  同「填帳號」兩件事。
- **相容範圍擴到 0.2.x** — `peerDependencies` 由 `^0.1.1-rc.2` 擴到
  `^0.1.1-rc.2 || ^0.2.0 || ^0.2.1-rc.5`。之前 0.2.1 桌面 app 會靜靜跳過插件，要人手寫
  `compatibility.json`；現在新裝唔需要。0.2.2-rc.x 這類未出 prerelease 仍要豁免（semver 規則）。- **`docs/UNOFFICIAL.md`** — 大字警告、五分鐘設定、HTTP 契約、錯誤碼表、撤退步驟。
- **`src/test_ig_bridge.py`** — 34 個 sidecar 測試：訊息正規化、額度、媒體白名單、token、
  HTTP 契約、BOM 容忍。只用標準庫、用假 client，不需要 instagrapi、不碰網絡。

### 修正

- 這一版沒有改動官方 transport 的行為。

### 已知限制

- unofficial **收不到留言**（webhook 在這種模式下沒有作用），`ig_reply_comment` 要手上有
  `mediaId` 才用得到。
- 2FA 不支援；voice note 要 m4a／opus，TTS 的 mp3 會退回「檔案附件」。
- 私有協議隨時會改。Instagram 一改簽名，登入就會壞，要等 instagrapi 更新 —— **壞了不保證修好**。
- **密碼登入已被 IG 封**：Instagram 不再提供 `ig-set-password-encryption-key-id`，instagrapi
  的 `password_publickeys()` 會 `int(None)`。請用 **sessionid** 登入（設定頁有欄位）。
- 非官方帳號會封。用一個可以犧牲的小號，先 dryrun 觀察一個星期。

---

## [0.2.0] — 2026-11-03

第一個「像人」的版本。0.1.0 只會打字；這一版會用聲講話、會忘記、也有自己的社交生活。

### 新增

- **語音**（`voice_send`）— 文字走任何 OpenAI-compatible `/audio/speech` 端點，或使用預錄語音包；音檔經驗證（magic byte + 大小）才當作成功。語氣標記 `[笑]` `[小聲]` `[難過]` 會被抽走並映射成語速，**不會被讀出來**。
- **表情包**（`sticker_list` / `sticker_send` / `sticker_collect`）— 收藏對方發來的圖、標情緒與描述、按情境挑一張發。編號單向遞增，刪除後不重用。
- **Reels**（`reel_watch` / `reel_share`）— 讀 metadata，封面可經 vision 觀看；分享直接傳連結，Instagram 自己會轉成卡片。
- **潮語學習**（`slang_query` / `slang_submit`）— 提交後**必須主人批准**（`/slang ok <id>`）才進入提示詞；每日提交上限，避免亂交。
- **每人一份印象**（`people_note` / `people_list`）— 每人一份稱呼、印象、未講完的話題；**跨對話隔離**寫在程式裡。
- **看圖**（`image_describe`）— 任何 OpenAI-compatible vision 端點，用於 reel 封面與對方傳來的圖。
- **網頁控制台** — `/ig-life/console`：狀態、記憶分層、能力、最近訊息，加上暫停／恢復／推進生命時鐘。只接受本機請求。
- **離線狀態報告** — `tools/report.mjs` 與雙擊即用的 `睇大肥魚狀態.cmd`：直接讀資料檔生成 `report.html`，不需要伺服器、不需要 port。
- **對話續接** — 記住 IG session id，DSH 重啟後用 `agents.resume()` 接回同一個對話，而不是每次開新 session。
- **24 小時回覆窗口** — 過了窗口不再嘗試主動發訊（API 會拒絕）。

### 修正

- **`apply()` 回傳物件導致整個 profile 起不來** — Cordis fiber 只接受 `undefined` 或 disposer，其他一律 `TypeError: Invalid effect`。改為掛在 `instance()` 上。
- **CI 三處**：`node --check` 對 top-level await 報 SyntaxError；一個測試硬編碼 Windows 路徑；self-check 假設主機裝了 DSH 套件（CI 沒有）。
- **桌面捷徑寫到假桌面** — Windows 會把可見桌面重定向到 OneDrive，改為探測多個候選並只寫入存在的目錄。
- **表情包編號重用** — 刪除後的號碼不再分配給新圖，否則 `#03` 會代表兩張不同的圖。

### 已知限制

- Instagram 官方 API **只支援 1:1**，沒有群組、沒有 sticker、沒有 forward。
- 非官方私有 API（帳密登入）**刻意不內建**。
- 沒有回讀 API，所以語音的「已驗證」只代表送出請求成功。
- `agent` 引擎尚未在長期真實 session 驗證；失敗會退回 `llm` 引擎。

---

## [0.1.0] — 2026-11-03

初版：一個能把 DeepSeek 接進 Instagram 私訊的 DSH bundle。

### 新增

- 收發 IG 私訊 — webhook → DSH session → 21→10 個模型工具
- 可塑性記憶四層（錨點／重要／眼前／模糊）+ 每晚睡眠壓縮
- 生命時鐘：體力、心情、清醒、主動私訊、自發發帖
- 人格協議 18 節（反 AI 味、主體性、該說不該說、收尾判斷、分條節奏、跨對話保密）
- 安全：白名單、每日額度、同對話冷卻、靜音時段、出站脫敏、webhook HMAC 驗簽
- dryrun 身體（一個字都不發出去）+ 官方 Graph API 身體
- 152 個測試、真 Cordis loader smoke、零 runtime 依賴
