#!/usr/bin/env node
/**
 * Mini Pi Agent - CLI Entry Point
 *
 * Usage:
 *   npx mini-pi                         # Start interactive REPL
 *   npx mini-pi "your prompt here"       # Single prompt (auto-exit)
 *   echo "prompt" | npx mini-pi         # Piped input
 *   npx mini-pi --help                  # Show help
 *   npx mini-pi --provider openai --model gpt-4o
 */

import { ConfigManager, BUILTIN_MODELS, getProviders } from "./config.js";
import { MiniPiREPL } from "./repl.js";
import { createOpenAIProvider, registerProvider } from "./provider.js";

function printHelp(): void {
  console.log(`
Mini Pi Agent v0.1.0 - A compact coding agent

USAGE:
  mini-pi [options] [prompt...]

OPTIONS:
  -m, --model <name>         Model ID (default: gpt-4o)
  -p, --provider <name>      Provider (default: openai)
  -k, --api-key <key>        API key for the provider
  -b, --base-url <url>       API base URL override
  -t, --thinking <level>     Thinking level: off|low|medium|high
  -c, --config               Print current configuration
  -l, --list-models          List available models
  -h, --help                 Show this help

EXAMPLES:
  mini-pi                          Start interactive session
  mini-pi "write hello world"      Single prompt, print output
  mini-pi -p deepseek -m deepseek-chat
  mini-pi -k sk-... "check tests"
  echo "list files" | mini-pi      Piped input

CONFIGURATION:
  Config is stored in ~/.mini-pi/config.json
  API keys in ~/.mini-pi/auth.json
  Environment variables: OPENAI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, etc.
`);
}

function printModels(): void {
  console.log("Available built-in models:");
  console.log("");
  const byProvider = new Map<string, typeof BUILTIN_MODELS>();
  for (const m of BUILTIN_MODELS) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }

  for (const [provider, models] of byProvider) {
    console.log(`  ${provider}:`);
    for (const m of models) {
      const thinking = m.reasoning ? " (thinking)" : "";
      console.log(`    ${m.id}${thinking}`);
    }
    console.log("");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse flags
  let provider: string | undefined;
  let model: string | undefined;
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let thinkingLevel: string | undefined;
  let showHelp = false;
  let showModels = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "-h":
      case "--help":
        showHelp = true;
        break;
      case "-l":
      case "--list-models":
        showModels = true;
        break;
      case "-m":
      case "--model":
        model = args[++i];
        break;
      case "-p":
      case "--provider":
        provider = args[++i];
        break;
      case "-k":
      case "--api-key":
        apiKey = args[++i];
        break;
      case "-b":
      case "--base-url":
        baseUrl = args[++i];
        break;
      case "-t":
      case "--thinking":
        thinkingLevel = args[++i];
        break;
      case "-c":
      case "--config":
        // Will show config from ConfigManager
        break;
      default:
        if (!arg.startsWith("-")) {
          positional.push(arg);
        }
        break;
    }
  }

  if (showHelp) {
    printHelp();
    process.exit(0);
  }

  if (showModels) {
    printModels();
    process.exit(0);
  }

  // Initialize config
  const config = new ConfigManager();
  config.load();

  // Apply CLI overrides
  if (provider) config.provider = provider;
  if (model) config.modelId = model;
  if (apiKey) {
    config.setApiKey(provider ?? config.provider, apiKey);
  }
  if (baseUrl) config.baseUrl = baseUrl;
  if (thinkingLevel && ["off", "low", "medium", "high"].includes(thinkingLevel)) {
    config.thinkingLevel = thinkingLevel as "off" | "low" | "medium" | "high";
  }

  // Determine mode: interactive or single prompt
  const isInteractive = positional.length === 0 && !process.env.CI && process.stdin.isTTY;
  const cwd = process.cwd();

  if (isInteractive) {
    // Interactive REPL
    const repl = new MiniPiREPL(cwd, config);
    await repl.run();
  } else if (positional.length > 0) {
    // Single prompt mode
    const prompt = positional.join(" ");
    const repl = new MiniPiREPL(cwd, config, { autoRun: true });
    // Override argv to include the prompt
    process.argv = process.argv.slice(0, 2).concat(prompt);
    await repl.run();
  } else {
    // Non-interactive (piped), use REPL with first line
    const repl = new MiniPiREPL(cwd, config);
    await repl.run();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
