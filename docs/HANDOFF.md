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

## 2. 非官方 transport（下一步要做的功能）

**背景**：使用者要求「像 QQ 那樣用普通 IG 帳號」。官方 Graph API **只支援 Creator／Business 帳號**，所以普通個人帳號只能走非官方協議（`instagrapi`）。這是 Meta 的限制，不是實作選擇。

**設計**（架構已預留：`lib/transport/` 可換）：

```
src/ig_bridge.py（Python sidecar，用 instagrapi）
  ├─ 首次 login 後 dump session.json，之後 reuse（最重要的防封措施）
  ├─ localhost HTTP：
  │    GET  /messages        回傳新私訊（含 thread_id / sender / text / attachments）
  │    POST /send            {threadId|username, text}
  │    POST /send_media      {threadId, path, type}
  │    POST /post            {caption, imagePath}
  │    GET  /health
  └─ 風控：輪詢間隔 ≥10s、每日上限、隨機延遲
lib/transport/unofficial.js
  └─ 呼叫上面的 sidecar；與 graph.js 同一介面（sendDm / sendAttachment / postPhoto / replyComment / health）
```

**必須遵守**：

1. **預設關閉**：`transport: 'unofficial'` 要使用者明確選擇。
2. **密碼只在本機**：`~/.dsh/ig-life/ig-secrets.json`（0600），永不進 repo／log／對話。
3. **README + `docs/UNOFFICIAL.md` 大字警告**：違反 IG 條款、可能封號、建議用可以犧牲的小號。
4. **session 重用**優先於重新登入 —— 每次全新登入是最大的封號觸發點。
5. 復用現有安全閥：白名單、每日額度、靜音時段、24 小時窗口、出站脫敏全部照生效。

**風險**：非官方私有 API 的簽名／風控隨時改，維護成本會壓過專案。要在 `docs/UNOFFICIAL.md` 講明「壞了就修不保證」。

---

## 3. 現況基線

- 152 個測試、`node scripts/loader-smoke.mjs`（真 Cordis）全綠
- CI：Node 20/22/24 × Ubuntu/Windows 全綠
- Release：`v0.2.0`；CHANGELOG 中英
- 可用入口：`dsh web` → `/ig-life/console`；桌面 `睇大肥魚狀態.cmd` → 直接讀資料檔
