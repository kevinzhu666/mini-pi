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

// SessionManager.load/delete validate the timestamp id format (YYYYMMDD-HHMMSS),
// so the smoke test must use a realistic id rather than a free-form label.
const SMOKE_ID = "20260811-120000";

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
    id: SMOKE_ID,
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

  const saved = sm.load(SMOKE_ID);
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
