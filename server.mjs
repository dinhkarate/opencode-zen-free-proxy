import express from "express";
import crypto from "crypto";
import https from "https";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PROXY_PORT || 6446;
// Bind address: default 0.0.0.0 for local use; set PROXY_HOST=127.0.0.1 on
// public VPSes (front them via a reverse proxy or SSH tunnel instead).
const HOST = process.env.PROXY_HOST || "0.0.0.0";
// Must stay >= 1.18.0 — older clients get 426 UpgradeRequired on free tier.
const OC_VERSION = "1.18.31";
const UA_CHAT = `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`;
const UA_RESPONSES = `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14`;
const PROXY_VERSION = "10";

// ── API Keys ───────────────────────────────────────────────────────
const keysFile = process.env.KEYS_FILE || "./api-keys.json";
let apiKeys = {};
function loadKeys() {
  try { apiKeys = JSON.parse(fs.readFileSync(keysFile, "utf8")); } catch {}
  if (Object.keys(apiKeys).length === 0) {
    apiKeys = {
      admin: "oc-" + crypto.randomBytes(20).toString("hex"),
      "user-default": "oc-" + crypto.randomBytes(20).toString("hex"),
    };
    fs.writeFileSync(keysFile, JSON.stringify(apiKeys, null, 2));
    console.log("[INIT] Generated new API keys →", keysFile);
  }
}
loadKeys();

function auth(req) {
  const hdr = req.headers.authorization || req.headers["x-api-key"] || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  for (const [name, key] of Object.entries(apiKeys)) {
    if (tok === key) return name;
  }
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────
// Exact replica of opencode's ID generator (packages/opencode/src/id/id.ts):
// prefix + 12 lowercase hex chars (48-bit time, ascending) or its bitwise
// complement (descending) + 14 random base62 chars. The Zen free tier
// validates this format and rejects stale/fake `msg_` IDs with 403.
let _lastTs = 0;
let _counter = 0;
function _randomBase62(length) {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let result = "";
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) result += chars[bytes[i] % 62];
  return result;
}
function _createId(prefix, direction, timestamp) {
  const now_ts = timestamp ?? Date.now();
  if (now_ts !== _lastTs) { _lastTs = now_ts; _counter = 0; }
  _counter++;
  let now = BigInt(now_ts) * BigInt(0x1000) + BigInt(_counter);
  now = direction === "descending" ? ~now : now;
  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }
  return prefix + "_" + timeBytes.toString("hex") + _randomBase62(14);
}
function ocId(prefix) {
  // sessions are descending, requests/messages ascending — like opencode
  return _createId(prefix, prefix === "ses" ? "descending" : "ascending");
}

const CHAT_MODELS = [
  "big-pickle",
  "mimo-v2.5-free",
  "nemotron-3-ultra-free",
];
const RESPONSES_MODELS = [
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
];
const MODELS = [...CHAT_MODELS, ...RESPONSES_MODELS];

// Zen free tier requires tools named exactly "bash" AND "read" in the
// request (its "only from within OpenCode" check). Inject minimal dummies
// when the client didn't send them.
function ensureChatTools(tools) {
  const list = Array.isArray(tools) ? [...tools] : [];
  const names = new Set(list.map((t) => t?.function?.name).filter(Boolean));
  const dummy = (name) => ({
    type: "function",
    function: { name, description: "Available tool", parameters: { type: "object", properties: {} } },
  });
  if (!names.has("bash")) list.push(dummy("bash"));
  if (!names.has("read")) list.push(dummy("read"));
  return list;
}

function ensureResponsesTools(tools) {
  const list = Array.isArray(tools) ? [...tools] : [];
  const names = new Set(list.map((t) => t?.name).filter(Boolean));
  const dummy = (name) => ({
    type: "function", name, description: "Available tool",
    parameters: { type: "object", properties: {}, required: [] },
  });
  if (!names.has("bash")) list.push(dummy("bash"));
  if (!names.has("read")) list.push(dummy("read"));
  return list;
}

// Track sessions per user (rotate every 30 min)
const userSessions = {};
function getSession(user) {
  const now = Date.now();
  if (!userSessions[user] || now - userSessions[user].ts > 30 * 60 * 1000) {
    userSessions[user] = { id: ocId("ses"), ts: now };
  }
  return userSessions[user].id;
}

// ── Zen API transport ──────────────────────────────────────────────
// Free tier only serves stream:true requests carrying bash+read tools,
// so we ALWAYS request SSE upstream and aggregate locally when the
// downstream client asked for a non-streaming response.
function zenRequest(model, messages, tools, tool_choice, sessionId, max_tokens) {
  const reqBody = { model, messages, stream: true, stream_options: { include_usage: true } };
  reqBody.tools = ensureChatTools(tools);
  if (tool_choice) reqBody.tool_choice = tool_choice;
  if (max_tokens) reqBody.max_tokens = max_tokens;
  const body = JSON.stringify(reqBody);
  const requestId = ocId("msg");

  return {
    body,
    options: {
      hostname: "opencode.ai",
      port: 443,
      path: "/zen/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": "Bearer public",
        "User-Agent": UA_CHAT,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-request": requestId,
        "x-opencode-session": sessionId,
      },
      timeout: 120000,
    },
  };
}

function zenRequestResponses(model, input, tools, tool_choice, sessionId, extra = {}) {
  const reqBody = { model, input, stream: true };
  reqBody.tools = ensureResponsesTools(tools);
  if (tool_choice) reqBody.tool_choice = tool_choice;
  if (extra.max_output_tokens) reqBody.max_output_tokens = extra.max_output_tokens;
  if (extra.instructions) reqBody.instructions = extra.instructions;
  if (extra.reasoning) reqBody.reasoning = extra.reasoning;
  const body = JSON.stringify(reqBody);
  const requestId = ocId("msg");

  return {
    body,
    options: {
      hostname: "opencode.ai",
      port: 443,
      path: "/zen/v1/responses",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": "Bearer public",
        "User-Agent": UA_RESPONSES,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-request": requestId,
        "x-opencode-session": sessionId,
      },
      timeout: 120000,
    },
  };
}

// Pipe Zen SSE stream to client (OpenAI format passthrough; upstream is
// always SSE, see zenRequest)
// Upstream errors worth one transparent retry (fresh msg ID). Model/support
// errors (401/426/ModelError/...) are returned immediately.
function retryableUpstreamError(parsed) {
  const msg = parsed?.error?.message || parsed?.message || "";
  const type = parsed?.error?.type || "";
  if (type === "FreeTierError") return true;
  if (/rate.?limit|429|overloaded|temporar|try again/i.test(msg)) return true;
  return false;
}

// build: () => ({ body, options }) — called fresh per attempt so each retry
// gets a new x-opencode-request ID.
function pipeZenResponse(build, res, attempts = 2) {
  const { body, options: zenOpts } = build();
  const req = https.request(zenOpts, (zenRes) => {
    let firstChunk = null;
    let headersSent = false;

    zenRes.on("data", (chunk) => {
      if (!firstChunk) {
        firstChunk = chunk;
        const str = chunk.toString().trim();

        if (str.startsWith("{") && (str.includes("FreeUsageLimitError") || str.includes('"error"'))) {
          try {
            const parsed = JSON.parse(str);
            if (parsed.error || parsed.type === "error") {
              const errMsg = parsed.error?.message || parsed.message || "Rate limit exceeded";
              if (attempts > 1 && retryableUpstreamError(parsed)) {
                console.log("[ZEN RETRY] transient upstream error, retrying:", errMsg.slice(0, 120));
                zenRes.resume();
                setTimeout(() => pipeZenResponse(build, res, attempts - 1), 1000);
                return;
              }
              console.log("[ZEN RATE LIMITED]", errMsg);
              if (!res.headersSent) {
                res.status(429).json({
                  error: { message: errMsg + " (free model rate limit)", type: "rate_limit_error", code: "rate_limit_exceeded" }
                });
              }
              zenRes.resume();
              return;
            }
          } catch {}
        }

        headersSent = true;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
          "Transfer-Encoding": "chunked",
        });
        res.flushHeaders();
        res.write(firstChunk);
        if (res.flush) res.flush();
        return;
      }
      if (headersSent) {
        res.write(chunk);
        if (res.flush) res.flush();
      }
    });

    zenRes.on("end", () => {
      if (!headersSent && !firstChunk) {
        console.log("[ZEN EMPTY] No response from Zen API");
        if (!res.headersSent) {
          res.status(502).json({ error: { message: "Empty response from upstream", type: "upstream_error" } });
        }
        return;
      }
      if (headersSent) res.end();
    });
  });

  req.on("error", (e) => {
    console.log("[ZEN ERROR]", e.message);
    if (!res.headersSent) {
      res.status(502).json({ error: { message: "Upstream error: " + e.message, type: "upstream_error" } });
    }
  });

  req.on("timeout", () => {
    req.destroy();
    console.log("[ZEN TIMEOUT]");
    if (!res.headersSent) {
      res.status(504).json({ error: { message: "Upstream timeout", type: "timeout_error" } });
    }
  });

  req.write(body);
  req.end();
}

// Parse SSE "data:" payloads from an upstream event-stream response.
function eachSSEPayload(raw, cb) {
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    try { cb(JSON.parse(payload)); } catch {}
  }
}

// Collect a streamed chat/completions SSE response into one OpenAI-style
// chat.completion object (used when downstream asked for stream:false).
function collectChatSSE(build, model, attempts = 2) {
  const { body, options: zenOpts } = build();
  return new Promise((resolve, reject) => {
    const req = https.request(zenOpts, (zenRes) => {
      const chunks = [];
      zenRes.on("data", (c) => chunks.push(c));
      zenRes.on("end", async () => {
        const raw = Buffer.concat(chunks).toString();
        if (raw.trim().startsWith("{")) {
          try {
            const parsed = JSON.parse(raw.trim());
            if (parsed.error || parsed.type === "error") {
              if (attempts > 1 && retryableUpstreamError(parsed)) {
                console.log("[ZEN RETRY] transient upstream error, retrying");
                await new Promise((r) => setTimeout(r, 1000));
                return resolve(collectChatSSE(build, model, attempts - 1));
              }
              return resolve({ error: parsed, status: zenRes.statusCode });
            }
          } catch {}
        }
        let content = "";
        const toolMap = new Map();
        let finishReason = "stop";
        let usage;
        let respId, created;
        eachSSEPayload(raw, (p) => {
          const choice = p.choices?.[0];
          if (!choice) return;
          if (p.id) respId = p.id;
          if (p.created) created = p.created;
          const delta = choice.delta || {};
          if (typeof delta.content === "string") content += delta.content;
          if (delta.reasoning_content && !content) content += delta.reasoning_content;
          for (const tc of delta.tool_calls || []) {
            const idx = tc.index ?? 0;
            if (!toolMap.has(idx)) toolMap.set(idx, { id: tc.id, name: "", args: "" });
            const cur = toolMap.get(idx);
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
          if (p.usage) usage = p.usage;
        });
        if (!respId && !content && toolMap.size === 0) {
          return resolve({ error: { error: { message: "Empty response from upstream", type: "upstream_error" } }, status: 502 });
        }
        const tool_calls = [...toolMap.values()]
          .filter((t) => t.name)
          .map((t) => ({
            id: t.id || ("call_" + crypto.randomBytes(12).toString("hex")),
            type: "function",
            function: { name: t.name, arguments: t.args || "{}" },
          }));
        const message = { role: "assistant", content: content || null };
        if (tool_calls.length) message.tool_calls = tool_calls;
        resolve({
          status: 200,
          data: {
            id: respId || ocId("chatcmpl"),
            object: "chat.completion",
            created: created || Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, message, finish_reason: tool_calls.length ? "tool_calls" : finishReason }],
            usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          },
        });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

// Collect a streamed Responses SSE response. The terminal
// `response.completed` event carries the full response object.
function collectResponsesSSE(build, attempts = 2) {
  const { body, options: zenOpts } = build();
  return new Promise((resolve, reject) => {
    const req = https.request(zenOpts, (zenRes) => {
      const chunks = [];
      zenRes.on("data", (c) => chunks.push(c));
      zenRes.on("end", async () => {
        const raw = Buffer.concat(chunks).toString();
        if (raw.trim().startsWith("{")) {
          try {
            const parsed = JSON.parse(raw.trim());
            if (parsed.error || parsed.type === "error") {
              if (attempts > 1 && retryableUpstreamError(parsed)) {
                console.log("[ZEN RETRY] transient upstream error, retrying");
                await new Promise((r) => setTimeout(r, 1000));
                return resolve(collectResponsesSSE(build, attempts - 1));
              }
              return resolve({ error: parsed, status: zenRes.statusCode });
            }
          } catch {}
        }
        let completed = null;
        let lastResponse = null;
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const evt = JSON.parse(payload);
            if (evt.response) lastResponse = evt.response;
            if (evt.type === "response.completed" && evt.response) completed = evt.response;
          } catch {}
        }
        if (completed) return resolve({ status: 200, data: completed });
        if (lastResponse) return resolve({ status: 200, data: lastResponse });
        return resolve({ error: { error: { message: "Empty response from upstream", type: "upstream_error" } }, status: 502 });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

// ── Anthropic Messages → OpenAI conversion ─────────────────────────
function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys = typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map(b => b.text || "").join("\n") : "";
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n");
      // tool_use blocks → assistant tool_calls
      const toolUses = msg.content.filter(b => b.type === "tool_use");
      if (toolUses.length && msg.role === "assistant") {
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolUses.map(t => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
          })),
        });
      } else if (msg.content.some(b => b.type === "tool_result")) {
        for (const b of msg.content.filter(b => b.type === "tool_result")) {
          const resultText = typeof b.content === "string" ? b.content
            : Array.isArray(b.content) ? b.content.map(c => c.text || "").join("\n") : "";
          messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: resultText });
        }
      } else {
        messages.push({ role: msg.role, content: text });
      }
    }
  }

  const tools = (body.tools || []).map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || {},
    },
  }));

  return { messages, tools: tools.length ? tools : undefined };
}

// OpenAI response → Anthropic Messages format
function openAIToAnthropic(oaiResp, model, inputTokens) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: ocId("msg"),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model,
      stop_reason: "end_turn",
      usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  }

  const content = [];
  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch {}
      content.push({
        type: "tool_use",
        id: tc.id || ocId("toolu"),
        name: tc.function.name,
        input,
      });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });

  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";
  else if (choice.finish_reason === "stop") stopReason = "end_turn";

  return {
    id: ocId("msg"),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || inputTokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

// Stream OpenAI SSE → Anthropic SSE
function pipeZenAsAnthropic(build, model, res, inputTokens, attempts = 2) {
  const msgId = ocId("msg");
  const { body, options: zenOpts } = build();

  const req = https.request(zenOpts, (zenRes) => {
    let headersSent = false;
    let buffer = "";
    let outputTokens = 0;
    let contentIdx = 0;
    let toolIdx = -1;
    let firstChunkHandled = false;

    function sendSSE(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (res.flush) res.flush();
    }

    function sendHeaders() {
      if (headersSent) return;
      headersSent = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      sendSSE("message_start", {
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant", content: [],
          model, stop_reason: null,
          usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });
    }

    zenRes.on("data", (chunk) => {
      const str = chunk.toString();

      // Check for errors on first chunk
      if (!firstChunkHandled) {
        firstChunkHandled = true;
        const trimmed = str.trim();
        if (trimmed.startsWith("{") && (trimmed.includes("FreeUsageLimitError") || trimmed.includes('"error"'))) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.error || parsed.type === "error") {
              const errMsg = parsed.error?.message || parsed.message || "Rate limit";
              if (attempts > 1 && retryableUpstreamError(parsed)) {
                console.log("[ZEN RETRY] transient upstream error, retrying");
                zenRes.resume();
                setTimeout(() => pipeZenAsAnthropic(build, model, res, inputTokens, attempts - 1), 1000);
                return;
              }
              if (!res.headersSent) {
                res.writeHead(429, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  type: "error",
                  error: { type: "rate_limit_error", message: errMsg + " (free model rate limit)" },
                }));
              }
              zenRes.resume();
              return;
            }
          } catch {}
        }
      }

      buffer += str;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;

        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        sendHeaders();

        // Text content
        if (delta.content) {
          if (contentIdx === 0 && toolIdx === -1) {
            sendSSE("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
            contentIdx = 1;
          }
          sendSSE("content_block_delta", {
            type: "content_block_delta", index: 0,
            delta: { type: "text_delta", text: delta.content },
          });
          outputTokens += Math.ceil(delta.content.length / 4);
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (idx > toolIdx) {
              // Close previous text block if open
              if (toolIdx === -1 && contentIdx > 0) {
                sendSSE("content_block_stop", { type: "content_block_stop", index: 0 });
              }
              toolIdx = idx;
              const blockIdx = contentIdx > 0 ? idx + 1 : idx;
              sendSSE("content_block_start", {
                type: "content_block_start", index: blockIdx,
                content_block: { type: "tool_use", id: tc.id || ocId("toolu"), name: tc.function?.name || "" },
              });
            }
            if (tc.function?.arguments) {
              const blockIdx = contentIdx > 0 ? idx + 1 : idx;
              sendSSE("content_block_delta", {
                type: "content_block_delta", index: blockIdx,
                delta: { type: "input_json_delta", partial_json: tc.function.arguments },
              });
              outputTokens += Math.ceil(tc.function.arguments.length / 4);
            }
          }
        }

        // Finish
        if (parsed.choices?.[0]?.finish_reason) {
          const fr = parsed.choices[0].finish_reason;
          // Close open blocks
          const totalBlocks = (contentIdx > 0 ? 1 : 0) + (toolIdx >= 0 ? toolIdx + 1 : 0);
          for (let i = 0; i < totalBlocks; i++) {
            sendSSE("content_block_stop", { type: "content_block_stop", index: i });
          }

          let stopReason = "end_turn";
          if (fr === "tool_calls") stopReason = "tool_use";
          else if (fr === "length") stopReason = "max_tokens";

          sendSSE("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason },
            usage: { output_tokens: outputTokens },
          });
          sendSSE("message_stop", { type: "message_stop" });
        }
      }
    });

    zenRes.on("end", () => {
      if (!headersSent) {
        if (!res.headersSent) {
          res.status(502).json({ type: "error", error: { type: "upstream_error", message: "Empty response" } });
        }
        return;
      }
      res.end();
    });
  });

  req.on("error", (e) => {
    console.log("[ZEN ERROR]", e.message);
    if (!res.headersSent) {
      res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
    }
  });

  req.on("timeout", () => {
    req.destroy();
    if (!res.headersSent) {
      res.status(504).json({ type: "error", error: { type: "timeout_error", message: "Upstream timeout" } });
    }
  });

  req.write(body);
  req.end();
}

// ── Routes: OpenAI format ──────────────────────────────────────────
app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: MODELS.map((id) => ({
      id, object: "model", created: 1779000000, owned_by: "opencode-free",
    })),
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: { message: "Invalid API key" } });

  const { model, messages, stream, tools, tool_choice, max_tokens } = req.body;
  if (!CHAT_MODELS.includes(model)) {
    return res.status(400).json({ error: { message: `Unknown model: ${model}. Chat models: ${CHAT_MODELS.join(", ")}. Responses models: ${RESPONSES_MODELS.join(", ")}` } });
  }

  const sessionId = getSession(user);
  const msgSummary = (messages || []).map(m => ({ role: m.role, len: (typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")).length }));
  console.log("[OAI]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", JSON.stringify(msgSummary));

  const buildChat = () => zenRequest(model, messages, tools, tool_choice, sessionId, max_tokens);
  if (stream) {
    pipeZenResponse(buildChat, res);
  } else {
    try {
      const collected = await collectChatSSE(buildChat, model);
      if (collected.error) {
        const errMsg = collected.error?.error?.message || "Upstream error";
        const code = collected.status === 429 ? 429 : 502;
        return res.status(code).json({ error: { message: errMsg, type: "upstream_error" } });
      }
      res.json(collected.data);
    } catch (e) {
      console.log("[ZEN ERROR]", e.message);
      if (!res.headersSent) {
        res.status(502).json({ error: { message: "Upstream error: " + e.message, type: "upstream_error" } });
      }
    }
  }
});

// ── Routes: OpenAI Responses format (muse-spark-*) ───────────────────
app.post("/v1/responses", async (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: { message: "Invalid API key" } });

  const { model, input, stream, tools, tool_choice, max_output_tokens, instructions, reasoning } = req.body;
  if (!RESPONSES_MODELS.includes(model)) {
    return res.status(400).json({ error: { message: `Unknown model: ${model}. Responses models: ${RESPONSES_MODELS.join(", ")}` } });
  }

  const sessionId = getSession(user);
  console.log("[RSP]", new Date().toISOString(), user, model, stream ? "stream" : "sync",
    "inputLen:", JSON.stringify(input || "").length);

  const buildResp = () => zenRequestResponses(model, input, tools, tool_choice, sessionId,
    { max_output_tokens, instructions, reasoning });
  if (stream) {
    pipeZenResponse(buildResp, res);
  } else {
    try {
      const collected = await collectResponsesSSE(buildResp);
      if (collected.error) {
        const errMsg = collected.error?.error?.message || "Upstream error";
        const code = collected.status === 429 ? 429 : 502;
        return res.status(code).json({ error: { message: errMsg, type: "upstream_error" } });
      }
      res.json(collected.data);
    } catch (e) {
      console.log("[ZEN ERROR]", e.message);
      if (!res.headersSent) {
        res.status(502).json({ error: { message: "Upstream error: " + e.message, type: "upstream_error" } });
      }
    }
  }
});

// ── Routes: Anthropic Messages format ──────────────────────────────
app.post("/v1/messages", async (req, res) => {
  const user = auth(req);
  if (!user) {
    return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
  }

  const { model, stream } = req.body;
  if (!CHAT_MODELS.includes(model)) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: `Unknown model: ${model}. Chat models: ${CHAT_MODELS.join(", ")}` },
    });
  }

  const sessionId = getSession(user);
  const { messages, tools } = anthropicToOpenAI(req.body);
  const inputTokens = JSON.stringify(messages).length / 4 | 0;

  console.log("[ANT]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", messages.length);

  const buildAnt = () => zenRequest(model, messages, tools, undefined, sessionId, req.body.max_tokens);

  if (stream) {
    pipeZenAsAnthropic(buildAnt, model, res, inputTokens);
  } else {
    try {
      const collected = await collectChatSSE(buildAnt, model);
      if (collected.error) {
        const errMsg = collected.error?.error?.message || "Upstream error";
        return res.status(collected.status === 429 ? 429 : 502).json({
          type: "error", error: { type: "upstream_error", message: errMsg },
        });
      }
      res.json(openAIToAnthropic(collected.data, model, inputTokens));
    } catch (e) {
      console.log("[ZEN ERROR]", e.message);
      res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
    }
  }
});

// ── Health ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status: "ok", version: `v${PROXY_VERSION}`, models: MODELS.length,
  endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1/models"],
}));

// ── Start ──────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`OpenCode Free Proxy v${PROXY_VERSION} on http://${HOST}:${PORT}`);
  console.log("  OpenAI:    POST /v1/chat/completions  (big-pickle, mimo-v2.5-free, nemotron-3-ultra-free)");
  console.log("  Responses: POST /v1/responses         (muse-spark-*-contributor-free)");
  console.log("  Anthropic: POST /v1/messages");
  console.log("  Models:    GET  /v1/models");
  console.log("  Health:    GET  /health");
  console.log("  Models:", MODELS.join(", "));
  for (const [name, key] of Object.entries(apiKeys)) {
    console.log(`  ${name.padEnd(15)} ${key}`);
  }
});
