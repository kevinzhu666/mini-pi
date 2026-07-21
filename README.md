# 🤖 Mini Pi Agent

> **English** | [中文](#)

---

**Mini Pi Agent** is a lightweight, extensible terminal-based AI coding assistant. It provides an interactive REPL where you can chat with LLMs to accomplish coding tasks — reading and writing files, editing code, running shell commands, and more.

**Mini Pi Agent** 是一个轻量级、可扩展的终端 AI 编程助手。它提供交互式 REPL 界面，让你在命令行中与 LLM 对话，自动完成代码编写任务。

---

## ✨ Features / 特性

| English | 中文 |
|---------|------|
| 💬 Interactive REPL with streaming output | 交互式 REPL，流式输出实时显示 |
| 🔌 Multi-model support (OpenAI, Anthropic, DeepSeek, Gemini, OpenRouter) | 多模型支持，接入主流 LLM 服务商 |
| 🛠 Built-in toolset (read, write, edit, bash, glob, grep) | 内置工具集（读写编辑文件、执行命令、搜索代码） |
| 🧠 Reasoning model support | 支持推理模型（如 o3-mini、DeepSeek Reasoner） |
| 🧩 Pluggable Provider architecture | Provider 插件化设计，易于扩展 |
| ⚡ Zero runtime dependencies | 零运行时外部依赖 |
| 🔐 Secure config (API keys in separate auth file) | 安全配置，API Key 独立存储 |

---

## 📦 Install / 安装

### Prerequisites / 前置要求

- **Node.js** >= 18
- **npm** or **pnpm**

### From source / 从源码安装

```bash
git clone https://github.com/kevinzhu666/mini-pi.git
cd mini-pi
npm install
npm run build
npm link             # optional: global install
```

---

## 🚀 Quick Start / 快速开始

### 1. Configure API Key / 配置 API Key

```bash
# Environment variable (recommended) / 环境变量（推荐）
export OPENAI_API_KEY="sk-..."
export DEEPSEEK_API_KEY="sk-..."

# Or pass at runtime / 或运行时传入
mini-pi -k sk-...
```

### 2. Start interactive session / 启动交互会话

```bash
mini-pi
```

### 3. Other usage / 其他用法

```bash
# Single prompt / 单次提问
mini-pi "Write a binary search tree in TypeScript"

# Piped input / 管道输入
echo "List all .ts files" | mini-pi

# Specify model / 指定模型
mini-pi -p deepseek -m deepseek-chat

# Enable reasoning / 启用推理模式
mini-pi -t high

# Show help / 查看帮助
mini-pi --help
```

---

## 🎮 REPL Commands / REPL 命令

Type `/` in the REPL to use commands:

| Command / 命令 | Description / 说明 |
|----------------|-------------------|
| `/help` | Show help / 显示帮助 |
| `/quit` or `/exit` | Exit REPL / 退出 |
| `/clear` | Clear conversation history / 清空对话 |
| `/reset` | Reset agent state / 重置 Agent 状态 |
| `/model <name>` | Switch model (e.g. `gpt-4o`) / 切换模型 |
| `/provider <name>` | Switch provider / 切换服务商 |
| `/thinking <off\|low\|medium\|high>` | Set thinking level / 设置推理级别 |
| `/tokens <num>` | Set max output tokens / 设置最大输出 Token |
| `/api-key <key>` | Set API key / 设置 API Key |
| `/config` | Show current config / 查看配置 |
| `/tools` | List available tools / 列出工具 |
| `/models` | List built-in models / 列出模型 |
| `/context` | Show context stats / 查看上下文统计 |
| `/remember <key> = <value>` | Store a persistent fact / 永久记住一条信息 |
| `/recall <key>` | Retrieve a stored fact / 回忆一条信息 |
| `/forget <key>` | Delete a stored fact / 忘记一条信息 |
| `/memories [tag]` | List all stored memories / 列出所有记忆 |

---

## ⚙️ Configuration / 配置

Config files are stored in `~/.mini-pi/`. You can use the example files in the project root as a starting point:

```bash
# Quick setup / 快速配置
cp config.example.json ~/.mini-pi/config.json
cp auth.example.json ~/.mini-pi/auth.json
# Then edit ~/.mini-pi/auth.json to add your API keys / 然后编辑 auth.json 填入密钥
```

> **Security note**: `auth.json` is **never** committed to version control. API keys are stored separately from general config. Environment variables also work and take priority — see below.

---

### `~/.mini-pi/config.json` — General Config / 通用配置

| Field / 字段 | Type / 类型 | Default / 默认值 | Description / 说明 |
|-------------|------------|------------------|-------------------|
| `provider` | `string` | `"openai"` | LLM service provider. One of: `openai`, `anthropic`, `deepseek`, `google`, `openrouter` |
| `model` | `string` | `"gpt-4o"` | Default model ID (see Provider & Models table below for full list) |
| `baseUrl` | `string` \| `null` | `null` | Override API base URL (e.g. for self-hosted proxy). `null` = use provider default |
| `thinkingLevel` | `string` | `"off"` | Reasoning effort: `off`, `low`, `medium`, `high` |
| `systemPrompt` | `string` | `"You are a helpful coding assistant."` | Custom system prompt |
| `maxTokens` | `number` | `8192` | Max output tokens per response |
| `toolExecution` | `string` | `"sequential"` | Tool execution mode: `sequential` (one at a time) or `parallel` (concurrent) |

**Example / 示例：**

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "thinkingLevel": "off",
  "maxTokens": 16384,
  "systemPrompt": "You are an expert TypeScript developer.",
  "toolExecution": "parallel"
}
```

---

### `~/.mini-pi/auth.json` — API Keys / 密钥存储

| Field / 字段 | Type / 类型 | Description / 说明 |
|-------------|------------|-------------------|
| `apiKeys` | `object` | Provider-scoped API keys. Key = provider name, value = API key |

**Example / 示例：**

```json
{
  "apiKeys": {
    "openai": "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "anthropic": "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "deepseek": "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "google": "AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "openrouter": "sk-or-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

---

### CLI Options / 命令行选项

| Flag / 参数 | Description / 说明 |
|-------------|-------------------|
| `-m, --model <name>` | Model ID (default: `gpt-4o`) |
| `-p, --provider <name>` | Provider (default: `openai`) |
| `-k, --api-key <key>` | API key |
| `-b, --base-url <url>` | API base URL override |
| `-t, --thinking <level>` | Thinking level: `off\|low\|medium\|high` |
| `-c, --config` | Print current configuration |
| `-l, --list-models` | List available models / 列出可用模型 |
| `-h, --help` | Show help / 显示帮助 |

CLI flags take **highest priority**, overriding both config file and environment variables.

### Environment Variables / 环境变量

Environment variables have **higher priority** than `auth.json`, but lower than CLI flags.

| Variable / 变量 | Provider |
|-----------------|----------|
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `GOOGLE_API_KEY` | Google Gemini |
| `OPENROUTER_API_KEY` | OpenRouter |

### Priority (High → Low) / 优先级（高 → 低）

1. **CLI flags** (`-k`, `-m`, `-p`, `-b`, `-t`)
2. **Environment variables** (`OPENAI_API_KEY`, etc.)
3. **Config files** (`~/.mini-pi/config.json`, `~/.mini-pi/auth.json`)
4. **Built-in defaults** (shown in tables above)

---

## 🧠 Memory System / 记忆系统

Mini Pi Agent supports a two-layer memory system for persisting facts across sessions.

### Layer 1: Explicit Memory (Key-Value)

Manually store and retrieve facts using REPL commands. Memories are saved to `~/.mini-pi/memory/memory.json`.

```bash
>>> /remember user-profile = Kevin，10余年经验的Java软件工程师
✓ Remembered "user-profile"

>>> /recall user-profile
  user-profile
  Kevin，10余年经验的Java软件工程师

>>> /memories
Memories:
  user-profile  [Kevin，10余年经验的Java软件工程师]
  ── 1 entries

>>> /forget user-profile
✓ Forgotten "user-profile"
```

An example file is provided at **[memory.example.json](memory.example.json)** in the project root:

```bash
cp memory.example.json ~/.mini-pi/memory/memory.json
# Then edit the file or use /remember in REPL
```

### Layer 2: Automatic Prompt Injection

Before each prompt, all stored memories are automatically injected into the system prompt. The AI sees them as context and can act on them without needing a `/recall` command.

```
System Prompt (auto-generated):
  You are a helpful coding assistant.
  ...
  ## Your Memory
  You remember these facts from past conversations:
  [1] Kevin，10余年经验的Java软件工程师 (tags: profile, user)
```

### File Format / 文件格式

```json
{
  "entries": [
    {
      "key": "unique-identifier",
      "value": "The fact to remember",
      "tags": ["optional", "tags"],
      "createdAt": 1721558400000,
      "updatedAt": 1721558400000
    }
  ]
}
```

---

| Provider / 服务商 | Models / 模型 |
|-------------------|---------------|
| **OpenAI** | `gpt-4o`, `gpt-4o-mini`, `o3-mini`, `o4-mini`, `gpt-4.1` |
| **Anthropic** | `claude-sonnet-4-20250514` |
| **DeepSeek** | `deepseek-chat`, `deepseek-reasoner`, `deepseek-v4-flash`, `deepseek-v4-pro` |
| **Google Gemini** | `gemini-2.5-flash`, `gemini-2.5-pro` |
| **OpenRouter** | `auto` (auto-routing) |

---

## 🏗 Project Architecture / 项目架构

```
src/
├── cli.ts            # CLI entry / 入口，参数解析
├── repl.ts           # Interactive REPL / 交互式终端界面
├── agent.ts          # Agent core (state, events, queues) / Agent 核心
├── agent-loop.ts     # Execution engine / 执行引擎
├── provider.ts       # LLM Provider abstraction / Provider 抽象层
├── tools.ts          # Built-in tools / 内置工具集
├── config.ts         # Config management + model catalog / 配置管理
├── event-stream.ts   # Push-based async event stream / 事件流
├── types.ts          # Core type definitions / 核心类型
└── index.ts          # Public API exports / 公共 API 导出
```

### Execution Flow / 执行流程

```
User Input → REPL → Agent.prompt()
                       ↓
                Agent Loop
                       ↓
            ┌─── LLM Stream ───┐
            │                   │
            ▼                   ▼
         Has Tool Call?      Done
            │                   │
            ▼                   ▼
        Execute Tool         Return
            │
            ▼
        Inject Result → Continue Loop
```

---

## 🧪 Development / 开发

```bash
# Watch mode / 开发模式（热重载）
npm run dev

# Build / 构建
npm run build

# Debug mode / 调试模式
npm run debug
```

---

## 🗺 Roadmap / 开发规划

### ✅ Done / 已完成

- [x] Layer 1: Explicit memory commands (`/remember`, `/recall`, `/forget`, `/memories`)
- [x] Layer 2: Automatic memory injection into system prompt

### 🚧 Planned / 规划中

- [ ] **Layer 3: Session Persistence / 会话持久化**
  - Auto-save conversation history to `~/.mini-pi/sessions/`
  - Restore previous sessions on startup
  - Named session snapshots (`/session save`, `/session load`)
  - `/sessions` command to browse history

- [ ] **Layer 4: Auto-Extraction / 自动事实提取**
  - After each conversation turn, ask the LLM to extract important facts
  - Automatically save extracted facts via `MemoryManager.remember()`
  - Deduplicate and update existing memories
  - Configurable extraction frequency (per-turn, per-session, manual)

---

## 📄 License / 许可

[MIT](LICENSE) — Free to use, modify, and distribute. See [LICENSE](LICENSE) for details.

MIT 协议 — 可自由使用、修改和分发。详见 [LICENSE](LICENSE) 文件。
