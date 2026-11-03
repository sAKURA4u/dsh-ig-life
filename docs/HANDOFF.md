# 交接 / Handoff

寫給下一個接手的人（或下一個我）。帶着事實來，不要重新摸索。

---

## 1. 桌面 app 掛載問題（未解）

DSH 桌面 app（`0.2.1-rc.5`，`resources/app.asar`）**不會掛載本插件**；`node scripts`／`dsh web`（npm 版 `0.1.1-rc.2`，profile `web`）則正常。

### 已證明（用 app 內部的診斷探針實測）

在 app 的 loader 內動態 `import()` 本插件並執行 `apply()`，**兩者都成功**：

```
E import OK, exports: apply,configSchema,inject,instance,mount,name
E apply OK, returned undefined
```

同一個 patch 檔、同一種寫法，**探針插件**（`mini-probe`，同目錄結構）可以正常掛載並執行。
所以：**模組與 `apply()` 都沒有問題，是 loader 對這個 row 的處理不同。**

### 已排除的假設（全部實測過，不要再試）

| # | 假設 | 結果 |
|---|---|---|
| 1 | 沒裝進 `desktop` profile | 已裝，`dsh.profile.bundles` 有 `dsh-ig-life` |
| 2 | 全局 `~/.dsh/cordis.patch.yml` | app 不讀 |
| 3 | row 沒插入 | 卡片顯示 `include: ig-life` + 完整檔案路徑 → row 有建立 |
| 4 | `inject: ['timer']` 等待服務 | 改成 `[]` 無效 |
| 5 | row id 與套件名衝突 | 換 `ig-life-live` 無效 |
| 6 | 中文路徑／percent-encoding | 純英文真實目錄（非 junction）無效 |
| 7 | `package.json` exports 限制 | 加 `./*` 通配無效 |
| 8 | 入口必須在套件根目錄 | 用 `entry.js` 再匯出無效 |

### 下一步（唯一剩下的方向）

在 app 內按 `Ctrl+Shift+I` 開 DevTools，看 console 對 `ig-life` 這個 entry 的實際錯誤。那是唯一尚未取得的資訊。

> 注意：app 的 profile patch 會被它自己管理（開機重寫 `cordis.yml`），設定 `~/.dsh/profiles/desktop/cordis.patch.yml` 時務必先備份。

---

## 2. 非官方 transport（已完成）

`transport: unofficial` 已經實作，**預設關閉**，要明確選。官方 Graph API 只服務
Creator／Business，所以「像 QQ 那樣用普通帳號」只有私有 API 一條路。

### 檔案

| 檔案 | 職責 |
|---|---|
| `src/ig_bridge.py` | sidecar：登入、session 重用、輪詢、發送、發帖、回留言、額度、媒體白名單、token |
| `lib/transport/unofficial.js` | Node 的 HTTP client：token、錯誤碼映射、本地額度／間隔、`poll()` 正規化 |
| `lib/poll.js` | 入站輪詢：地板 10 秒、jitter、指數退避、重疊保護、可 dispose |
| `src/test_ig_bridge.py` | 33 個 sidecar 測試（假 client，不需要 instagrapi、不碰網絡） |
| `docs/UNOFFICIAL.md` | 大字警告、五分鐘設定、HTTP 契約、錯誤碼表、撤退步驟 |

### 決定（不要再重新討論）

1. **密碼與 cookie 只在 sidecar**，Node 永遠不讀。理由：config、log、提示詞、崩潰報告全部
   經過 Node。
2. **sidecar 決定 IG 的實際節奏**（讀取地板 10 秒 + instagrapi `delay_range` 1.5–4 秒）。
   Node 的 `pollSeconds` 只是「最少等幾久」，不是節奏來源。
3. **入站用拉的**。`/messages` 回傳的 event 形狀 = `webhook.js` 正規化後的形狀，
   所以 `bridge.ingest()` 完全沒有改。
4. **兩層每日額度**：Node 擋一次、sidecar 再擋一次（防止有人直接 curl sidecar）。
   生命時鐘的主動訊息也計入 Node 那一層。
5. **節流時回空，不回放 cache**。回放會令同一條訊息重複進 inbox；已送出的 id
   記在 `ig-bridge-state.json`。
6. **登入退避 10 分鐘**：崩潰重啟 ≠ 登入風暴。只有 `--relogin` 可以無視。
7. **媒體白名單**：sidecar 只准上傳 `<dataDir>`（與 `--media-root`）之內的檔案 ——
   否則一個 bug 就可以把整部機的檔案傳上 IG。
8. **token 自動共享**：`<dataDir>/sidecar-token`，兩邊讀同一個檔案；不做 config 複製。

### 未做（刻意或待辦）

- **留言**：unofficial **收不到** comment 事件（沒有 webhook）。`ig_reply_comment` 要
  `mediaId` 才用得到。要補就要在 sidecar 加 `media_comments` 輪詢，但那是另一倍的 API
  呼叫，風險要另計 —— 不要為了功能對稱而加。
- **voice note**：IG 要 m4a／opus。TTS 出 mp3，sidecar 先試 `direct_send_voice`，
  失敗就 `direct_send_file`，回傳 `mode` 講清楚是哪一種。
- **2FA**：不支援，會回 `IG_2FA_REQUIRED`。
- **沒有**模擬瀏覽器指紋、代理輪換、多帳號。刻意不做。
- **未在真實 IG 帳號上驗證過**（開發時沒有可用的小號）。JS 測試用假 fetch、Python 測試用
  假 client。第一件事應該是 `python src/ig_bridge.py --login`，看真實回傳的錯誤碼。

---

## 3. 現況基線

- **186 個 JS 測試** + **33 個 Python sidecar 測試**，全綠
- `node scripts/loader-smoke.mjs`（真 Cordis）全綠
- CI：Node 20/22/24 × Ubuntu/Windows 全綠（Python 測試要手動跑：`python src/test_ig_bridge.py`）
- Release：`v0.3.0`；CHANGELOG 中英
- 可用入口：`dsh web` → `/ig-life/console`；桌面 `睇大肥魚狀態.cmd` → 直接讀資料檔
- 三副身體：`dryrun`（預設）、`graph`（官方，需要專業帳號）、`unofficial`（普通帳號，會封號）
