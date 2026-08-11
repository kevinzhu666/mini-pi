/**
 * Smoke test for SessionManager — runs against a temp directory.
 * Usage: node --import tsx scripts/smoke-session.ts
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
