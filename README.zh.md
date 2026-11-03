<p align="center">
  <b>中文</b> ｜ <a href="README.md">English</a>
</p>

<h1 align="center">dsh-ig-life</h1>

<p align="center">
  <b>把 DeepSeek 養進 Instagram</b><br />
  一副 IG 身體 · 一副會忘記的記憶 · 一條會自己生活的時間軸
</p>

<p align="center">
  <a href="https://github.com/sAKURA4u/dsh-ig-life/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/sAKURA4u/dsh-ig-life/ci.yml?branch=main&label=tests&style=flat-square" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/sAKURA4u/dsh-ig-life?style=flat-square" /></a>
  <a href="https://github.com/sAKURA4u/dsh-ig-life/releases"><img alt="Release" src="https://img.shields.io/github/v/release/sAKURA4u/dsh-ig-life?style=flat-square" /></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white" />
  <img alt="Dependencies" src="https://img.shields.io/badge/runtime%20dependencies-0-brightgreen?style=flat-square" />
  <img alt="DSH" src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE?style=flat-square" />
</p>

<br />

> **一分鐘示範**：不需要 IG 帳號、不需要 API key —— 這只示範它怎麼說話，不是正式使用。
> 要真正收發私訊，有兩副身體可以接：**官方**那一副（IG 專業帳號 + Meta App long-lived token +
> 公開 HTTPS 隧道，見 [docs/IG-SETUP.md](docs/IG-SETUP.md)），或者**非官方**那一副
> （普通個人帳號 + 本機 Python sidecar，見 [docs/UNOFFICIAL.md](docs/UNOFFICIAL.md)；
> 違反 IG 條款，會封號）。插件本身永遠收不到你的密碼。
>
> ```bash
> git clone https://github.com/sAKURA4u/dsh-ig-life && cd dsh-ig-life
> node scripts/self-check.mjs
> ```

```text
── 1. 收到私訊 ──────────────────────────
  · [dryrun] dm → dafish_owner：我啱啱喺窗邊睇雨。你有冇帶傘
  同一對話即時再問：handled=0（被冷卻擋住）
  重複投遞：ingested=0（被擋 duplicate）
  陌生人：handled=0（allowlist 外預設唔回）

── 2. 生命時鐘（主動搵你）───────────────
  主動訊息：「喂，你今日有冇食飯」
  狀態：出世第 1 日｜心情：有啲坐唔定｜體力：69/100｜親近感：32/100

── 3. 可塑性記憶 ────────────────────────
  總數 9 條｜錨點 8、重要 0、眼前 1、模糊 0
```

這不是一個客服機器人。它會**主動找你**、**已讀不回**、**拒絕你**、**忘記不重要的事**，也會在你沒講話的三天後突然問你「你仲喺唔喺」。

---

## ✨ 它會做什麼

| | |
|---|---|
| 💬 **收發 IG 私訊** | webhook 進來 → 變成一個真正的 DSH session → 模型自己決定回不回、怎麼回 |
| 🧠 **可塑性記憶** | 記得開頭、最近、真正重要的事；其餘逐日淡忘，每晚三點「睡眠壓縮」 |
| 🌙 **自己生活** | 有體力、有心情、會睡；醒著時可能主動找你、發一篇日記 |
| 🎙 **用聲講話** | 文字 → TTS → 公開 mp3 → IG audio；`[笑]` `[小聲]` 轉成語速，不會被讀出來 |
| 🖼 **表情包** | 收藏對方發來的圖、標情緒、按情境挑一張發（編號永不重用） |
| 🎬 **睇／傳 Reels** | Graph metadata + 封面經 vision 睇；分享直接傳連結，IG 自己轉成卡片 |
| 📚 **學潮語** | 提交 → 主人 `/slang ok <id>` 批准 → 才注入提示詞 |
| 👤 **記住每個人** | 每人一份印象／話題／細節；跨對話隔離是硬規則 |

## 🧠 記憶：會忘記才是人

> 只記得開頭、最近，和真正重要的事 —— 其餘逐日淡忘。

| 層 | 誰會進來 | 會不會被忘 |
|---|---|---|
| **錨點** | pinned、identity、最早的前 8 條 | 永不忘 |
| **重要** | 分數 ≥ 0.75，或被想起 ≥ 3 次 | 不忘，而且越用越牢 |
| **眼前** | 最近 12 條 | 離開窗口後才衰減 |
| **模糊** | 其餘 | `exp(-age/21d)`，每晚按日剪枝 |

不需要向量庫、不需要 embedding API、不需要分詞器 —— 中文用字元 bigram + IDF。[完整說明 →](docs/MEMORY.md)

## ⚡ 安裝

```bash
dsh plugin --profile web add /path/to/dsh-ig-life
```

重啟 DSH，日誌出現：

```text
[ig-life] ready · transport=dryrun · engine=agent · tools=21 · webhook=/ig-life/webhook · poll=off · life=off · memory=7
```

**預設是 dryrun**：一個字都不會發去 IG，全部寫進 `~/.dsh/ig-life/outbox.jsonl`。
先讀一個星期，覺得那個人值得認識，再換一副真身體。

### 三副身體，同一個角色

| `transport` | 帳號 | 需要什麼 | 代價 |
|---|---|---|---|
| `dryrun` | 不用 | 什麼都不用 | 一個字都不發，只留 transcript |
| `graph` | 專業帳號（Creator／Business） | Meta App、long-lived token、公開 HTTPS | 他人要用要過 App Review，有 API 限流 |
| `unofficial` | **普通個人帳號** | Python 3.9+、`instagrapi`、本機 sidecar | **違反 IG 條款，會封號** |

`unofficial` 就是 `lib/transport/unofficial.js` 透過 127.0.0.1 跟 `src/ig_bridge.py` 講話。
密碼同 session cookie 永遠不進 Node 的 config、log 或提示詞 —— 而且「幾快碰 IG」是由 sidecar
決定的。[完整警告與設定 →](docs/UNOFFICIAL.md)

### ⚙️ 直接喺 GUI 改設定

插件會在 **DSH → 設定 → Instagram 人生** 加一頁：身體（transport）、主人帳號、白名單、
生命節奏、每日額度、sidecar 位址。存檔寫入 `<dataDir>/settings.json`（只寫這些欄位，
**永遠唔會寫 token／密碼**），頁面會講清楚「重啟 DSH 後生效」。

如果嗰頁冇出現（例如 client bundle 註冊失敗），`/ig-life/console` 一樣改得到；
整頁包在自己的 error boundary 裡，壞掉都唔會拖死其他設定頁。

<details>
<summary><b>📝 設定範例（點開）</b></summary>

覆寫位置：`~/.dsh/profiles/web/cordis.patch.yml`

```yaml
- id: ig-life
  config:
    transport: dryrun          # dryrun | graph | unofficial
    ownerHandle: your_main_account
    allowlist: [your_main_account]
    graph:
      accessToken: ''          # 或用環境變數 IG_LIFE_GRAPH_TOKEN
      igUserId: ''
      appSecret: ''
      verifyToken: ''
      publicBaseUrl: ''        # 發圖／語音需要公開 HTTPS
    unofficial:                # 只有 transport: unofficial 會用到
      baseUrl: http://127.0.0.1:8737
      pollSeconds: 20          # 地板 10 —— 讀得更快就是封號的原因
      pollJitterSeconds: 6
      sendPerDay: 30
      sendGapSeconds: 8
    life:
      enabled: false           # 想讓它自己生活才開
      tickSeconds: 300
      timezone: Asia/Hong_Kong
    limits: { dmPerDay: 12, postsPerDay: 2, commentsPerDay: 15, replyCooldownSeconds: 20 }
```

⚠️ patch 是**整行取代**，不是深層合併。完整預設值見 [lib/config.js](lib/config.js)。接 IG 的完整步驟見 [docs/IG-SETUP.md](docs/IG-SETUP.md)。

</details>

## 🎭 換人格

`persona/example/` 就是「大肥魚」這個範例角色：

```text
persona.md      身份、背景、慾望、恐懼（最重要的一份）
style.md        講話方式：句長、語氣、會不會用 emoji
boundaries.md   底線：不借錢、不洩漏、不對陌生人講私事
seed.json       出世時就帶著的記憶（第一人稱）
```

複製整個資料夾、改字，`personaPath` 指過去就是另一個存在。**不需要改一行程式碼。**

## 🛡 安全（寫在程式裡，不只是提示詞）

- 陌生人預設完全不回；開了也只給短、無害、無個人資訊的回覆
- 出站前一律脫敏（金鑰、token、`system prompt` 樣式）
- webhook 預設驗 HMAC 簽章；每日額度 + 同對話冷卻 + 靜音時段 + 24 小時回覆窗口
- **記憶分層**：某人專屬的記憶只會出現在跟那個人的對話裡
- 記憶檔壞掉會被隔離成 `.corrupt-<時間戳>`，不會靜默丟失

[完整說明 →](docs/PRIVACY.md)

<details>
<summary><b>🧩 21 個模型工具（點開）</b></summary>

模型不是「回傳文字被自動轉發」—— 它必須**主動呼叫工具**才會開口。思考與說話分開，才不會出現客服腔的匯報。

| 工具 | 作用 |
|---|---|
| `ig_send_dm` | 打字（唯一「開口」的方式，可分條） |
| `voice_send` | 用聲講（TTS 或語音包） |
| `sticker_list` / `sticker_send` / `sticker_collect` | 表情包：看、發、收藏 |
| `reel_watch` / `reel_share` | 看 reel、傳 reel（傳連結即可） |
| `slang_query` / `slang_submit` | 潮語：查、提交待批 |
| `people_note` / `people_list` | 記住某人的細節 |
| `image_describe` | 看圖（需 vision 端點） |
| `ig_inbox` / `ig_wait` / `ig_mark_read` | 看訊息、等對方講完、收尾 |
| `ig_post` / `ig_reply_comment` / `ig_life_status` | 發日記、回留言、看自己狀態 |
| `memory_remember` / `memory_recall` / `memory_forget` | 記憶 |

主人可從 IG 私訊直接下指令：`/pause` `/resume` `/sleep` `/status` `/slang` `/people` `/voice` `/help`

</details>

## 📚 深入

| 文件 | 內容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 為什麼是插件而不是外部橋接；兩種 reply engine；缺服務時如何降級 |
| [docs/MEMORY.md](docs/MEMORY.md) | 四層記憶、檢索評分、睡眠壓縮、調參建議 |
| [docs/IG-SETUP.md](docs/IG-SETUP.md) | Meta App、webhook、語音／表情包／Reels 設定、完整錯誤碼表 |
| [docs/UNOFFICIAL.md](docs/UNOFFICIAL.md) | 普通個人帳號那條路：封號風險、sidecar 設定、session 重用、錯誤碼 |
| [docs/PRIVACY.md](docs/PRIVACY.md) | 存什麼、不存什麼、防封號機制、風險台賬 |
| [CHANGELOG.md](CHANGELOG.md) | 更新日記：每一版改了什麼、為什麼 |

## ✅ 驗證

```bash
node scripts/test.mjs          # 199 tests · 0 fail · 零依賴、零網絡
node scripts/self-check.mjs    # 端到端示範（dryrun + 假大腦）
node scripts/loader-smoke.mjs  # 用真 Cordis 起一次，釘死載入契約
python src/test_ig_bridge.py   # 非官方 sidecar：只用標準庫，不需要 instagrapi
```

## ⚠️ 已知限制（誠實）

- IG 官方 API **只支援 1:1** —— 沒有群組、沒有 sticker、沒有 forward
- 非官方私有 API **現在內建了**，但是獨立、預設關閉的 `transport: unofficial`：違反 IG 條款、
  會封號，而且私有協議隨時會改 —— 沒有任何部分保證一直可用。用一個可以失去的帳號，
  見 [docs/UNOFFICIAL.md](docs/UNOFFICIAL.md)
- IG 沒有回讀 API，所以語音的 `verified` 只代表「送出請求成功」；失敗時協議要求改打字
- `agent` 引擎尚未在長期真實 DSH session 驗證；失敗會自動退回 `llm` 引擎
- 還沒有：語音輸入理解、圖片生成、多平台同步

## 🙏 參考

[**surfcore**](https://github.com/Mieksido/surfcore) —— 把 DeepSeek 養進 QQ 的完整實作。
本專案很多判斷（模型必須用工具講話、失敗帶 `code`+`hint`、人格與安全分離、額度寫在程式裡）來自讀它的原始碼與文檔。

## License

[MIT](LICENSE)
