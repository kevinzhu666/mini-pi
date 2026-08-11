/**
 * Smoke test for the REPL's streaming render. Drives a real MiniPiREPL with
 * faux responses that include thinking blocks, captures stdout, and asserts the
 * display is clean: decorations (`[thinking: ` / `...]`) appear exactly once,
 * no ANSI cursor-control codes are emitted (the append-only renderer must not
 * regress to clear-and-rewrite), and thinking renders before text.
 *
 * This targets the two regressions seen in the field:
 *   1. every thinking delta re-printing the truncated `...]` suffix
 *   2. relying on `readline.moveCursor/clearLine` (fails on some terminals)
 *
 * Usage: node --import tsx scripts/smoke-stream.ts
 * Exits non-zero on any failed assertion.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigManager } from "../src/config.js";
import { MiniPiREPL } from "../src/repl.js";
import { fauxAssistantMessage } from "../src/provider.js";

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`✓ ${label}`);
  } else {
    console.error(`✗ FAIL: ${label}`);
    failures++;
  }
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const count = (s: string, sub: string): number => s.split(sub).length - 1;
/** Cursor movement (up/down/left/right) and line/screen erase sequences. */
const cursorCodes = /\x1b\[[0-9]*[A-HKJ]/;

// Long thinking (>100 chars) so the display truncates and streams many deltas.
const LONG_THINKING =
  "The user is asking \"今天发生的大事有哪些\" (What major events happened today?). " +
  "This is a question about current events and news. I do not have access to " +
  "real-time news or internet browsing, so I cannot answer from live sources. " +
  "I should be honest about that limitation and offer to help in other ways.";
const TEXT = "抱歉，我没有实时获取新闻的能力。";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-pi-stream-"));
  const config = new ConfigManager(dir);
  config.load();
  config.provider = "faux";
  config.modelId = "faux-1";

  let captured = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ..._rest: unknown[]) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    return true;
  }) as typeof process.stdout.write;

  const repl = new MiniPiREPL(process.cwd(), config, {
    // Stream faux content slowly so the REPL renders each delta incrementally —
    // a one-shot burst would never hit the suffix-re-emission regression.
    fauxTokensPerSecond: 200,
    fauxResponses: [
      // 1. thinking + text — the decorations-must-appear-once regression case
      fauxAssistantMessage([
        { type: "thinking", thinking: LONG_THINKING },
        { type: "text", text: TEXT },
      ]),
      // 2. thinking only
      fauxAssistantMessage([{ type: "thinking", thinking: "只思考不回答的情况。" }]),
      // 3. text only
      fauxAssistantMessage("纯文本回复。"),
    ],
  });

  await repl.run();
  process.stdout.write = origWrite;
  fs.rmSync(dir, { recursive: true, force: true });

  // Split into per-turn sections by the turn banner.
  const parts = captured.split("─── Turn ───");
  assert(parts.length >= 4, `3 turns rendered (got ${parts.length - 1})`);
  const [s1, s2, s3] = parts.slice(1, 4);

  // Global: the append-only renderer must not use ANSI cursor control.
  assert(!cursorCodes.test(captured), "no ANSI cursor-control codes emitted");

  // Turn 1: thinking + text
  assert(count(s1, "[thinking: ") === 1, `turn1 [thinking: once (got ${count(s1, "[thinking: ")})`);
  assert(count(s1, "...]") === 1, `turn1 "...]" once (got ${count(s1, "...]")})`);
  const plain1 = stripAnsi(s1);
  assert(plain1.includes(LONG_THINKING.slice(0, 100)), "turn1 thinking truncated at 100 chars");
  assert(plain1.includes(TEXT), "turn1 text present");
  assert(plain1.indexOf("[thinking: ") < plain1.indexOf(TEXT), "turn1 thinking printed before text");

  // Turn 2: thinking only
  assert(count(s2, "[thinking: ") === 1, `turn2 [thinking: once (got ${count(s2, "[thinking: ")})`);
  assert(count(s2, "...]") === 1, `turn2 "...]" once (got ${count(s2, "...]")})`);
  assert(!stripAnsi(s2).includes(TEXT), "turn2 no text");

  // Turn 3: text only
  assert(count(s3, "[thinking: ") === 0, "turn3 no thinking");
  assert(stripAnsi(s3).includes("纯文本回复。"), "turn3 text present");

  console.log(failures === 0 ? "Done — all passed." : `Done — ${failures} FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
