/**
 * Interactive REPL (Read-Eval-Print Loop) for Mini Pi Agent.
 * Provides a command-line chat interface with streaming responses.
 */

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentOptions } from "./agent.js";
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  SessionFile,
  SessionMeta,
  ToolResultMessage,
} from "./types.js";
import { createDefaultTools, createCodingTools } from "./tools.js";
import { ConfigManager, BUILTIN_MODELS, findBuiltinModel } from "./config.js";
import { registerProvider, createOpenAIProvider, createFauxProvider, type FauxResponse } from "./provider.js";
import { SessionManager } from "./session.js";
import { MemoryManager } from "./memory.js";

// ─── Colors ──────────────────────────────────────────────────────────────────

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

function colorize(text: string, color: keyof typeof colors): string {
  return `${colors[color]}${text}${colors.reset}`;
}

function formatSessionTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── REPL ───────────────────────────────────────────────────────────────────

export interface MiniPiREPLOptions {
  autoRun?: boolean;
  /** Resume a saved session by id on startup. */
  sessionId?: string;
  /** Test seam: pre-set responses for the faux provider (offline smoke testing). */
  fauxResponses?: FauxResponse[];
  /**
   * Test seam: stream faux responses at this rate so the REPL actually sees
   * incremental deltas (the real providers deliver content over time). Without
   * it the faux provider emits every chunk in one synchronous burst and the
   * streaming-render path is never exercised.
   */
  fauxTokensPerSecond?: number;
}

export class MiniPiREPL {
  private agent: Agent;
  private config: ConfigManager;
  private rl: readline.ReadLine;
  private cwd: string;
  private running = false;
  private abortController: AbortController | null = null;
  private isStreaming = false;
  /** Streaming state per block of the current assistant message: body chars shown + decorative suffix emitted. */
  private streamState: { bodyShown: number; suffixDone: boolean }[] = [];
  private autoRun = false;
  private memoryManager: MemoryManager;
  private sessionManager: SessionManager;
  private currentSessionId?: string;
  private currentAlias?: string;
  private sessionCreatedAt?: number;
  private resumed = false;
  private fauxResponses?: FauxResponse[];
  private fauxTokensPerSecond?: number;
  /** Piped (non-TTY) input handling — readline delivers all lines at once, so buffer and drain them. */
  private pipedLines: string[] | null = null;
  private pipedWaiters: Array<(line: string | null) => void> = [];
  private pipedClosed = false;

  constructor(cwd: string, config: ConfigManager, options?: MiniPiREPLOptions) {
    this.cwd = cwd;
    this.config = config;
    this.autoRun = options?.autoRun ?? false;
    this.fauxResponses = options?.fauxResponses;
    this.fauxTokensPerSecond = options?.fauxTokensPerSecond;

    // Initialize providers
    this.initProviders();

    // Create tools
    const tools = createDefaultTools({ cwd });

    // Initialize memory
    this.memoryManager = new MemoryManager();
    this.memoryManager.load();

    // Build system prompt (with memories if any)
    const systemPrompt = this.buildSystemPromptWithMemories();

    // Get model
    const model = this.resolveModel();

    // Create agent
    this.agent = new Agent({
      systemPrompt,
      model,
      thinkingLevel: config.thinkingLevel,
      tools,
      apiKey: config.getApiKey(config.provider),
      maxTokens: config.maxTokens,
      toolExecution: config.toolExecution,
    });

    // Subscribe to agent events for display
    this.agent.subscribe((event) => this.handleAgentEvent(event));

    // Initialize session persistence
    this.sessionManager = new SessionManager();
    this.initializeSession(options?.sessionId);

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "",
      terminal: true,
    });

    // Piped (non-TTY) input arrives all at once; rl.question() would only ever
    // consume the first line. Buffer every line and drain it in getInput().
    if (!process.stdin.isTTY) {
      this.pipedLines = [];
      this.rl.on("line", (line: string) => {
        const waiter = this.pipedWaiters.shift();
        if (waiter) waiter(line);
        else this.pipedLines!.push(line);
      });
      this.rl.on("close", () => {
        this.pipedClosed = true;
        const waiter = this.pipedWaiters.shift();
        if (waiter) waiter(null);
      });
    }
  }

  private initProviders(): void {
    // Register built-in OpenAI provider
    const openaiKey = this.config.getApiKey("openai");
    if (openaiKey) {
      registerProvider(createOpenAIProvider({
        id: "openai",
        name: "OpenAI",
        apiKey: openaiKey,
        baseUrl: "https://api.openai.com/v1",
        models: BUILTIN_MODELS.filter((m) => m.provider === "openai"),
      }));
    }

    // Register anthropic provider (OpenAI-compatible)
    const anthropicKey = this.config.getApiKey("anthropic");
    if (anthropicKey) {
      registerProvider(createOpenAIProvider({
        id: "anthropic",
        name: "Anthropic",
        apiKey: anthropicKey,
        baseUrl: this.config.baseUrl ?? "https://api.anthropic.com/v1",
        models: BUILTIN_MODELS.filter((m) => m.provider === "anthropic"),
      }));
    }

    // Register deepseek provider
    const deepseekKey = this.config.getApiKey("deepseek");
    if (deepseekKey) {
      registerProvider(createOpenAIProvider({
        id: "deepseek",
        name: "DeepSeek",
        apiKey: deepseekKey,
        baseUrl: "https://api.deepseek.com/v1",
        models: BUILTIN_MODELS.filter((m) => m.provider === "deepseek"),
      }));
    }

    // Register google provider
    const googleKey = this.config.getApiKey("google");
    if (googleKey) {
      registerProvider(createOpenAIProvider({
        id: "google",
        name: "Google Gemini",
        apiKey: googleKey,
        baseUrl: this.config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta/openai",
        models: BUILTIN_MODELS.filter((m) => m.provider === "google"),
      }));
    }

    // Register openrouter provider
    const openrouterKey = this.config.getApiKey("openrouter");
    if (openrouterKey) {
      registerProvider(createOpenAIProvider({
        id: "openrouter",
        name: "OpenRouter",
        apiKey: openrouterKey,
        baseUrl: "https://openrouter.ai/api/v1",
        models: BUILTIN_MODELS.filter((m) => m.provider === "openrouter"),
      }));
    }

    // Always register faux provider for testing
    const faux = createFauxProvider(this.fauxTokensPerSecond ? { tokensPerSecond: this.fauxTokensPerSecond } : {});
    registerProvider(faux);
    if (this.fauxResponses?.length) {
      faux.setResponses(this.fauxResponses);
    }
  }

  private buildSystemPrompt(): string {
    const basePrompt = this.config.systemPrompt;
    const tools = createCodingTools({ cwd: this.cwd });
    const toolDescriptions = tools
      .map((t) => `- \`${t.name}\`: ${t.description.split(".")[0]}.`)
      .join("\n");

    return `${basePrompt}

You have access to the following tools:
${toolDescriptions}

You can use these tools by responding with tool calls. The available tools allow you to:
- Read files (read)
- Write files (write)
- Edit files with precise text replacement (edit)
- Execute shell commands (bash)
- Search file contents with regex (grep)
- Find files by glob pattern (glob)

Guidelines:
- Use "read" to view file contents before editing
- Use "bash" to run tests, build, or explore the project
- Use "grep" to search for patterns in code
- Use "glob" to find files by name patterns
- Be concise but thorough
- Show file paths when referencing code`;
  }

  /** Build system prompt with persistent memories injected (Layer 2). */
  private buildSystemPromptWithMemories(): string {
    const base = this.buildSystemPrompt();
    const memories = this.memoryManager.format();
    return memories ? `${base}\n${memories}` : base;
  }

  private resolveModel() {
    const provider = this.config.provider;
    const modelId = this.config.modelId;
    const found = findBuiltinModel(provider, modelId);

    if (found) {
      return found;
    }

    // Custom/fallback model
    return {
      id: modelId,
      name: modelId,
      api: "openai-completions" as const,
      provider,
      baseUrl: this.config.baseUrl ?? `https://api.${provider}.com/v1`,
      reasoning: this.config.thinkingLevel !== "off",
      input: ["text", "image"] as ("text" | "image")[],
      cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
      contextWindow: 128000,
      maxTokens: this.config.maxTokens,
    };
  }

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

  private usedIds = new Set<string>();

  private startNewSession(): void {
    if (this.currentSessionId) this.usedIds.add(this.currentSessionId);
    this.currentSessionId = this.sessionManager.generateId(this.usedIds);
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

  // ─── Agent Event Handler ──────────────────────────────────────────────

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          this.isStreaming = true;
          this.streamState = [];
        }
        break;

      case "message_update": {
        this.emitStreamUpdate(event.message);
        break;
      }

      case "message_end":
        if (event.message.role === "assistant") {
          this.isStreaming = false;
          // Flush any content not yet streamed, then terminate the streaming line.
          this.finishStream(event.message as AssistantMessage);
          if (this.streamState.length > 0) {
            process.stdout.write("\n\n");
          }
          this.streamState = [];
        } else if (event.message.role === "toolResult") {
          const tr = event.message as ToolResultMessage;
          const toolContent = tr.content.map((c) => c.type === "text" ? c.text : "[image]").join("\n");
          const lines = toolContent.split("\n");
          const displayLines = lines.length > 20
            ? lines.slice(0, 20).join("\n") + colorize(`\n... (${lines.length - 20} more lines)`, "dim")
            : toolContent;

          process.stdout.write(colorize(displayLines, "dim") + "\n\n");
        }
        break;

      case "tool_execution_start": {
        process.stdout.write(
          colorize(`  🛠 ${event.toolName}(${JSON.stringify(event.args).slice(0, 80)}...)\n`, "yellow")
        );
        break;
      }

      case "tool_execution_end": {
        const status = event.isError ? "✗" : "✓";
        const color: keyof typeof colors = event.isError ? "red" : "green";
        process.stdout.write(colorize(`  ${status} ${event.toolName} completed\n`, color));
        break;
      }

      case "turn_start": {
        if (!this.isStreaming) {
          process.stdout.write(colorize("\n─── Turn ───\n", "bold"));
        }
        break;
      }

      case "agent_end": {
        this.isStreaming = false;
        if (this.agent.messages.length > 0) this.saveCurrentSession();
        break;
      }
    }
  }

  /** Build the displayable blocks of an assistant message (text + thinking). */
  private streamBlocks(msg: AssistantMessage): { prefix: string; body: string; suffix: string; color: keyof typeof colors }[] {
    return msg.content
      .filter((b) => b.type === "text" || b.type === "thinking")
      .map((b): { prefix: string; body: string; suffix: string; color: keyof typeof colors } =>
        b.type === "text"
          ? { prefix: "", body: b.text, suffix: "", color: "cyan" }
          : { prefix: "[thinking: ", body: b.thinking.slice(0, 100), suffix: "...]", color: "dim" }
      );
  }

  /**
   * Incrementally emit the display text for an assistant message, printing only
   * the portion not shown yet. Static decorations (`[thinking: ` / `...]`) are
   * emitted once per block; only the growing body is streamed. Appends per block
   * — no ANSI cursor control — so it renders correctly in every terminal.
   */
  private emitStreamUpdate(msg: AssistantMessage): void {
    const blocks = this.streamBlocks(msg);
    for (let i = 0; i < blocks.length; i++) {
      let st = this.streamState[i];
      if (!st) {
        if (i > 0) process.stdout.write("\n");
        if (blocks[i].prefix) process.stdout.write(colorize(blocks[i].prefix, blocks[i].color));
        st = this.streamState[i] = { bodyShown: 0, suffixDone: false };
      }
      const block = blocks[i];
      if (block.body.length > st.bodyShown) {
        process.stdout.write(colorize(block.body.slice(st.bodyShown), block.color));
        st.bodyShown = block.body.length;
      }
      // A block followed by another is complete — close its decorative suffix now.
      if (i < blocks.length - 1 && !st.suffixDone) {
        if (block.suffix) process.stdout.write(colorize(block.suffix, block.color));
        st.suffixDone = true;
      }
    }
  }

  /** Flush remaining streaming content and close the final block's decorative suffix. */
  private finishStream(msg: AssistantMessage): void {
    this.emitStreamUpdate(msg);
    const blocks = this.streamBlocks(msg);
    const i = blocks.length - 1;
    if (i >= 0) {
      const st = this.streamState[i];
      const block = blocks[i];
      if (st && !st.suffixDone && block.suffix) {
        process.stdout.write(colorize(block.suffix, block.color));
        st.suffixDone = true;
      }
    }
  }

  // ─── Commands ─────────────────────────────────────────────────────────

  private async handleCommand(input: string): Promise<boolean> {
    const trimmed = input.trim();

    if (trimmed === "/exit") {
      if (this.agent.messages.length > 0) this.saveCurrentSession();
      process.stdout.write("Goodbye!\n");
      this.running = false;
      this.rl.close();
      return true;
    }

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

    if (trimmed === "/clear") {
      const prevId = this.currentSessionId;
      this.agent.reset();
      console.clear();
      this.startNewSession();
      process.stdout.write(colorize(`Started new session ${this.currentSessionId} (previous: ${prevId})\n`, "dim"));
      return true;
    }

    if (trimmed.startsWith("/model ")) {
      const modelId = trimmed.slice(7).trim();
      if (modelId) {
        const model = findBuiltinModel(this.config.provider, modelId) ?? {
          ...BUILTIN_MODELS[0],
          id: modelId,
          name: modelId,
        };
        this.agent.model = model;
        this.config.modelId = modelId;
        process.stdout.write(colorize(`Switched to model: ${modelId}\n`, "green"));
      }
      return true;
    }

    if (trimmed.startsWith("/provider ")) {
      const provider = trimmed.slice(10).trim();
      if (provider) {
        this.config.provider = provider;
        const model = this.resolveModel();
        this.agent.model = model;
        process.stdout.write(colorize(`Switched provider to: ${provider}\n`, "green"));
      }
      return true;
    }

    if (trimmed.startsWith("/thinking ")) {
      const level = trimmed.slice(10).trim() as "off" | "low" | "medium" | "high";
      if (["off", "low", "medium", "high"].includes(level)) {
        this.agent.thinkingLevel = level;
        this.config.thinkingLevel = level;
        process.stdout.write(colorize(`Thinking level set to: ${level}\n`, "green"));
      } else {
        process.stdout.write(colorize("Valid levels: off, low, medium, high\n", "red"));
      }
      return true;
    }

    if (trimmed.startsWith("/tokens ")) {
      const num = parseInt(trimmed.slice(8).trim(), 10);
      if (!isNaN(num) && num > 0) {
        this.agent.maxTokens = num;
        this.config.maxTokens = num;
        process.stdout.write(colorize(`Max tokens set to: ${num}\n`, "green"));
      }
      return true;
    }

    if (trimmed.startsWith("/api-key ")) {
      const key = trimmed.slice(9).trim();
      if (key) {
        this.config.setApiKey(this.config.provider, key);
        this.agent.apiKey = key;
        process.stdout.write(colorize("API key saved.\n", "green"));
      }
      return true;
    }

    if (trimmed === "/config") {
      process.stdout.write(colorize(`\nCurrent Configuration:\n`, "bold"));
      process.stdout.write(`  Provider:      ${this.config.provider}\n`);
      process.stdout.write(`  Model:         ${this.config.modelId}\n`);
      process.stdout.write(`  Thinking:      ${this.config.thinkingLevel}\n`);
      process.stdout.write(`  Max Tokens:    ${this.config.maxTokens}\n`);
      process.stdout.write(`  Base URL:      ${this.config.baseUrl ?? "(default)"}\n`);
      process.stdout.write(`  API Key:       ${this.config.hasApiKey(this.config.provider) ? "✓ configured" : "✗ not set"}\n`);
      process.stdout.write(`  Messages:      ${this.agent.messages.length}\n`);
      return true;
    }

    if (trimmed === "/tools") {
      process.stdout.write(colorize(`\nAvailable Tools:\n`, "bold"));
      for (const tool of this.agent.tools) {
        process.stdout.write(`  ${colorize(tool.name, "green")}: ${tool.description.split(".")[0]}.\n`);
      }
      return true;
    }

    if (trimmed === "/models") {
      process.stdout.write(colorize(`\nBuilt-in Models:\n`, "bold"));
      const current = `${this.config.provider}/${this.config.modelId}`;
      for (const model of BUILTIN_MODELS) {
        const prefix = `${model.provider}/${model.id}` === current ? "▶ " : "  ";
        const thinking = model.reasoning ? " (thinking)" : "";
        process.stdout.write(`  ${prefix}${model.provider}/${model.id}${thinking}\n`);
      }
      return true;
    }

    if (trimmed === "/context") {
      const msgs = this.agent.messages;
      const userMsgs = msgs.filter((m) => m.role === "user").length;
      const assistantMsgs = msgs.filter((m) => m.role === "assistant").length;
      const toolMsgs = msgs.filter((m) => m.role === "toolResult").length;
      process.stdout.write(colorize(`\nContext Stats:\n`, "bold"));
      process.stdout.write(`  Total messages:  ${msgs.length}\n`);
      process.stdout.write(`  User messages:   ${userMsgs}\n`);
      process.stdout.write(`  Assistant msgs:  ${assistantMsgs}\n`);
      process.stdout.write(`  Tool results:    ${toolMsgs}\n`);
      process.stdout.write(`  Is streaming:    ${this.agent.isStreaming}\n`);
      process.stdout.write(`  Pending tools:   ${this.agent.pendingToolCalls.size}\n`);
      return true;
    }

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

    // ─── Memory Commands ────────────────────────────────────────────────

    if (trimmed.startsWith("/remember ")) {
      // Parse: /remember key = value
      const rest = trimmed.slice(10).trim();
      const eqIdx = rest.indexOf("=");
      if (eqIdx === -1) {
        process.stdout.write(colorize("Usage: /remember <key> = <value>\n", "yellow"));
        return true;
      }
      const key = rest.slice(0, eqIdx).trim();
      const value = rest.slice(eqIdx + 1).trim();
      if (!key || !value) {
        process.stdout.write(colorize("Usage: /remember <key> = <value>\n", "yellow"));
        return true;
      }
      this.memoryManager.remember(key, value);
      process.stdout.write(colorize(`✓ Remembered "${key}"\n`, "green"));
      return true;
    }

    if (trimmed.startsWith("/recall ")) {
      const key = trimmed.slice(8).trim();
      if (!key) {
        process.stdout.write(colorize("Usage: /recall <key>\n", "yellow"));
        return true;
      }
      const entry = this.memoryManager.recall(key);
      if (entry) {
        const tagStr = entry.tags.length > 0 ? colorize(` (${entry.tags.join(", ")})`, "dim") : "";
        process.stdout.write(`  ${colorize(entry.key, "green")}${tagStr}\n`);
        process.stdout.write(`  ${entry.value}\n`);
      } else {
        process.stdout.write(colorize(`No memory found for "${key}"\n`, "dim"));
      }
      return true;
    }

    if (trimmed.startsWith("/forget ")) {
      const key = trimmed.slice(8).trim();
      if (!key) {
        process.stdout.write(colorize("Usage: /forget <key>\n", "yellow"));
        return true;
      }
      if (this.memoryManager.forget(key)) {
        process.stdout.write(colorize(`✓ Forgotten "${key}"\n`, "green"));
      } else {
        process.stdout.write(colorize(`No memory found for "${key}"\n`, "dim"));
      }
      return true;
    }

    if (trimmed === "/memories" || trimmed.startsWith("/memories ")) {
      const tag = trimmed.length > 10 ? trimmed.slice(10).trim() : undefined;
      const entries = this.memoryManager.list(tag);

      if (entries.length === 0) {
        process.stdout.write(colorize(tag ? `No memories with tag "${tag}"\n` : "No memories yet. Use /remember to add some.\n", "dim"));
        return true;
      }

      process.stdout.write(colorize(`\nMemories${tag ? ` (tag: ${tag})` : ""}:\n`, "bold"));
      for (const e of entries) {
        const tagStr = e.tags.length > 0 ? colorize(` [${e.tags.join(", ")}]`, "dim") : "";
        process.stdout.write(`  ${colorize(e.key, "green")}${tagStr}\n`);
        process.stdout.write(`    ${e.value}\n`);
      }
      process.stdout.write(colorize(`  ── ${entries.length} entries\n\n`, "dim"));
      return true;
    }

    return false; // Not a command, treat as prompt
  }

  // ─── Main Loop ────────────────────────────────────────────────────────

  async run(): Promise<void> {
    this.running = true;

    // Show startup banner
    process.stdout.write(colorize(`
╔═══════════════════════════════════╗
║  🤖 Mini Pi Agent v0.1.0         ║
║  Type /help for commands          ║
╚═══════════════════════════════════╝
`, "green"));

    process.stdout.write(colorize(`Model: ${this.config.provider}/${this.config.modelId}\n`, "dim"));
    process.stdout.write(colorize(`CWD: ${this.cwd}\n`, "dim"));
    if (this.currentSessionId) {
      const label = this.resumed ? `resumed · ${this.agent.messages.length} messages` : "new";
      process.stdout.write(colorize(`Session: ${this.currentSessionId} (${label})\n`, "dim"));
    }
    if (this.memoryManager.count > 0) {
      process.stdout.write(colorize(`Memory: ${this.memoryManager.count} facts loaded\n`, "dim"));
    }
    process.stdout.write("\n");

    // If auto-run with initial prompt
    if (this.autoRun && process.argv.slice(2).length > 0) {
      const prompt = process.argv.slice(2).join(" ");
      if (prompt && !prompt.startsWith("/")) {
        process.stdout.write(colorize(`\n  Prompt: ${prompt}\n`, "yellow"));
        await this.sendPrompt(prompt);
      }
    }

    // Main input loop
    while (this.running) {
      const input = await this.getInput();

      if (!input) continue;

      // Check for commands
      if (input.startsWith("/")) {
        const handled = await this.handleCommand(input);
        if (!handled && this.running) {
          process.stdout.write(colorize(`Unknown command: ${input}\n`, "red"));
        }
        continue;
      }

      // Send as prompt
      await this.sendPrompt(input);
    }
  }

  private getInput(): Promise<string> {
    if (this.pipedLines) {
      // Piped input: drain buffered lines in order; wait if none buffered yet.
      if (this.pipedLines.length > 0) {
        return Promise.resolve(this.pipedLines.shift()!);
      }
      if (this.pipedClosed) {
        this.running = false;
        return Promise.resolve("");
      }
      return new Promise((resolve) => {
        this.pipedWaiters.push((line) => resolve(line ?? ""));
      });
    }
    const prompt = colorize("\n>>> ", "green");
    return new Promise((resolve) => {
      this.rl.question(prompt, (answer) => {
        resolve(answer);
      });
    });
  }

  private async sendPrompt(input: string): Promise<void> {
    try {
      // Refresh system prompt with latest memories before each prompt
      this.agent.systemPrompt = this.buildSystemPromptWithMemories();
      await this.agent.prompt(input);
    } catch (err) {
      if (err instanceof Error && err.message.includes("already processing")) {
        // Queue as steering message
        this.agent.steer({ role: "user", content: input, timestamp: Date.now() });
        process.stdout.write(colorize("(queued as steering message)\n", "yellow"));
      } else {
        process.stdout.write(colorize(`Error: ${err instanceof Error ? err.message : String(err)}\n`, "red"));
      }
    }
  }
}
