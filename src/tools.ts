/**
 * Built-in tools for Mini Pi Agent.
 */

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { exec, type ExecOptions } from "node:child_process";
import * as util from "node:util";
import type { AgentTool, AgentToolResult, TextContent, ImageContent, ToolParameterSchema } from "./types.js";

const execPromise = util.promisify(exec);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function textContent(text: string): TextContent {
  return { type: "text", text };
}

function imageContent(data: string, mimeType: string): ImageContent {
  return { type: "image", data, mimeType };
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

async function readImageAsBase64(filePath: string): Promise<string> {
  const buffer = await fsPromises.readFile(filePath);
  return buffer.toString("base64");
}

function getMimeType(ext: string): string {
  const mimeMap: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  };
  return mimeMap[ext.toLowerCase()] ?? "application/octet-stream";
}

const DEFAULT_LINE_LIMIT = 200;
const DEFAULT_BYTE_LIMIT = 64 * 1024; // 64KB

function truncateOutput(text: string, maxLines: number, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) {
    const lines = text.split("\n");
    if (lines.length <= maxLines) {
      return { text, truncated: false };
    }
    return {
      text: lines.slice(0, maxLines).join("\n") + `\n... (${lines.length - maxLines} more lines)`,
      truncated: true,
    };
  }

  // Truncate by bytes
  let truncated = false;
  let result = text;

  if (Buffer.byteLength(text, "utf-8") > maxBytes) {
    let bytes = 0;
    const chars: string[] = [];
    for (const char of text) {
      bytes += Buffer.byteLength(char, "utf-8");
      if (bytes > maxBytes) break;
      chars.push(char);
    }
    result = chars.join("");
    truncated = true;
  }

  const lines = result.split("\n");
  if (lines.length > maxLines) {
    result = lines.slice(0, maxLines).join("\n") + `\n... (${lines.length - maxLines} more lines)`;
    truncated = true;
  }

  return { text: truncated ? `${result}\n(Output truncated)` : result, truncated: true };
}

function escapeForRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Read Tool ───────────────────────────────────────────────────────────────

export interface ReadToolParams {
  path: string;
  offset?: number;
  limit?: number;
}

export const readToolSchema: ToolParameterSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Absolute or relative path to the file to read" },
    offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
    limit: { type: "number", description: "Maximum number of lines to read" },
  },
  required: ["path"],
};

export function createReadTool(cwd: string): AgentTool<typeof readToolSchema, { path: string; lineCount: number }> {
  return {
    name: "read",
    label: "Read",
    description: "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). For text files, output is automatically truncated. Use offset/limit to paginate large files.",
    parameters: readToolSchema,
    async execute(toolCallId, params, signal) {
      const { path: filePath, offset, limit } = params as unknown as ReadToolParams;
      const resolvedPath = path.resolve(cwd, filePath);

      // Security: prevent reading outside workspace (basic)
      if (!resolvedPath.startsWith(cwd) && !resolvedPath.startsWith(process.cwd())) {
        return { content: [textContent(`Error: Path "${filePath}" is outside the allowed workspace`)], details: { path: filePath, lineCount: 0 } };
      }

      try {
        // Check if it's an image
        if (isImageFile(resolvedPath)) {
          const ext = path.extname(resolvedPath);
          const base64 = await readImageAsBase64(resolvedPath);
          const stats = await fsPromises.stat(resolvedPath);
          return {
            content: [
              textContent(`Image file: ${filePath} (${(stats.size / 1024).toFixed(1)} KB, ${ext.slice(1).toUpperCase()})`),
              imageContent(base64, getMimeType(ext)),
            ],
            details: { path: filePath, lineCount: 0 },
          };
        }

        // Read text file
        const content = await fsPromises.readFile(resolvedPath, "utf-8");
        const allLines = content.split("\n");

        if (offset !== undefined) {
          const startLine = Math.max(0, offset - 1);
          const endLine = limit !== undefined ? startLine + limit : startLine + DEFAULT_LINE_LIMIT;
          const selectedLines = allLines.slice(startLine, endLine);
          const lineNumbers = selectedLines.map((line, i) => `${startLine + i + 1}: ${line}`);
          const result = lineNumbers.join("\n");

          const showLimit = limit ?? DEFAULT_LINE_LIMIT;
          const hasMore = endLine < allLines.length;
          const footer = hasMore ? `\n... (${allLines.length - endLine} more lines. Use offset=${endLine + 1} to continue)` : "";

          return {
            content: [textContent(result + footer)],
            details: { path: filePath, lineCount: selectedLines.length },
          };
        }

        const effectiveLimit = limit ?? DEFAULT_LINE_LIMIT;
        const { text, truncated } = truncateOutput(content, effectiveLimit, DEFAULT_BYTE_LIMIT);

        if (!truncated && offset === undefined) {
          const lineNumbers = allLines.map((line, i) => `${i + 1}: ${line}`);
          return {
            content: [textContent(lineNumbers.join("\n"))],
            details: { path: filePath, lineCount: allLines.length },
          };
        }

        return {
          content: [textContent(text)],
          details: { path: filePath, lineCount: allLines.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [textContent(`Error reading file "${filePath}": ${msg}`)], details: { path: filePath, lineCount: 0 } };
      }
    },
  };
}

// ─── Write Tool ──────────────────────────────────────────────────────────────

export interface WriteToolParams {
  path: string;
  content: string;
}

export const writeToolSchema: ToolParameterSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Absolute or relative path of the file to write" },
    content: { type: "string", description: "The full content to write to the file (overwrites existing content)" },
  },
  required: ["path", "content"],
};

export function createWriteTool(cwd: string): AgentTool<typeof writeToolSchema, { path: string; size: number }> {
  return {
    name: "write",
    label: "Write",
    description: "Create a new file or overwrite an existing file with new content. Automatically creates parent directories if they don't exist.",
    parameters: writeToolSchema,
    async execute(toolCallId, params) {
      const { path: filePath, content } = params as unknown as WriteToolParams;
      const resolvedPath = path.resolve(cwd, filePath);

      try {
        await fsPromises.mkdir(path.dirname(resolvedPath), { recursive: true });
        await fsPromises.writeFile(resolvedPath, content, "utf-8");
        const size = Buffer.byteLength(content, "utf-8");
        return {
          content: [textContent(`Successfully wrote ${size} bytes to "${filePath}"`)],
          details: { path: filePath, size },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [textContent(`Error writing file "${filePath}": ${msg}`)], details: { path: filePath, size: 0 } };
      }
    },
  };
}

// ─── Edit Tool ───────────────────────────────────────────────────────────────

export interface EditOperation {
  oldText: string;
  newText: string;
}

export interface EditToolParams {
  path: string;
  edits: EditOperation[];
}

export const editToolSchema: ToolParameterSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Absolute or relative path of the file to edit" },
    edits: {
      type: "array",
      description: "Array of edit operations. Each operation replaces oldText with newText. Operations are applied in order.",
      items: {
        type: "object",
        properties: {
          oldText: { type: "string", description: "The exact text to search for (must match exactly)" },
          newText: { type: "string", description: "The replacement text" },
        },
        required: ["oldText", "newText"],
      },
    },
  },
  required: ["path", "edits"],
};

function computeUnifiedDiff(original: string, modified: string, filePath: string, editIdx: number): string {
  const origLines = original.split("\n");
  const modLines = modified.split("\n");
  const diff: string[] = [];

  // Simple diff: find first differing line
  let firstDiff = -1;
  for (let i = 0; i < Math.max(origLines.length, modLines.length); i++) {
    if (origLines[i] !== modLines[i]) {
      firstDiff = i;
      break;
    }
  }

  if (firstDiff === -1) return "  (no changes)";

  const contextStart = Math.max(0, firstDiff - 3);
  const origEnd = Math.min(origLines.length, firstDiff + 4);
  const modEnd = Math.min(modLines.length, firstDiff + 4);

  diff.push(`--- ${filePath}`);
  diff.push(`+++ ${filePath}`);
  diff.push(`@@ -${contextStart + 1},${origEnd - contextStart} +${contextStart + 1},${modEnd - contextStart} @@`);

  for (let i = contextStart; i < origEnd; i++) {
    if (i < firstDiff || i >= firstDiff + 1) {
      diff.push(` ${origLines[i] ?? ""}`);
    } else {
      diff.push(`-${origLines[i] ?? ""}`);
    }
  }
  for (let i = contextStart; i < modEnd; i++) {
    if (i < firstDiff || i >= firstDiff + (modLines.length - origLines.length + 1 > 0 ? modLines.length - origLines.length + 1 : 0)) {
      // skip, already shown
    }
    if (i >= firstDiff && i < firstDiff + (modLines.length - firstDiff)) {
      const modIdx = i - firstDiff + firstDiff;
      if (modIdx < modLines.length) {
        // Only show the actually changed lines
        if (i >= firstDiff && i < firstDiff + (modLines.length - origLines.length + (origLines.length - firstDiff))) {
          // This is getting complex, let's just show the changed portion
        }
      }
    }
  }

  // Simpler approach: show the edit context
  const ctxLines: string[] = [];
  for (let i = contextStart; i < origEnd; i++) {
    if (i < firstDiff) {
      ctxLines.push(` ${origLines[i] ?? ""}`);
    } else {
      ctxLines.push(`-${origLines[i] ?? ""}`);
    }
  }
  ctxLines.push("---");
  for (let i = contextStart; i < modEnd; i++) {
    if (i < modLines.length) {
      if (i < firstDiff) {
        ctxLines.push(` ${modLines[i] ?? ""}`);
      } else {
        ctxLines.push(`+${modLines[i] ?? ""}`);
      }
    }
  }

  return ctxLines.join("\n");
}

export function createEditTool(cwd: string): AgentTool<typeof editToolSchema, { path: string; appliedEdits: number }> {
  return {
    name: "edit",
    label: "Edit",
    description: "Apply precise text replacements to an existing file. Each edit operation replaces an exact match of oldText with newText. All edits are applied sequentially to the same file content.",
    parameters: editToolSchema,
    async execute(toolCallId, params) {
      const { path: filePath, edits } = params as unknown as EditToolParams;
      const resolvedPath = path.resolve(cwd, filePath);

      try {
        const content = await fsPromises.readFile(resolvedPath, "utf-8");
        let modified = content;
        let appliedCount = 0;

        for (let i = 0; i < edits.length; i++) {
          const { oldText, newText } = edits[i];

          if (modified.includes(oldText)) {
            modified = modified.replace(oldText, newText);
            appliedCount++;
          } else {
            // Try to find a close match for better error reporting
            const searchStr = oldText.slice(0, 40).replace(/\n/g, "\\n");
            return {
              content: [textContent(`Error editing "${filePath}" (edit #${i + 1}): Could not find exact match for:\n\`\`\`\n${searchStr}...\n\`\`\`\n\nMake sure the oldText matches the file content exactly, including whitespace.`)],
              details: { path: filePath, appliedEdits: appliedCount },
              terminate: false,
            };
          }
        }

        if (appliedCount > 0) {
          await fsPromises.writeFile(resolvedPath, modified, "utf-8");
          const diff = computeUnifiedDiff(content, modified, filePath, 0);
          return {
            content: [textContent(`Applied ${appliedCount} edit(s) to "${filePath}":\n\n${diff}`)],
            details: { path: filePath, appliedEdits: appliedCount },
          };
        }

        return {
          content: [textContent(`No edits were applied to "${filePath}"`)],
          details: { path: filePath, appliedEdits: 0 },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [textContent(`Error editing file "${filePath}": ${msg}`)], details: { path: filePath, appliedEdits: 0 } };
      }
    },
  };
}

// ─── Bash Tool ───────────────────────────────────────────────────────────────

export interface BashToolParams {
  command: string;
  timeout?: number;
  description?: string;
}

export const bashToolSchema: ToolParameterSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "The shell command to execute" },
    timeout: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
    description: { type: "string", description: "Optional description of what this command does" },
  },
  required: ["command"],
};

export function createBashTool(cwd: string): AgentTool<typeof bashToolSchema, { command: string; exitCode: number | null }> {
  // Track child processes for cleanup
  const children = new Map<string, { process: ReturnType<typeof exec>; startTime: number }>();

  return {
    name: "bash",
    label: "Bash",
    description: "Execute a shell command in the project directory. Returns stdout, stderr, and exit code. Long-running commands are automatically truncated after 30 seconds. Use timeout parameter to override.",
    parameters: bashToolSchema,
    async execute(toolCallId, params, signal, onUpdate) {
      const { command, timeout: timeoutMs } = params as unknown as BashToolParams;
      const effectiveTimeout = timeoutMs ?? 30000;

      // Security: basic dangerous command detection
      const dangerousPatterns = [
        /^\s*rm\s+-rf\s+\/$/, /^\s*dd\s+/, /^\s*:\(\)\s*\{\s*:\s*\|/,
        /^\s*>\s*\/dev\/sda/, /^\s*mkfs/,
      ];
      for (const pattern of dangerousPatterns) {
        if (pattern.test(command)) {
          return {
            content: [textContent(`Error: Command blocked for safety: "${command.slice(0, 50)}..."`)],
            details: { command, exitCode: -1 },
          };
        }
      }

      const execOptions: ExecOptions = {
        cwd,
        timeout: effectiveTimeout,
        maxBuffer: 1024 * 1024, // 1MB
        env: { ...process.env, PWD: cwd },
        shell: process.platform === "win32" ? undefined : "/bin/bash",
      };

      try {
        onUpdate?.({ content: [textContent(`$ ${command}`)], details: { command, exitCode: null } });

        const { stdout, stderr } = await execPromise(command, execOptions);

        const outputParts: string[] = [];
        if (stdout) {
          const { text, truncated } = truncateOutput(String(stdout), 500, 512 * 1024);
          outputParts.push(text);
          if (truncated) outputParts.push("(stdout truncated)");
        }
        if (stderr) {
          const { text, truncated } = truncateOutput(String(stderr), 200, 256 * 1024);
          if (outputParts.length > 0) outputParts.push("\n--- stderr ---\n");
          outputParts.push(text);
          if (truncated) outputParts.push("(stderr truncated)");
        }

        const result = outputParts.join("\n");
        return {
          content: [textContent(result || "(no output)")],
          details: { command, exitCode: 0 },
        };
      } catch (err) {
        const execErr = err as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; signal?: string };

        if (execErr.killed || execErr.signal === "SIGTERM") {
          return {
            content: [textContent(`Command timed out after ${effectiveTimeout}ms:\n$ ${command}`)],
            details: { command, exitCode: null },
          };
        }

        const outputParts: string[] = [];
        if (execErr.stdout) {
          outputParts.push(execErr.stdout);
        }
        if (execErr.stderr) {
          if (outputParts.length > 0) outputParts.push("\n--- stderr ---\n");
          outputParts.push(execErr.stderr);
        }

        const exitCode = typeof execErr.code === "number" ? execErr.code : 1;
        outputParts.push(`\n(exit code: ${exitCode})`);

        return {
          content: [textContent(outputParts.join("\n"))],
          details: { command, exitCode },
          terminate: exitCode !== 0 && command.includes("npm") ? false : undefined,
        };
      }
    },
  };
}

// ─── Glob Tool ───────────────────────────────────────────────────────────────

export interface GlobToolParams {
  pattern: string;
  path?: string;
  limit?: number;
}

export const globToolSchema: ToolParameterSchema = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Glob pattern (e.g., '**/*.ts', 'src/**/*.js')" },
    path: { type: "string", description: "Directory to search in (defaults to cwd)" },
    limit: { type: "number", description: "Maximum number of results (default: 200)" },
  },
  required: ["pattern"],
};

// Minimal glob implementation using fs
function globFiles(rootDir: string, pattern: string, maxResults: number): string[] {
  const results: string[] = [];

  function matchesGlob(filePath: string, pattern: string): boolean {
    // Convert simple glob to regex
    let regexStr = "";
    let inStar = false;

    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];

      if (ch === "*" && i + 1 < pattern.length && pattern[i + 1] === "*" && i + 2 < pattern.length && pattern[i + 2] === "/") {
        // **/ matches any depth
        regexStr += "(?:.+/)?";
        i += 2;
        continue;
      }
      if (ch === "*" && i + 1 < pattern.length && pattern[i + 1] === "*") {
        // ** at end matches everything
        regexStr += ".*";
        i += 1;
        continue;
      }
      if (ch === "*") {
        regexStr += "[^/]*";
        continue;
      }
      if (ch === "?") {
        regexStr += "[^/]";
        continue;
      }
      if (ch === ".") {
        regexStr += "\\.";
        continue;
      }
      regexStr += ch;
    }

    try {
      return new RegExp(`^${regexStr}$`).test(filePath);
    } catch {
      return filePath.includes(pattern.replace(/\*/g, ""));
    }
  }

  function walk(dir: string): void {
    if (results.length >= maxResults) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(rootDir, fullPath).replace(/\\/g, "/");

        if (entry.isDirectory()) {
          // Skip node_modules, .git, .next, dist
          if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next" || entry.name === "dist" || entry.name === "build") continue;
          if (matchesGlob(relPath + "/", pattern)) {
            results.push(relPath + "/");
          }
          walk(fullPath);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          if (matchesGlob(relPath, pattern)) {
            results.push(relPath);
          }
        }
      }
    } catch {
      // Permission errors, skip
    }
  }

  walk(rootDir);
  return results.slice(0, maxResults);
}

export function createGlobTool(cwd: string): AgentTool<typeof globToolSchema, { pattern: string; count: number }> {
  return {
    name: "glob",
    label: "Glob",
    description: "Find files matching a glob pattern. Supports ** (any depth), * (within one directory), and ? (single character). Skips node_modules, .git, dist, and build directories automatically.",
    parameters: globToolSchema,
    async execute(toolCallId, params) {
      const { pattern, path: searchPath, limit } = params as unknown as GlobToolParams;
      const rootDir = searchPath ? path.resolve(cwd, searchPath) : cwd;
      const maxResults = limit ?? 200;

      try {
        const results = globFiles(rootDir, pattern, maxResults);
        const count = results.length;
        const hasMore = count >= maxResults;

        if (count === 0) {
          return {
            content: [textContent(`No files matching "${pattern}" found in "${path.relative(cwd, rootDir) || "."}"`)],
            details: { pattern, count: 0 },
          };
        }

        const output = results.join("\n") + (hasMore ? `\n... (showing ${maxResults} of ${count}+ results)` : "");
        return {
          content: [textContent(output)],
          details: { pattern, count },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [textContent(`Error searching for "${pattern}": ${msg}`)], details: { pattern, count: 0 } };
      }
    },
  };
}

// ─── Grep Tool ───────────────────────────────────────────────────────────────

export interface GrepToolParams {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  limit?: number;
  context?: number;
}

export const grepToolSchema: ToolParameterSchema = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Search pattern (regex)" },
    path: { type: "string", description: "Directory or file to search in" },
    glob: { type: "string", description: "Glob pattern for file filtering (e.g., '*.ts', '*.{ts,js}')" },
    ignoreCase: { type: "boolean", description: "Case-insensitive search" },
    limit: { type: "number", description: "Maximum number of results (default: 50)" },
    context: { type: "number", description: "Number of context lines before and after each match" },
  },
  required: ["pattern"],
};

export function createGrepTool(cwd: string): AgentTool<typeof grepToolSchema, { pattern: string; count: number }> {
  return {
    name: "grep",
    label: "Grep",
    description: "Search file contents using regular expressions. Returns matching lines with file paths and line numbers.",
    parameters: grepToolSchema,
    async execute(toolCallId, params, signal) {
      const { pattern, path: searchPath, glob: fileGlob, ignoreCase, limit, context } = params as unknown as GrepToolParams;
      const rootDir = searchPath ? path.resolve(cwd, searchPath) : cwd;
      const maxResults = limit ?? 50;
      const contextLines = context ?? 0;

      try {
        const results: string[] = [];
        let totalMatches = 0;

        function searchInFile(filePath: string): void {
          if (totalMatches >= maxResults) return;

          try {
            const content = fs.readFileSync(filePath, "utf-8");
            const lines = content.split("\n");
            const flags = ignoreCase ? "gi" : "g";
            let regex: RegExp;

            try {
              regex = new RegExp(pattern, flags);
            } catch {
              // If invalid regex, treat as literal string
              regex = new RegExp(escapeForRegex(pattern), flags);
            }

            const relPath = path.relative(cwd, filePath).replace(/\\/g, "/");

            for (let i = 0; i < lines.length; i++) {
              if (totalMatches >= maxResults) break;

              if (regex.test(lines[i])) {
                // Context lines
                if (contextLines > 0) {
                  const ctxStart = Math.max(0, i - contextLines);
                  const ctxEnd = Math.min(lines.length, i + contextLines + 1);
                  const ctxLines: string[] = [];

                  for (let j = ctxStart; j < ctxEnd; j++) {
                    const prefix = j === i ? ">" : " ";
                    ctxLines.push(`${prefix} ${relPath}:${j + 1}: ${lines[j]}`);
                  }
                  results.push(ctxLines.join("\n") + "\n---");
                } else {
                  results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
                }
                totalMatches++;
              }
            }
          } catch {
            // Skip unreadable files
          }
        }

        function walkDir(dir: string): void {
          if (totalMatches >= maxResults) return;

          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (totalMatches >= maxResults) return;
              const fullPath = path.join(dir, entry.name);

              if (entry.isDirectory()) {
                if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next" || entry.name === "dist" || entry.name === "build") continue;
                walkDir(fullPath);
              } else if (entry.isFile()) {
                if (fileGlob) {
                  const relPath = path.relative(rootDir, fullPath);
                  if (!fileGlob.split(",").some((g) => {
                    const trimmed = g.trim();
                    const regex = new RegExp("^" + escapeForRegex(trimmed).replace(/\\\*/g, ".*") + "$");
                    return regex.test(relPath) || regex.test(path.basename(fullPath));
                  })) continue;
                }
                searchInFile(fullPath);
              }
            }
          } catch {
            // Permission errors
          }
        }

        if (searchPath && fs.statSync(rootDir).isFile()) {
          searchInFile(rootDir);
        } else {
          walkDir(rootDir);
        }

        if (totalMatches === 0) {
          return {
            content: [textContent(`No matches found for "${pattern}"`)],
            details: { pattern, count: 0 },
          };
        }

        const output = results.join("\n") + (totalMatches >= maxResults ? `\n... (showing ${maxResults} of ${totalMatches}+ matches)` : `\n(${totalMatches} match${totalMatches > 1 ? "es" : ""})`);

        return {
          content: [textContent(output)],
          details: { pattern, count: totalMatches },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [textContent(`Error searching for "${pattern}": ${msg}`)], details: { pattern, count: 0 } };
      }
    },
  };
}

// ─── Tool Factory ────────────────────────────────────────────────────────────

export interface ToolFactoriesOptions {
  cwd: string;
}

export function createDefaultTools(options: ToolFactoriesOptions): AgentTool[] {
  const { cwd } = options;

  return [
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createBashTool(cwd),
    createGlobTool(cwd),
    createGrepTool(cwd),
  ];
}

export function createCodingTools(options: ToolFactoriesOptions): AgentTool[] {
  const { cwd } = options;
  // The "coding" subset: read, write, edit, bash
  return [
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createBashTool(cwd),
  ];
}
