# dsh-plugin-github

DeepSeek Harness 插件：用 Personal Access Token 访问 GitHub（含**私有仓库**），向 Agent 提供 `github_*` 系列工具，并在「插件」页提供 token 配置卡片。

An installable DeepSeek Harness bundle that gives the Agent authenticated GitHub REST access — private repositories included — plus a Plugins-page card that stores the Personal Access Token through the credentials seam.

## 能力 / Tools

| 工具 | 说明 |
| --- | --- |
| `github_list_repos` | 列出 token 可见的仓库（含私有），返回 name / fullName / private / defaultBranch / updatedAt |
| `github_list_contents` | 列出仓库目录（支持 `path` / `ref`） |
| `github_read_file` | 读取文件文本，自动 base64 解码；>1 MiB 自动改用 Git Blobs API |
| `github_write_file` | 通过 Contents API 创建/更新文件（自动探测已有文件的 sha） |
| `github_create_issue` | 创建 Issue（支持 labels / assignees） |
| `github_create_pull_request` | 创建 PR（支持 draft） |
| `github_api` | 通用 REST 透传（GET/POST/PATCH/PUT/DELETE），覆盖 search、branches、releases、actions 等 |

## 安装 / Install

在本机 Harness 的「插件 → 添加插件」中任选其一：

1. **本地插件目录**：填入本仓库克隆后的绝对路径；
2. **GitHub 仓库地址**：填入本仓库 URL。

对应的 CLI 等价操作是 `plugin_manager` 的 `install_bundle`（profile 级安装，安装后所有会话可用）。

> 修改 Host 侧代码后需要在进程重启后才会加载新的模块代（ESM 模块缓存），安装/启停本身是即时的。

## Token / 凭据

插件**不保存 token 到设置文件或对话记录**，而是通过 Harness 的 credentials 服务按引用 `GITHUB_TOKEN` 解析，优先级：

1. 启动环境变量 `GITHUB_TOKEN`
2. `~/.dsh/.credentials.yaml`
3. `.env`（项目级 / 用户级）

在「插件 → GitHub 私人仓库」卡片中粘贴并保存即可（写入第 2 项）。

需要的权限：

- 经典令牌：`repo`
- 细粒度令牌：`Contents` (读写)、`Issues` (读写)、`Pull requests` (读写)、`Metadata` (只读，自动带)

## 配置 / Config

行配置（写入 profile 的 `cordis.patch.yml` 覆盖层）支持：

```yaml
- id: github
  name: '@local/dsh-github'
  config:
    apiBase: https://api.github.com   # GitHub REST 基址（GitHub Enterprise 可改）
    tokenRef: GITHUB_TOKEN            # 凭据引用名
    timeoutMs: 45000                  # 单次请求预算
    maxOutputBytes: 600000            # 单次响应捕获上限
    allowWrites: true                 # false 则只注册 4 个只读工具
```

## 实现要点 / Notes

- 请求经沙箱化 shell 执行 `curl`：凭据头无法走 `web` 抓取通道，因此走进程通道；每个参数都以单引号字面量包裹，模型输入无法逃逸出 shell。
- 工具定义以注册表原始形式注册，**本包零依赖**：profile 安装的包从自身目录解析，无法 import Harness 自带包，因此不引入任何 `@deepseek-ai/*` 依赖。
- 兼容两代 shell 服务形态：`resolve` + `run`，以及 `resolve` + `execute` + `result()`。
