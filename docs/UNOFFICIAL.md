# 非官方 transport / A personal Instagram account

> **⚠️ 先讀這段，再決定要不要用**
>
> 這條路**不是** Meta 提供的 API。它用 `instagrapi` 直接扮 IG app 講私人協議，
> **違反 Instagram 的服務條款**。後果由你承擔：
>
> - 帳號可能被限流、要求驗證、**或者直接永久停用** —— 沒有申訴、沒有解釋、沒有預警；
> - 用**主帳號**等於拿你全部的照片、對話、朋友去賭；
> - 本專案對這條路**不提供任何保證**：Instagram 一改簽名或風控，登入就會壞，
>   要等 instagrapi 更新，可能幾日，也可能永遠修不好；
> - 唔好用嚟做騷擾、詐騙、假身份騙財、大量加人、賣廣告。那是另一種東西，不是這個專案。
>
> **建議**：開一個可以隨時犧牲的小號，只放它一個人在裡面。當它是一個**會死的角色**來設計，
> 而不是一個「唔會有事」的產品。
>
> 如果你想要合法、穩定、不封號的路，請用官方 `transport: graph`（需要 Creator／Business 帳號），
> 見 [IG-SETUP.md](IG-SETUP.md)。

---

## 為什麼需要這條路

Meta 的 Instagram Messaging API **只服務 Creator／Business 帳號**，而且要 Meta App、
App Review、公開 HTTPS webhook。一個普通個人帳號**完全沒有官方 API**。

所以「像 QQ 那樣用普通 IG 帳號養一個 agent」只有一條路：用非官方私有協議登入。
這是 Meta 的限制，不是實作上的取捨。

## 架構：密碼永遠不進 Node

```
DSH 進程
  lib/poll.js ── 每 20 秒（+ 隨機）──▶ transport/unofficial.js ──▶ bridge.ingest()
  bridge（工具／生命時鐘）──────────▶ transport/unofficial.js
                                            │
                                            │ HTTP，127.0.0.1，帶 x-ig-life-token
                                            ▼
                        src/ig_bridge.py（唯一持有 session 的進程）
                          instagrapi · ig-session.json（0600，重用）
                          ig-secrets.json（0600，密碼只在這裡）
                                            │
                                            ▼
                                  Instagram 私有 API
```

三個刻意設計：

1. **密碼與 session 只在 Python sidecar**。Node 那一邊的 config、log、提示詞、
   測試、崩潰報告永遠看不到密碼或 cookie。
2. **sidecar 只聽 127.0.0.1，而且要求 token**。同一部機的其他程式也拿不到 session。
3. **sidecar 決定 IG 的實際節奏**：最少 10 秒一次讀取、內建隨機延遲、自己再擋一次每日額度。
   Node 那邊的節奏設定錯了，也不會直接打到 IG。

## 五分鐘設定

### 0. 需要什麼

- Python 3.9+
- 一個**可以犧牲**的 IG 小號（不要用主帳號）
- 建議把號養幾日：有頭像、有幾張相、有幾個 follow，不要一出世就發訊息

### 1. 裝依賴

```bash
python -m pip install -r src/requirements.txt
```

### 2. 放密碼（只放本機，永不進 repo）

資料夾預設是 `~/.dsh/ig-life/`（`DSH_HOME` 有設就跟著走）。

```bash
python src/ig_bridge.py --set-credentials
```

它會問 username 同 password（輸入時不會顯示、不會留在 shell 歷史、不會出現在任何 log），
確認兩次之後寫入 `<dataDir>/ig-secrets.json`，權限 0600。

想自己建檔也可以，但**唔好用 Windows PowerShell 5.1 的 `Set-Content -Encoding utf8`** ——
它會偷偷加 BOM（sidecar 現在容忍，但其他工具未必）：

```powershell
# Windows PowerShell
$dir = Join-Path $env:USERPROFILE '.dsh\ig-life'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
[IO.File]::WriteAllText((Join-Path $dir 'ig-secrets.json'),
  '{"username":"your_throwaway_account","password":"..."}')
```

> 也可以用 `IG_USERNAME` / `IG_PASSWORD` 環境變數，但環境變數會出現在進程列表和 shell
> 歷史裡，比檔案更不安全。

### 3. 登入一次

```bash
python src/ig_bridge.py --login
```

它會：

- 找到 `ig-session.json` 就先**重用**（唔會開新登入請求）；
- 只有 session 真的失效才用密碼登入，登入後把 settings + cookies 寫成 0600；
- 如果 IG 要求驗證（Challenge），會回 `IG_CHALLENGE_REQUIRED`：打開 IG app 按「呢個係我」，
  再跑一次；
- 如果 10 分鐘內已經重新登入過，會拒絕再登入（`IG_LOGIN_BACKOFF`）——
  崩潰重啟迴圈變成「不斷登入」是最大的封號觸發點。

成功會印出 `{"ok": true, "loggedIn": true, "session": "reused", ...}`。

### 4. 起 sidecar

```bash
python src/ig_bridge.py                     # 預設 127.0.0.1:8737
python src/ig_bridge.py --port 8737 --verbose
```

看到 `ig-bridge 監聽 http://127.0.0.1:8737` 就成功。讓它一直開著（另一個終端、或 Windows
的工作排程／NSSM；不要用 UAC 提權）。

`sidecar-token` 會自動生成在 `<dataDir>/sidecar-token`，Node 那邊會讀同一個檔案，
**兩邊不需要手動同步**。想自己看：

```bash
python src/ig_bridge.py --print-token
```

### 5. 設定插件

`~/.dsh/profiles/web/cordis.patch.yml`（整行取代，不是深層合併）：

```yaml
- id: ig-life
  config:
    transport: unofficial
    ownerHandle: your_main_account      # 你本人（唔係小號）
    allowlist: [your_main_account]
    webhook:
      enabled: false                    # 這條路收不到 webhook，關掉少一個入口
    unofficial:
      baseUrl: http://127.0.0.1:8737
      pollSeconds: 20                   # 地板 10，寫細過 10 會被夾成 10
      pollJitterSeconds: 6
      sendPerDay: 30
      postPerDay: 2
      sendGapSeconds: 8
    life:
      enabled: false                    # 先用 false 觀察一個星期
```

重啟 DSH，日誌應該出現：

```text
[ig-life] inbound polling every 20s (+0–6s jitter)
[ig-life] transport=unofficial：非官方私有 API，違反 IG 條款，有封號風險 —— 用可以犧牲嘅小號
[ig-life] ready · transport=unofficial · engine=agent · tools=21 · webhook=off · console=/ig-life/console · poll=20s · life=off · memory=7
```

### 6. 確認

用小號私訊自己（或者叫朋友私訊小號）。20 秒內 DSH session 應該收到那一則訊息，
模型要用 `ig_send_dm` 才會回。看：

- 網頁控制台 `/ig-life/console`（transport 一欄會顯示 session 是否重用、今日用量）
- `<dataDir>/outbox.jsonl`（實際發出去的每一則）
- `<dataDir>/ig-bridge.log`（sidecar 自己的日誌）

## 設定一覽

| 欄位 | 預設 | 作用 |
|---|---|---|
| `transport` | `dryrun` | 必須明確改成 `unofficial` |
| `unofficial.baseUrl` | `http://127.0.0.1:8737` | sidecar 位址；不是 loopback 會 warn |
| `unofficial.token` | `''` | 空 = 讀 `<dataDir>/sidecar-token` |
| `unofficial.pollSeconds` | `20` | 兩次讀取之間最少幾秒；**地板 10** |
| `unofficial.pollJitterSeconds` | `6` | 每次再加 0–6 秒隨機，避免節拍器 |
| `unofficial.sendPerDay` | `30` | Node 這邊的硬上限（連生命時鐘的主動訊息都算） |
| `unofficial.postPerDay` | `2` | 每日發帖上限 |
| `unofficial.sendGapSeconds` | `8` | 兩則出站訊息之間最少等幾秒 |
| `unofficial.requestTimeoutSeconds` | `45` | 呼叫 sidecar 的 timeout（發帖會拉到 90） |

環境變數：`IG_LIFE_UNOFFICIAL_URL`、`IG_LIFE_UNOFFICIAL_TOKEN`、`IG_LIFE_UNOFFICIAL_POLL_SECONDS`。

sidecar 自己另有 `--poll-seconds`（下限同樣 10）、`--send-per-day`、`--post-per-day`、
`--media-root`。兩邊的額度是**兩道閘**，任何一道擋住都發不出去。

## 安全閥：實際做了什麼

| 機制 | 位置 | 作用 |
|---|---|---|
| session 重用 | `ig_bridge._login` | 每次啟動都先試舊 session；唔會無事重新登入 |
| 登入退避 | `IG_LOGIN_BACKOFF`（10 分鐘） | 同一時段只准一次全新登入，斷絕崩潰迴圈 |
| 讀取地板 | `pollSeconds` ≥ 10 | 人類 app 不會 5 秒問一次 |
| 隨機延遲 | `pollJitterSeconds` + instagrapi `delay_range` | 不是節拍器、不是固定 UA |
| 發訊間隔 | `sendGapSeconds` | 連續回覆之間有真空 |
| 每日上限（兩層） | `unofficial.sendPerDay` + sidecar `--send-per-day` | 就算有人直接 curl sidecar 也發不爆 |
| 首次見面封頂 | sidecar `FIRST_SIGHT_MESSAGES = 3` | 第一次見到一個 thread 只取最新 3 條，不會一次過回覆一星期積壓 |
| username 補查 | sidecar（每次 poll 最多 3 次） | 有些 thread 沒帶用戶名；沒有名字就對不上白名單 |
| 白名單 | `gate.js`（原有） | 陌生人預設不回 |
| 靜音時段／冷卻／24 小時窗口 | `gate.js`（原有） | 照樣生效 |
| 出站脫敏 | `gate.js`（原有） | 密碼／token 形狀的字串不會被送出 |
| 媒體白名單 | sidecar `--media-root` | 只准上傳 `<dataDir>`（與你指定的資料夾）的檔案，避免誤傳整部機的檔案上 IG |
| 失敗不快轉 | `IG_RATE_LIMIT` | 撞牆就停，不會自動重試硬撞 |

**沒有**做的事：模擬瀏覽器指紋、代理輪換、多帳號。那些是養號工具的工作，不是這裡。

## HTTP 契約（debug 用）

所有請求都要 `x-ig-life-token`（同 `<dataDir>/sidecar-token`）。

| 方法 | 路徑 | Body | 回傳 |
|---|---|---|---|
| GET | `/health` | — | `{ok, loggedIn, needsLogin, username, session, sentToday, postToday, ...}` |
| GET | `/messages` | — | `{ok, messages:[...], cursor, throttled, skippedGroups}` |
| POST | `/send` | `{text, threadId?|userId?|username?}` | `{ok, id}` |
| POST | `/send_media` | `{path, type:image|audio|video|file, text?, threadId?...}` | `{ok, id, textId, mode}` |
| POST | `/post` | `{caption, imagePath}` | `{ok, mediaId, permalink}` |
| POST | `/reply_comment` | `{commentId, mediaId, text}` | `{ok, id}` |

`messages[]` 的形狀就是 webhook 正規化後的形狀（`id / threadId / senderId / username / text / at /
attachments`），所以 `bridge.ingest()` 完全不需要知道訊息是推進來還是拉回來的。

`/messages` 有內建節流：兩次之間短過 `pollSeconds` 就回 `{throttled:true, messages:[]}`，
**不會重播上一批**。

## 錯誤碼表

| 碼 | 意思 | 下一步 |
|---|---|---|
| `IG_SIDECAR_DOWN` | 連不上 sidecar | `python src/ig_bridge.py` |
| `IG_SIDECAR_TIMEOUT` | sidecar 45 秒沒回應 | 看 sidecar 終端；可能卡在登入 |
| `IG_SIDECAR_TOKEN_INVALID` | token 不對 | 兩邊讀同一個 `sidecar-token`；`--print-token` 核對 |
| `IG_SIDECAR_NO_DEPS` | 未裝 instagrapi | `python -m pip install -r src/requirements.txt` |
| `IG_NO_CREDENTIALS` | 找不到帳密 | 寫 `<dataDir>/ig-secrets.json`（0600） |
| `IG_LOGIN_REQUIRED` | session 失效 | `python src/ig_bridge.py --login` |
| `IG_CHALLENGE_REQUIRED` | IG 要求驗證 | 在 IG app 批准，再 `--login` |
| `IG_2FA_REQUIRED` | 帳號開了兩步驗證 | 關掉 2FA，或改用官方 graph |
| `IG_LOGIN_BACKOFF` | 10 分鐘內登入過 | 等，或者你真的要就 `--relogin` |
| `IG_RATE_LIMIT` | IG 限流 | 停手半個鐘以上，之後調慢 |
| `IG_DAILY_CAP` | sidecar 的每日上限 | 等明日 |
| `IG_UNOFFICIAL_CAP` | Node 這邊的每日上限 | 等明日 |
| `IG_MEDIA_ROOT` | 檔案不在允許的資料夾 | 用 `--media-root` 指定 |
| `IG_MEDIA_NOT_FOUND` | 檔案不存在 | 路徑要係 sidecar 讀到的本機檔案 |
| `IG_COMMENT_NEEDS_MEDIA` | 回留言缺 media id | 私有 API 要 media_id；見下面限制 |
| `IG_NOT_FOUND` | thread／media 不存在 | 對方封鎖／刪訊息 |
| `IG_UNOFFICIAL_ERROR` | 其他私有 API 錯誤 | 看 sidecar log；可能是 instagrapi 要更新 |

## 已知限制（誠實）

- **收不到留言**。webhook 在 unofficial 模式下完全沒作用，留言事件不會來。
  `ig_reply_comment` 只在你手上有 `mediaId` 時才用得到。
- **陌生人第一次私訊會落在「訊息請求」**，sidecar 讀的是主 inbox，所以看不到那批
  pending requests。這是 IG 的設計（也剛好是安全閥）：對方要先被接受，才會出現在對話列表。
- **第一次見到一個 thread 只會取最新 3 條**。更早的訊息不會補回；`bridge.json` 的
  inbox 也只有看得到的那些。
- **沒有群組**。群組 thread 會被跳過（`skippedGroups`），整個專案本來就只做 1:1。
- **沒有已讀回執、沒有 typing indicator**（IG 的私有協議有，但這裡刻意不做）。
- **語音格式**：IG 的 voice note 要 m4a／opus。專案預設 TTS 出 mp3，sidecar 會先試
  voice note，失敗就退回「檔案附件」。兩種都算送出，但對方看到的不是語音條。
- **看不到 reel／圖的內容**：附件只給 URL；要理解圖仍然要 `vision` 端點。
- **帳號綁在這部機**：session 檔換機或換 IP 太頻繁，容易被要求驗證。
- **2FA 不支援**。
- **沒有回讀**：跟官方一樣，送出的訊息只能確認「請求成功」。
- **升級會壞**：instagrapi 跟不上 IG 的改動時，登入會直接失敗。那時只能等，或者回到
  `dryrun`／`graph`。**壞了就修不保證。**

## 停用 / 撤退

1. 把 `transport` 改回 `dryrun`（或 `graph`），重啟 DSH。
2. 停掉 sidecar。
3. 想徹底斷開：在 IG app 改密碼（會令所有 session 失效），然後刪
   `<dataDir>/ig-secrets.json`、`ig-session.json`、`ig-session-meta.json`。
4. 角色自己的記憶留在 `<dataDir>/memory.json`，不受影響 —— 換一個身體可以繼續。

## 測試

```bash
node scripts/test.mjs            # 全部 JS 測試（包括 unofficial transport + poller）
python src/test_ig_bridge.py     # sidecar：正規化、額度、媒體白名單、token、HTTP 契約
python src/ig_bridge.py --health # 真實 session 狀態（會試重用 session）
```

`src/test_ig_bridge.py` 只用標準庫，不需要 instagrapi，也不會碰網絡：它用一個假 client
代替 instagrapi，所以 CI／離線都跑得。

## 最後

這條路的存在，是因為你想要一個**普通帳號**上的角色，而不是一個企業 API 的客服號。
代價是：它隨時會死，而且死的時候不會通知你。

把這件事寫進你的設計裡：記憶存在 `<dataDir>`，身體（帳號）可以換。
角色不應該因為一個帳號被停用而消失。
