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

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 760" width="960" height="760" style="width:100%;max-width:960px;height:auto;">
  <style>
    text { font-family: 'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', 'Microsoft JhengHei', 'SimHei', sans-serif; }
  </style>
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="#2563eb"/>
    </marker>
  </defs>
  <rect width="960" height="760" fill="#ffffff" data-graph-role="background"/>
  <text x="480" y="36" text-anchor="middle" fill="#111827" font-size="18" font-weight="600" data-graph-role="label">Mini Pi Architecture</text>
  <g data-graph-role="node">
    <rect x="240" y="64" width="480" height="88" rx="8" ry="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>
    <rect x="242" y="66" width="5" height="84" rx="2.5" fill="#2563eb"/>
    <text x="480.0" y="92" text-anchor="middle" fill="#111827" font-size="15" font-weight="600">CLI (cli.ts)</text>
    <text x="480.0" y="114" text-anchor="middle" fill="#6b7280" font-size="12.5">Arg parsing · mode select (interactive / one-shot / piped)</text>
    <text x="480.0" y="134" text-anchor="middle" fill="#6b7280" font-size="12.5">Load config &amp; auth · apply CLI overrides</text>
  </g>
  <g data-graph-role="node">
    <rect x="240" y="186" width="480" height="88" rx="8" ry="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>
    <rect x="242" y="188" width="5" height="84" rx="2.5" fill="#2563eb"/>
    <text x="480.0" y="214" text-anchor="middle" fill="#111827" font-size="15" font-weight="600">REPL (repl.ts)</text>
    <text x="480.0" y="236" text-anchor="middle" fill="#6b7280" font-size="12.5">readline UI · slash commands · memory → system prompt</text>
    <text x="480.0" y="256" text-anchor="middle" fill="#6b7280" font-size="12.5">session persistence · streaming render</text>
  </g>
  <g data-graph-role="node">
    <rect x="240" y="308" width="480" height="88" rx="8" ry="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>
    <rect x="242" y="310" width="5" height="84" rx="2.5" fill="#2563eb"/>
    <text x="480.0" y="336" text-anchor="middle" fill="#111827" font-size="15" font-weight="600">Agent (agent.ts)</text>
    <text x="480.0" y="358" text-anchor="middle" fill="#6b7280" font-size="12.5">state (prompt / model / tools / messages) · event system</text>
    <text x="480.0" y="378" text-anchor="middle" fill="#6b7280" font-size="12.5">steering / follow-up queues · lifecycle</text>
  </g>
  <g data-graph-role="node">
    <rect x="240" y="430" width="480" height="88" rx="8" ry="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>
    <rect x="242" y="432" width="5" height="84" rx="2.5" fill="#2563eb"/>
    <text x="480.0" y="458" text-anchor="middle" fill="#111827" font-size="15" font-weight="600">Agent Loop (agent-loop.ts) — the engine</text>
    <text x="480.0" y="480" text-anchor="middle" fill="#6b7280" font-size="12.5">convertToLlm → stream LLM → run tool calls</text>
    <text x="480.0" y="500" text-anchor="middle" fill="#6b7280" font-size="12.5">loop until the model stops</text>
  </g>
  <g data-graph-role="node">
    <rect x="200" y="552" width="250" height="88" rx="8" ry="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>
    <rect x="202" y="554" width="5" height="84" rx="2.5" fill="#9333ea"/>
    <text x="325.0" y="580" text-anchor="middle" fill="#111827" font-size="15" font-weight="600">Provider (provider.ts)</text>
    <text x="325.0" y="602" text-anchor="middle" fill="#6b7280" font-size="12.5">OpenAI-compatible</text>
    <text x="325.0" y="622" text-anchor="middle" fill="#6b7280" font-size="12.5">registerProvider()</text>
  </g>
  <g data-graph-role="node">
    <rect x="510" y="552" width="250" height="88" rx="8" ry="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>
    <rect x="512" y="554" width="5" height="84" rx="2.5" fill="#9333ea"/>
    <text x="635.0" y="580" text-anchor="middle" fill="#111827" font-size="15" font-weight="600">Tools (tools.ts)</text>
    <text x="635.0" y="602" text-anchor="middle" fill="#6b7280" font-size="12.5">read · write · edit</text>
    <text x="635.0" y="622" text-anchor="middle" fill="#6b7280" font-size="12.5">bash · glob · grep</text>
  </g>
  <g data-graph-role="node">
    <rect x="200" y="672" width="250" height="62" rx="8" ry="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>
    <rect x="202" y="674" width="5" height="58" rx="2.5" fill="#6b7280"/>
    <text x="325.0" y="700" text-anchor="middle" fill="#111827" font-size="15" font-weight="600">LLM API</text>
    <text x="325.0" y="722" text-anchor="middle" fill="#6b7280" font-size="12.5">(OpenAI-compatible)</text>
  </g>
  <g data-graph-role="node">
    <rect x="510" y="672" width="250" height="62" rx="8" ry="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>
    <rect x="512" y="674" width="5" height="58" rx="2.5" fill="#6b7280"/>
    <text x="635.0" y="700" text-anchor="middle" fill="#111827" font-size="15" font-weight="600">Project FS</text>
    <text x="635.0" y="722" text-anchor="middle" fill="#6b7280" font-size="12.5">(filesystem)</text>
  </g>
  <line x1="480" y1="152" x2="480" y2="186" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>
  <text x="489" y="173.0" data-graph-role="label" fill="#6b7280" font-size="11.5">new MiniPiREPL(cwd, config, opts)</text>
  <line x1="480" y1="274" x2="480" y2="308" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>
  <text x="489" y="295.0" data-graph-role="label" fill="#6b7280" font-size="12">prompt(input)</text>
  <line x1="480" y1="396" x2="480" y2="430" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>
  <text x="489" y="417.0" data-graph-role="label" fill="#6b7280" font-size="12">runAgentLoop</text>
  <line x1="325" y1="518" x2="325" y2="552" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>
  <text x="334" y="539.0" data-graph-role="label" fill="#6b7280" font-size="12">streamModel</text>
  <line x1="635" y1="518" x2="635" y2="552" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>
  <text x="644" y="539.0" data-graph-role="label" fill="#6b7280" font-size="12">tool.execute</text>
  <line x1="325" y1="640" x2="325" y2="672" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>
  <text x="334" y="660.0" data-graph-role="label" fill="#6b7280" font-size="12">HTTP</text>
  <line x1="635" y1="640" x2="635" y2="672" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>
  <text x="644" y="660.0" data-graph-role="label" fill="#6b7280" font-size="12">FS</text>
</svg>


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

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 850" width="960" height="850" style="width:100%;max-width:960px;height:auto;">
  <style>
    text { font-family: 'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', 'Microsoft JhengHei', 'SimHei', sans-serif; }
  </style>
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="#2563eb"/>
    </marker>
  </defs>
  <rect width="960" height="850" fill="#ffffff" data-graph-role="background"/>
  <text x="480" y="34" text-anchor="middle" fill="#111827" font-size="18" font-weight="600" data-graph-role="label">Mini Pi — Conversation Flow</text>
  <g data-graph-role="node">
    <rect x="220" y="58" width="520" height="68" rx="8" ry="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>
    <rect x="222" y="60" width="5" height="64" rx="2.5" fill="#2563eb"/>
    <text x="480.0" y="84" text-anchor="middle" fill="#111827" font-size="14.5" font-weight="600">You launch mini-pi</text>
  </g>
  <g data-graph-role="node">
    <rect x="220" y="152" width="520" height="68" rx="8" ry="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>
    <rect x="222" y="154" width="5" height="64" rx="2.5" fill="#2563eb"/>
    <text x="480.0" y="178" text-anchor="middle" fill="#111827" font-size="14.5" font-weight="600">It loads your setup</text>
    <text x="480.0" y="198" text-anchor="middle" fill="#6b7280" font-size="12.5">(which AI model, where to save)</text>
  </g>
  <g data-graph-role="node">
    <rect x="220" y="246" width="520" height="68" rx="8" ry="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>
    <rect x="222" y="248" width="5" height="64" rx="2.5" fill="#2563eb"/>
    <text x="480.0" y="272" text-anchor="middle" fill="#111827" font-size="14.5" font-weight="600">You type a message</text>
    <text x="480.0" y="292" text-anchor="middle" fill="#6b7280" font-size="12.5">(a question, or “fix this bug”)</text>
  </g>
  <g data-graph-role="node">
    <rect x="220" y="340" width="520" height="68" rx="8" ry="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>
    <rect x="222" y="342" width="5" height="64" rx="2.5" fill="#2563eb"/>
    <text x="480.0" y="366" text-anchor="middle" fill="#111827" font-size="14.5" font-weight="600">Your message goes to the AI</text>
  </g>
  <g data-graph-role="node">
    <rect x="220" y="434" width="520" height="104" rx="8" ry="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>
    <rect x="222" y="436" width="5" height="100" rx="2.5" fill="#2563eb"/>
    <text x="480.0" y="460" text-anchor="middle" fill="#111827" font-size="14.5" font-weight="600">The AI decides what to do</text>
    <text x="480.0" y="480" text-anchor="middle" fill="#6b7280" font-size="12.5">· answer you directly</text>
    <text x="480.0" y="500" text-anchor="middle" fill="#6b7280" font-size="12.5">· or work first — read files, edit code, run a command, search</text>
    <text x="480.0" y="520" text-anchor="middle" fill="#6b7280" font-size="12.5">· until it’s ready to reply</text>
  </g>
  <g data-graph-role="node">
    <rect x="220" y="564" width="520" height="68" rx="8" ry="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>
    <rect x="222" y="566" width="5" height="64" rx="2.5" fill="#2563eb"/>
    <text x="480.0" y="590" text-anchor="middle" fill="#111827" font-size="14.5" font-weight="600">The answer streams in word by word</text>
    <text x="480.0" y="610" text-anchor="middle" fill="#6b7280" font-size="12.5">(you can interrupt it anytime)</text>
  </g>
  <g data-graph-role="node">
    <rect x="220" y="658" width="520" height="68" rx="8" ry="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>
    <rect x="222" y="660" width="5" height="64" rx="2.5" fill="#2563eb"/>
    <text x="480.0" y="684" text-anchor="middle" fill="#111827" font-size="14.5" font-weight="600">Your conversation is saved</text>
  </g>
  <g data-graph-role="node">
    <rect x="220" y="752" width="520" height="68" rx="8" ry="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>
    <rect x="222" y="754" width="5" height="64" rx="2.5" fill="#2563eb"/>
    <text x="480.0" y="778" text-anchor="middle" fill="#111827" font-size="14.5" font-weight="600">Type /exit to quit</text>
    <text x="480.0" y="798" text-anchor="middle" fill="#6b7280" font-size="12.5">(or come back later and resume)</text>
  </g>
  <line x1="480" y1="126" x2="480" y2="152" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>
  <line x1="480" y1="220" x2="480" y2="246" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>
  <line x1="480" y1="314" x2="480" y2="340" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>
  <line x1="480" y1="408" x2="480" y2="434" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>
  <line x1="480" y1="538" x2="480" y2="564" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>
  <line x1="480" y1="632" x2="480" y2="658" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>
  <line x1="480" y1="726" x2="480" y2="752" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>
</svg>


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
