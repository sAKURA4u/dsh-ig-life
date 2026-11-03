/**
 * 瀏覽器那一半：DSH 設定側邊欄的「Instagram 人生」一頁。
 *
 * 這是 DSH 的 client module 格式（lazy CJS factory），不是 ESM：
 * `window.__ModuleLoader__.load({ id, factory })` 只登記 factory，真正執行在
 * materialization 時。所以這裡用 `require('react')` 而唔用 import。
 *
 * 有意保持「一個 plain form + 兩條同源 fetch」：
 *   · 唔經 `ctx.settingsScope`（要 schemastery schema + revision fencing，
 *     而這個插件要存的只是幾個已驗證的偏好）；
 *   · 唔 import 任何 DSH ui 套件（第三方插件要自己 reproduce build，乾脆唔要）；
 *   · 整頁包在自己的 error boundary 裡，這一頁壞掉唔會拖死整個設定面板。
 *
 * 寫入的是 `<dataDir>/settings.json`，重啟 DSH 後生效（頁面會講清楚）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-ig-life',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const API = '/ig-life/console/api/settings'

    /**
     * The app may put a browser-trust token in the page's query string; carry it
     * over so the plugin's own routes pass the same fence the shell does.
     */
    function apiUrl() {
      try {
        const token = new URLSearchParams(window.location.search).get('token')
        return token ? `${API}?token=${encodeURIComponent(token)}` : API
      } catch {
        return API
      }
    }

    const T = {
      title: 'Instagram 人生',
      lead: '這個角色用哪一副身體、跟誰說話、多久主動一次。存檔後要重啟 DSH 才會生效。',
      loading: '載入中…',
      failed: '載入失敗',
      save: '儲存',
      saving: '儲存中…',
      saved: '已儲存。重啟 DSH 後生效。',
      unchanged: '沒有任何改動。',
      transport: '身體（transport）',
      owner: '主人帳號',
      allowlist: '白名單（逗號分隔）',
      strangers: '回覆陌生人',
      life: '生命循環',
      lifeEnabled: '讓它自己生活（主動私訊／發帖）',
      tick: '時鐘間隔（秒）',
      timezone: '時區',
      quiet: '靜音時段（例如 02:00-08:00）',
      limits: '每日額度',
      dmPerDay: '私訊',
      postsPerDay: '發帖',
      commentsPerDay: '留言',
      cooldown: '同對話冷卻（秒）',
      unofficial: '非官方身體（sidecar）',
      baseUrl: 'Sidecar 位址',
      poll: '讀取間隔（秒，最少 10）',
      sendPerDay: '每日訊息上限',
      postPerDayU: '每日發帖上限',
      gap: '訊息之間最少等（秒）',
      file: '設定檔',
    }

    function field(label, input) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, minWidth: 180, flex: '1 1 220px' } },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary, #8b93a7)' } }, label),
        input,
      )
    }

    const inputStyle = {
      font: 'inherit',
      fontSize: 13,
      padding: '6px 9px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, #2d3852)',
      background: 'var(--dsw-alias-bg-layer-1, #141924)',
      color: 'var(--dsw-alias-label-primary, #e6e9ef)',
    }

    function textInput(value, onChange, props = {}) {
      return h('input', {
        type: 'text',
        style: inputStyle,
        value: value ?? '',
        onChange: (event) => onChange(event.target.value),
        ...props,
      })
    }

    function numberInput(value, onChange) {
      return h('input', {
        type: 'number',
        style: inputStyle,
        value: value ?? 0,
        onChange: (event) => onChange(Number(event.target.value)),
      })
    }

    function section(title, children) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 0', borderTop: '1px solid var(--dsw-alias-border-l2, #232b3a)' } },
        h('div', { style: { fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-tertiary, #8b93a7)' } }, title),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } }, ...children),
      )
    }

    function Page() {
      const [state, setState] = React.useState({ loading: true, error: null, transports: [], settingsFile: '' })
      const [draft, setDraft] = React.useState(null)
      const [message, setMessage] = React.useState(null)
      const [saving, setSaving] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const response = await fetch(apiUrl(), { headers: { accept: 'application/json' } })
            const payload = await response.json()
            if (!alive) return
            if (!payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
            setState({ loading: false, error: null, transports: payload.transports ?? [], settingsFile: payload.settingsFile ?? '' })
            setDraft(payload.effective)
          } catch (error) {
            if (alive) setState({ loading: false, error: String(error?.message ?? error), transports: [], settingsFile: '' })
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      const patch = (group, key, value) => {
        setDraft((current) => {
          if (!current) return current
          if (!group) return { ...current, [key]: value }
          return { ...current, [group]: { ...current[group], [key]: value } }
        })
      }

      const save = async () => {
        if (!draft) return
        setSaving(true)
        setMessage(null)
        try {
          const response = await fetch(apiUrl(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(draft),
          })
          const payload = await response.json()
          if (!payload?.ok) throw new Error((payload?.errors ?? [payload?.error ?? '儲存失敗']).join('；'))
          setMessage({
            kind: 'ok',
            text: payload.changed?.length ? `${T.saved}（${payload.changed.join(', ')}）` : T.unchanged,
          })
          if (payload.saved) setDraft((current) => current)
        } catch (error) {
          setMessage({ kind: 'error', text: String(error?.message ?? error) })
        } finally {
          setSaving(false)
        }
      }

      if (state.loading) return h('div', { style: { padding: 24, fontSize: 13, opacity: 0.7 } }, T.loading)
      if (state.error) return h('div', { style: { padding: 24, fontSize: 13, color: 'var(--dsw-alias-state-error-primary, #ff6b6b)' } }, `${T.failed}：${state.error}`)
      if (!draft) return h('div', { style: { padding: 24, fontSize: 13, opacity: 0.7 } }, T.loading)

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', maxWidth: 760, width: '100%', color: 'var(--dsw-alias-label-primary, #e6e9ef)' } },
        h('h2', { style: { fontSize: 18, margin: '0 0 6px' } }, T.title),
        h('p', { style: { margin: '0 0 10px', fontSize: 13, color: 'var(--dsw-alias-label-secondary, #8b93a7)' } }, T.lead),

        section(T.transport, [
          field(
            T.transport,
            h(
              'select',
              { style: inputStyle, value: draft.transport, onChange: (event) => patch(null, 'transport', event.target.value) },
              ...(state.transports.length ? state.transports : ['dryrun', 'graph', 'unofficial']).map((value) =>
                h('option', { key: value, value }, value),
              ),
            ),
          ),
          field(T.owner, textInput(draft.ownerHandle, (value) => patch(null, 'ownerHandle', value), { placeholder: 'your_main_account' })),
          field(T.allowlist, textInput((draft.allowlist ?? []).join(', '), (value) => patch(null, 'allowlist', value.split(/[,;\s]+/).filter(Boolean)))),
          field(
            T.strangers,
            h(
              'select',
              { style: inputStyle, value: draft.replyToStrangers ? 'yes' : 'no', onChange: (event) => patch(null, 'replyToStrangers', event.target.value === 'yes') },
              h('option', { value: 'no' }, '否'),
              h('option', { value: 'yes' }, '是'),
            ),
          ),
        ]),

        section(T.life, [
          field(
            T.lifeEnabled,
            h(
              'select',
              { style: inputStyle, value: draft.life.enabled ? 'yes' : 'no', onChange: (event) => patch('life', 'enabled', event.target.value === 'yes') },
              h('option', { value: 'no' }, '關'),
              h('option', { value: 'yes' }, '開'),
            ),
          ),
          field(T.tick, numberInput(draft.life.tickSeconds, (value) => patch('life', 'tickSeconds', value))),
          field(T.timezone, textInput(draft.life.timezone, (value) => patch('life', 'timezone', value))),
          field(T.quiet, textInput(draft.life.quietHours, (value) => patch('life', 'quietHours', value))),
        ]),

        section(T.limits, [
          field(T.dmPerDay, numberInput(draft.limits.dmPerDay, (value) => patch('limits', 'dmPerDay', value))),
          field(T.postsPerDay, numberInput(draft.limits.postsPerDay, (value) => patch('limits', 'postsPerDay', value))),
          field(T.commentsPerDay, numberInput(draft.limits.commentsPerDay, (value) => patch('limits', 'commentsPerDay', value))),
          field(T.cooldown, numberInput(draft.limits.replyCooldownSeconds, (value) => patch('limits', 'replyCooldownSeconds', value))),
        ]),

        section(T.unofficial, [
          field(T.baseUrl, textInput(draft.unofficial.baseUrl, (value) => patch('unofficial', 'baseUrl', value))),
          field(T.poll, numberInput(draft.unofficial.pollSeconds, (value) => patch('unofficial', 'pollSeconds', value)), null),
          field(T.sendPerDay, numberInput(draft.unofficial.sendPerDay, (value) => patch('unofficial', 'sendPerDay', value))),
          field(T.postPerDayU, numberInput(draft.unofficial.postPerDay, (value) => patch('unofficial', 'postPerDay', value))),
          field(T.gap, numberInput(draft.unofficial.sendGapSeconds, (value) => patch('unofficial', 'sendGapSeconds', value))),
        ]),

        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2, #232b3a)' } },
          h(
            'button',
            {
              type: 'button',
              onClick: save,
              disabled: saving,
              style: {
                font: 'inherit',
                padding: '7px 18px',
                borderRadius: 8,
                cursor: saving ? 'default' : 'pointer',
                border: '1px solid var(--dsw-alias-state-business-primary, #35599f)',
                background: 'var(--dsw-alias-state-business-primary, #2b4b8f)',
                color: '#fff',
                opacity: saving ? 0.6 : 1,
              },
            },
            saving ? T.saving : T.save,
          ),
          message
            ? h(
                'span',
                {
                  style: {
                    fontSize: 12,
                    color:
                      message.kind === 'error'
                        ? 'var(--dsw-alias-state-error-primary, #ff6b6b)'
                        : 'var(--dsw-alias-state-success-primary, #4ade80)',
                  },
                },
                message.text,
              )
            : null,
        ),
        state.settingsFile ? h('div', { style: { fontSize: 11, opacity: 0.5, paddingTop: 8 } }, `${T.file}：${state.settingsFile}`) : null,
      )
    }

    /** A render failure in this page must not take the settings panel with it. */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { style: { padding: 20, fontSize: 13, color: 'var(--dsw-alias-state-error-primary, #ff6b6b)' } },
            `「Instagram 人生」設定頁出錯：${String(this.state.error?.message ?? this.state.error)}`,
          )
        }
        return this.props.children
      }
    }

    function Guarded() {
      return h(Boundary, null, h(Page))
    }

    function apply(ctx) {
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'ig-life',
              order: 50,
              label: () => 'Instagram 人生',
            },
            Guarded,
          ),
        )
      } catch (error) {
        // Registration failing is a missing page, not a broken app.
        console.error('[ig-life] settings section not registered:', error)
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
