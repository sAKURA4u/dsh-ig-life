/**
 * 瀏覽器那一半：DSH 設定側邊欄的「Instagram 人生」一頁。
 *
 * 這是 DSH 的 client module 格式（lazy CJS factory），不是 ESM：
 * `window.__ModuleLoader__.load({ id, factory })` 只登記 factory，真正執行在
 * materialization 時。所以這裡用 `require('react')` 而唔用 import。
 *
 * 有意保持「plain form + 同源 fetch」：
 *   · 唔經 `ctx.settingsScope`（要 schemastery schema + revision fencing，
 *     而這個插件要存的只是幾個已驗證的偏好）；
 *   · 唔 import 任何 DSH ui 套件（第三方插件要自己 reproduce build，乾脆唔要）；
 *   · 整頁包在自己的 error boundary 裡，這一頁壞掉唔會拖死整個設定面板。
 *
 * 帳密只經 `/ig-life/console/api/account` 轉去 sidecar；sidecar 是唯一會把它
 * 寫落地（0600）的進程，這裡的密碼欄位在存檔後即清空，也不會被讀回來。
 */

window.__ModuleLoader__.load({
  id: 'dsh-ig-life',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const API = '/ig-life/console/api/settings'
    const ACCOUNT_API = '/ig-life/console/api/account'
    const SIDECAR_API = '/ig-life/console/api/sidecar'

    /** The app may put a browser-trust token in the query string; carry it over. */
    function withToken(url) {
      try {
        const token = new URLSearchParams(window.location.search).get('token')
        return token ? `${url}?token=${encodeURIComponent(token)}` : url
      } catch {
        return url
      }
    }

    const T = {
      title: 'Instagram 人生',
      lead: '這個角色用哪一副身體、跟誰說話、多久主動一次。設定存檔後要重啟 DSH；帳密存檔後可以即刻登入。',
      loading: '載入中…',
      failed: '載入失敗',
      save: '儲存設定',
      saving: '儲存中…',
      saved: '已儲存。重啟 DSH 後生效。',
      unchanged: '沒有任何改動。',
      account: '帳號（只有 unofficial 需要）',
      loggedIn: '已登入',
      loggedOut: '未登入',
      saveAccount: '儲存帳密',
      saveAndLogin: '儲存並登入',
      accountSaved: '帳密已儲存。',
      accountHint: '密碼只寫入 sidecar 的本機檔案（0600），不會寫進 log、提示詞或這個頁面。',
      transport: '身體（transport）',
      owner: '主人帳號',
      allowlist: '白名單（逗號分隔）',
      strangers: '回覆陌生人',
      life: '生命循環',
      lifeEnabled: '讓它自己生活',
      tick: '時鐘間隔（秒）',
      timezone: '時區',
      quiet: '靜音時段',
      limits: '每日額度',
      dmPerDay: '私訊',
      postsPerDay: '發帖',
      commentsPerDay: '留言',
      cooldown: '同對話冷卻（秒）',
      unofficial: '非官方身體（sidecar）',
      baseUrl: 'Sidecar 位址',
      poll: '讀取間隔（秒）',
      sendPerDay: '每日訊息上限',
      postPerDayU: '每日發帖上限',
      gap: '訊息之間最少等（秒）',
      username: 'IG 使用者名稱（小號）',
      password: 'IG 密碼',
      file: '設定檔',
    }

    /** Every option gets a sentence: what it does, and what it costs. */
    const HINTS = {
      transport:
        'dryrun 唔會連 IG，只寫 outbox；graph 是官方 API（要 Creator／Business 帳號）；unofficial 用普通帳號經本機 sidecar，違反 IG 條款、有封號風險。',
      ownerHandle: '你自己主帳號。只有它可以下 /pause 等控制指令，而且永遠在白名單。',
      allowlist: '仲有邊啲人可以跟它講話，用逗號分隔。唔在白名單的人預設完全唔回。',
      replyToStrangers: '開咗之後，陌生人只會收到短、無害、不含個人資訊的回覆。',
      'life.enabled': '它會不會自己主動私訊、發日記。建議先關，觀察夠、覺得似真人才開。',
      'life.tickSeconds': '生命時鐘幾久推進一次（秒）。越細越似活著，但每 tick 都可能叫一次模型。',
      'life.timezone': '它自己的時區（IANA 名，例如 Asia/Hong_Kong），決定幾點醒、幾點靜音。',
      'life.quietHours': '這段時間不主動、不回陌生人，本地時區。格式 02:00-08:00。',
      'limits.dmPerDay': '每日最多發幾則私訊（包括主動訊息）。這是硬上限，爆了就等明日。',
      'limits.postsPerDay': '每日最多發幾篇帖。',
      'limits.commentsPerDay': '每日最多回幾則留言。',
      'limits.replyCooldownSeconds': '同一個對話兩次回覆之間最少隔幾秒，防止連珠炮式回覆。',
      'unofficial.baseUrl': '本機 sidecar 位址，正常是 http://127.0.0.1:8737。改之前先確認 sidecar 正在跑。',
      'unofficial.pollSeconds': '幾久去問一次有沒有新私訊（秒）。最少 10；調得太快是封號原因之一。',
      'unofficial.pollJitterSeconds': '每次輪詢再加 0–N 秒隨機，令節奏不像機器。',
      'unofficial.sendPerDay': 'sidecar 自己再擋一次的每日訊息上限（第二道閘）。',
      'unofficial.postPerDay': 'sidecar 自己再擋一次的每日發帖上限。',
      'unofficial.sendGapSeconds': '兩則訊息之間最少等幾秒，模擬打字與思考。',
      igUsername: '小號（角色帳號）的 IG 使用者名稱，不用 @。sidecar 用它來登入。',
      igPassword:
        '只寫入 sidecar 的 0600 檔案，不會出現在 log、提示詞或回應裡。留空＝保留舊密碼；存檔後自動清空、不會被讀回。',
    }

    function hint(hintText) {
      return h('span', { style: { fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, #7b8499)' } }, hintText)
    }

    function field(labelText, input, hintText) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, minWidth: 180, flex: '1 1 220px' } },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary, #8b93a7)' } }, labelText),
        input,
        hintText ? hint(hintText) : null,
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

    function selectInput(value, options, onChange) {
      return h(
        'select',
        { style: inputStyle, value, onChange: (event) => onChange(event.target.value) },
        ...options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
      )
    }

    function section(title, children) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 0', borderTop: '1px solid var(--dsw-alias-border-l2, #232b3a)' } },
        h(
          'div',
          { style: { fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-tertiary, #8b93a7)' } },
          title,
        ),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } }, ...children),
      )
    }

    function button(labelText, onClick, { primary = false, disabled = false } = {}) {
      return h(
        'button',
        {
          type: 'button',
          onClick,
          disabled,
          style: {
            font: 'inherit',
            padding: '7px 16px',
            borderRadius: 8,
            cursor: disabled ? 'default' : 'pointer',
            border: `1px solid ${primary ? 'var(--dsw-alias-state-business-primary, #35599f)' : 'var(--dsw-alias-border-l2, #2d3852)'}`,
            background: primary ? 'var(--dsw-alias-state-business-primary, #2b4b8f)' : 'transparent',
            color: primary ? '#fff' : 'inherit',
            opacity: disabled ? 0.6 : 1,
          },
        },
        labelText,
      )
    }

    function statusLine(kind, text) {
      return h(
        'span',
        {
          style: {
            fontSize: 12,
            color:
              kind === 'error'
                ? 'var(--dsw-alias-state-error-primary, #ff6b6b)'
                : kind === 'ok'
                  ? 'var(--dsw-alias-state-success-primary, #4ade80)'
                  : 'var(--dsw-alias-label-tertiary, #7b8499)',
          },
        },
        text,
      )
    }

    function Page() {
      const [state, setState] = React.useState({
        loading: true,
        error: null,
        transports: [],
        settingsFile: '',
        account: null,
        health: null,
        configuredTransport: null,
        sidecar: null,
      })
      const [draft, setDraft] = React.useState(null)
      const [accountName, setAccountName] = React.useState('')
      const [password, setPassword] = React.useState('')
      const [message, setMessage] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [accountMessage, setAccountMessage] = React.useState(null)
      const [accountBusy, setAccountBusy] = React.useState(false)
      const [sidecarBusy, setSidecarBusy] = React.useState(false)
      const [sidecarMessage, setSidecarMessage] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const [settingsResponse, accountResponse, sidecarResponse] = await Promise.all([
              fetch(withToken(API), { headers: { accept: 'application/json' } }),
              fetch(withToken(ACCOUNT_API), { headers: { accept: 'application/json' } }),
              fetch(withToken(SIDECAR_API), { headers: { accept: 'application/json' } }),
            ])
            const settings = await settingsResponse.json()
            const account = await accountResponse.json()
            const sidecar = await sidecarResponse.json().catch(() => null)
            if (!alive) return
            if (!settings?.ok) throw new Error(settings?.error || `HTTP ${settingsResponse.status}`)
            setState({
              loading: false,
              error: null,
              transports: settings.transports ?? [],
              settingsFile: settings.settingsFile ?? '',
              account: account?.account ?? null,
              health: account?.health ?? null,
              configuredTransport: account?.configuredTransport ?? null,
              sidecar: sidecar?.status ?? null,
            })
            setAccountName(account?.account?.username ?? account?.health?.username ?? '')
            setDraft(settings.effective)
          } catch (error) {
            if (alive)
              setState({
                loading: false,
                error: String(error?.message ?? error),
                transports: [],
                settingsFile: '',
                account: null,
                health: null,
                configuredTransport: null,
                sidecar: null,
              })
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
          const response = await fetch(withToken(API), {
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
        } catch (error) {
          setMessage({ kind: 'error', text: String(error?.message ?? error) })
        } finally {
          setSaving(false)
        }
      }

      const saveAccount = async (login) => {
        setAccountBusy(true)
        setAccountMessage(null)
        try {
          const response = await fetch(withToken(ACCOUNT_API), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: accountName, password, login }),
          })
          const payload = await response.json()
          if (!payload?.ok) throw new Error([payload?.code, payload?.error, payload?.hint].filter(Boolean).join(' · '))
          setPassword('')
          setState((current) => ({ ...current, account: payload.account ?? current.account, health: payload.health ?? current.health }))
          setAccountName(payload.account?.username ?? accountName)
          setAccountMessage({ kind: payload.account?.loggedIn === false ? 'error' : 'ok', text: payload.note ?? T.accountSaved })
        } catch (error) {
          setAccountMessage({ kind: 'error', text: String(error?.message ?? error) })
        } finally {
          setAccountBusy(false)
        }
      }

      /**
       * Switch the effective transport to unofficial in one click. The account
       * is useless under dryrun, and asking someone to save twice is how this
       * got confusing in the first place.
       */
      const switchTransport = async () => {
        if (!draft) return
        const next = { ...draft, transport: 'unofficial' }
        setSaving(true)
        setMessage(null)
        try {
          const response = await fetch(withToken(API), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(next),
          })
          const payload = await response.json()
          if (!payload?.ok) throw new Error([payload?.error, payload?.hint].filter(Boolean).join(' · '))
          setDraft(next)
          setMessage({ kind: 'ok', text: '已改為 unofficial，重啟 DSH 後生效。' })
        } catch (error) {
          setMessage({ kind: 'error', text: String(error?.message ?? error) })
        } finally {
          setSaving(false)
        }
      }

      const sidecarAction = async (action) => {
        setSidecarBusy(true)
        setSidecarMessage(null)
        try {
          const response = await fetch(withToken(SIDECAR_API), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action }),
          })
          const payload = await response.json()
          if (!payload?.ok) throw new Error([payload?.code, payload?.error].filter(Boolean).join(' · '))
          setState((current) => ({ ...current, sidecar: payload.status ?? current.sidecar }))
          if (payload.note) {
            setSidecarMessage({ kind: payload.installed?.ok ? 'ok' : 'error', text: payload.note })
          }
        } catch (error) {
          setSidecarMessage({ kind: 'error', text: String(error?.message ?? error) })
        } finally {
          setSidecarBusy(false)
        }
      }

      if (state.loading) return h('div', { style: { padding: 24, fontSize: 13, opacity: 0.7 } }, T.loading)
      if (state.error) return h('div', { style: { padding: 24, fontSize: 13, color: 'var(--dsw-alias-state-error-primary, #ff6b6b)' } }, `${T.failed}：${state.error}`)
      if (!draft) return h('div', { style: { padding: 24, fontSize: 13, opacity: 0.7 } }, T.loading)

      const account = state.account
      const loggedIn = Boolean(state.health?.loggedIn)

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', maxWidth: 780, width: '100%', color: 'var(--dsw-alias-label-primary, #e6e9ef)' } },
        h('h2', { style: { fontSize: 18, margin: '0 0 6px' } }, T.title),
        h('p', { style: { margin: '0 0 10px', fontSize: 13, color: 'var(--dsw-alias-label-secondary, #8b93a7)' } }, T.lead),

        section(T.account, [
          field(T.username, textInput(accountName, setAccountName, { placeholder: 'your_throwaway_account', autoComplete: 'off' }), HINTS.igUsername),
          field(
            T.password,
            h('input', {
              type: 'password',
              style: inputStyle,
              value: password,
              autoComplete: 'new-password',
              placeholder: account?.hasCredentials ? '留空＝保留舊密碼' : '第一次要輸入',
              onChange: (event) => setPassword(event.target.value),
            }),
            HINTS.igPassword,
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', width: '100%' } },
            statusLine(loggedIn ? 'ok' : 'idle', loggedIn ? `${T.loggedIn} @${accountName || '?'}` : T.loggedOut),
            button(T.saveAccount, () => saveAccount(false), { disabled: accountBusy }),
            button(T.saveAndLogin, () => saveAccount(true), { primary: true, disabled: accountBusy }),
          ),
          accountMessage ? statusLine(accountMessage.kind, accountMessage.text) : null,
          draft.transport !== 'unofficial'
            ? h(
                'div',
                {
                  style: {
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                    fontSize: 12,
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: 'var(--dsw-alias-bg-layer-3, #1b2230)',
                    color: 'var(--dsw-alias-label-secondary, #8b93a7)',
                  },
                },
                h(
                  'span',
                  null,
                  `目前 transport 是 ${draft.transport}：帳密會存去 sidecar，但要改為 unofficial 才會使用。`,
                ),
                button('改用 unofficial', switchTransport, { disabled: saving }),
              )
            : null,
          hint(T.accountHint),
        ]),

        section('連線（sidecar）', [
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', width: '100%' } },
            statusLine(
              state.sidecar?.running ? 'ok' : 'idle',
              state.sidecar?.running
                ? state.sidecar.managed
                  ? 'sidecar 運行中（由插件啟動）'
                  : 'sidecar 運行中（外部）'
                : 'sidecar 未啟動',
            ),
            statusLine(
              state.sidecar?.deps === true ? 'ok' : state.sidecar?.deps === false ? 'error' : 'idle',
              state.sidecar?.deps === true
                ? 'Python 依賴已安裝'
                : state.sidecar?.deps === false
                  ? state.sidecar?.pythonMissing
                    ? '找不到 Python'
                    : 'Python 依賴未安裝'
                  : '依賴未檢查',
            ),
            button('啟動', () => sidecarAction('start'), { disabled: sidecarBusy }),
            button('重新啟動', () => sidecarAction('restart'), { disabled: sidecarBusy }),
            button('檢查依賴', () => sidecarAction('deps'), { disabled: sidecarBusy }),
            button('安裝依賴', () => sidecarAction('install-deps'), { primary: state.sidecar?.deps === false, disabled: sidecarBusy }),
          ),
          sidecarMessage ? statusLine(sidecarMessage.kind, sidecarMessage.text) : null,
          state.sidecar?.lastError ? statusLine('error', state.sidecar.lastError) : null,
          hint(
            '插件會自己開 sidecar（unofficial.autoStart）。「安裝依賴」會跑一次 python -m pip install -r src/requirements.txt（第一次要幾十秒，也會裝 Pillow 等套件）。',
          ),
        ]),

        section(T.transport, [
          field(
            T.transport,
            selectInput(
              draft.transport,
              (state.transports.length ? state.transports : ['dryrun', 'graph', 'unofficial']).map((value) => ({ value, label: value })),
              (value) => patch(null, 'transport', value),
            ),
            HINTS.transport,
          ),
          field(T.owner, textInput(draft.ownerHandle, (value) => patch(null, 'ownerHandle', value), { placeholder: 'your_main_account' }), HINTS.ownerHandle),
          field(
            T.allowlist,
            textInput((draft.allowlist ?? []).join(', '), (value) => patch(null, 'allowlist', value.split(/[,;\s]+/).filter(Boolean))),
            HINTS.allowlist,
          ),
          field(
            T.strangers,
            selectInput(
              draft.replyToStrangers ? 'yes' : 'no',
              [
                { value: 'no', label: '否' },
                { value: 'yes', label: '是' },
              ],
              (value) => patch(null, 'replyToStrangers', value === 'yes'),
            ),
            HINTS.replyToStrangers,
          ),
        ]),

        section(T.life, [
          field(
            T.lifeEnabled,
            selectInput(
              draft.life.enabled ? 'yes' : 'no',
              [
                { value: 'no', label: '關' },
                { value: 'yes', label: '開' },
              ],
              (value) => patch('life', 'enabled', value === 'yes'),
            ),
            HINTS['life.enabled'],
          ),
          field(T.tick, numberInput(draft.life.tickSeconds, (value) => patch('life', 'tickSeconds', value)), HINTS['life.tickSeconds']),
          field(T.timezone, textInput(draft.life.timezone, (value) => patch('life', 'timezone', value)), HINTS['life.timezone']),
          field(T.quiet, textInput(draft.life.quietHours, (value) => patch('life', 'quietHours', value)), HINTS['life.quietHours']),
        ]),

        section(T.limits, [
          field(T.dmPerDay, numberInput(draft.limits.dmPerDay, (value) => patch('limits', 'dmPerDay', value)), HINTS['limits.dmPerDay']),
          field(T.postsPerDay, numberInput(draft.limits.postsPerDay, (value) => patch('limits', 'postsPerDay', value)), HINTS['limits.postsPerDay']),
          field(T.commentsPerDay, numberInput(draft.limits.commentsPerDay, (value) => patch('limits', 'commentsPerDay', value)), HINTS['limits.commentsPerDay']),
          field(T.cooldown, numberInput(draft.limits.replyCooldownSeconds, (value) => patch('limits', 'replyCooldownSeconds', value)), HINTS['limits.replyCooldownSeconds']),
        ]),

        section(T.unofficial, [
          field(T.baseUrl, textInput(draft.unofficial.baseUrl, (value) => patch('unofficial', 'baseUrl', value)), HINTS['unofficial.baseUrl']),
          field(T.poll, numberInput(draft.unofficial.pollSeconds, (value) => patch('unofficial', 'pollSeconds', value)), HINTS['unofficial.pollSeconds']),
          field(T.sendPerDay, numberInput(draft.unofficial.sendPerDay, (value) => patch('unofficial', 'sendPerDay', value)), HINTS['unofficial.sendPerDay']),
          field(T.postPerDayU, numberInput(draft.unofficial.postPerDay, (value) => patch('unofficial', 'postPerDay', value)), HINTS['unofficial.postPerDay']),
          field(T.gap, numberInput(draft.unofficial.sendGapSeconds, (value) => patch('unofficial', 'sendGapSeconds', value)), HINTS['unofficial.sendGapSeconds']),
        ]),

        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2, #232b3a)' } },
          button(saving ? T.saving : T.save, save, { primary: true, disabled: saving }),
          message ? statusLine(message.kind, message.text) : null,
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
