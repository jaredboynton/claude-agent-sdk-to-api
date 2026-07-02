// client-tools.mjs - client tool registration for code mode: JSON Schema -> Zod
// conversion, the parking MCP server whose handlers await client tool_results,
// streamed tool_use correlation, and late-tool merge/announcement.

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ANCHORED_EDIT_TOOLS, mergeAnchorEditSchema, patchCodeEditDescription } from "./anchor-edit.mjs";
import { SCRIPT_FIELD_DESCRIPTION, buildCodeToolDescription, codeToolInputShape, normalizeClientToolMeta } from "./code-mode.mjs";
import { cavemanLevels, compressProse } from "./caveman.mjs";
import { createSdkMcpServer, z } from "./sdk.mjs";
import { LOG_PREFIX, metrics } from "./metrics.mjs";

const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS || process.env.ACP_TOOL_TIMEOUT_MS || 1800000); // 30 min; a tool_result that never arrives returns isError so the SDK loop survives

// Build the Zod raw shape for one tool's top-level input_schema, preserving the
// caller's full JSON Schema via the bundled Zod v4 z.fromJSONSchema (which
// resolves oneOf/anyOf/allOf/$ref/$defs/const/nullable/format/pattern/bounds).
// Falls back to a permissive per-property converter on the rare unrepresentable
// schema so one exotic tool can never break the whole request.
function toolInputShape(schema) {
  if (!schema || typeof schema !== "object") return {};
  try {
    const zt = z.fromJSONSchema(schema, { unrepresentable: "any" });
    if (zt && zt.shape && typeof zt.shape === "object") return zt.shape;
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} fromJSONSchema failed (${String(e?.message || e).slice(0, 100)}); using permissive fallback\n`);
  }
  return fallbackShape(schema);
}

function fallbackShape(schema) {
  const shape = {};
  const required = new Set(schema.required || []);
  for (const [k, v] of Object.entries(schema.properties || {})) {
    const converted = jsonSchemaToZod(v);
    shape[k] = required.has(k) ? converted : converted.optional();
  }
  return shape;
}

function jsonSchemaToZod(schema) {
  if (!schema || typeof schema !== "object") return z.unknown();
  const desc = schema.description || "";
  if (schema.enum) return z.enum(schema.enum).describe(desc);
  switch (schema.type) {
    case "string": return z.string().describe(desc);
    case "number":
    case "integer": return z.number().describe(desc);
    case "boolean": return z.boolean().describe(desc);
    case "array": return z.array(jsonSchemaToZod(schema.items)).describe(desc);
    case "object": {
      const shape = {};
      const required = new Set(schema.required || []);
      for (const [k, v] of Object.entries(schema.properties || {})) {
        const converted = jsonSchemaToZod(v);
        shape[k] = required.has(k) ? converted : converted.optional();
      }
      return z.object(shape).describe(desc);
    }
    default: return z.unknown();
  }
}

// The SDK namespaces in-process MCP tools as mcp__<serverId>__<originalName>.
// The serverId is a numeric index (observed mcp__0__), never containing an
// underscore, so /^mcp__[^_]+__/ strips exactly one namespace segment.
const BRIDGE_NS_RE = /^mcp__[^_]+__/;

// Restore the caller's original tool name from the SDK-namespaced tool_use name.
function stripBridgeToolName(name, originalNames) {
  if (typeof name !== "string") return name;
  if (originalNames && originalNames.has(name)) return name;
  const stripped = name.replace(BRIDGE_NS_RE, "");
  if (!originalNames || originalNames.has(stripped)) return stripped;
  return stripped;
}

// Normalize a tool input value through the SAME Zod object schema the MCP layer
// used to validate the handler's args. The SDK's validateToolInput runs
// normalizeObjectSchema(inputSchema).parse(raw), which injects every JSON-Schema
// `default` and applies coercions — so the args the handler receives are NOT the
// raw JSON the model streamed. Running BOTH the streamed entry.input and the
// handler args through our parser (built from the same shape) canonicalizes them
// to the same form, making isDeepStrictEqual succeed. Idempotent: parsing an
// already-normalized value yields the same object. Identity when no parser is
// registered (keeps pure-logic tests and bare sessions working).
function normalizeToolInput(session, name, value) {
  const parser = session.inputParsers?.get(name);
  if (!parser) return value;
  try {
    const r = parser.safeParse(value);
    return r.success ? r.data : value;
  } catch {
    return value;
  }
}

// Opportunistic, future-proof id hint: if the SDK ever forwards the Anthropic
// tool_use.id into the handler's extra._meta, claim that id directly and skip
// content matching entirely. Today the mcp_message path forwards a plain
// JSON-RPC tools/call with no Anthropic id, so this scans _meta for any value
// that already equals a currently-streamed id — zero-risk: a value only matches
// if it genuinely is one of our streamed ids.
function extractIdHint(session, extra) {
  const meta = extra && typeof extra === "object" ? extra._meta : null;
  if (!meta || typeof meta !== "object") return null;
  const ids = new Set();
  for (const e of session.streamedToolUses) if (e && e.id) ids.add(e.id);
  if (!ids.size) return null;
  for (const v of Object.values(meta)) {
    if (typeof v === "string" && ids.has(v)) return v;
  }
  return null;
}

// Claim the streamed tool_use entry that corresponds to a handler invocation.
// The SDK does not pass the tool_use id to the handler, but it passes the tool
// name (via the handler closure) and the validated input args. We correlate in
// layered priority so a correlation miss can never silently wedge a session:
//   1. Direct id (idHint) — if a real tool_use.id was forwarded via extra._meta.
//   2. Exact normalized (name + normalized input) — the primary path; defaults
//      and coercions are canceled by parsing both sides through the same schema.
//   3. Per-name single candidate — safety net for a uniquely-named tool whose
//      normalization drifted; avoids FIFO when only one entry shares the name.
//   4. Global FIFO (last resort) — preserves prior behavior, but structured log
//      + counter make the drift observable instead of a silent 4.5-min hang.
function claimStreamedToolUse(session, name, args, idHint = null) {
  // 1. Direct id.
  if (idHint) {
    const idx = session.streamedToolUses.findIndex((e) => e && e.id === idHint);
    if (idx !== -1) return session.streamedToolUses.splice(idx, 1)[0] || null;
  }

  // 2. Exact normalized (name + normalized input).
  const normArgs = normalizeToolInput(session, name, args);
  for (let i = 0; i < session.streamedToolUses.length; i++) {
    const entry = session.streamedToolUses[i];
    if (!entry || entry.name !== name) continue;
    if (isDeepStrictEqual(normalizeToolInput(session, name, entry.input), normArgs)) {
      return session.streamedToolUses.splice(i, 1)[0] || null;
    }
  }

  // 3. Per-name single candidate.
  let sameNameIdx = -1;
  let sameNameCount = 0;
  for (let i = 0; i < session.streamedToolUses.length; i++) {
    const entry = session.streamedToolUses[i];
    if (entry && entry.name === name) { sameNameIdx = i; sameNameCount++; }
  }
  if (sameNameCount === 1) {
    return session.streamedToolUses.splice(sameNameIdx, 1)[0] || null;
  }

  // 4. Global FIFO (last resort) — observable.
  if (session.streamedToolUses.length) {
    const fallback = session.streamedToolUses[0];
    session.fifoFallbacks = (session.fifoFallbacks || 0) + 1;
    metrics.totalFifoFallbacks++;
    const remaining = session.streamedToolUses.map((e) => e?.id).filter(Boolean).join(",");
    process.stderr.write(
      `${LOG_PREFIX} tool correlation FIFO fallback for ${name}: no exact match `
      + `(args=${JSON.stringify(args).slice(0, 200)}); claiming ${fallback?.id}`
      + ` (remaining: ${remaining})\n`
    );
    return session.streamedToolUses.shift();
  }
  return null;
}

// Build an SDK MCP server whose handlers PARK: when the model calls a tool, the
// handler claims the matching streamed tool_use id, then either returns a result
// that already arrived, or returns a promise that the bridge resolves when the
// client POSTs the matching tool_result. A watchdog timeout returns {isError:true}
// so the SDK agent loop survives a never-delivered tool result.
//
// Code mode is the only mode: the model is offered exactly ONE tool, `code`.
// The model writes an async JS script that calls the client's tools via
// `await tools.<Name>(args)`; the bridge fabricates synthetic client tool_use
// blocks for each await wave (see dispatchCodeWave). The native client tools are
// never registered with the SDK — they are only known to the script runtime, so
// the model has no way to call them directly.
function buildParkingMcpServer(tools, session, createServer = createSdkMcpServer, frozen = null) {
  // A frozen toolset (warm-window resume) supplies both the raw tools to seed
  // the script runtime and the exact description bytes the conversation
  // already cached.
  const sourceTools = frozen?.tools?.length ? frozen.tools : (tools || []);
  if (!sourceTools.length) return null;

  const makeHandler = (originalName) => async (args, extra) => {
    session.lastActivity = Date.now();
    const idHint = extractIdHint(session, extra);
    const entry = claimStreamedToolUse(session, originalName, args, idHint);
    const id = entry?.id;

    if (id && session.resolvedResults.has(id)) {
      const r = session.resolvedResults.get(id);
      session.resolvedResults.delete(id);
      session.lastActivity = Date.now();
      return r;
    }

    return new Promise((resolve) => {
      let settled = false;
      // The `code` handler parks for an ENTIRE multi-wave run, not a single
      // tool_result. Capping it with TOOL_TIMEOUT_MS would kill a legitimately
      // long-running script mid-run (punishing intelligent code-mode logic), so
      // it parks with no per-run clock: a genuine client disconnect is caught
      // event-driven by onClose, and a dead session (client received a wave and
      // never returned) is reclaimed by the idle sweeper (SESSION_TTL_MS,
      // refreshed on every wave POST). Every teardown path resolves this handler
      // via abandonToolRound, so dropping the timer never orphans it. Individual
      // client tools keep the bounded park so the SDK loop survives one missing
      // tool_result.
      const timer = originalName === "code" ? null : setTimeout(() => {
        if (!settled) {
          settled = true;
          if (id) session.pendingTools.delete(id);
          else {
            const idx = session.orphanResolvers.indexOf(wrappedResolve);
            if (idx !== -1) session.orphanResolvers.splice(idx, 1);
          }
          session.lastActivity = Date.now();
          process.stderr.write(`${LOG_PREFIX} tool ${id ?? originalName} park timeout after ${TOOL_TIMEOUT_MS}ms; returning isError\n`);
          resolve({ content: [{ type: "text", text: `Tool result was not provided within ${TOOL_TIMEOUT_MS}ms` }], isError: true });
        }
      }, TOOL_TIMEOUT_MS);
      timer?.unref?.();

      const wrappedResolve = (result) => {
        if (!settled) {
          settled = true;
          if (timer) clearTimeout(timer);
          session.lastActivity = Date.now();
          resolve(result);
        }
      };

      if (id) session.pendingTools.set(id, wrappedResolve);
      else session.orphanResolvers.push(wrappedResolve);
    });
  };

  session.clientTools = session.clientTools || new Map();
  for (const t of sourceTools) registerClientTool(session, t);
  // Raw tool snapshot behind the description; persisted as the frozen-toolset
  // blob and extended by mergeLateTool so a later warm resume seeds the full
  // runtime set without touching the frozen bytes.
  session.toolsetRawTools = sourceTools
    .filter((t) => t && t.name)
    .map((t) => ({
      name: t.name,
      description: t.description || "",
      input_schema: t.input_schema || { type: "object", properties: {} },
    }));

  // The script field's schema description is cached-prefix bytes too, so it is
  // frozen with the toolset: legacy blobs (persisted before scriptDesc existed)
  // resume with NO schema description — the exact bytes those conversations
  // already cached — while fresh sessions render the current prose (caveman-
  // compressed at the same level as the description, then frozen alongside it).
  const scriptDesc = frozen
    ? (typeof frozen.scriptDesc === "string" ? frozen.scriptDesc : "")
    : compressProse(SCRIPT_FIELD_DESCRIPTION, { level: cavemanLevels().tools }).text;
  session.scriptDesc = scriptDesc;
  const codeShape = codeToolInputShape(z, scriptDesc);
  // The description's bytes are part of the conversation's cached prefix: a
  // warm-window resume MUST reuse the persisted bytes verbatim (a re-render
  // with a grown tool list or newer prose re-writes the whole prefix at 2x).
  // Fresh sessions and past-TTL resumes render live — the only moments the
  // bytes are allowed to change.
  const description = typeof frozen?.description === "string" && frozen.description
    ? frozen.description
    : buildCodeToolDescription(session.clientTools);
  session.codeDescription = description;
  session.descHash = createHash("sha256").update(description).digest("hex").slice(0, 12);
  // Fresh compressed render: measure once against the uncompressed baseline so
  // savings are observable (stderr here, cavemanSaved in the cache-log receipt).
  // Frozen resumes replay persisted bytes — nothing was rendered, no receipt.
  if (!frozen && cavemanLevels().tools !== "off") {
    const rawBytes = Buffer.byteLength(buildCodeToolDescription(session.clientTools, { caveman: "off" }), "utf8")
      + Buffer.byteLength(SCRIPT_FIELD_DESCRIPTION, "utf8");
    const outBytes = Buffer.byteLength(description, "utf8") + Buffer.byteLength(scriptDesc, "utf8");
    session.cavemanDescSaved = Math.max(0, rawBytes - outBytes);
    const pct = rawBytes ? Math.round((session.cavemanDescSaved / rawBytes) * 100) : 0;
    process.stderr.write(`${LOG_PREFIX} caveman ${cavemanLevels().tools}: code description ${rawBytes}B -> ${outBytes}B (saved ${session.cavemanDescSaved}B, ${pct}%)\n`);
  }
  const codeTool = {
    name: "code",
    description,
    inputSchema: codeShape,
    handler: makeHandler("code"),
  };
  return createServer({ name: "bridge", tools: [codeTool], alwaysLoad: true });
}

// Register one client tool with the session's script runtime: normalized meta
// in session.clientTools (drives the per-run worker catalog, the rendered
// description for NEW sessions, and dispatch lookups) and a canonical z.object
// parser in session.inputParsers (built from the RAW schema — anchor fields
// are translated back to native before validation, mirroring the MCP layer's
// validateToolInput so claimStreamedToolUse can normalize both the streamed
// raw input and the handler's parsed args to the same form). Anchor editing is
// additive in code mode: the native old_string path still works (scripts
// derive bytes from the Read result), and anchor fields are merged in as
// OPTIONAL so the rendered `code` signature documents both. Safe to call
// mid-conversation: neither map feeds a frozen `code` description, so late
// registration never changes cached-prefix bytes.
function registerClientTool(session, t) {
  const anchorOn = ANCHORED_EDIT_TOOLS.has(t.name);
  session.clientTools.set(t.name, normalizeClientToolMeta(t.name, {
    description: anchorOn ? patchCodeEditDescription(t.name, t.description || "") : (t.description || ""),
    input_schema: anchorOn
      ? mergeAnchorEditSchema(t.name, t.input_schema || { type: "object", properties: {} })
      : (t.input_schema || { type: "object", properties: {} }),
  }));
  const shape = toolInputShape(t.input_schema || { type: "object", properties: {} });
  try {
    const parser = z.object(shape);
    if (session.inputParsers) session.inputParsers.set(t.name, parser);
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} z.object(shape) failed for ${t.name} (${String(e?.message || e).slice(0, 100)}); correlation will use raw input\n`);
  }
}

// A tool that arrives after the conversation's `code` description froze: make
// it fully callable through the script runtime (the worker catalog and wave
// validation read session.clientTools at every run) and queue an in-band
// announcement for the next code tool_result. Appending to the transcript
// extends the cache incrementally; the frozen description is never
// re-rendered, so the cached prefix stays byte-identical.
function mergeLateTool(session, t) {
  registerClientTool(session, t);
  if (Array.isArray(session.toolsetRawTools)) {
    session.toolsetRawTools.push({
      name: t.name,
      description: t.description || "",
      input_schema: t.input_schema || { type: "object", properties: {} },
    });
  }
  session.lateTools = session.lateTools || new Set();
  session.lateTools.add(t.name);
  session.pendingToolNotice = session.pendingToolNotice || new Set();
  session.pendingToolNotice.add(t.name);
  process.stderr.write(`${LOG_PREFIX} tool ${t.name} arrived after session start key=${session.key ? session.key.slice(0, 8) : "?"}; merged into the script runtime (frozen code description unchanged)\n`);
}

// Deliver queued late-tool announcements on a code tool_result. Mutates the
// result's first text block in place and clears the queue once delivered.
// Append one in-band note to a collapsed code result. Tool_result text is
// append-only transcript: it extends the cache incrementally and never touches
// the frozen description bytes — the safe channel for all dynamic info.
function appendCodeResultNote(collapsed, note) {
  const block = collapsed?.content?.[0];
  if (!block || typeof block.text !== "string" || !note) return collapsed;
  block.text = block.text ? `${block.text}\n\n${note}` : note;
  return collapsed;
}

function appendPendingToolNotice(session, collapsed) {
  if (!session.pendingToolNotice?.size) return collapsed;
  const names = [...session.pendingToolNotice].sort();
  const note = `[new tools available (not in the docs above): ${names.join(", ")} — call them normally; docs via codemode.describe(${JSON.stringify(names[0])})]`;
  appendCodeResultNote(collapsed, note);
  session.pendingToolNotice = null;
  return collapsed;
}

// Serialized byte size of the script's `state`. Plain JSON.stringify counts a
// Map/Set as "{}", so Map/Set-heavy state would dodge the cap entirely; the
// replacer expands them to their entries for counting purposes only.
function stateByteSize(state) {
  const json = JSON.stringify(state, (_k, v) => {
    if (v instanceof Map) return { "@map": [...v.entries()] };
    if (v instanceof Set) return { "@set": [...v.values()] };
    return v;
  });
  return Buffer.byteLength(json ?? "null", "utf8");
}

export {
  toolInputShape,
  fallbackShape,
  jsonSchemaToZod,
  stripBridgeToolName,
  normalizeToolInput,
  extractIdHint,
  claimStreamedToolUse,
  buildParkingMcpServer,
  registerClientTool,
  mergeLateTool,
  appendCodeResultNote,
  appendPendingToolNotice,
  stateByteSize,
};
