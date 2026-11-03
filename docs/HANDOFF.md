# 交接 / Handoff

寫給下一個接手的人（或下一個我）。帶着事實來，不要重新摸索。

---

## 1. 桌面 app 掛載問題（已解決）

DSH 桌面 app（`0.2.1-rc.5`，`resources/app.asar`）曾經**不會掛載本插件**；2026-11-03 23:22
已喺 app 內成功掛載（`tools registered: 21 (ok)`）。根因同出口如下。

### 根因：DSH 0.2 的插件相容性閘（不是 loader、不是 path、不是 row）

DSH 0.2 的啟動器（`@deepseek-ai/dsh-app-boot`）逐個 bundle 檢查相容性，**唔符就靜靜跳過**，
只寫 `skipping profile bundle ...` 去 stderr —— Electron 冇 console，所以完全睇唔到。

規則（`evaluatePluginCompatibility`）：

- `package.json` 有 `engines.dsh` → 只睇它；
- 否則，**每一個** `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peerDependency 都要 `semver.satisfies(runtimeVersion, range)`；
- 注意 semver 的 prerelease 規則：`^0.1.1-rc.2` 只覆蓋 `0.1.1-rc.x` 同 `0.1.x` release，
  **唔會**覆蓋 `0.2.1-rc.5`；而且 `>=0.1.1-rc.2 <0.3.0` 都唔會（prerelease 要同一 tuple 先算）。

實測：

```
dsh-app-boot 0.2.1-rc.5（桌面 app）  vs ^0.1.1-rc.2 -> false   ← 被跳過
dsh 0.1.1-rc.2（npm CLI）            vs ^0.1.1-rc.2 -> true    ← 掛得到
```

`mini-probe` 得、本插件唔得，差別就在這裡：探針冇宣告 `@deepseek-ai/dsh-*` peer。

### 出口：精確版本豁免（官方機制）

`<profile>/compatibility.json`，key 係 `name@version`，value 係精確 runtime 版本清單：

```json
{ "dsh-ig-life@0.3.0": ["0.2.1-rc.5"] }
```

已寫入 `~/.dsh/profiles/desktop/compatibility.json`。等價於 app 插件管理器／
`dsh plugin allow-version` 的「接受風險」授權；**唔會**改 manifest，移除檔案即撤回。

> ⚠️ **呢個檔案唔可以有 BOM。** PowerShell 5.1／部分環境的 `Set-Content -Encoding utf8`
> 會加 BOM，DSH 的 `JSON.parse` 會失敗，然後**靜靜當作冇豁免**（warning 只寫去 stderr）。
> 用 `[IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding($false)))`。
> 第一次就係踩了呢個：檔案存在、內容正確，但豁免完全冇生效。

### 診斷方法（可重用，唔需要 DevTools）

app 內的 DSH runtime 可以直接當 node 用，叫它自己解釋一次 profile 組合：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'D:\Users\felix\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' probe.mjs
```

`probe.mjs`：

```js
const ASAR = 'D:/Users/felix/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const boot = await import(`file:///${ASAR}/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`)
const profile = boot.loadProfileDirectory('dsh', 'C:\\Users\\felix\\.dsh\\profiles\\desktop', `${ASAR}/dsh/package.json`)
console.log(JSON.stringify({ layers: profile.layers.map((l) => l.packageName), skipped: profile.skippedBundles }, null, 2))
```

這次的實測輸出（豁免修好之後）：

```
exemptions: {"dsh-ig-life@0.3.0":["0.2.1-rc.5"]}  warnings: []
layers: ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-ig-life"]
skipped: []
entries: […, "ui-settings-plugins", …, "ig-life"]
```

`skippedBundles[].reason` 就係之前一直睇唔到的那句錯誤 —— 它只會寫去 stderr，
Electron app 冇 console，所以整條線索斷在這裡。

### 預檢：插件在 0.2.1-rc.5 真的跑得起來

用**隔離的 `DSH_HOME`** + app 自己的 CLI（唔碰用戶 profile、唔開 GUI）boot 一次：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'; $env:DSH_HOME = "$env:TEMP\dsh-preflight"
& 'D:\...\DeepSeek Harness.exe' 'D:\...\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js' `
  --profile preflight --port 0 --no-open
```

```
tools registered: 21 (ok)
mounted ok
```

所以 `transport`、工具註冊、webServer 在 0.2.1 都正常；剩下的風險只在 agent engine
（要真人對話才驗得到）。**呢個方法係日後測 app 相容性最快的路**：唔使重啟 app。

> 修過一個相關 bug：`makeTrace` 以前唔會先 `mkdir`，**全新 data dir 的第一行
> `apply() enter` 會寫失**（ENOENT 被吞）。偏偏那行就係「插件有冇被呼叫」的唯一證據。
> 現在 `lib/index.js` 建 trace 時先建資料夾，測試 `plugin.test.js` 釘住。

> 未做：把 `peerDependencies` 的範圍正式擴到 `0.2.x`。那等於宣稱已在 0.2 驗證過 ——
> 應該先在 0.2.1-rc.5 真正跑通（tools 註冊已過、agent 未驗），再改 manifest 出 release。
> 另外豁免係**精確版本**：app 一升級（例如 0.2.2-rc.x）就要再加一條，否則又會被跳過。

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

（以上其實都唔係原因 —— 係 bundle 未載入，先行到假設 3 的一步。真正原因見上。）

### 點樣確認掛載成功

重啟 app 之後，`~/.dsh/ig-life/boot.log` 會多一段**完整** trace：

```
--- apply() enter (pid ...) ---
persona + memory + capability layer ready
bridge started, webhook enabled
tools registered: 21 (ok)
mounted ok
```

如果只有 `enter` + `mounted ok`（冇中間三行），代表 `enabled: false`（測試寫入的），唔算成功。
再用 `http://127.0.0.1:<app port>/ig-life/console` 確認。

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
| `src/test_ig_bridge.py` | 34 個 sidecar 測試（假 client，不需要 instagrapi、不碰網絡） |
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

## 3. GUI 設定頁（已完成）

**DSH → 設定 → Instagram 人生** 一頁，改完存檔、重啟生效。

| 檔案 | 職責 |
|---|---|
| `lib/settings.js` | 三層合併的第三層：白名單欄位、`resolveConfig` 驗證、只寫使用者改過的 path |
| `lib/client.js` | 手寫的 DSH client bundle（`window.__ModuleLoader__.load` + lazy CJS factory），無 build step |
| `lib/console.js` | `/ig-life/console/api/settings`（GET 讀 effective + saved，POST 驗證並寫檔） |
| `package.json` | `exports["./client"]` + `dsh.client.platform: "web"` |

### 決定

1. **唔用 DSH 的 `ctx.settings` namespace**。那要 schemastery schema + revision fencing，
   而這裡要存的只是幾個已驗證的偏好；用檔案做使用者層，blast radius 限於「本插件重讀自己的
   config」。日後若要 native 設定卡，再把 `settings.register` 接上而保留同一個檔案。
2. **只寫使用者改過的 path**。第一版寫整個 projection，結果把今日的預設值烙進檔案、還把
   上一次的 ownerHandle 蓋成 `''`（測試抓到）。現在 `providedPaths()` + `subsetOf()` 只留
   提交過的葉節點。
3. **永遠冇 secret**：`EDITABLE` 不含 token／密碼，`graph.accessToken` 寫入會被丟棄（有測試）。
4. **client bundle 包 error boundary**：註冊或 render 失敗只影響這一頁，不會拖死設定面板。
5. **console 唔再依附 webhook**：`/ig-life/console`、`/ig-life/media` 只要有 webServer 就掛。

### 已驗證（用 app 自己的 0.2.1 runtime，隔離 DSH_HOME 預檢）

```
boot graph: …,dsh-ig-life/client.js,…
GET  /ig-life/console/api/settings → {ok:true, effective:{transport:"dryrun",…}}
POST → {ok:true, changed:["transport","ownerHandle","limits.dmPerDay"], restartRequired:true}
重啟後 GET → effective.transport = "unofficial"、dmPerDay = 9   ← 使用者層真的生效
```

### 未做

- 未在**真實 GUI** 內按過那一頁（預檢只證明 bundle 入 graph、API 通；React 渲染要人眼）。
  如果頁面空白：DevTools（Ctrl+Shift+I）看 `[ig-life] settings section not registered`。
- 設定頁只覆蓋常用欄位；Graph token／voice／stickers 仍在 YAML。

---

## 4. 現況基線

- **199 個 JS 測試** + **34 個 Python sidecar 測試**，全綠
- `node scripts/loader-smoke.mjs`（真 Cordis）全綠
- CI：Node 20/22/24 × Ubuntu/Windows + 一個 `python sidecar` job（`py_compile` + stdlib 測試）
- Release：`v0.3.0`；CHANGELOG 中英
- 可用入口：`dsh web` → `/ig-life/console`；桌面 `睇大肥魚狀態.cmd` → 直接讀資料檔
- 三副身體：`dryrun`（預設）、`graph`（官方，需要專業帳號）、`unofficial`（普通帳號，會封號）
