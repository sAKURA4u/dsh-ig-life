# 記憶模型 / Plastic memory

> 只記得開頭、最近，和真正重要的事 —— 其餘逐日淡忘。

這不是「把對話全部塞進 context」也不是「全部丟向量庫」。這是刻意做成**會忘記**的記憶，
因為一個什麼都記得的存在，不會像人，也燒不起 token。

## 四層

| 層 | 誰會進來 | 清晰度 | 會不會被忘 |
|---|---|---|---|
| **錨點 anchor** | `pinned` 的、`kind: identity` 的、最早期的前 `anchorCount` 條 | 0.95 起，永不衰減 | 不會 |
| **重要 important** | `importance ≥ importanceThreshold`（預設 0.75），或被想起 `recallPromotionCount` 次（預設 3） | 0.8 起 | 不會 |
| **眼前 recent** | 最新的 `recentCount` 條（預設 12） | 0.92 起，隨日略降 | 離開近期窗口後才會開始衰減 |
| **模糊 fading** | 其餘全部 | `exp(-age / halfLife) × (0.35 + 0.65 × importance)` | 每晚壓縮時按比例剪走 |

對應那張圖：左邊最早那幾根柱最高（錨點）、右邊最近那幾根也高（眼前）、
中間三根被標成「重要」的柱不會掉下去、其餘灰色逐日變矮。

## 檢索

每次回覆前，用這一輪的訊息當 query 排序：

```
score = 0.50 × 詞彙相似度       ← 中文用字元 bigram、英文用單詞，IDF 加權
      + 0.22 × 清晰度           ← 上面的四層
      + 0.16 × importance
      + 0.07 × 被想起次數        ← 越多越前
      + 0.05 × 是否錨點
```

不需要 embedding、不需要網絡、不需要 tokenizer：`tokenize()` 把中文切成人字 bigram
（「大肥魚」→ `大肥`、`肥魚`），英文切單詞，然後在候選池上算 IDF。
幾千條記憶在記憶體裡排序是微秒級。

**每次被檢索到 = 一次複習（rehearsal）**：`recallCount += 1`、更新 `lastRecalledAt`。
想起夠多次就會被夜間壓縮「焊」成 important。這是間隔效應（spacing effect）的簡化版。

## 睡眠壓縮

每天在 `memory.consolidateHour`（預設 03:00，本地時間）跑一次：

1. **升級**：`recallCount ≥ recallPromotionCount` 的記憶，把 `importance` 直接焊到門檻值 0.75，
   之後就算計數器被清掉也不會再淡忘。
2. **按日剪枝**：所有 fading 記憶按「建立日期」分組，每組只留清晰度最高的
   `ceil(數量 × keepFraction)` 條（預設 35%）。
   —— 一整天不會整批消失，而是被壓縮成一兩條痕跡，就像人的記憶。
3. **錨點與重要永不進入剪枝隊列。**

報告會回傳 `{before, after, pruned, promoted}`，寫進日誌：
`[ig-life] 睡眠壓縮：412 → 289 條記憶（剪走 125、升級 2）`

## 參數怎麼調

```yaml
memory:
  anchorCount: 8              # 最早的幾條永不忘（角色起源）
  recentCount: 12             # 眼前保留多少條
  importanceThreshold: 0.75  # 過了就是「重要」
  recallPromotionCount: 3     # 被想起幾次就升級
  decayHalfLifeDays: 21       # 其餘的記憶半衰期
  keepFraction: 0.35          # 每晚每個日期保留多少比例的模糊記憶
  consolidateHour: 3
  injectLimit: 10             # 每次回覆最多注入幾條
```

* 想讓它「記性好一點」：`decayHalfLifeDays: 60`、`keepFraction: 0.6`。
* 想讓它「更像人、更會忘」：`decayHalfLifeDays: 7`、`keepFraction: 0.2`。
* 想省 token：`injectLimit: 6`、`recentCount: 8`。

## 模型自己也有一支筆

除了自動記憶，模型可以主動：

* `memory_remember` —— 寫一條（`importance` 給 0.75 以上就永不忘；`pinned: true` 直接當錨點）
* `memory_recall` —— 主動搜（撿回話題、確認對方喜好）
* `memory_forget` —— 刪（記錯、或主人要求）

寫入的都是第一人稱：「我同 @xxx 講：……」而不是「用戶說……」。這個人稱差別看起來很小，
但它決定了模型醒來之後覺得那些事是**自己的**經歷還是**別人的紀錄**。

## 檔案位置

```
${DSH_HOME:-~/.dsh}/ig-life/
├── memory.json     # { version, memories: [...] }
├── state.json      # 體力、心情、親近感、上次主動/發帖時間
├── bridge.json     # 已處理訊息 id、inbox 快取、今日用量
├── flags.json      # 播種標記（避免重複播種人格記憶）
├── inbox 記錄       # 在 bridge.json 內，最近 200 條
├── outbox.jsonl    # 實際發出的東西（append-only）
└── media/          # 發帖用的圖片
```

記憶檔壞掉不會靜靜丟失：`store.js` 會把它改名成 `memory.json.corrupt-<時間戳>` 留著。
