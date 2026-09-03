> **English** | [**中文**](README.zh-CN.md)

# Mini Pi Agent

**Mini Pi Agent** is a lightweight terminal AI coding assistant. Chat with LLMs right in your terminal to read files, edit code, and run commands.

## Features

| Feature | Description |
|---------|-------------|
| 💬 Interactive REPL | Streaming output, real-time responses |
| 🔌 Multi-model support | OpenAI, Anthropic, DeepSeek, Gemini, OpenRouter |
| 🛠 Built-in toolset | read / write / edit / bash / glob / grep |
| 🧠 Reasoning models | o3-mini, DeepSeek Reasoner, etc. |
| 💾 Session persistence | Auto-save conversations, resume across restarts |
| 🧩 Pluggable providers | Easy to add new providers |
| ⚡ Zero runtime deps | No external runtime packages |
| 🔐 Separate API keys | Keys live in auth.json, never committed |

---

## Quick Start

> Prerequisites: **Node.js ≥ 18**

### 1. Install

```bash
git clone https://github.com/kevinzhu666/mini-pi.git
cd mini-pi
npm install
```

### 2. Configure (all 3 example files at once)

The repo ships `config.example.json`, `auth.example.json`, and `memory.example.json`. Copy them into `~/.mini-pi/`, then only edit `auth.json` to add your API keys:

```bash
mkdir -p ~/.mini-pi/memory
cp config.example.json  ~/.mini-pi/config.json
cp auth.example.json    ~/.mini-pi/auth.json
cp memory.example.json  ~/.mini-pi/memory/memory.json

vi ~/.mini-pi/auth.json   # replace the placeholders with your own keys
```

- `config.json` — model, provider, thinking level, etc.
- `auth.json` — per-provider API keys
- `memory/memory.json` — persisted facts

See the [Configuration Reference](#configuration-reference) below for every field.

### 3. Run

```bash
npm run dev      # dev mode (recommended, hot reload)

# Or build and install globally, then use the mini-pi command:
npm run build && npm link
mini-pi
```

### Usage examples

```bash
mini-pi                              # interactive session
mini-pi "write a binary search tree" # single prompt
echo "list all .ts files" | mini-pi  # piped input
mini-pi -p deepseek -m deepseek-chat # pick provider and model
mini-pi -s 20260810-152030           # resume a saved session
```

---

## Configuration Reference

Everything lives under `~/.mini-pi/`, in 3 files:

| File | Purpose |
|------|---------|
| `config.json` | model, provider, thinking level, etc. |
| `auth.json` | per-provider API keys (not git-tracked) |
| `memory/memory.json` | facts stored via `/remember` |

### config.json fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `string` | `"openai"` | `openai` / `anthropic` / `deepseek` / `google` / `openrouter` |
| `model` | `string` | `"gpt-4o"` | default model ID (see models table below) |
| `baseUrl` | `string` \| `null` | `null` | custom API endpoint (proxy/self-host); leave `null` normally |
| `thinkingLevel` | `string` | `"off"` | `off` / `low` / `medium` / `high` |
| `systemPrompt` | `string` | `"You are a helpful coding assistant."` | custom system prompt |
| `maxTokens` | `number` | `8192` | max output tokens per response |
| `toolExecution` | `string` | `"sequential"` | `sequential` or `parallel` |

### API keys

**Priority: CLI flags > `auth.json` > environment variables.**

1. Put keys in `auth.json` (recommended):

```json
{ "apiKeys": { "deepseek": "sk-xxx", "openai": "sk-xxx" } }
```

2. Or use env vars (only used if `auth.json` has no key for that provider):

```bash
export DEEPSEEK_API_KEY="sk-..."
export OPENAI_API_KEY="sk-..."
```

> Note: `OPENAI_API_KEY` is the universal fallback for every provider.

### CLI options

| Flag | Description |
|------|-------------|
| `-m, --model <name>` | model ID |
| `-p, --provider <name>` | provider |
| `-k, --api-key <key>` | API key |
| `-b, --base-url <url>` | custom API endpoint |
| `-t, --thinking <level>` | `off\|low\|medium\|high` |
| `-s, --session <id>` | resume a session on startup |
| `-c, --config` | print the current configuration |
| `-l, --list-models` | list available models |
| `-h, --help` | show help |

CLI flags take the highest priority, overriding both config files and env vars.

---

## REPL Commands

Type `/` in the REPL (`/help` lists them all):

| Command | Description |
|---------|-------------|
| `/help` | show help |
| `/exit` | exit |
| `/clear` | reset and start a new session |
| `/model <name>` | switch model |
| `/provider <name>` | switch provider |
| `/thinking <off\|low\|medium\|high>` | set thinking level |
| `/tokens <num>` | set max output tokens |
| `/api-key <key>` | set API key |
| `/config` | show current config |
| `/tools` | list tools |
| `/models` | list models |
| `/context` | show context stats |
| `/sessions` | list saved sessions |
| `/resume <id>` | resume a session |
| `/session name <name>` | alias the current session |
| `/session delete <id>` | delete a session |
| `/remember <key> = <value>` | store a fact |
| `/recall <key>` | recall a fact |
| `/forget <key>` | delete a fact |
| `/memories [tag]` | list all memories |

---

## Session Persistence

Conversations auto-save to `~/.mini-pi/sessions/<id>.json` and resume across restarts:

```bash
>>> /sessions                  # list all sessions
>>> /session name login-flow   # alias the current session
>>> /resume 20260810-152030    # switch back to a session
>>> /exit                      # auto-save on exit
mini-pi -s 20260810-152030     # resume on startup
```

One JSON file per session — user / assistant / toolResult messages (including tool output), plus provider, model, and thinking level. The system prompt is derived state and is not persisted.

---

## Memory

- **Explicit**: store facts with `/remember key = value`, recall with `/recall`; data lives in `~/.mini-pi/memory/memory.json`.
- **Auto-injection**: before every prompt, all stored facts are injected into the system prompt — no `/recall` needed.

```bash
>>> /remember user-profile = Kevin, 10+ years Java engineer
✓ Remembered "user-profile"
>>> /recall user-profile
```

---

## Models

| Provider | Models |
|----------|--------|
| **OpenAI** | `gpt-4o`, `gpt-4o-mini`, `o3-mini`, `o4-mini`, `gpt-4.1` |
| **Anthropic** | `claude-sonnet-4-20250514` |
| **DeepSeek** | `deepseek-chat`, `deepseek-reasoner`, `deepseek-v4-flash`, `deepseek-v4-pro` |
| **Google Gemini** | `gemini-2.5-flash`, `gemini-2.5-pro` |
| **OpenRouter** | `auto` |

---

## Architecture

Mini Pi is layered: the CLI picks a mode, the REPL drives an `Agent`, and the Agent loop is the engine that streams from a provider and executes tools.

### Component layers

```
┌─────────────────────────────────────────────────────────────┐
│                        CLI  (cli.ts)                        │
│   arg parsing · mode select (interactive/one-shot/piped)   │
│          load config & auth · apply CLI overrides          │
└──────────────────────────────┬──────────────────────────────┘
                              │ new MiniPiREPL(cwd, config, opts)
                              ▼                              
┌─────────────────────────────────────────────────────────────┐
│                       REPL  (repl.ts)                       │
│  readline UI · slash commands · memory → system prompt     │
│           session persistence · streaming render           │
└──────────────────────────────┬──────────────────────────────┘
                              │ prompt(input)                
                              ▼                              
┌─────────────────────────────────────────────────────────────┐
│                      Agent  (agent.ts)                      │
│     state (prompt/model/tools/messages) · event system     │
│          steering / follow-up queues · lifecycle           │
└──────────────────────────────┬──────────────────────────────┘
                              │ runAgentLoop                 
                              ▼                              
┌─────────────────────────────────────────────────────────────┐
│         Agent Loop  (agent-loop.ts)  — the engine          │
│ convertToLlm → stream LLM → run tool calls → loop to stop  │
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
│    LLM API (OpenAI-compatible)   ·   project filesystem    │
└─────────────────────────────────────────────────────────────┘
```

Cross-cutting modules:
  config.ts  (config + model catalog)    session.ts  (persistence)
  memory.ts  (facts + auto-inject)       event-stream.ts  (async stream)
  types.ts   (core types)                index.ts     (public API)

### Source layout

```
src/
├── cli.ts            # CLI entry, arg parsing
├── repl.ts           # interactive REPL
├── agent.ts          # agent core (state, events, queues)
├── agent-loop.ts     # execution engine
├── provider.ts       # LLM provider abstraction
├── tools.ts          # built-in tools
├── config.ts         # config management + model catalog
├── session.ts        # session persistence
├── memory.ts         # memory system
├── event-stream.ts   # push-based async event stream
├── types.ts          # core types
└── index.ts          # public API exports
```

### Conversation flow

What actually happens when you use mini-pi, from launch to exit:

```
┌─────────────────────────────────────┐
│         You launch mini-pi          │
└─────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│         It loads your setup         │
│   (which AI model, where to save)   │
└─────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│         You type a message          │
│   (a question, or "fix this bug")   │
└─────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│     Your message goes to the AI     │
└─────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│      The AI decides what to do      │
│                                     │
│       · answer you directly        │
│   · or work first — read files,   │
│  edit code, run a command, search —│
│       until it's ready to reply     │
└─────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│ The answer streams in word by word  │
│   (you can interrupt it anytime)    │
└─────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│     Your conversation is saved      │
└─────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│         Type /exit to quit          │
│   (or come back later and resume)   │
└─────────────────────────────────────┘
```

---

## Development

```bash
npm run dev       # dev mode (hot reload)
npm run build     # build
npm run debug     # debug mode
```

### Smoke tests

```bash
node --import tsx scripts/smoke-session.ts   # session persistence API
node --import tsx scripts/smoke-resume.ts    # save → resume round-trip
node --import tsx scripts/smoke-stream.ts    # streaming render (decorations once)
```

---

## Roadmap

### Done

- [x] **Core engine** — Agent + Agent Loop + push event stream
- [x] **REPL** — interactive / one-shot / piped input modes
- [x] **6 built-in tools** — read / write / edit / bash / glob / grep
- [x] **Steering & hooks** — `steer()` / `followUp()` mid-turn queues + `before`/`after` toolCall hooks
- [x] **Explicit memory** — `/remember` `/recall` `/forget` `/memories`
- [x] **Memory auto-injection** — stored facts injected into the system prompt each turn
- [x] **Session persistence** — auto-save / `-s` resume / list & alias
- [x] **Config & CLI** — multi-provider (OpenAI-compatible) · `-c`/`--config` · `-l`/`--list-models` · `baseUrl`/`api-key` overrides

### Planned

- [ ] **Auto fact extraction** — after each turn, ask the LLM to extract key facts, save & dedupe them automatically
- [ ] **`transformContext` pipeline** — a single context-transform entry point (history trimming, RAG, long-term memory)
- [ ] **Context compaction** — auto-summarize long sessions to stay under the context window
- [ ] **Skills & prompt templates** — `/skill:name` and `.md` templates
- [ ] **Extension system · session tree/fork · multi-protocol providers · TUI**

---

## License

[MIT](LICENSE) — free to use, modify, and distribute.
