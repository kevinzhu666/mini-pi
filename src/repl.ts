/**
 * Interactive REPL (Read-Eval-Print Loop) for Mini Pi Agent.
 * Provides a command-line chat interface with streaming responses.
 */

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentOptions } from "./agent.js";
import type { AgentEvent, AgentMessage, AssistantMessage, ToolResultMessage } from "./types.js";
import { createDefaultTools, createCodingTools } from "./tools.js";
import { ConfigManager, BUILTIN_MODELS, findBuiltinModel } from "./config.js";
import { registerProvider, createOpenAIProvider, createFauxProvider } from "./provider.js";

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

// ─── REPL ───────────────────────────────────────────────────────────────────

export class MiniPiREPL {
  private agent: Agent;
  private config: ConfigManager;
  private rl: readline.ReadLine;
  private cwd: string;
  private running = false;
  private abortController: AbortController | null = null;
  private isStreaming = false;
  private currentLines: string[] = [];
  private autoRun = false;

  constructor(cwd: string, config: ConfigManager, autoRun?: boolean) {
    this.cwd = cwd;
    this.config = config;
    this.autoRun = autoRun ?? false;

    // Initialize providers
    this.initProviders();

    // Create tools
    const tools = createDefaultTools({ cwd });

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt();

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

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "",
      terminal: true,
    });
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
    registerProvider(createFauxProvider());
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

  // ─── Agent Event Handler ──────────────────────────────────────────────

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          this.isStreaming = true;
          this.currentLines = [];
        }
        break;

      case "message_update": {
        const content = this.getDisplayText(event.message);
        // Clear current line and rewrite
        this.clearStreamingLine();
        this.currentLines = this.wrapText(content);
        this.printStreamingLine();
        break;
      }

      case "message_end":
        if (event.message.role === "assistant") {
          this.isStreaming = false;
          const content = this.getDisplayText(event.message as AssistantMessage);
          this.clearStreamingLine();
          if (content) {
            process.stdout.write(colorize(content, "cyan") + "\n\n");
          }
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
        break;
      }
    }
  }

  private getDisplayText(msg: AssistantMessage): string {
    return msg.content
      .filter((b) => b.type === "text" || b.type === "thinking")
      .map((b) => b.type === "text" ? b.text : colorize(`[thinking: ${b.thinking.slice(0, 100)}...]`, "dim"))
      .join("\n");
  }

  private clearStreamingLine(): void {
    for (let i = 0; i < this.currentLines.length; i++) {
      readline.moveCursor(process.stdout, 0, -1);
      readline.clearLine(process.stdout, 0);
    }
  }

  private printStreamingLine(): void {
    for (const line of this.currentLines) {
      process.stdout.write(colorize(line, "cyan") + "\n");
    }
  }

  private wrapText(text: string): string[] {
    const width = process.stdout.columns || 80;
    const lines: string[] = [];
    for (const line of text.split("\n")) {
      if (line.length <= width) {
        lines.push(line);
      } else {
        let remaining = line;
        while (remaining.length > 0) {
          lines.push(remaining.slice(0, width));
          remaining = remaining.slice(width);
        }
      }
    }
    return lines;
  }

  // ─── Commands ─────────────────────────────────────────────────────────

  private async handleCommand(input: string): Promise<boolean> {
    const trimmed = input.trim();

    if (trimmed === "/quit" || trimmed === "/exit") {
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
║ /quit, /exit     Exit the REPL               ║
║ /clear           Clear message history       ║
║ /model <name>    Switch model (e.g., gpt-4o) ║
║ /provider <name> Switch provider             ║
║ /thinking <off|low|medium|high>              ║
║ /tokens <num>    Set max tokens              ║
║ /api-key <key>   Set API key                 ║
║ /config          Show current config          ║
║ /tools           List available tools         ║
║ /models          List available models        ║
║ /context         Show context stats           ║
║ /reset           Reset conversation           ║
╚══════════════════════════════════════════════╝
`, "green"));
      return true;
    }

    if (trimmed === "/clear") {
      console.clear();
      this.agent.messages = [];
      this.agent.clearAllQueues();
      process.stdout.write(colorize("Conversation cleared.\n", "dim"));
      return true;
    }

    if (trimmed === "/reset") {
      this.agent.reset();
      process.stdout.write(colorize("Agent state reset.\n", "dim"));
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
    process.stdout.write(colorize(`CWD: ${this.cwd}\n\n`, "dim"));

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
    return new Promise((resolve) => {
      const prompt = colorize("\n>>> ", "green");

      if (!this.rl.terminal) {
        // Non-interactive mode (piped input)
        this.rl.question(prompt, (answer) => {
          resolve(answer);
        });
      } else {
        this.rl.question(prompt, (answer) => {
          resolve(answer);
        });
      }
    });
  }

  private async sendPrompt(input: string): Promise<void> {
    try {
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
