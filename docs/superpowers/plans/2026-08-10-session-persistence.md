# Session Persistence（会话持久化，Layer 3）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 mini-pi 把每轮对话自动保存到 `~/.mini-pi/sessions/<id>.json`，支持用 `/resume`、`-s/--session` 恢复历史会话继续对话。

**Architecture:** 新增独立的 `SessionManager` 模块（镜像 `MemoryManager` 的文件 I/O 模式）负责会话文件的增删改查；REPL 持有当前会话状态（id/别名/创建时间），在 `agent_end` 与退出时把 `agent.messages` + 模型设置组装成 `SessionFile` 落盘；`/resume` 与 `-s` 启动参数把文件内容还原回 agent 与 config。系统提示词是派生状态，不持久化。

**Tech Stack:** Node.js ≥18 + TypeScript + ESM（`.js` 导入后缀）、`node:fs` 同步 I/O、`tsx` 运行冒烟脚本（项目无测试框架，按 spec §8 用手动冒烟 + faux provider 验证）。

**参考设计文档:** `docs/superpowers/specs/2026-08-10-session-persistence-design.md`

---

## 文件结构

| 文件 | 职责 | 变更 |
|------|------|------|
| `src/types.ts` | 新增 `SessionMeta` / `SessionFile` 类型 | 修改 |
| `src/session.ts` | 新建 `SessionManager`：会话文件增删改查 | 新建 |
| `scripts/smoke-session.ts` | `SessionManager` 单元冒烟（临时目录，离线） | 新建 |
| `scripts/smoke-resume.ts` | 保存→恢复全链路冒烟（Agent + faux provider + 工具结果） | 新建 |
| `src/repl.ts` | 会话状态、自动保存、4 个会话命令、`/clear` 轮换、删除 `/reset` `/quit` | 修改 |
| `src/cli.ts` | 新增 `-s/--session` 参数 | 修改 |
| `src/index.ts` | 导出 `SessionManager` 及会话类型 | 修改 |
| `README.md` | 命令表、CLI 参数、Roadmap | 修改 |

> **对 spec 的两处细化**（已确认，写代码时按这里来）：
> 1. `SessionManager.list()` 返回 `{ sessions: SessionMeta[]; corrupted: number }` 而非裸 `SessionMeta[]` —— spec §7 要求提示 `(N corrupted file(s) skipped)`，数量必须流出 API；返回对象让 REPL 能显示。
> 2. `SessionMeta` 增加可选字段 `title?: string` —— `/sessions` 无别名时的自动标题（取第一条用户消息、截断 24 字符）。由 `list()` 解析完整文件时计算，符合 spec §7「/sessions 全量解析」的已知权衡。

---

## Task 1: 会话类型定义（types.ts）

**Files:**
- Modify: `src/types.ts`（在 `AgentMessage` 定义之后，即第 209 行之后追加）

- [ ] **Step 1: 追加会话类型**

在 `src/types.ts` 末尾（`AgentMessage` 别名与 `AgentContext` 之间的区域，或文件末尾）追加：

```ts
// ─── Session Persistence ─────────────────────────────────────────────────────

export interface SessionMeta {
  version: number;
  id: string;
  alias?: string;
  /** Auto-title from the first user message (computed by SessionManager.list). */
  title?: string;
  cwd: string;
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface SessionFile extends SessionMeta {
  messages: AgentMessage[];
}
```

> `AgentMessage` 与 `ThinkingLevel` 在本文件已定义，`SessionFile.messages` 直接复用运行时消息类型，JSON 无损往返。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出、退出码 0。

- [ ] **Step 3: 提交**

```bash
git add src/types.ts
git commit -m "feat(session): add SessionMeta and SessionFile types"
```

---

## Task 2: SessionManager 模块 + 冒烟脚本

**Files:**
- Create: `src/session.ts`
- Create: `scripts/smoke-session.ts`

- [ ] **Step 1: 新建 `src/session.ts`**

```ts
/**
 * Session Manager — persistent conversation storage for Mini Pi Agent.
 *
 * Stores each conversation as a single JSON file in ~/.mini-pi/sessions/
 * so users can resume previous sessions across restarts. Mirrors the
 * MemoryManager pattern: injectable dir, node:fs sync I/O, silent tolerance.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SessionFile, SessionMeta } from "./types.js";

const DEFAULT_DIR = path.join(os.homedir(), ".mini-pi", "sessions");
const FILE_VERSION = 1;

type RawMeta = SessionMeta & { messages?: unknown };

function isValidMeta(m: unknown): m is SessionMeta {
  if (!m || typeof m !== "object") return false;
  const o = m as RawMeta;
  return (
    typeof o.version === "number" &&
    typeof o.id === "string" &&
    typeof o.cwd === "string" &&
    typeof o.provider === "string" &&
    typeof o.model === "string" &&
    (o.thinkingLevel === "off" || o.thinkingLevel === "low" || o.thinkingLevel === "medium" || o.thinkingLevel === "high") &&
    typeof o.createdAt === "number" &&
    typeof o.updatedAt === "number" &&
    typeof o.messageCount === "number"
  );
}

/** Extract a short title from the first user message, or undefined. */
function deriveTitle(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role !== "user") continue;
    const content = msg.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b: unknown): b is { type: string; text?: string } =>
          !!b && typeof b === "object" && (b as { type?: string }).type === "text" && typeof (b as { text?: unknown }).text === "string")
        .map((b) => (b as { text: string }).text)
        .join(" ");
    }
    text = text.replace(/\s+/g, " ").trim();
    if (!text) return undefined;
    return text.length > 24 ? `${text.slice(0, 24)}…` : text;
  }
  return undefined;
}

export class SessionManager {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_DIR;
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  /** Generate a timestamp ID: YYYYMMDD-HHMMSS. On same-second collision, append -1, -2, … */
  generateId(): string {
    this.ensureDir();
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const base =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    if (!fs.existsSync(this.filePath(base))) return base;
    let suffix = 1;
    while (fs.existsSync(this.filePath(`${base}-${suffix}`))) suffix++;
    return `${base}-${suffix}`;
  }

  /** Save a session (overwrites <id>.json; creates the directory if needed). Returns false on failure. */
  save(session: SessionFile): boolean {
    try {
      this.ensureDir();
      fs.writeFileSync(this.filePath(session.id), JSON.stringify(session, null, 2), "utf-8");
      return true;
    } catch {
      // Serialization failure (e.g. non-serializable toolResult.details) — caller shows a hint.
      return false;
    }
  }

  /** Load a full session (with messages) by id. Returns null if missing or corrupt. */
  load(id: string): SessionFile | null {
    if (!/^\d{8}-\d{6}(-\d+)?$/.test(id)) return null;
    try {
      const file = this.filePath(id);
      if (!fs.existsSync(file)) return null;
      const raw: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (!isValidMeta(raw) || raw.version !== FILE_VERSION || !Array.isArray((raw as RawMeta).messages)) {
        return null;
      }
      return raw as SessionFile;
    } catch {
      return null;
    }
  }

  /**
   * List all sessions (metadata only), newest first by updatedAt.
   * Corrupt / version-mismatched files are skipped and counted.
   */
  list(): { sessions: SessionMeta[]; corrupted: number } {
    const sessions: SessionMeta[] = [];
    let corrupted = 0;
    try {
      this.ensureDir();
      const files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const raw: unknown = JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf-8"));
          if (!isValidMeta(raw) || raw.version !== FILE_VERSION) {
            corrupted++;
            continue;
          }
          const { messages, ...meta } = raw as RawMeta;
          const title = deriveTitle(messages);
          sessions.push({ ...meta, title });
        } catch {
          corrupted++;
        }
      }
    } catch {
      // Directory unreadable — return what we have.
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return { sessions, corrupted };
  }

  /** Delete a session file. Returns true on success. */
  delete(id: string): boolean {
    if (!/^\d{8}-\d{6}(-\d+)?$/.test(id)) return false;
    try {
      const file = this.filePath(id);
      if (!fs.existsSync(file)) return false;
      fs.unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }
}
```

> `tsconfig.json` 的 `include` 只覆盖 `src/**/*`，`tsc --noEmit` 不会编译 `scripts/`；冒烟脚本由 `tsx` 直接运行，类型错误不阻断执行（断言在运行时生效）。

- [ ] **Step 2: 新建 `scripts/smoke-session.ts`**

```ts
/**
 * Smoke test for SessionManager — runs against a temp directory.
 * Usage: npx tsx scripts/smoke-session.ts
 * Exits non-zero on any failed assertion.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../src/session.js";
import type { AgentMessage, SessionFile } from "../src/types.js";

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`✓ ${label}`);
  } else {
    console.error(`✗ FAIL: ${label}`);
    failures++;
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-pi-session-"));
const sm = new SessionManager(dir);
const base: SessionFile = {
  version: 1,
  id: "20260810-120000",
  alias: "smoke",
  cwd: process.cwd(),
  provider: "deepseek",
  model: "deepseek-chat",
  thinkingLevel: "off",
  createdAt: 1,
  updatedAt: 2,
  messageCount: 1,
  messages: [{ role: "user", content: [{ type: "text", text: "Hello world" }], timestamp: 1 }] as AgentMessage[],
};

// 1. generateId shape
const id = sm.generateId();
assert(/^\d{8}-\d{6}(-\d+)?$/.test(id), `generateId shape: ${id}`);

// 2. save / load round-trip
assert(sm.save(base) === true, "save returns true");
const loaded = sm.load(base.id);
assert(loaded !== null, "load returns the session");
assert(loaded?.messages.length === 1, "messages round-trip");
assert(loaded?.messages[0].role === "user", "user message role round-trip");
assert(loaded?.alias === "smoke", "alias round-trip");
assert(JSON.stringify(loaded?.messages) === JSON.stringify(base.messages), "lossless JSON round-trip");

// 3. load missing → null
assert(sm.load("nonexistent") === null, "load missing → null");

// 4. list: newest first, metadata only, title derived
const second: SessionFile = {
  ...base,
  id: "20260810-130000",
  updatedAt: 3,
  messages: [{ role: "user", content: [{ type: "text", text: "This is a very long first message that should definitely get truncated" }], timestamp: 1 }] as AgentMessage[],
};
sm.save(second);
const { sessions, corrupted } = sm.list();
assert(sessions.length === 2, `list has 2 sessions (got ${sessions.length})`);
assert(sessions[0].id === "20260810-130000", "list newest first");
assert(!("messages" in sessions[0]), "list excludes messages");
assert(sessions[0].title === "This is a very long firs…", `title truncated (${sessions[0].title})`);
assert(sessions[1].title === "Hello world", `title from first user message (${sessions[1].title})`);
assert(corrupted === 0, "no corrupted files yet");

// 5. corrupted file skipped + counted
fs.writeFileSync(path.join(dir, "bad.json"), "{ not json", "utf-8");
fs.writeFileSync(path.join(dir, "v99.json"), JSON.stringify({ ...base, id: "v99", version: 99 }), "utf-8");
const after = sm.list();
assert(after.sessions.length === 2, "corrupt + version-mismatch skipped");
assert(after.corrupted === 2, `corrupted count = 2 (got ${after.corrupted})`);
assert(sm.load("bad") === null, "load corrupt → null");
assert(sm.load("v99") === null, "load version-mismatch → null");
assert(sm.load("../etc/passwd") === null, "load rejects path-traversal id");

// 6. delete
assert(sm.delete("20260810-130000") === true, "delete success");
assert(sm.delete("20260810-130000") === false, "delete missing → false");
assert(sm.load("20260810-130000") === null, "deleted session gone");

// 7. title from plain-string content
const strSession: SessionFile = {
  ...base,
  id: "20260810-150000",
  updatedAt: 5,
  messages: [{ role: "user", content: "Plain string hello", timestamp: 1 }] as AgentMessage[],
};
sm.save(strSession);
const titled = sm.list().sessions.find((s) => s.id === "20260810-150000");
assert(titled?.title === "Plain string hello", `title from string content (${titled?.title})`);

// cleanup
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "Done — all passed." : `Done — ${failures} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 3: 运行冒烟脚本**

Run: `npx tsx scripts/smoke-session.ts`
Expected: 全部 `✓`，末尾 `Done — all passed.`，退出码 0。

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出、退出码 0。若 `session.ts` 中 `isThinkingLevel` 报未使用，删掉该函数。

- [ ] **Step 5: 提交**

```bash
git add src/session.ts scripts/smoke-session.ts
git commit -m "feat(session): add SessionManager with smoke test"
```

---

## Task 3: REPL 构造改为 options 对象 + 会话初始化

**Files:**
- Modify: `src/repl.ts`（构造函数 37-90 行、`initProviders` 92-155 行、新增会话方法、`run()` banner 555-571 行）

- [ ] **Step 1: 更新导入与 `MiniPiREPLOptions`**

在 `src/repl.ts` 顶部，把第 10、13 行的导入改为：

```ts
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  SessionFile,
  SessionMeta,
  ToolResultMessage,
} from "./types.js";
import { registerProvider, createOpenAIProvider, createFauxProvider, type FauxResponse } from "./provider.js";
import { SessionManager } from "./session.js";
```

并在类定义前新增 options 接口：

```ts
export interface MiniPiREPLOptions {
  autoRun?: boolean;
  /** Resume a saved session by id on startup. */
  sessionId?: string;
  /** Test seam: pre-set responses for the faux provider (offline smoke testing). */
  fauxResponses?: FauxResponse[];
}
```

- [ ] **Step 2: 新增类字段**

把第 46-47 行的字段区改为：

```ts
  private autoRun = false;
  private memoryManager: MemoryManager;
  private sessionManager: SessionManager;
  private currentSessionId?: string;
  private currentAlias?: string;
  private sessionCreatedAt?: number;
  private resumed = false;
  private fauxResponses?: FauxResponse[];
```

- [ ] **Step 3: 改构造函数签名与主体**

把第 49-52 行改为：

```ts
  constructor(cwd: string, config: ConfigManager, options?: MiniPiREPLOptions) {
    this.cwd = cwd;
    this.config = config;
    this.autoRun = options?.autoRun ?? false;
    this.fauxResponses = options?.fauxResponses;
```

在构造函数第 82 行 `this.agent.subscribe(...)` 之后、`this.rl = readline.createInterface(...)` 之前，插入会话初始化：

```ts
    // Initialize session persistence
    this.sessionManager = new SessionManager();
    this.initializeSession(options?.sessionId);
```

- [ ] **Step 4: `initProviders` 增加 faux 响应注入**

把第 153-154 行的

```ts
    // Always register faux provider for testing
    registerProvider(createFauxProvider());
```

改为：

```ts
    // Always register faux provider for testing
    const faux = createFauxProvider();
    registerProvider(faux);
    if (this.fauxResponses?.length) {
      faux.setResponses(this.fauxResponses);
    }
```

- [ ] **Step 5: 新增会话方法**

在 `resolveModel()` 方法之后（第 215 行后）、`handleAgentEvent` 之前，插入：

```ts
  // ─── Session Persistence ──────────────────────────────────────────────

  private initializeSession(sessionId?: string): void {
    if (sessionId) {
      const sf = this.sessionManager.load(sessionId);
      if (sf) {
        this.applySessionFile(sf);
        this.resumed = true;
        return;
      }
      process.stdout.write(colorize(`Session "${sessionId}" not found, starting a new one.\n`, "yellow"));
    }
    this.startNewSession();
  }

  private startNewSession(): void {
    this.currentSessionId = this.sessionManager.generateId();
    this.currentAlias = undefined;
    this.sessionCreatedAt = Date.now();
  }

  /** Apply a loaded session file to agent + config. Used by startup resume and /resume. */
  private applySessionFile(sf: SessionFile): void {
    this.agent.reset();
    this.agent.messages = sf.messages;
    this.agent.thinkingLevel = sf.thinkingLevel;
    this.config.thinkingLevel = sf.thinkingLevel;
    const model = findBuiltinModel(sf.provider, sf.model);
    if (model) {
      this.agent.model = model;
      this.config.provider = sf.provider;
      this.config.modelId = sf.model;
    } else {
      process.stdout.write(colorize(`Model ${sf.provider}/${sf.model} not found, using current\n`, "yellow"));
    }
    this.currentSessionId = sf.id;
    this.currentAlias = sf.alias;
    this.sessionCreatedAt = sf.createdAt;
  }

  /** Assemble agent + config state into a SessionFile and persist it. */
  private saveCurrentSession(): void {
    if (!this.currentSessionId) return;
    const now = Date.now();
    const session: SessionFile = {
      version: 1,
      id: this.currentSessionId,
      alias: this.currentAlias,
      cwd: this.cwd,
      provider: this.agent.model.provider,
      model: this.agent.model.id,
      thinkingLevel: this.agent.thinkingLevel,
      createdAt: this.sessionCreatedAt ?? now,
      updatedAt: now,
      messageCount: this.agent.messages.length,
      messages: this.agent.messages,
    };
    if (!this.sessionManager.save(session)) {
      // Spec §7: save failure is visible to the user, not silent.
      process.stdout.write(colorize("Warning: could not save session (non-serializable data?).\n", "dim"));
    }
  }
```

> **恢复时同步 config 的说明**：`applySessionFile` 同时更新 `config.provider/modelId/thinkingLevel`，与 `/model` `/provider` `/thinking` 的既有行为（config 与 agent 同步）保持一致，保证 banner、`/config`、后续模型解析不偏离会话设置。副作用是恢复会把该会话的模型写回 config.json —— 这是「还原模型设置」的预期行为（spec §6）。

- [ ] **Step 6: `run()` banner 增加会话行**

把第 566-567 行：

```ts
    process.stdout.write(colorize(`Model: ${this.config.provider}/${this.config.modelId}\n`, "dim"));
    process.stdout.write(colorize(`CWD: ${this.cwd}\n`, "dim"));
```

改为：

```ts
    process.stdout.write(colorize(`Model: ${this.config.provider}/${this.config.modelId}\n`, "dim"));
    process.stdout.write(colorize(`CWD: ${this.cwd}\n`, "dim"));
    if (this.currentSessionId) {
      const label = this.resumed ? `resumed · ${this.agent.messages.length} messages` : "new";
      process.stdout.write(colorize(`Session: ${this.currentSessionId} (${label})\n`, "dim"));
    }
```

- [ ] **Step 7: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出、退出码 0。

- [ ] **Step 8: 提交**

```bash
git add src/repl.ts
git commit -m "feat(session): wire session state into REPL constructor and banner"
```

---

## Task 4: 自动保存（agent_end + 退出）并删除 `/quit`

**Files:**
- Modify: `src/repl.ts`（`handleAgentEvent` 278-281 行、`/quit||/exit` 327-332 行）

- [ ] **Step 1: `agent_end` 时保存**

把 `handleAgentEvent` 中的 `case "agent_end"` 块（第 278-281 行）改为：

```ts
      case "agent_end": {
        this.isStreaming = false;
        if (this.agent.messages.length > 0) this.saveCurrentSession();
        break;
      }
```

> 空消息不落盘（spec §5 空会话不立即写盘）。`agent_end` 也在 `handleRunFailure` 时触发，此时保存的是失败前已累积的消息，属增量保存。

- [ ] **Step 2: `/quit` 删除、`/exit` 退出前保存**

把第 327-332 行的

```ts
    if (trimmed === "/quit" || trimmed === "/exit") {
      process.stdout.write("Goodbye!\n");
      this.running = false;
      this.rl.close();
      return true;
    }
```

改为：

```ts
    if (trimmed === "/exit") {
      if (this.agent.messages.length > 0) this.saveCurrentSession();
      process.stdout.write("Goodbye!\n");
      this.running = false;
      this.rl.close();
      return true;
    }
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出、退出码 0。

- [ ] **Step 4: 提交**

```bash
git add src/repl.ts
git commit -m "feat(session): auto-save on agent_end and exit; drop /quit alias"
```

---

## Task 5: 会话命令 + `/clear` 轮换 + 删除 `/reset` + 更新 `/help`

**Files:**
- Modify: `src/repl.ts`（`handleCommand` 324-551 行）

- [ ] **Step 1: `/clear` 改为完整重置 + 轮换**

把第 361-367 行的

```ts
    if (trimmed === "/clear") {
      console.clear();
      this.agent.messages = [];
      this.agent.clearAllQueues();
      process.stdout.write(colorize("Conversation cleared.\n", "dim"));
      return true;
    }
```

改为：

```ts
    if (trimmed === "/clear") {
      const prevId = this.currentSessionId;
      this.agent.reset();
      console.clear();
      this.startNewSession();
      process.stdout.write(colorize(`Started new session ${this.currentSessionId} (previous: ${prevId})\n`, "dim"));
      return true;
    }
```

- [ ] **Step 2: 删除 `/reset`**

删除第 369-373 行的整个 `/reset` 分支：

```ts
    if (trimmed === "/reset") {
      this.agent.reset();
      process.stdout.write(colorize("Agent state reset.\n", "dim"));
      return true;
    }
```

- [ ] **Step 3: 新增会话命令**

在 `/context` 分支（第 477 行）之后、`// ─── Memory Commands` 注释之前，插入：

```ts
    // ─── Session Commands ───────────────────────────────────────────────

    if (trimmed === "/sessions") {
      const { sessions, corrupted } = this.sessionManager.list();
      if (sessions.length === 0) {
        process.stdout.write(colorize("No sessions yet.\n", "dim"));
      } else {
        process.stdout.write(colorize(`\nSessions:\n`, "bold"));
        for (const s of sessions) {
          const active = s.id === this.currentSessionId ? "▶" : " ";
          const title = s.alias ?? s.title ?? "(no messages)";
          process.stdout.write(
            `  ${colorize(active, "green")} ${colorize(s.id, "cyan")} ${title} · ${s.provider}/${s.model} · ${s.messageCount} msgs · ${formatSessionTime(s.updatedAt)}\n`,
          );
        }
        process.stdout.write(colorize(`  ── ${sessions.length} sessions\n\n`, "dim"));
      }
      if (corrupted > 0) {
        process.stdout.write(colorize(`  (${corrupted} corrupted file(s) skipped)\n`, "dim"));
      }
      return true;
    }

    if (trimmed.startsWith("/resume ")) {
      const id = trimmed.slice("/resume ".length).trim();
      if (!id) {
        process.stdout.write(colorize("Usage: /resume <id>\n", "yellow"));
        return true;
      }
      const sf = this.sessionManager.load(id);
      if (!sf) {
        process.stdout.write(colorize(`Session "${id}" not found.\n`, "red"));
        return true;
      }
      this.applySessionFile(sf);
      process.stdout.write(colorize(`Resumed session ${sf.id} · ${sf.messages.length} messages\n`, "green"));
      return true;
    }

    if (trimmed.startsWith("/session name ")) {
      const name = trimmed.slice("/session name ".length).trim();
      if (!name) {
        process.stdout.write(colorize("Usage: /session name <名字>\n", "yellow"));
        return true;
      }
      this.currentAlias = name;
      this.saveCurrentSession();
      process.stdout.write(colorize(`Session aliased as "${name}"\n`, "green"));
      return true;
    }

    if (trimmed.startsWith("/session delete ")) {
      const id = trimmed.slice("/session delete ".length).trim();
      if (!id) {
        process.stdout.write(colorize("Usage: /session delete <id>\n", "yellow"));
        return true;
      }
      if (id === this.currentSessionId) {
        process.stdout.write(colorize("Cannot delete the current session.\n", "red"));
        return true;
      }
      if (this.sessionManager.delete(id)) {
        process.stdout.write(colorize(`Deleted session ${id}\n`, "green"));
      } else {
        process.stdout.write(colorize(`Session "${id}" not found.\n`, "dim"));
      }
      return true;
    }
```

- [ ] **Step 4: 新增 `formatSessionTime` 模块级工具**

在 `colorize` 函数之后（第 33 行后）加入：

```ts
function formatSessionTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
```

- [ ] **Step 5: 更新 `/help` 文本**

把第 334-358 行的帮助框整体替换为：

```ts
    if (trimmed === "/help") {
      process.stdout.write(colorize(`
╔══════════════════════════════════════════════╗
║         Mini Pi Agent - Commands            ║
╠══════════════════════════════════════════════╣
║ /help            Show this help              ║
║ /exit            Exit the REPL               ║
║ /clear           Reset + start new session   ║
║ /model <name>    Switch model (e.g., gpt-4o) ║
║ /provider <name> Switch provider             ║
║ /thinking <off|low|medium|high>              ║
║ /tokens <num>    Set max tokens              ║
║ /api-key <key>   Set API key                 ║
║ /config          Show current config          ║
║ /tools           List available tools         ║
║ /models          List available models        ║
║ /context         Show context stats           ║
║ /sessions        List saved sessions          ║
║ /resume <id>     Resume a saved session       ║
║ /session name <n> Set session alias          ║
║ /session delete <id> Delete a session        ║
║ /remember k = v  Remember a fact               ║
║ /recall <key>    Recall a fact                ║
║ /forget <key>    Forget a fact                ║
║ /memories [tag]  List stored memories         ║
╚══════════════════════════════════════════════╝
`, "green"));
      return true;
    }
```

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出、退出码 0。

- [ ] **Step 7: 提交**

```bash
git add src/repl.ts
git commit -m "feat(session): add session commands, /clear rotation, drop /reset, update help"
```

---

## Task 6: CLI `-s/--session` 参数

**Files:**
- Modify: `src/cli.ts`（参数解析 72-122 行、三处构造点 153-168 行、帮助文本 17-46 行）

- [ ] **Step 1: 解析 `-s`**

在第 76 行附近新增变量：

```ts
  let sessionId: string | undefined;
```

在 `switch` 中（第 110 行 `-t` 分支后）新增：

```ts
      case "-s":
      case "--session":
        sessionId = args[++i];
        break;
```

- [ ] **Step 2: 三个构造点传 options**

把第 153-168 行的三个构造点改为：

```ts
  if (isInteractive) {
    // Interactive REPL
    const repl = new MiniPiREPL(cwd, config, { sessionId });
    await repl.run();
  } else if (positional.length > 0) {
    // Single prompt mode
    const prompt = positional.join(" ");
    const repl = new MiniPiREPL(cwd, config, { autoRun: true, sessionId });
    // Override argv to include the prompt
    process.argv = process.argv.slice(0, 2).concat(prompt);
    await repl.run();
  } else {
    // Non-interactive (piped), use REPL with first line
    const repl = new MiniPiREPL(cwd, config, { sessionId });
    await repl.run();
  }
```

- [ ] **Step 3: 帮助文本**

在 `printHelp()` 的 `-t, --thinking` 行后新增：

```
  -s, --session <id>    Resume a saved session
```

- [ ] **Step 4: 类型检查 + 帮助验证**

Run: `npx tsc --noEmit`
Expected: 无输出、退出码 0。

Run: `npx tsx src/cli.ts -h`
Expected: 帮助文本含 `-s, --session <id>    Resume a saved session`。

- [ ] **Step 5: 提交**

```bash
git add src/cli.ts
git commit -m "feat(session): add -s/--session CLI flag"
```

---

## Task 7: 公共 API 导出

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 导出会话类型**

在类型导出块（第 8-35 行）中追加：

```ts
  SessionMeta,
  SessionFile,
```

（追加到 `ThinkingLevel` 之后的任意位置即可）

- [ ] **Step 2: 导出 SessionManager**

在 `// REPL` 导出之前新增：

```ts
// Session
export { SessionManager } from "./session.js";
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出、退出码 0。

- [ ] **Step 4: 提交**

```bash
git add src/index.ts
git commit -m "feat(session): export SessionManager and session types"
```

---

## Task 8: 保存→恢复全链路冒烟脚本

**Files:**
- Create: `scripts/smoke-resume.ts`

> 用 Agent + faux provider 跑一轮带工具调用的对话，按 REPL 的组装方式保存成 `SessionFile`，再恢复进一个全新的 Agent，验证「含工具结果的完整上下文」无损往返（spec §8）。

- [ ] **Step 1: 新建 `scripts/smoke-resume.ts`**

```ts
/**
 * Smoke test — save → resume full round-trip with tool results.
 * Usage: npx tsx scripts/smoke-resume.ts
 * Exits non-zero on any failed assertion.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "../src/agent.js";
import { createFauxProvider, registerProvider, fauxAssistantMessage, fauxToolCall } from "../src/provider.js";
import { createDefaultTools } from "../src/tools.js";
import { SessionManager } from "../src/session.js";
import type { Model, SessionFile } from "../src/types.js";

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`✓ ${label}`);
  } else {
    console.error(`✗ FAIL: ${label}`);
    failures++;
  }
}

const FAUX_MODEL: Model = {
  id: "faux-1",
  name: "Faux Model",
  api: "faux",
  provider: "faux",
  baseUrl: "http://localhost:0",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 16384,
};

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-pi-resume-"));
  const sm = new SessionManager(dir);

  const faux = createFauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })]),
    fauxAssistantMessage("Done reading the file."),
  ]);
  registerProvider(faux);

  const agent = new Agent({
    model: FAUX_MODEL,
    tools: createDefaultTools({ cwd: process.cwd() }),
    apiKey: "x",
  });
  await agent.prompt("Read the README for me");

  assert(agent.messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall")), "assistant emitted a tool call");
  assert(agent.messages.some((m) => m.role === "toolResult"), "tool result recorded");

  // Same assembly the REPL's saveCurrentSession() does.
  const sf: SessionFile = {
    version: 1,
    id: "smoke-resume",
    cwd: process.cwd(),
    provider: agent.model.provider,
    model: agent.model.id,
    thinkingLevel: agent.thinkingLevel,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: agent.messages.length,
    messages: agent.messages,
  };
  sm.save(sf);

  const saved = sm.load("smoke-resume");
  assert(saved !== null, "session saved");
  assert(saved!.messageCount === agent.messages.length, "messageCount matches");
  assert(saved!.messages.some((m) => m.role === "toolResult"), "toolResult persisted");
  assert(JSON.stringify(saved!.messages) === JSON.stringify(agent.messages), "lossless round-trip");

  // Resume into a fresh agent.
  const agent2 = new Agent({
    model: FAUX_MODEL,
    tools: createDefaultTools({ cwd: process.cwd() }),
    apiKey: "x",
    thinkingLevel: saved!.thinkingLevel,
    messages: saved!.messages,
  });
  assert(agent2.messages.length === saved!.messages.length, "resume restores messages");
  assert(agent2.messages[0].role === "user", "resume keeps user message first");

  // Agent can continue from the restored context.
  faux.setResponses([fauxAssistantMessage("Continuing after resume.")]);
  await agent2.prompt("Thanks");
  assert(agent2.messages.length > saved!.messages.length, "continue appends after resume");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? "Done — all passed." : `Done — ${failures} FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 2: 运行冒烟脚本**

Run: `npx tsx scripts/smoke-resume.ts`
Expected: 全部 `✓`，末尾 `Done — all passed.`，退出码 0。

- [ ] **Step 3: 提交**

```bash
git add scripts/smoke-resume.ts
git commit -m "test: add save/resume round-trip smoke test"
```

---

## Task 9: README 更新

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 命令表**

把命令表中这三行：

```markdown
| `/quit` or `/exit` | Exit REPL / 退出 |
| `/clear` | Clear conversation history / 清空对话 |
| `/reset` | Reset agent state / 重置 Agent 状态 |
```

改为：

```markdown
| `/exit` | Exit REPL / 退出 |
| `/clear` | Reset and start a new session / 重置并开始新会话 |
```

在 `/context` 行后新增：

```markdown
| `/sessions` | List saved sessions / 列出已保存会话 |
| `/resume <id>` | Resume a saved session / 恢复会话 |
| `/session name <name>` | Alias the current session / 给当前会话命名 |
| `/session delete <id>` | Delete a saved session / 删除会话 |
```

- [ ] **Step 2: CLI 参数表**

在 CLI Options 表（第 187 行 `-t` 行后）新增：

```markdown
| `-s, --session <id>` | Resume a saved session / 恢复已保存的会话 |
```

- [ ] **Step 3: 新增「Session Persistence」小节**

在 `## 🧠 Memory System` 一节之后、`## 🏗 Project Architecture` 之前，新增：

```markdown
## 💾 Session Persistence / 会话持久化

对话自动保存到 `~/.mini-pi/sessions/<id>.json`，支持跨启动恢复上下文。

```bash
>>> /sessions                    # 列出所有会话（最近在前）
>>> /session name 优化登录流程    # 给当前会话命名
>>> /exit                        # 退出时自动保存
```

```bash
mini-pi -s 20260810-152030       # 启动时恢复该会话
```

```bash
>>> /resume 20260810-152030      # REPL 内切换回历史会话
>>> /session delete 20260810-145500   # 删除指定会话（不能删当前会话）
```

每个会话一个 JSON 文件，完整保存 user / assistant / toolResult 消息（含工具结果），并记录 provider、model、thinkingLevel。系统提示词是派生状态，不持久化。
```

- [ ] **Step 4: Roadmap**

把「### ✅ Done / 已完成」改为：

```markdown
### ✅ Done / 已完成

- [x] Layer 1: Explicit memory commands (`/remember`, `/recall`, `/forget`, `/memories`)
- [x] Layer 2: Automatic memory injection into system prompt
- [x] Layer 3: Session persistence
  - Auto-save conversation history to `~/.mini-pi/sessions/`
  - Resume sessions on startup (`-s <id>`) or in-REPL (`/resume <id>`)
  - Session listing, aliasing, and deletion
```

把「### 🚧 Planned / 规划中」中的 Layer 3 条目删除（只留 Layer 4）：

```markdown
### 🚧 Planned / 规划中

- [ ] **Layer 4: Auto-Extraction / 自动事实提取**
  - After each conversation turn, ask the LLM to extract important facts
  - Automatically save extracted facts via `MemoryManager.remember()`
  - Deduplicate and update existing memories
  - Configurable extraction frequency (per-turn, per-session, manual)
```

- [ ] **Step 5: 验证构建**

Run: `npm run build`
Expected: 编译通过，无报错。

- [ ] **Step 6: 提交**

```bash
git add README.md
git commit -m "docs: document session persistence"
```

---

## Task 10: 手动冒烟清单（faux provider + 管道输入）

> 无测试框架，按 spec §8 手动验证。分两块：**命令面**（离线，管道输入即可验证，不触达 provider）与**完整链路**（需要 faux 响应或真实 API key）。

**Files:**
- Create: `scripts/run-repl-faux.ts`（完整链路的离线驱动）

- [ ] **Step 1: 新建 `scripts/run-repl-faux.ts`**

```ts
/**
 * REPL smoke driver — injects preset faux responses so a full chat loop
 * runs offline. Uses a temp config dir so the real ~/.mini-pi/config.json
 * is untouched, and forces provider "faux" so every prompt hits the faux
 * provider (the agent resolves its model from config.provider).
 * Usage:
 *   printf '/sessions\nhello\n/exit\n' | npx tsx scripts/run-repl-faux.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigManager } from "../src/config.js";
import { MiniPiREPL } from "../src/repl.js";
import { fauxAssistantMessage } from "../src/provider.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-pi-repl-faux-"));
const config = new ConfigManager(dir);
config.load();
config.provider = "faux";
config.modelId = "faux-1";

const repl = new MiniPiREPL(process.cwd(), config, {
  fauxResponses: [
    fauxAssistantMessage("Faux reply one."),
    fauxAssistantMessage("Faux reply two."),
  ],
});
await repl.run();

fs.rmSync(dir, { recursive: true, force: true });
```

> `config.provider` / `config.modelId` 的 setter 会 `save()`，因 configDir 指向临时目录，写盘落在 temp，不污染真实配置。

- [ ] **Step 2: 命令面（离线）验证**

Run: `printf '/sessions\n/exit\n' | npx tsx src/cli.ts`
Expected: banner 含 `Session: <id> (new)`；`/sessions` 列出历史会话（若 `~/.mini-pi/sessions/` 已有数据）或 `No sessions yet.`；`/exit` 正常退出。

Run: `printf '/clear\n/session name smoke-test\n/exit\n' | npx tsx src/cli.ts`
Expected: `/clear` 输出 `Started new session <新id> (previous: <旧id>)`；`/session name` 输出 `Session aliased as "smoke-test"`。

Run: `printf '/session delete <该会话id>\n/sessions\n/exit\n' | npx tsx src/cli.ts`
Expected: `/session delete` 输出 `Deleted session <id>`（当前会话会输出 `Cannot delete the current session.`）。

Run: `printf '/reset\n/quit\n' | npx tsx src/cli.ts`
Expected: `Unknown command: /reset` 与 `Unknown command: /quit`（两命令已删除）。

- [ ] **Step 3: 完整链路（离线）验证**

Run: `printf '/sessions\nhello\n/exit\n' | npx tsx scripts/run-repl-faux.ts`
Expected:
1. banner 显示 `Model: faux/faux-1` 与 `Session: <id> (new)`；
2. 发送 `hello` → faux 回复 `Faux reply one.`；
3. 该轮 `agent_end` 后自动保存，文件出现在 `~/.mini-pi/sessions/<id>.json`；
4. `/sessions` 列出该会话，`[▶]` 标记当前会话；
5. `/exit` 退出。

检查文件内容：`cat ~/.mini-pi/sessions/<id>.json`，确认含 user + assistant 两条消息、`messageCount: 2`、正确的 `provider/model/thinkingLevel`。

- [ ] **Step 4: 恢复验证（离线）**

Run: `printf '/resume <id>\nhello\n/exit\n' | npx tsx scripts/run-repl-faux.ts`
Expected:
1. `/resume <id>` 输出 `Resumed session <id> · 2 messages`；
2. 下一轮 `hello` 后，该文件被写回（更新 `updatedAt`、`messageCount` 增加），上下文连贯；
3. `/sessions` 中该会话排在最前（updatedAt 最新）。

Run: `printf '/resume does-not-exist\n/exit\n' | npx tsx scripts/run-repl-faux.ts`
Expected: 输出 `Session "does-not-exist" not found.`。

- [ ] **Step 5: 启动恢复验证（离线）**

Run: `printf 'hello\n/exit\n' | npx tsx src/cli.ts -s <id>`（用 Step 3 生成的 id）
Expected: banner 显示 `Session: <id> resumed · N messages`；`hello` 走真实配置的 provider（如无 key 则报错属预期，不影响会话逻辑）。

- [ ] **Step 6: 交互式完整验证（可选，需要真实 API key）**

Run: `npx tsx src/cli.ts`
Expected:
1. 正常对话几轮（含一次工具调用，如「读一下 README.md」）；
2. `/session name 冒烟会话` 命名；
3. `/sessions` 看到当前会话带别名；
4. `/exit` 后 `cat ~/.mini-pi/sessions/<id>.json` 确认消息完整；
5. 重启 `npx tsx src/cli.ts -s <id>`，确认上下文恢复、能基于旧上下文继续提问。

- [ ] **Step 7: 边界验证**

Run: `printf '/session name 空会话\n/exit\n' | npx tsx src/cli.ts`
Expected: 直接命名后退出，`~/.mini-pi/sessions/` 下生成一个仅含元数据 + 0 条消息的文件（别名已持久化）。若不需要可 `/session delete <id>` 清理。

同秒撞 ID：`/clear` 快速连按两次，观察两个会话 id 不同（正常情况下一为 `YYYYMMDD-HHMMSS`、一为 `-1` 后缀）。

损坏文件：手动往 `~/.mini-pi/sessions/` 写一个 `bad.json`（内容 `{ not json`），再 `/sessions`，确认该文件被跳过并提示 `(1 corrupted file(s) skipped)`。

- [ ] **Step 8: 清理 + 提交**

Run: `printf '/session delete smoke-test\n/session delete <各测试id>\n/exit\n' | npx tsx src/cli.ts`（清理测试产生的会话）

```bash
git add scripts/run-repl-faux.ts
git commit -m "test: add REPL faux-provider smoke driver"
```

---

## Self-Review（写完后核对）

**Spec 覆盖：**

| spec 需求 | 对应任务 |
|-----------|---------|
| §3 文件格式 / 类型 | Task 1、2 |
| §4 SessionManager API（generateId/save/load/list/delete） | Task 2 |
| §5 新增命令 `/sessions` `/resume` `/session name` `/session delete` | Task 5 |
| §5 `/clear` 合并 + `/reset` 删除 | Task 5 |
| §5 `/quit` 删除保留 `/exit` | Task 4 |
| §5 CLI `-s/--session` | Task 6 |
| §6 构造签名 options 对象 | Task 3、6 |
| §6 自动保存（agent_end + 退出） | Task 4 |
| §6 `/resume` 还原实现 | Task 3（applySessionFile）、5 |
| §6 banner 会话显示 | Task 3 |
| §7 边界表（损坏/版本/模型回退/撞ID/空会话/删当前/序列化失败） | Task 2（损坏/版本）、5（删当前）、10（撞ID/空会话/损坏/模型回退） |
| §8 冒烟测试（含工具结果 / resume / clear 轮换 / 损坏跳过） | Task 2、8、10 |
| §9 不做列表（--sessions、/session save|load、index.json、截断、测试框架） | 全程未实现 |

**类型一致性检查：**
- `SessionManager.list()` 返回 `{ sessions: SessionMeta[]; corrupted: number }` —— Task 2 定义，Task 5 `/sessions` 解构使用，Task 2 冒烟断言使用，全计划一致。
- `saveCurrentSession()` 组装 `SessionFile` 字段顺序与 `SessionFile` 定义一致。
- `applySessionFile()` 在 Task 3 定义，Task 5 `/resume` 调用，签名一致。
- `formatSessionTime` 在 Task 5 定义，Task 5 `/sessions` 调用。
- 构造函数三处 `new MiniPiREPL(cwd, config, { sessionId })` 与 `MiniPiREPLOptions` 匹配。

**占位符扫描：** 无 TBD/TODO；每步含完整代码与预期输出。
