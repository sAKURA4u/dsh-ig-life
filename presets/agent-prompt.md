# Agent preset prompt（可選）

`dsh-ig-life` **唔需要**你建立 agent preset：插件在建立 IG 對話 agent 時，會把
`persona/*.md` 同 Instagram 協議一起注入該 agent 的 system prompt（
`systemPrompt.section({ name: 'ig-life:persona' })`），只影響那一個 agent。

如果你比較喜歡「一個 preset 管全部」（surfcore 的做法），把下面內容貼進
`${DSH_HOME:-~/.dsh}/.agent-presets/<id>/agent.cordis.yml` 的 `dsh-persona` row，
然後在 `dsh-ig-life` 的設定裡指定 `bridge.agentPreset: <id>`：

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: |-
      <把 persona/example/persona.md 的內容貼在這裡>

      <把 lib/persona.js 的 renderIgProtocol() 產生的協議貼在這裡>
```

> ⚠️ 不要同時用兩種方式：preset 的 persona 會疊在插件注入的 section 之上，
> 兩份人設打架時模型會無所適從。二選一。

## 為什麼預設用「插件注入」而不是 preset

1. 少一個要人手抄的檔案 —— preset 一升級就要重抄一次，抄漏就人格突變。
2. 範圍更準確：只影響 IG 那一個 agent，不會污染你日常寫程式的 session。
3. persona 改了即時生效，不用重啟 Harness。
