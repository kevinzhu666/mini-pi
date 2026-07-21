/**
 * Memory Manager — persistent key-value memory for Mini Pi Agent.
 *
 * Stores facts in ~/.mini-pi/memory/memory.json so the agent can
 * remember things across sessions. Designed as part of a two-layer
 * memory system:
 *   Layer 1 — explicit remember/recall/forget commands
 *   Layer 2 — auto-inject memories into the system prompt
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  key: string;
  value: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MemoryStore {
  entries: MemoryEntry[];
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_DIR = path.join(os.homedir(), ".mini-pi", "memory");
const DEFAULT_FILE = "memory.json";

// ─── Memory Manager ─────────────────────────────────────────────────────────

export class MemoryManager {
  private entries: MemoryEntry[] = [];
  private dir: string;
  private filePath: string;

  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_DIR;
    this.filePath = path.join(this.dir, DEFAULT_FILE);
  }

  // ─── Persistence ──────────────────────────────────────────────────────

  load(): void {
    try {
      if (!fs.existsSync(this.dir)) {
        fs.mkdirSync(this.dir, { recursive: true });
      }
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const store: MemoryStore = JSON.parse(raw);
        this.entries = Array.isArray(store.entries) ? store.entries : [];
      }
    } catch {
      this.entries = [];
    }
  }

  save(): void {
    try {
      if (!fs.existsSync(this.dir)) {
        fs.mkdirSync(this.dir, { recursive: true });
      }
      const store: MemoryStore = { entries: this.entries };
      fs.writeFileSync(this.filePath, JSON.stringify(store, null, 2), "utf-8");
    } catch {
      // Silently fail — memory is non-critical
    }
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────

  /** Remember a fact. If the key already exists, the value is overwritten. */
  remember(key: string, value: string, tags?: string[]): void {
    const existing = this.entries.find((e) => e.key === key);
    const now = Date.now();

    if (existing) {
      existing.value = value;
      if (tags !== undefined) existing.tags = tags;
      existing.updatedAt = now;
    } else {
      this.entries.push({
        key,
        value,
        tags: tags ?? [],
        createdAt: now,
        updatedAt: now,
      });
    }

    this.save();
  }

  /** Recall the value for a given key. Returns null if not found. */
  recall(key: string): MemoryEntry | null {
    return this.entries.find((e) => e.key === key) ?? null;
  }

  /** Forget (delete) a memory by key. */
  forget(key: string): boolean {
    const idx = this.entries.findIndex((e) => e.key === key);
    if (idx === -1) return false;
    this.entries.splice(idx, 1);
    this.save();
    return true;
  }

  /** Search for memories whose key or value contains the query (case-insensitive). */
  search(query: string): MemoryEntry[] {
    const q = query.toLowerCase();
    return this.entries.filter(
      (e) =>
        e.key.toLowerCase().includes(q) ||
        e.value.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }

  /** List all memories, optionally filtered by a tag. */
  list(tag?: string): MemoryEntry[] {
    if (!tag) return [...this.entries];
    return this.entries.filter((e) => e.tags.includes(tag));
  }

  /** Return total count of stored memories. */
  get count(): number {
    return this.entries.length;
  }

  // ─── Format for Prompt Injection (Layer 2) ────────────────────────────

  /**
   * Format all memories as a readable text block suitable for appending
   * to the system prompt. Returns an empty string if there are no memories.
   */
  format(): string {
    if (this.entries.length === 0) return "";

    const lines: string[] = ["\n## Your Memory", "You remember these facts from past conversations:"];
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const tagStr = e.tags.length > 0 ? ` (tags: ${e.tags.join(", ")})` : "";
      lines.push(`[${i + 1}] ${e.value}${tagStr}`);
    }
    return lines.join("\n");
  }

  /** Alias for backward compatibility — same as format(). */
  getAll(): string {
    return this.format();
  }
}
