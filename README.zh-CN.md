> [**English**](README.md) | **中文**

# Mini Pi Agent

**Mini Pi Agent** 是一个轻量级的终端 AI 编程助手：在命令行里和 LLM 对话，自动完成读文件、改代码、跑命令等编码任务。

## 特性

| 特性 | 说明 |
|------|------|
| 💬 交互式 REPL | 流式输出，实时显示回答与思考过程 |
| 🔌 多模型支持 | OpenAI、Anthropic、DeepSeek、Gemini、OpenRouter |
| 🛠 内置工具集 | read / write / edit / bash / glob / grep |
| 🧠 推理模型支持 | o3-mini、DeepSeek Reasoner 等推理模型 |
| 💾 会话持久化 | 自动保存对话，跨启动恢复上下文 |
| 🧩 Provider 插件化 | 易于扩展新服务商 |
| ⚡ 零运行时依赖 | 不依赖任何外部运行时包 |
| 🔐 密钥独立存储 | API Key 单独存于 auth.json，不会进版本库 |

---

## 快速开始

> 前置要求：**Node.js ≥ 18**

### 1. 安装

```bash
git clone https://github.com/kevinzhu666/mini-pi.git
cd mini-pi
npm install
```

### 2. 配置（3 个示例文件一次搞定）

项目根目录有 `config.example.json`、`auth.example.json`、`memory.example.json` 三个示例，复制到 `~/.mini-pi/` 后只改 `auth.json` 填 API key：

```bash
mkdir -p ~/.mini-pi/memory
cp config.example.json  ~/.mini-pi/config.json
cp auth.example.json    ~/.mini-pi/auth.json
cp memory.example.json  ~/.mini-pi/memory/memory.json

vi ~/.mini-pi/auth.json   # 把每个 provider 的 key 换成你自己的
```

- `config.json` — 模型、服务商、推理级别等常规配置
- `auth.json` — 各服务商的 API Key
- `memory/memory.json` — 记忆数据

各字段含义见下方 [配置参考](#配置参考-configuration-reference)。

### 3. 启动

```bash
npm run dev      # 开发模式（推荐，改动即时生效）

# 或构建后全局安装，直接用 mini-pi 命令：
npm run build && npm link
mini-pi
```

### 用法示例

```bash
mini-pi                              # 交互式会话
mini-pi "写一个二分查找"               # 单次提问
echo "列出所有 .ts 文件" | mini-pi     # 管道输入
mini-pi -p deepseek -m deepseek-chat  # 指定服务商和模型
mini-pi -s 20260810-152030            # 启动时恢复历史会话
```

---

## 配置参考 Configuration Reference

所有配置都在 `~/.mini-pi/` 下，共 3 个文件：

| 文件 | 作用 |
|------|------|
| `config.json` | 模型、服务商、推理级别等常规配置 |
| `auth.json` | 各服务商的 API Key（不会被 git 跟踪） |
| `memory/memory.json` | 记忆数据（`/remember` 写入的事实） |

### config.json 字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `provider` | `string` | `"openai"` | 服务商：`openai` / `anthropic` / `deepseek` / `google` / `openrouter` |
| `model` | `string` | `"gpt-4o"` | 默认模型 ID（见下方模型表） |
| `baseUrl` | `string` \| `null` | `null` | 自定义 API 地址（代理/自建时设置，一般留 `null`） |
| `thinkingLevel` | `string` | `"off"` | 推理级别：`off` / `low` / `medium` / `high` |
| `systemPrompt` | `string` | `"You are a helpful coding assistant."` | 自定义系统提示词 |
| `maxTokens` | `number` | `8192` | 每次响应最大输出 Token |
| `toolExecution` | `string` | `"sequential"` | 工具执行模式：`sequential`（串行）/ `parallel`（并行） |

### API Key

**优先级：CLI 参数 > `auth.json` > 环境变量。**

1. 写在 `auth.json`（推荐）：

```json
{ "apiKeys": { "deepseek": "sk-xxx", "openai": "sk-xxx" } }
```

2. 或用环境变量（`auth.json` 里没配时才生效）：

```bash
export DEEPSEEK_API_KEY="sk-..."
export OPENAI_API_KEY="sk-..."
```

> 备注：`OPENAI_API_KEY` 是所有 provider 的兜底环境变量。

### 命令行参数 CLI Options

| 参数 | 说明 |
|------|------|
| `-m, --model <name>` | 模型 ID |
| `-p, --provider <name>` | 服务商 |
| `-k, --api-key <key>` | API key |
| `-b, --base-url <url>` | 自定义 API 地址 |
| `-t, --thinking <level>` | 推理级别：`off\|low\|medium\|high` |
| `-s, --session <id>` | 启动时恢复会话 |
| `-c, --config` | 打印当前配置 |
| `-l, --list-models` | 列出可用模型 |
| `-h, --help` | 帮助 |

CLI 参数优先级最高，覆盖配置文件和环境变量。

---

## REPL 命令

进入 REPL 后输入 `/` 开头的命令（`/help` 查看全部）：

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/exit` | 退出 |
| `/clear` | 重置并开始新会话 |
| `/model <name>` | 切换模型 |
| `/provider <name>` | 切换服务商 |
| `/thinking <off\|low\|medium\|high>` | 设置推理级别 |
| `/tokens <num>` | 设置最大输出 Token |
| `/api-key <key>` | 设置 API key |
| `/config` | 查看当前配置 |
| `/tools` | 列出可用工具 |
| `/models` | 列出模型 |
| `/context` | 查看上下文统计 |
| `/sessions` | 列出已保存会话 |
| `/resume <id>` | 恢复会话 |
| `/session name <name>` | 给当前会话命名 |
| `/session delete <id>` | 删除会话 |
| `/remember <key> = <value>` | 记住一条事实 |
| `/recall <key>` | 回忆一条事实 |
| `/forget <key>` | 删除一条事实 |
| `/memories [tag]` | 列出所有记忆 |

---

## 会话持久化

对话自动保存到 `~/.mini-pi/sessions/<id>.json`，跨启动恢复上下文：

```bash
>>> /sessions                  # 列出所有会话
>>> /session name 优化登录流程   # 给当前会话命名
>>> /resume 20260810-152030    # 恢复历史会话
>>> /exit                      # 退出时自动保存
mini-pi -s 20260810-152030     # 启动时恢复
```

每个会话一个 JSON 文件，完整保存 user / assistant / toolResult 消息（含工具结果），并记录 provider、model、thinkingLevel。系统提示词是派生状态，不持久化。

---

## 记忆系统

- **显式记忆**：用 `/remember key = value` 记录，`/recall` 回忆，数据存于 `~/.mini-pi/memory/memory.json`。
- **自动注入**：每次提问前，所有记忆自动注入系统提示词，无需手动 `/recall`。

```bash
>>> /remember user-profile = Kevin，10余年Java工程师
✓ Remembered "user-profile"
>>> /recall user-profile
```

---

## 模型列表

| 服务商 | 模型 |
|--------|------|
| **OpenAI** | `gpt-4o`, `gpt-4o-mini`, `o3-mini`, `o4-mini`, `gpt-4.1` |
| **Anthropic** | `claude-sonnet-4-20250514` |
| **DeepSeek** | `deepseek-chat`, `deepseek-reasoner`, `deepseek-v4-flash`, `deepseek-v4-pro` |
| **Google Gemini** | `gemini-2.5-flash`, `gemini-2.5-pro` |
| **OpenRouter** | `auto` |

---

## 项目架构

Mini Pi 分层设计：CLI 决定运行模式，REPL 驱动 `Agent`，Agent 循环是执行引擎——从 provider 流式拉取回复并执行工具。

### 组件分层

```
┌─────────────────────────────────────────────────────────────┐
│                        CLI  (cli.ts)                        │
│        参数解析 · 模式选择（交互式/单次/管道输入）         │
│               加载配置与密钥 · 应用 CLI 覆盖               │
└──────────────────────────────┬──────────────────────────────┘
                              │ new MiniPiREPL(cwd, config, opts)
                              ▼                              
┌─────────────────────────────────────────────────────────────┐
│                       REPL  (repl.ts)                       │
│       readline 界面 · 斜杠命令 · 记忆 → 系统提示词       │
│                   会话持久化 · 流式渲染                    │
└──────────────────────────────┬──────────────────────────────┘
                              │ prompt(input)                
                              ▼                              
┌─────────────────────────────────────────────────────────────┐
│                      Agent  (agent.ts)                      │
│          状态（提示词/模型/工具/消息）· 事件系统           │
│            steering / follow-up 队列 · 生命周期            │
└──────────────────────────────┬──────────────────────────────┘
                              │ runAgentLoop                 
                              ▼                              
┌─────────────────────────────────────────────────────────────┐
│          Agent Loop  (agent-loop.ts)  — 执行引擎           │
│    convertToLlm → 流式 LLM → 执行工具 → 循环直到停止     │
└─────────────┬─────────────────────────────────┬─────────────┘
             streamModel                       tool.execute  
             ▼                                 ▼             
┌───────────────────────────┐     ┌───────────────────────────┐
│  Provider (provider.ts)   │     │     Tools  (tools.ts)     │
│     OpenAI-compatible     │     │   read / write / edit /   │
│    registerProvider()     │     │    bash / glob / grep     │
└─────────────┬─────────────┘     └─────────────┬─────────────┘
             │ HTTP                            │ FS          
             ▼                                 ▼             
┌─────────────────────────────────────────────────────────────┐
│           LLM API（OpenAI 兼容） · 项目文件系统            │
└─────────────────────────────────────────────────────────────┘
```

横切模块：
  config.ts    （配置 + 模型目录）    session.ts     （会话持久化）
  memory.ts    （记忆 + 自动注入）    event-stream.ts（异步事件流）
  types.ts     （核心类型）            index.ts       （公共 API）

### 源文件布局

```
src/
├── cli.ts            # CLI 入口，参数解析
├── repl.ts           # 交互式终端界面
├── agent.ts          # Agent 核心（状态、事件、队列）
├── agent-loop.ts     # 执行引擎
├── provider.ts       # LLM Provider 抽象
├── tools.ts          # 内置工具集
├── config.ts         # 配置管理 + 模型目录
├── session.ts        # 会话持久化
├── memory.ts         # 记忆系统
├── event-stream.ts   # Push 异步事件流
├── types.ts          # 核心类型
└── index.ts          # 公共 API 导出
```

### 对话流程

用 mini-pi 时实际发生什么，从启动到退出：

```
┌───────────────────────────────┐
│         启动 mini-pi          │
└───────────────────────────────┘
               │
               ▼
┌───────────────────────────────┐
│         读取你的设置          │
│  （用哪个 AI 模型、存在哪）   │
└───────────────────────────────┘
               │
               ▼
┌───────────────────────────────┐
│         你输入一句话          │
│ （提问，或「帮我修个 bug」）  │
└───────────────────────────────┘
               │
               ▼
┌───────────────────────────────┐
│        把你的话发给 AI        │
└───────────────────────────────┘
               │
               ▼
┌───────────────────────────────┐
│       AI 判断怎么处理：       │
│                               │
│         · 直接回答你         │
│· 或先动手——读文件、改代码、│
│   跑命令、搜索——直到能回答  │
└───────────────────────────────┘
               │
               ▼
┌───────────────────────────────┐
│         答案逐字显示          │
│      （随时可以打断它）       │
└───────────────────────────────┘
               │
               ▼
┌───────────────────────────────┐
│         对话自动保存          │
└───────────────────────────────┘
               │
               ▼
┌───────────────────────────────┐
│        输入 /exit 退出        │
│      （下次回来接着聊）       │
└───────────────────────────────┘
```

---

## 开发

```bash
npm run dev       # 开发模式（热重载）
npm run build     # 构建
npm run debug     # 调试模式
```

### 冒烟测试

```bash
node --import tsx scripts/smoke-session.ts   # 会话持久化 API
node --import tsx scripts/smoke-resume.ts    # 保存 → 恢复 round-trip
node --import tsx scripts/smoke-stream.ts    # 流式渲染（装饰只出现一次）
```

---

## 规划 Roadmap

### 已完成

- [x] **核心引擎** — Agent + Agent 循环 + 推送式事件流
- [x] **REPL** — 交互式 / 单次提问 / 管道输入 三种模式
- [x] **6 个内置工具** — read / write / edit / bash / glob / grep
- [x] **Steering 与钩子** — `steer()` / `followUp()` 中途改向队列 + `before`/`after` 工具调用钩子
- [x] **显式记忆** — `/remember` `/recall` `/forget` `/memories`
- [x] **记忆自动注入** — 每次提问前把已存事实注入系统提示词
- [x] **会话持久化** — 自动保存 / `-s` 恢复 / 列表、命名、删除
- [x] **配置与 CLI** — 多服务商（OpenAI 兼容协议）· `-c`/`--config` · `-l`/`--list-models` · `baseUrl`/`api-key` 覆盖

### 规划中

- [ ] **自动事实提取** — 每轮对话后让 LLM 提取重要事实并自动保存、去重更新
- [ ] **`transformContext` 管线** — 统一的上下文变换入口（历史裁剪、RAG、长期记忆）
- [ ] **上下文压缩 Compaction** — 长会话自动摘要，控制在上下文窗口内
- [ ] **Skills 与 Prompt 模板** — `/skill:name` 与 `.md` 模板
- [ ] **扩展系统 · 会话树/分支 · 多协议 provider · TUI**

---

## 许可

[MIT](LICENSE) — 可自由使用、修改和分发。
