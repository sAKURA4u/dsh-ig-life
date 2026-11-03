# dsh-ig-life

> Raise a DeepSeek agent on Instagram — a body for Instagram DMs, a memory that fades, and a life that keeps running when nobody is talking.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (Cordis) bundle plugin. Install it and your agent gets:

* **Instagram DMs as a real channel** — a webhook arrives, becomes a DSH session turn, and the model decides whether and how to answer.
* **Plastic memory** — it remembers the beginning, the recent, and the genuinely important; everything else fades day by day ([how](docs/MEMORY.md)).
* **A daily rhythm** — energy, mood, sleep. While awake it may reach out first, or publish a diary post.
* **A persona made of markdown** — edit `persona/*.md` and it is somebody else. No code changes.
* **No ban-by-volume** — allowlist, daily caps, quiet hours, dedupe, no hard retries. Enforced in code.

It ships **dry-run by default**: nothing leaves the machine, everything lands in
`~/.dsh/ig-life/outbox.jsonl` so you can read what it *would* have said.

```bash
node scripts/self-check.mjs     # no DSH, no IG account, no API key needed
```

## Quick start

```bash
# 1. install into your DSH profile
dsh plugin --profile web add /path/to/dsh-ig-life

# 2. restart DSH; you should see
#    [ig-life] ready · transport=dryrun · engine=agent · tools=10 · webhook=/ig-life/webhook · life=off

# 3. prove it works end to end, offline
node scripts/self-check.mjs
```

Then, when you actually want a real account:

1. Follow [docs/IG-SETUP.md](docs/IG-SETUP.md) (Instagram Creator account + Meta app + public HTTPS webhook).
2. Override the row in `~/.dsh/profiles/web/cordis.patch.yml`.
3. Keep `transport: dryrun` but wire the **real** webhook first: it receives, it never sends.
   Read `outbox.jsonl` for a week. Only then switch to `transport: graph`.

```yaml
- id: ig-life
  config:
    transport: graph
    ownerHandle: your_main_account
    allowlist: [your_main_account]
    graph: { accessToken: 'IGAA...', igUserId: '178414...', appSecret: '...', verifyToken: '...' }
    life: { enabled: true }
```

> A patch replaces the whole row `config` — there is no deep merge. Defaults live in
> [lib/config.js](lib/config.js). Full reference: [README.zh.md](README.zh.md#設定).

## Tools the model gets

`ig_send_dm`, `ig_inbox`, `ig_wait`, `ig_mark_read`, `ig_post`, `ig_reply_comment`,
`ig_life_status`, `memory_remember`, `memory_recall`, `memory_forget`.

The model must *call a tool* to speak — its text output is only thinking. That is deliberate:
auto-forwarding assistant text is what turns a character into a support bot.

The owner can also send `/pause`, `/resume`, `/sleep`, `/status`, `/help` over DM.

## Design notes

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full picture, including:

* why this is a plugin instead of an external bridge + MCP (compared honestly with surfcore);
* why `inject: ['timer']` is the only hard dependency (an inactive row aborts the DSH boot audit);
* the two reply engines (`agent` preferred, `llm` as a degraded fallback).

## Verify

```bash
npm test                       # 73 tests, no dependencies, no network
node scripts/self-check.mjs    # end-to-end dry run with a scripted brain
node scripts/link-dsh.mjs      # link the local DSH install to exercise the real defineTool
```

## Known limitations

* The official Graph API path needs a Creator/Business account, a Meta app and App Review.
  The unofficial private-API path (username/password) is **deliberately not included** — it
  violates Instagram's terms and gets accounts banned; write your own transport instead
  ([example](docs/IG-SETUP.md)).
* The `agent` reply engine has not yet been verified against a live DSH session; if
  `ctx.agents.create` fails it falls back to the `llm` engine and logs why.
* Publishing needs a public image URL (`publicBaseUrl` + `media/` folder).
* Not included yet: voice, image understanding, group-chat etiquette, multi-platform sync.

## Credits

[surfcore](https://github.com/Mieksido/surfcore) — a complete "DeepSeek raised on QQ" implementation.
Several hard-won decisions here (the model must speak through tools, failures carry `code` + `hint`,
persona and safety kept apart, budgets enforced in code) come from reading its source and docs.

MIT licensed.
