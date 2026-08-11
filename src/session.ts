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
