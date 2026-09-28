/**
 * Host half of the GitHub private-repository plugin.
 *
 * Registers the `github_*` model tools on the host composition and reads the
 * Personal Access Token from the credentials seam on every call, so a token
 * changed in the Plugins page reaches the next tool call without a restart.
 *
 * The module deliberately imports nothing: a profile-installed bundle is
 * resolved from its own directory, where the Harness packages it would import
 * are not installed. Tool definitions are therefore built in the registry's
 * own plain form (`name`/`description`/`parameters`/`output`/`execute`), which
 * `ctx.tools.register` accepts directly.
 *
 * Requests run through the sandboxed shell (`curl`) because the credential
 * header cannot travel through the `web` fetch seam; every argument is passed
 * as one single-quoted bash literal so model-supplied text cannot break out.
 *
 * @module @local/dsh-github
 */

/** Trailing marker curl appends after the body, carrying the HTTP status. */
const MARK = '__DSH_GH_STATUS__'

/** Services the tools need; the row stays inactive while any is missing. */
export const inject = ['tools', 'shell', 'credentials', 'sandboxPolicy']

export function apply(ctx, config) {
  const settings = config ?? {}
  const apiBase = typeof settings.apiBase === 'string' ? settings.apiBase : 'https://api.github.com'
  const tokenRef = typeof settings.tokenRef === 'string' ? settings.tokenRef : 'GITHUB_TOKEN'
  const defaultTimeout = Number.isFinite(settings.timeoutMs) ? settings.timeoutMs : 45000
  const maxOutputBytes = Number.isFinite(settings.maxOutputBytes) ? settings.maxOutputBytes : 600000
  const allowWrites = settings.allowWrites !== false

  /** Lossless-JSON guard: drops undefined keys before a value crosses the wire. */
  const clean = (value) => JSON.parse(JSON.stringify(value))

  /** Wrap one bash argument as a single-quoted literal, escaping embedded quotes. */
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

  async function resolveToken() {
    const resolved = await ctx.credentials.resolve(tokenRef)
    return resolved !== undefined && resolved.value.length > 0 ? resolved.value : undefined
  }

  /**
   * Run one shell request against whichever shape this deployment's shell seam
   * exposes: `resolve` + `run` (the older seam) or `resolve` + `execute` +
   * `result()` (the current one). Both yield the same `ShellRunResult`.
   */
  async function runShell(request) {
    const shell = ctx.shell
    const spec = shell.resolve(request)
    if (typeof shell.run === 'function') return shell.run(spec)
    if (typeof shell.execute === 'function') {
      const execution = await shell.execute(spec)
      if (execution && typeof execution.result === 'function') return execution.result()
      throw new Error('shell.execute() 返回的句柄不提供 result()')
    }
    throw new Error('当前 shell 服务没有可用的执行方法')
  }

  /** Run curl through the sandboxed shell and return the raw run result. */
  async function curlRun(method, url, options) {
    const parts = [
      'curl', '-sS', '--connect-timeout', '15',
      '--max-time', String(Math.max(1, Math.floor((options.timeoutMs ?? defaultTimeout) / 1000))),
      '-X', method,
      '-w', `\\n${MARK}%{http_code}`,
    ]
    const headers = options.headers ?? {}
    for (const key of Object.keys(headers)) parts.push('-H', `${key}: ${headers[key]}`)
    if (options.body !== undefined && options.body !== null) parts.push('--data-binary', String(options.body))
    parts.push(url)

    const policy = ctx.sandboxPolicy.resolve()
    return runShell({
      command: parts.map(q).join(' '),
      timeoutMs: options.timeoutMs ?? defaultTimeout,
      stdoutMaxBytes: options.stdoutMaxBytes ?? maxOutputBytes,
      sandboxPolicy: policy,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }

  function splitStatus(out) {
    const at = out.lastIndexOf(MARK)
    if (at < 0) return { body: out, status: 0 }
    return { body: out.slice(0, at), status: parseInt(out.slice(at + MARK.length).trim(), 10) || 0 }
  }

  /** One authenticated request; `raw: true` asks for raw media instead of JSON. */
  async function githubFetch(method, urlOrPath, options) {
    const opts = options ?? {}
    const token = await resolveToken()
    if (token === undefined) {
      throw new Error(
        `尚未配置 GitHub token：请在「插件 → GitHub 私人仓库」中粘贴 Personal Access Token，或设置环境变量 ${tokenRef}`,
      )
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: opts.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-github-plugin/1.0',
    }
    let body
    if (opts.body !== undefined && opts.body !== null) {
      headers['Content-Type'] = 'application/json'
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
    }
    const url = /^https?:\/\//.test(urlOrPath) ? urlOrPath : apiBase + urlOrPath
    const run = await curlRun(method, url, {
      headers,
      body,
      signal: opts.signal,
      stdoutMaxBytes: opts.stdoutMaxBytes,
      timeoutMs: opts.timeoutMs,
    })
    const parsed = splitStatus(run.stdout.text)
    return {
      status: parsed.status,
      text: parsed.body,
      truncated: run.stdout.truncated || false,
      stderr: run.stderr.text,
      exitCode: run.exitCode,
    }
  }

  /** Request expecting JSON; a non-JSON body reports `parseFailed`. */
  async function ghJson(method, urlOrPath, body, options) {
    const opts = { ...(options ?? {}) }
    if (body !== undefined) opts.body = body
    const fetched = await githubFetch(method, urlOrPath, opts)
    const text = fetched.text.trim()
    let data
    let parseFailed = false
    if (text !== '') {
      try {
        data = JSON.parse(text)
      } catch {
        parseFailed = true
      }
    }
    return { status: fetched.status, data, parseFailed, text: fetched.text, truncated: fetched.truncated }
  }

  /** Turn a non-2xx response into the error object the tools return. */
  function asError(res, fallback) {
    if (res.status >= 200 && res.status < 300 && !res.parseFailed) return res.data
    if (res.parseFailed) {
      const detail = res.text ? `：${res.text.slice(0, 400)}` : ''
      return { ok: false, httpStatus: res.status, error: `${fallback ?? 'GitHub 返回了无法解析的响应'}${detail}` }
    }
    if (res.data && res.data.message) {
      let message = String(res.data.message)
      if (Array.isArray(res.data.errors) && res.data.errors.length > 0) {
        message += ` (${res.data.errors.map((e) => (e && e.message ? e.message : JSON.stringify(e))).join('; ')})`
      }
      return { ok: false, httpStatus: res.status, error: message }
    }
    return {
      ok: false,
      httpStatus: res.status,
      error: fallback ? `${fallback} (HTTP ${res.status})` : `GitHub HTTP ${res.status}`,
    }
  }

  const encodePath = (p) => String(p).split('/').map((segment) => encodeURIComponent(segment)).join('/')
  const encodeRepo = (owner, repo) => `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`

  async function defaultBranch(owner, repo, fallback, signal) {
    try {
      const res = await ghJson('GET', `/repos/${encodeRepo(owner, repo)}`, undefined, { signal })
      if (res.status === 200 && res.data && typeof res.data.default_branch === 'string') {
        return res.data.default_branch
      }
    } catch {
      /* fall through to the caller's default */
    }
    return fallback
  }

  /** Blob sha of an oversized file: its newest commit, then that commit's tree. */
  async function blobShaOf(owner, repo, path, ref, signal) {
    const query = ref ? `?sha=${encodeURIComponent(ref)}&per_page=1` : '?per_page=1'
    const commits = await ghJson(
      'GET',
      `/repos/${encodeRepo(owner, repo)}/commits${query}&path=${encodePath(path)}`,
      undefined,
      { signal },
    )
    if (commits.status !== 200 || !Array.isArray(commits.data) || commits.data.length === 0) return undefined
    const tree = await ghJson(
      'GET',
      `/repos/${encodeRepo(owner, repo)}/git/trees/${encodeURIComponent(commits.data[0].sha)}?recursive=0`,
      undefined,
      { signal },
    )
    if (tree.status !== 200 || !tree.data || !Array.isArray(tree.data.tree)) return undefined
    const hit = tree.data.tree.find((node) => node && node.path === path && node.type === 'blob')
    return hit ? hit.sha : undefined
  }

  const capText = (value, limit) => {
    const text = String(value)
    return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false }
  }

  /**
   * Register one tool in the registry's plain definition form. Arguments are
   * not pre-validated (that is `defineTool`'s job, unavailable to a
   * dependency-free package), so every executor defaults and narrows its own
   * input.
   */
  function tool(definition) {
    const registered = {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: {
        schema: {},
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      ...(Number.isFinite(definition.timeoutMs) ? { timeoutMs: definition.timeoutMs } : {}),
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        try {
          return clean(await definition.execute(input, exec))
        } catch (error) {
          return { ok: false, httpStatus: 0, error: error && error.message ? error.message : String(error) }
        }
      },
    }
    ctx.effect(() => ctx.tools.register(registered), `dsh-github: tool ${definition.name}`)
  }

  tool({
    name: 'github_api',
    description:
      'Generic authenticated GitHub REST call. Use it for anything the dedicated github_* tools do not cover: search, branches, tags, issue and pull-request listing, releases, actions, webhooks, comments, merges. endpoint is a path starting with "/" or a full https://api.github.com URL. Writes (POST/PATCH/PUT/DELETE) are allowed. Returns { ok, httpStatus, data, truncated, error }.',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], description: 'HTTP method; defaults to GET.' },
        endpoint: { type: 'string', description: 'GitHub REST path such as /repos/{owner}/{repo}/issues, or a full https://api.github.com URL.' },
        body: { description: 'Optional JSON request body for writes.' },
      },
      required: ['endpoint'],
    },
    timeoutMs: 60000,
    async execute(args, exec) {
      const method = String(args.method || 'GET').toUpperCase()
      const res = await ghJson(method, String(args.endpoint), args.body === undefined ? undefined : args.body, {
        signal: exec.signal,
      })
      if (res.parseFailed) {
        return {
          ok: res.status >= 200 && res.status < 300,
          httpStatus: res.status,
          data: { raw: res.text.slice(0, 60000) },
          truncated: res.truncated,
        }
      }
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, httpStatus: res.status, data: res.data, truncated: res.truncated }
      }
      const failure = asError(res, 'GitHub 请求失败')
      return { ok: false, httpStatus: failure.httpStatus, data: res.data, truncated: res.truncated, error: failure.error }
    },
  })

  tool({
    name: 'github_list_repos',
    description:
      'List repositories the configured token can see, including PRIVATE ones (private: true). Use it to discover the owner/repo identifiers of the user private repositories. Returns name, fullName, private, defaultBranch, description, language, updatedAt.',
    parameters: {
      type: 'object',
      properties: {
        visibility: { type: 'string', enum: ['all', 'public', 'private'], description: 'Visibility filter; defaults to all.' },
        sort: { type: 'string', enum: ['updated', 'created', 'full_name', 'pushed'], description: 'Sort order; defaults to updated.' },
        perPage: { type: 'integer', description: 'Items per page, 1-100; defaults to 30.' },
        page: { type: 'integer', description: 'Page number; defaults to 1.' },
      },
    },
    timeoutMs: 60000,
    async execute(args, exec) {
      const perPage = Math.min(100, Math.max(1, Number(args.perPage) || 30))
      const page = Math.max(1, Number(args.page) || 1)
      let query = `per_page=${perPage}&page=${page}&sort=${args.sort || 'updated'}`
      if (args.visibility && args.visibility !== 'all') query += `&visibility=${args.visibility}`
      const res = await ghJson('GET', `/user/repos?${query}`, undefined, { signal: exec.signal })
      if (res.status < 200 || res.status >= 300) return asError(res, '无法列出仓库')
      if (!Array.isArray(res.data)) return { ok: false, httpStatus: res.status, error: '响应格式异常' }
      const repos = res.data.map((r) => ({
        name: r.name,
        fullName: r.full_name,
        private: !!r.private,
        fork: !!r.fork,
        description: r.description || null,
        language: r.language || null,
        defaultBranch: r.default_branch || null,
        updatedAt: r.updated_at || null,
        htmlUrl: r.html_url || null,
      }))
      return { ok: true, httpStatus: res.status, count: repos.length, page, repos }
    },
  })

  tool({
    name: 'github_list_contents',
    description:
      'List one directory of a repository (the repository root when path is omitted), private repositories included. Returns entries with name, type (file/dir/submodule/symlink), path, size, sha.',
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner (user or organization).' },
        repo: { type: 'string', description: 'Repository name.' },
        path: { type: 'string', description: 'Directory path inside the repository; omit for the root.' },
        ref: { type: 'string', description: 'Branch, tag or commit SHA; defaults to the repository default branch.' },
      },
      required: ['owner', 'repo'],
    },
    timeoutMs: 60000,
    async execute(args, exec) {
      const path = typeof args.path === 'string' ? args.path : ''
      const suffix = args.ref ? `?ref=${encodeURIComponent(String(args.ref))}` : ''
      const res = await ghJson(
        'GET',
        `/repos/${encodeRepo(args.owner, args.repo)}/contents/${encodePath(path)}${suffix}`,
        undefined,
        { signal: exec.signal },
      )
      if (res.status < 200 || res.status >= 300) return asError(res, '无法读取目录')
      if (!Array.isArray(res.data)) return { ok: false, httpStatus: res.status, error: '该路径不是目录，请用 github_read_file' }
      const entries = res.data.map((e) => ({
        name: e.name,
        type: e.type,
        path: e.path,
        size: e.type === 'file' ? e.size : null,
        sha: e.sha,
        target: e.target || null,
      }))
      return { ok: true, httpStatus: res.status, path: path || '/', count: entries.length, entries }
    },
  })

  tool({
    name: 'github_read_file',
    description:
      'Read the text of one file from a repository (private included), decoding base64 and falling back to the Git Blobs API for files over 1 MiB. Returns { ok, name, path, sha, size, content, truncated, error }.',
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner (user or organization).' },
        repo: { type: 'string', description: 'Repository name.' },
        path: { type: 'string', description: 'File path inside the repository, such as src/main.py.' },
        ref: { type: 'string', description: 'Branch, tag or commit SHA; defaults to the repository default branch.' },
      },
      required: ['owner', 'repo', 'path'],
    },
    timeoutMs: 90000,
    async execute(args, exec) {
      const ref = args.ref
        ? String(args.ref)
        : await defaultBranch(args.owner, args.repo, 'main', exec.signal)
      const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : ''
      const res = await ghJson(
        'GET',
        `/repos/${encodeRepo(args.owner, args.repo)}/contents/${encodePath(args.path)}${suffix}`,
        undefined,
        { signal: exec.signal },
      )
      if (res.status === 404) {
        return { ok: false, httpStatus: 404, error: `文件不存在: ${args.owner}/${args.repo} ${args.path} (${ref || 'default'})` }
      }
      const tooLarge =
        res.status === 409 ||
        (res.data && typeof res.data.message === 'string' && /blobs up to 1 MiB/i.test(res.data.message))
      if (tooLarge) {
        const sha = await blobShaOf(args.owner, args.repo, args.path, ref, exec.signal)
        if (!sha) {
          return { ok: false, httpStatus: 409, error: `文件超过 1 MiB 且无法解析 blob sha: ${res.data ? res.data.message : ''}` }
        }
        const blob = await githubFetch(
          'GET',
          `/repos/${encodeRepo(args.owner, args.repo)}/git/blobs/${encodeURIComponent(sha)}`,
          { raw: true, signal: exec.signal, stdoutMaxBytes: 1200000 },
        )
        if (blob.status < 200 || blob.status >= 300) {
          return { ok: false, httpStatus: blob.status, error: `Blob 读取失败 HTTP ${blob.status}` }
        }
        const capped = capText(blob.text, 400000)
        return {
          ok: true,
          httpStatus: 200,
          name: String(args.path).split('/').pop(),
          path: args.path,
          sha,
          size: blob.text.length,
          content: capped.text,
          truncated: capped.truncated || blob.truncated,
          note: '通过 Git Blobs API 读取 (>1 MiB)',
        }
      }
      if (res.status < 200 || res.status >= 300) return asError(res, '无法读取文件')
      if (Array.isArray(res.data)) return { ok: false, httpStatus: res.status, error: `${args.path} 是目录，请用 github_list_contents` }
      const data = res.data
      if (!data || typeof data !== 'object') return { ok: false, httpStatus: res.status, error: '响应格式异常' }
      if (data.type === 'symlink' || data.type === 'submodule') {
        return { ok: false, httpStatus: res.status, error: `${data.type} 无法直接读取，target: ${data.target || 'n/a'}` }
      }
      if (!data.content) return { ok: false, httpStatus: res.status, error: '响应中没有文件内容（可能是二进制文件）' }
      let decoded
      try {
        decoded = Buffer.from(String(data.content), 'base64').toString('utf8')
      } catch (error) {
        return { ok: false, httpStatus: res.status, error: `内容解码失败: ${error && error.message ? error.message : String(error)}` }
      }
      const capped = capText(decoded, 400000)
      return {
        ok: true,
        httpStatus: res.status,
        name: data.name,
        path: data.path,
        sha: data.sha,
        size: data.size,
        content: capped.text,
        truncated: capped.truncated,
      }
    },
  })

  if (allowWrites) {
    tool({
      name: 'github_write_file',
      description:
        'Create or update one file in a repository with a Contents API commit. An existing file is updated automatically (its current sha is fetched when sha is omitted). Returns { ok, commitSha, commitUrl, path, httpStatus, error }.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner (user or organization).' },
          repo: { type: 'string', description: 'Repository name.' },
          path: { type: 'string', description: 'File path to create or update, such as docs/note.md.' },
          content: { type: 'string', description: 'Complete new file content.' },
          message: { type: 'string', description: 'Commit message.' },
          branch: { type: 'string', description: 'Branch to commit to; defaults to the repository default branch.' },
          sha: { type: 'string', description: 'Current blob sha, required to overwrite an existing file; omit to auto-detect.' },
        },
        required: ['owner', 'repo', 'path', 'content', 'message'],
      },
      timeoutMs: 90000,
      async execute(args, exec) {
        const branch = args.branch
          ? String(args.branch)
          : await defaultBranch(args.owner, args.repo, 'main', exec.signal)
        let sha = typeof args.sha === 'string' ? args.sha : undefined
        if (!sha) {
          const suffix = branch ? `?ref=${encodeURIComponent(branch)}` : ''
          const probe = await ghJson(
            'GET',
            `/repos/${encodeRepo(args.owner, args.repo)}/contents/${encodePath(args.path)}${suffix}`,
            undefined,
            { signal: exec.signal },
          )
          if (probe.status === 200) {
            if (Array.isArray(probe.data)) return { ok: false, httpStatus: 200, error: `${args.path} 是目录，不能作为文件写入` }
            sha = probe.data && probe.data.sha
          } else if (probe.status !== 404) {
            return asError(probe, '探测文件时出错')
          }
        }
        const body = { message: args.message, content: Buffer.from(String(args.content), 'utf8').toString('base64') }
        if (branch) body.branch = branch
        if (sha) body.sha = sha
        const res = await ghJson(
          'PUT',
          `/repos/${encodeRepo(args.owner, args.repo)}/contents/${encodePath(args.path)}`,
          body,
          { signal: exec.signal },
        )
        if (res.status < 200 || res.status >= 300) return asError(res, '提交失败（覆盖已有文件需要其 sha，token 需要写权限）')
        const data = res.data || {}
        return {
          ok: true,
          httpStatus: res.status,
          path: data.content && data.content.path ? data.content.path : args.path,
          contentSha: data.content && data.content.sha ? data.content.sha : null,
          commitSha: data.commit && data.commit.sha ? data.commit.sha : null,
          commitUrl: data.commit && data.commit.html_url ? data.commit.html_url : null,
          commitMessage: data.commit && data.commit.message ? data.commit.message : null,
        }
      },
    })

    tool({
      name: 'github_create_issue',
      description: 'Open an issue in a repository. Returns { ok, number, state, title, htmlUrl, httpStatus, error }.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner (user or organization).' },
          repo: { type: 'string', description: 'Repository name.' },
          title: { type: 'string', description: 'Issue title.' },
          body: { type: 'string', description: 'Issue body (Markdown).' },
          labels: { type: 'string', description: 'Optional comma-separated label names.' },
          assignees: { type: 'string', description: 'Optional comma-separated GitHub usernames.' },
        },
        required: ['owner', 'repo', 'title'],
      },
      timeoutMs: 60000,
      async execute(args, exec) {
        const body = { title: args.title }
        if (args.body) body.body = args.body
        if (args.labels) body.labels = String(args.labels).split(',').map((s) => s.trim()).filter(Boolean)
        if (args.assignees) body.assignees = String(args.assignees).split(',').map((s) => s.trim()).filter(Boolean)
        const res = await ghJson('POST', `/repos/${encodeRepo(args.owner, args.repo)}/issues`, body, { signal: exec.signal })
        if (res.status < 200 || res.status >= 300) return asError(res, '创建 Issue 失败')
        const data = res.data || {}
        return { ok: true, httpStatus: res.status, number: data.number, state: data.state, title: data.title, htmlUrl: data.html_url }
      },
    })

    tool({
      name: 'github_create_pull_request',
      description:
        'Open a pull request between two branches. Returns { ok, number, state, title, htmlUrl, head, base, httpStatus, error }.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner (user or organization).' },
          repo: { type: 'string', description: 'Repository name.' },
          title: { type: 'string', description: 'Pull request title.' },
          head: { type: 'string', description: 'Source branch, or owner:branch for a cross-repository pull request.' },
          base: { type: 'string', description: 'Branch to merge into.' },
          body: { type: 'string', description: 'Pull request description (Markdown).' },
          draft: { type: 'boolean', description: 'Open as a draft pull request.' },
        },
        required: ['owner', 'repo', 'title', 'head', 'base'],
      },
      timeoutMs: 60000,
      async execute(args, exec) {
        const body = { title: args.title, head: args.head, base: args.base }
        if (args.body) body.body = args.body
        if (args.draft === true) body.draft = true
        const res = await ghJson('POST', `/repos/${encodeRepo(args.owner, args.repo)}/pulls`, body, { signal: exec.signal })
        if (res.status < 200 || res.status >= 300) return asError(res, '创建 PR 失败')
        const data = res.data || {}
        return {
          ok: true,
          httpStatus: res.status,
          number: data.number,
          state: data.state,
          title: data.title,
          htmlUrl: data.html_url,
          head: data.head && data.head.ref,
          base: data.base && data.base.ref,
        }
      },
    })
  }
}
