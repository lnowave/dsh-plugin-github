/**
 * Client half of the GitHub private-repository plugin.
 *
 * Contributes one card to the Plugins page (`plugins.item`) that stores and
 * reports the Personal Access Token the Host half reads. The token travels
 * through the credentials remote, so it never enters a settings file or the
 * conversation log.
 *
 * @module @local/dsh-github/client
 */
window.__ModuleLoader__.load({
	id: '@local/dsh-github',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		/** Locale namespace of this plugin. */
		const NS = 'dsh-github'
		/** Credential reference holding the token; the Host half reads the same one. */
		const TOKEN_REF = 'GITHUB_TOKEN'

		const COPY = {
			en: {
				title: 'GitHub private repositories',
				configured: 'Token configured',
				unconfigured: 'No token configured',
				heading: 'Personal Access Token',
				hint: 'Needs the repo scope (classic token) or Contents, Issues and Pull requests read-and-write (fine-grained token). Stored outside the settings file; leave blank to keep the current token.',
				placeholder: 'ghp_… or github_pat_…',
				save: 'Save token',
				saving: 'Saving…',
				saved: 'Token saved. It is verified on the next github_* tool call.',
				empty: 'Paste a token first.',
				clear: 'Remove token',
				cleared: 'Token removed.',
				unavailable: 'The credential service is unavailable on this page.',
				tools: 'Tools: github_list_repos · github_list_contents · github_read_file · github_write_file · github_create_issue · github_create_pull_request · github_api',
			},
			zh: {
				title: 'GitHub 私人仓库',
				configured: '已配置 token',
				unconfigured: '未配置 token',
				heading: 'Personal Access Token',
				hint: '需要 repo 权限（经典令牌），或 Contents / Issues / Pull requests 读写权限（细粒度令牌）。token 保存在设置文件之外；留空则保持当前 token。',
				placeholder: 'ghp_… 或 github_pat_…',
				save: '保存 token',
				saving: '保存中…',
				saved: 'token 已保存，下次调用 github_* 工具时生效并验证。',
				empty: '请先粘贴 token。',
				clear: '移除 token',
				cleared: 'token 已移除。',
				unavailable: '当前页面无法访问凭据服务。',
				tools: '工具：github_list_repos · github_list_contents · github_read_file · github_write_file · github_create_issue · github_create_pull_request · github_api',
			},
		}

		/** Read one Client service without letting a missing one fail the plugin. */
		const readService = (ctx, key) => {
			try {
				const service = ctx.get(key)
				if (service !== undefined) return service
			} catch {
				/* fall through to the property form */
			}
			try {
				return ctx[key]
			} catch {
				return undefined
			}
		}

		return {
			inject: ['slots'],
			apply(ctx) {
				const slots = readService(ctx, 'slots')
				if (slots === undefined) return
				const remote = readService(ctx, 'remote')
				const locale = readService(ctx, 'locale')

				let t = (key) => COPY.zh[key] ?? key
				if (locale !== undefined) {
					ctx.effect(() => locale.register(NS, COPY), 'dsh-github: locale')
					t = locale.bind(NS)
				}

				/** The credential remote face, when this page exposes one. */
				const credentials = () => {
					if (remote === undefined) return undefined
					try {
						return remote.credentials
					} catch {
						return undefined
					}
				}

				const token = {
					color: 'var(--dsw-alias-label-primary)',
					muted: 'var(--dsw-alias-label-secondary)',
					border: 'var(--dsw-alias-border-l1)',
					field: 'var(--dsw-alias-bg-layer-2)',
					ok: 'var(--dsw-alias-state-success-primary)',
					idle: 'var(--dsw-alias-state-idle-primary)',
					error: 'var(--dsw-alias-state-error-primary)',
					brand: 'var(--dsw-alias-brand-primary)',
				}

				function GithubCard(props) {
					const isPage = props.view === 'page'
					const [state, setState] = React.useState({ configured: false, writable: true })
					const [value, setValue] = React.useState('')
					const [busy, setBusy] = React.useState(false)
					const [status, setStatus] = React.useState('')

					const read = React.useCallback(() => {
						const creds = credentials()
						if (creds === undefined) return
						Promise.resolve(creds.describe([TOKEN_REF]))
							.then((res) => {
								const info = res && res.ok && res.value ? res.value[TOKEN_REF] : undefined
								setState({
									configured: !!(info && info.configured),
									writable: !(info && info.writable === false),
								})
							})
							.catch(() => setState({ configured: false, writable: true }))
					}, [])

					React.useEffect(() => {
						read()
					}, [read])

					React.useEffect(() => {
						if (remote === undefined || typeof remote.$on !== 'function') return undefined
						const off = remote.$on('credentials/reference-updated', (ref) => {
							if (ref === TOKEN_REF) read()
						})
						return () => {
							if (typeof off === 'function') off()
						}
					}, [read])

					const save = () => {
						const next = value.trim()
						if (next.length === 0) {
							setStatus(t('empty'))
							return
						}
						const creds = credentials()
						if (creds === undefined) {
							setStatus(t('unavailable'))
							return
						}
						setBusy(true)
						setStatus('')
						Promise.resolve(creds.set(TOKEN_REF, next))
							.then(() => {
								setValue('')
								setStatus(t('saved'))
								read()
							})
							.catch((error) => setStatus(String((error && error.message) || error)))
							.finally(() => setBusy(false))
					}

					const clear = () => {
						const creds = credentials()
						if (creds === undefined || typeof creds.unset !== 'function') return
						setBusy(true)
						setStatus('')
						Promise.resolve(creds.unset(TOKEN_REF))
							.then(() => {
								setStatus(t('cleared'))
								read()
							})
							.catch((error) => setStatus(String((error && error.message) || error)))
							.finally(() => setBusy(false))
					}

					if (!isPage) {
						return h(
							'span',
							{ style: { color: state.configured ? token.ok : token.idle } },
							state.configured ? t('configured') : t('unconfigured'),
						)
					}

					const canClear = credentials() !== undefined && state.configured

					return h(
						'div',
						{ style: { display: 'flex', flexDirection: 'column', gap: '10px', color: token.color } },
						h('div', { style: { fontSize: '13px', fontWeight: 600 } }, t('heading')),
						h('div', { style: { fontSize: '12px', color: token.muted, lineHeight: 1.5 } }, t('hint')),
						h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
							h('input', {
								type: 'password',
								value,
								placeholder: t('placeholder'),
								disabled: busy,
								'aria-label': t('heading'),
								onChange: (event) => setValue(event.target.value),
								onKeyDown: (event) => {
									if (event.key === 'Enter') save()
								},
								style: {
									flex: '1 1 260px',
									minWidth: 0,
									padding: '6px 9px',
									fontSize: '13px',
									color: token.color,
									background: token.field,
									border: `1px solid ${token.border}`,
									borderRadius: '6px',
								},
							}),
							h('button', {
								type: 'button',
								disabled: busy,
								onClick: save,
								style: {
									padding: '6px 13px',
									fontSize: '13px',
									color: 'var(--dsw-alias-bg-base)',
									background: token.brand,
									border: '1px solid transparent',
									borderRadius: '6px',
									cursor: busy ? 'default' : 'pointer',
									opacity: busy ? 0.6 : 1,
								},
							}, busy ? t('saving') : t('save')),
							canClear
								? h('button', {
									type: 'button',
									disabled: busy,
									onClick: clear,
									style: {
										padding: '6px 13px',
										fontSize: '13px',
										color: token.color,
										background: 'transparent',
										border: `1px solid ${token.border}`,
										borderRadius: '6px',
										cursor: busy ? 'default' : 'pointer',
									},
								}, t('clear'))
								: null,
						),
						h('div', { style: { fontSize: '12px', color: state.configured ? token.ok : token.muted } },
							state.configured ? t('configured') : t('unconfigured')),
						status
							? h('div', { style: { fontSize: '12px', color: token.muted } }, status)
							: null,
						h('div', { style: { fontSize: '12px', color: token.muted, lineHeight: 1.5 } }, t('tools')),
					)
				}

				ctx.effect(
					() => slots.inject('plugins.item', () => slots.register({
						name: 'plugins.item',
						id: 'github',
						order: 50,
						label: () => t('title'),
						locale: NS,
					}, GithubCard)),
					'dsh-github: plugins page card',
				)
			},
		}
	},
})
