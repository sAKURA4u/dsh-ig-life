<p align="center">
  <b>English</b> ｜ <a href="README.zh.md">中文</a>
</p>

<h1 align="center">dsh-ig-life</h1>

<p align="center">
  <b>Raise a DeepSeek agent on Instagram</b><br />
  An IG body · a memory that fades · a life that keeps running when nobody is talking
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

> **One-minute demo**: no Instagram account, no API key — this only shows how it talks.
> Real DMs need one of two bodies: the **official** one (an Instagram professional account,
> a Meta app long-lived token and a public HTTPS tunnel — [docs/IG-SETUP.md](docs/IG-SETUP.md)),
> or the **unofficial** one (a plain personal account through a local Python sidecar —
> [docs/UNOFFICIAL.md](docs/UNOFFICIAL.md); it violates Instagram's terms and can get the
> account banned). The plugin itself never receives your password.
>
> ```bash
> git clone https://github.com/sAKURA4u/dsh-ig-life && cd dsh-ig-life
> node scripts/self-check.mjs
> ```

Real output below, verbatim — the bundled persona speaks Cantonese. The English is my annotation, not the program's.

```text
── 1. 收到私訊 ──  (an inbound DM)
  · [dryrun] dm → dafish_owner：我啱啱喺窗邊睇雨。你有冇帶傘   ← "I was watching the rain. Did you bring an umbrella"
  同一對話即時再問：handled=0（被冷卻擋住）                    ← same thread again: thread cooldown
  重複投遞：ingested=0（被擋 duplicate）                        ← replayed webhook: deduped
  陌生人：handled=0（allowlist 外預設唔回）                     ← a stranger: ignored by default

── 2. 生命時鐘（主動搵你）──  (the life clock: it reaches out first)
  主動訊息：「喂，你今日有冇食飯」                              ← "hey, have you eaten today"
  狀態：出世第 1 日｜心情：有啲坐唔定｜體力：69/100｜親近感：32/100

── 3. 可塑性記憶 ──  (plastic memory)
  總數 9 條｜錨點 8、重要 0、眼前 1、模糊 0                     ← 9 total · anchor 8 · important 0 · recent 1 · fading 0
```

This is not a support bot. It reaches out first, leaves you on read, refuses you, forgets what doesn't matter — and three days after you went quiet it asks whether you're still there.

---

## ✨ What it does

| | |
|---|---|
| 💬 **Instagram DMs** | a webhook arrives → becomes a real DSH session → the model decides whether and how to answer |
| 🧠 **Plastic memory** | remembers the beginning, the recent, the genuinely important; the rest fades, with a nightly "sleep compression" |
| 🌙 **A daily rhythm** | energy, mood, sleep. While awake it may reach out first or publish a diary post |
| 🎙 **Voice** | text → TTS → public mp3 → IG audio attachment. `[laugh]` `[whisper]` map to speech rate and are never spoken aloud |
| 🖼 **Stickers** | collect images people send, tag them, send the fitting one — numbers are never reused |
| 🎬 **Reels** | read metadata + cover through a vision endpoint; sharing just sends the link and Instagram renders the card |
| 📚 **Slang** | submit → the owner approves with `/slang ok <id>` → only then injected |
| 👤 **Per-person memory** | impressions, open topics and details per handle; cross-thread leakage is blocked in code |

## 🧠 Memory: forgetting is what makes it human

> It remembers the beginning, the recent, and the genuinely important — the rest fades day by day.

| Tier | What lands here | Forgotten? |
|---|---|---|
| **anchor** | pinned, identity, the first 8 | never |
| **important** | score ≥ 0.75, or recalled ≥ 3 times | never — and it gets stronger with use |
| **recent** | the newest 12 | only after leaving the window |
| **fading** | everything else | `exp(-age/21d)`, pruned per day each night |

No vector database, no embedding API, no tokenizer — CJK character bigrams plus IDF. [How it works →](docs/MEMORY.md)

## ⚡ Install

```bash
dsh plugin --profile web add /path/to/dsh-ig-life
```

Restart DSH and you should see:

```text
[ig-life] ready · transport=dryrun · engine=agent · tools=21 · webhook=/ig-life/webhook · poll=off · life=off · memory=7
```

**Dry-run by default**: nothing leaves the machine, everything lands in `~/.dsh/ig-life/outbox.jsonl`.
Read it for a week. Only then switch to a real body.

### Three bodies, one character

| `transport` | Account | Needs | The catch |
|---|---|---|---|
| `dryrun` | none | nothing | sends nothing; a transcript only |
| `graph` | Creator/Business | Meta app, long-lived token, public HTTPS | App Review for other people, API rate limits |
| `unofficial` | **any personal account** | Python 3.9+, `instagrapi`, a local sidecar | **violates Instagram's terms; the account can be banned** |

`unofficial` is `lib/transport/unofficial.js` talking to `src/ig_bridge.py` over
127.0.0.1. The password and the session cookie never enter the Node process, its config,
its logs or a prompt — and the sidecar is the thing that decides how fast Instagram is
touched. [The full warning and setup →](docs/UNOFFICIAL.md)

<details>
<summary><b>📝 Configuration (click)</b></summary>

Override the row in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: ig-life
  config:
    transport: dryrun          # dryrun | graph | unofficial
    ownerHandle: your_main_account
    allowlist: [your_main_account]
    graph:
      accessToken: ''          # or the IG_LIFE_GRAPH_TOKEN env var
      igUserId: ''
      appSecret: ''
      verifyToken: ''
      publicBaseUrl: ''        # required for images and voice
    unofficial:                # only used by transport: unofficial
      baseUrl: http://127.0.0.1:8737
      pollSeconds: 20          # floor 10 — a faster poll is how accounts get flagged
      pollJitterSeconds: 6
      sendPerDay: 30
      sendGapSeconds: 8
    life:
      enabled: false           # turn on to give it a life of its own
      tickSeconds: 300
      timezone: Asia/Hong_Kong
    limits: { dmPerDay: 12, postsPerDay: 2, commentsPerDay: 15, replyCooldownSeconds: 20 }
```

⚠️ A patch **replaces the whole row `config`** — there is no deep merge. Defaults live in [lib/config.js](lib/config.js); the full Instagram setup is in [docs/IG-SETUP.md](docs/IG-SETUP.md).

</details>

## 🎭 Change the persona

`persona/example/` is the bundled character:

```text
persona.md      identity, backstory, wants, fears (the important one)
style.md        how it talks: sentence length, tone, emoji habits
boundaries.md   what it refuses: no money, no secrets, nothing personal to strangers
seed.json       the memories it is born with, in the first person
```

Copy the folder, edit the words, point `personaPath` at it — that's somebody else. **No code changes.**

## 🛡 Safety, enforced in code

- Strangers are ignored by default; when enabled they get only short, harmless, non-personal replies
- Everything outbound is scrubbed of keys, tokens and `system prompt` shapes
- Webhook HMAC verification; daily caps, per-thread cooldown, quiet hours, a 24-hour reply window
- **Memory layering**: a memory tagged for one person never appears in another's conversation
- A corrupt memory file is quarantined as `.corrupt-<timestamp>` — never silently dropped

[Full notes →](docs/PRIVACY.md)

<details>
<summary><b>🧩 The 21 model tools (click)</b></summary>

The model must **call a tool** to speak — its text output is only thinking. Keeping thought and speech apart is what stops it from turning into a support bot.

| Tool | What it does |
|---|---|
| `ig_send_dm` | type (the only way to speak; may be several messages) |
| `voice_send` | speak (TTS or a recorded voice pack) |
| `sticker_list` / `sticker_send` / `sticker_collect` | browse, send, collect stickers |
| `reel_watch` / `reel_share` | read a reel; send one (a link is enough) |
| `slang_query` / `slang_submit` | look up new slang, submit it for approval |
| `people_note` / `people_list` | remember specifics about someone |
| `image_describe` | look at an image (needs a vision endpoint) |
| `ig_inbox` / `ig_wait` / `ig_mark_read` | read, wait for them to finish, wrap up |
| `ig_post` / `ig_reply_comment` / `ig_life_status` | publish, reply to comments, inspect itself |
| `memory_remember` / `memory_recall` / `memory_forget` | memory |

The owner can also send `/pause` `/resume` `/sleep` `/status` `/slang` `/people` `/voice` `/help` over DM.

</details>

## 📚 Deep dives

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | why a plugin instead of an external bridge; the two reply engines; graceful degradation |
| [docs/MEMORY.md](docs/MEMORY.md) | the four tiers, retrieval scoring, sleep compression, tuning |
| [docs/IG-SETUP.md](docs/IG-SETUP.md) | Meta app, webhook, voice/sticker/reel setup, the full error-code table |
| [docs/UNOFFICIAL.md](docs/UNOFFICIAL.md) | the personal-account path: ban risk, sidecar setup, session reuse, error codes |
| [docs/PRIVACY.md](docs/PRIVACY.md) | what is stored, what never leaves, anti-ban mechanics, risk register |
| [CHANGELOG.md](CHANGELOG.md) | what changed in each version, and why |

## ✅ Verify

```bash
node scripts/test.mjs          # 186 tests, 0 failures, no dependencies, no network
node scripts/self-check.mjs    # end-to-end dry run with a scripted brain
node scripts/loader-smoke.mjs  # boots under the real Cordis runtime
python src/test_ig_bridge.py   # the unofficial sidecar: stdlib only, no instagrapi needed
```

## ⚠️ Honest limitations

- The official Instagram API is **1:1 only** — no groups, no stickers, no forwards
- The unofficial private API **is** included now, as a separate opt-in transport (`transport: unofficial`). It violates Instagram's terms, the account can be banned, and the private protocol changes without notice — nothing about it is guaranteed to keep working. Use an account you can lose; see [docs/UNOFFICIAL.md](docs/UNOFFICIAL.md)
- Instagram has no read-back API, so a voice message's `verified` only means "the send request succeeded"; the protocol requires falling back to text on failure
- The `agent` engine has not yet been validated over a long-lived real DSH session; it degrades to the `llm` engine
- Not included yet: understanding incoming voice notes, image generation, multi-platform sync

## 🙏 Credits

[**surfcore**](https://github.com/Mieksido/surfcore) — a complete "DeepSeek raised on QQ" implementation.
Several hard-won decisions here (the model must speak through tools, failures carry `code` + `hint`, persona and safety kept apart, budgets enforced in code) came from reading its source and docs.

## License

[MIT](LICENSE)
