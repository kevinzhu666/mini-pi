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

---

## ⚙️ Configuration / 配置

Config files are stored in `~/.mini-pi/`:

| File / 文件 | Purpose / 用途 |
|-------------|----------------|
| `config.json` | General config (provider, model, etc.) / 通用配置 |
| `auth.json` | API keys (separate for security) / API Key 安全存储 |

### CLI Options / 命令行选项

| Flag / 参数 | Description / 说明 |
|-------------|-------------------|
| `-m, --model <name>` | Model ID (default: `gpt-4o`) |
| `-p, --provider <name>` | Provider (default: `openai`) |
| `-k, --api-key <key>` | API key |
| `-b, --base-url <url>` | API base URL override |
| `-t, --thinking <level>` | Thinking level: `off\|low\|medium\|high` |
| `-l, --list-models` | List available models / 列出可用模型 |
| `-h, --help` | Show help / 显示帮助 |

### Environment Variables / 环境变量

```
OPENAI_API_KEY       OpenAI
ANTHROPIC_API_KEY    Anthropic
DEEPSEEK_API_KEY     DeepSeek
GOOGLE_API_KEY       Google Gemini
OPENROUTER_API_KEY   OpenRouter
```

---

## 🔌 Supported Providers & Models / 支持的服务商与模型

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

## 📄 License / 许可

[MIT](LICENSE) — Free to use, modify, and distribute. See [LICENSE](LICENSE) for details.

MIT 协议 — 可自由使用、修改和分发。详见 [LICENSE](LICENSE) 文件。
