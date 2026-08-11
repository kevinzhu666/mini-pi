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
