/**
 * Configuration management for Mini Pi Agent.
 * Manages model selection, API keys, and system prompt configuration.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Model, ThinkingLevel } from "./types.js";

// ─── Config File Paths ──────────────────────────────────────────────────────

export const CONFIG_DIR = ".mini-pi";
export const CONFIG_FILE = "config.json";
export const AUTH_FILE = "auth.json";

function getConfigDir(): string {
  return path.join(os.homedir(), CONFIG_DIR);
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), CONFIG_FILE);
}

export function getAuthPath(): string {
  return path.join(getConfigDir(), AUTH_FILE);
}

// ─── Config Schema ───────────────────────────────────────────────────────────

export interface MiniPiConfig {
  /** Default model provider */
  provider?: string;
  /** Default model ID */
  model?: string;
  /** API base URL (overrides provider default) */
  baseUrl?: string;
  /** Default thinking level */
  thinkingLevel?: ThinkingLevel;
  /** System prompt customization */
  systemPrompt?: string;
  /** Max tokens for responses */
  maxTokens?: number;
  /** Tool execution mode */
  toolExecution?: "sequential" | "parallel";
}

// ─── Auth Schema ─────────────────────────────────────────────────────────────

export interface MiniPiAuth {
  /** Provider-scoped API keys */
  apiKeys?: Record<string, string>;
}

// ─── Config Manager ──────────────────────────────────────────────────────────

export class ConfigManager {
  private config: MiniPiConfig = {};
  private auth: MiniPiAuth = {};
  private configPath: string;
  private authPath: string;
  private loaded = false;

  constructor(configDir?: string) {
    const dir = configDir ?? getConfigDir();
    this.configPath = path.join(dir, CONFIG_FILE);
    this.authPath = path.join(dir, AUTH_FILE);
  }

  load(): void {
    try {
      if (!fs.existsSync(path.dirname(this.configPath))) {
        fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      }
      if (fs.existsSync(this.configPath)) {
        this.config = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
      }
      if (fs.existsSync(this.authPath)) {
        this.auth = JSON.parse(fs.readFileSync(this.authPath, "utf-8"));
      }
      this.loaded = true;
    } catch (err) {
      console.error("Warning: Could not load config:", err instanceof Error ? err.message : String(err));
      this.config = {};
      this.auth = {};
    }
  }

  save(): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf-8");
    } catch (err) {
      console.error("Warning: Could not save config:", err instanceof Error ? err.message : String(err));
    }
  }

  saveAuth(): void {
    try {
      const dir = path.dirname(this.authPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.authPath, JSON.stringify(this.auth, null, 2), "utf-8");
    } catch (err) {
      console.error("Warning: Could not save auth:", err instanceof Error ? err.message : String(err));
    }
  }

  get provider(): string { return this.config.provider ?? "openai"; }
  set provider(p: string) { this.config.provider = p; this.save(); }

  get modelId(): string { return this.config.model ?? "gpt-4o"; }
  set modelId(m: string) { this.config.model = m; this.save(); }

  get baseUrl(): string | undefined { return this.config.baseUrl; }
  set baseUrl(b: string | undefined) { this.config.baseUrl = b; this.save(); }

  get thinkingLevel(): ThinkingLevel { return this.config.thinkingLevel ?? "off"; }
  set thinkingLevel(t: ThinkingLevel) { this.config.thinkingLevel = t; this.save(); }

  get systemPrompt(): string {
    return this.config.systemPrompt ?? "You are a helpful coding assistant.";
  }
  set systemPrompt(s: string) { this.config.systemPrompt = s; this.save(); }

  get maxTokens(): number { return this.config.maxTokens ?? 8192; }
  set maxTokens(m: number) { this.config.maxTokens = m; this.save(); }

  get toolExecution(): "sequential" | "parallel" { return this.config.toolExecution ?? "sequential"; }
  set toolExecution(t: "sequential" | "parallel") { this.config.toolExecution = t; this.save(); }

  getApiKey(provider: string): string | undefined {
    // Check auth file first
    if (this.auth.apiKeys?.[provider]) return this.auth.apiKeys[provider];

    // Check environment variables
    const envVar = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
    return process.env[envVar] ?? process.env.OPENAI_API_KEY;
  }

  setApiKey(provider: string, key: string): void {
    if (!this.auth.apiKeys) this.auth.apiKeys = {};
    this.auth.apiKeys[provider] = key;
    this.saveAuth();
  }

  hasApiKey(provider: string): boolean {
    return !!this.getApiKey(provider);
  }

  resolveModel(extraModels?: Model[]): Model | undefined {
    const provider = this.provider;
    const modelId = this.modelId;

    if (extraModels) {
      const found = extraModels.find((m) => m.id === modelId && m.provider === provider);
      if (found) return found;
    }

    // Return a default model config that will be resolved at runtime
    return {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider,
      baseUrl: this.baseUrl ?? "https://api.openai.com/v1",
      reasoning: this.thinkingLevel !== "off",
      input: ["text", "image"],
      cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
      contextWindow: 128000,
      maxTokens: this.maxTokens,
    };
  }
}

// ─── Built-in Models Catalog ─────────────────────────────────────────────────

export const BUILTIN_MODELS: Model[] = [
  // OpenAI
  { id: "gpt-4o", name: "GPT-4o", api: "openai-completions", provider: "openai", baseUrl: "https://api.openai.com/v1", reasoning: false, input: ["text", "image"], cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 }, contextWindow: 128000, maxTokens: 16384 },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", api: "openai-completions", provider: "openai", baseUrl: "https://api.openai.com/v1", reasoning: false, input: ["text", "image"], cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 }, contextWindow: 128000, maxTokens: 16384 },
  { id: "o3-mini", name: "o3 Mini", api: "openai-completions", provider: "openai", baseUrl: "https://api.openai.com/v1", reasoning: true, input: ["text"], cost: { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 }, contextWindow: 200000, maxTokens: 100000 },
  { id: "o4-mini", name: "o4 Mini", api: "openai-completions", provider: "openai", baseUrl: "https://api.openai.com/v1", reasoning: true, input: ["text", "image"], cost: { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 }, contextWindow: 200000, maxTokens: 100000 },
  { id: "gpt-4.1", name: "GPT-4.1", api: "openai-completions", provider: "openai", baseUrl: "https://api.openai.com/v1", reasoning: false, input: ["text", "image"], cost: { input: 2, output: 8, cacheRead: 1, cacheWrite: 2 }, contextWindow: 1047000, maxTokens: 16384 },

  // Anthropic (via OpenAI-compatible proxy)
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", api: "openai-completions", provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", reasoning: false, input: ["text", "image"], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, contextWindow: 200000, maxTokens: 8192 },

  // DeepSeek
  { id: "deepseek-chat", name: "DeepSeek Chat", api: "openai-completions", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", reasoning: false, input: ["text"], cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 }, contextWindow: 64000, maxTokens: 8192 },
  { id: "deepseek-reasoner", name: "DeepSeek Reasoner", api: "openai-completions", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", reasoning: true, input: ["text"], cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 }, contextWindow: 64000, maxTokens: 8192 },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", api: "openai-completions", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", reasoning: false, input: ["text"], cost: { input: 0.2, output: 0.8, cacheRead: 0.05, cacheWrite: 0.2 }, contextWindow: 128000, maxTokens: 16384 },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", api: "openai-completions", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", reasoning: true, input: ["text"], cost: { input: 0.5, output: 2.0, cacheRead: 0.125, cacheWrite: 0.5 }, contextWindow: 128000, maxTokens: 16384 },

  // Google Gemini (via OpenAI-compatible)
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", api: "openai-completions", provider: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", reasoning: false, input: ["text", "image"], cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 }, contextWindow: 1048576, maxTokens: 8192 },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", api: "openai-completions", provider: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", reasoning: true, input: ["text", "image"], cost: { input: 1.25, output: 10, cacheRead: 0.1, cacheWrite: 1.25 }, contextWindow: 1048576, maxTokens: 8192 },

  // OpenRouter
  { id: "auto", name: "OpenRouter Auto", api: "openai-completions", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 },
];

export function findBuiltinModel(provider: string, id: string): Model | undefined {
  return BUILTIN_MODELS.find((m) => m.provider === provider && m.id === id);
}

export function getModelsByProvider(provider: string): Model[] {
  return BUILTIN_MODELS.filter((m) => m.provider === provider);
}

export function getProviders(): string[] {
  const providers = new Set(BUILTIN_MODELS.map((m) => m.provider));
  return Array.from(providers).sort();
}
