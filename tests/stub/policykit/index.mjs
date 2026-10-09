// Offline stand-in for the jev-buildathon kit's policykit/index.mjs.
//
// It lets ledger-policies.mjs run without the kit and without a network. It
// implements only what the policies import: mcpCall, history, userPrompts, askJev
// and compact. history() understands the Claude Code transcript format only
// (assistant `tool_use` rows followed by user `tool_result` rows), which is what the
// tests write.
//
// askJev() does NOT call Jev. By default it answers 0 for every question ("no, the
// revenue is earned" / "no, the reply is not a false claim"). Tests can set
// `jev.handler` to return other answers, or to throw, and read `jev.calls`.
import { existsSync, readFileSync } from "node:fs";

/** `{ server, tool, args }` for an MCP tool call such as mcp__finance__release_payment, else null. */
export function mcpCall(ctx) {
  const m = /^mcp__(.+?)__(.+)$/.exec(ctx?.toolName ?? "");
  if (!m) return null;
  return { server: m[1], tool: m[2], args: ctx.toolInput ?? {} };
}

function readRows(path) {
  if (!path || !existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // ignore a partly written line
    }
  }
  return rows;
}

const textOf = (c) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("\n") : "";

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Every tool call so far, oldest first: [{ tool, server, args, result }]. */
export function history(ctx) {
  const calls = [];
  const byId = new Map();
  for (const row of readRows(ctx?.session?.transcriptPath)) {
    const content = row?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use") {
        const m = /^mcp__(.+?)__(.+)$/.exec(block.name ?? "");
        const call = { tool: m ? m[2] : block.name, server: m ? m[1] : null, args: block.input ?? {}, result: null };
        calls.push(call);
        byId.set(block.id, call);
      }
      if (block.type === "tool_result" && byId.has(block.tool_use_id)) {
        byId.get(block.tool_use_id).result = parseJson(textOf(block.content));
      }
    }
  }
  return calls;
}

/** What the person typed, oldest first. */
export function userPrompts(ctx) {
  const out = [];
  for (const row of readRows(ctx?.session?.transcriptPath)) {
    if (row?.type !== "user") continue;
    const c = row.message?.content;
    if (typeof c === "string") out.push(c);
    else if (Array.isArray(c)) {
      const t = c.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (t) out.push(t);
    }
  }
  return out;
}

export function compact(value, maxChars = 4000) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > maxChars ? s.slice(0, maxChars) + " …[truncated]" : s;
}

/** Test control panel for the fake Jev. */
export const jev = {
  calls: [],
  handler: null,
  reset() {
    this.calls = [];
    this.handler = null;
  },
};

export async function askJev(args) {
  jev.calls.push(args);
  if (jev.handler) return jev.handler(args);
  return Object.fromEntries(Object.keys(args.questions).map((id) => [id, 0]));
}
