#!/usr/bin/env node
/**
 * stress-test.mjs — load tester for opencode-zen-free-proxy (or any
 * OpenAI-compatible endpoint: OpenAI, OpenRouter, LM Studio, vLLM, ...).
 *
 * Zero dependencies, runs on Node 18+.
 *
 * Usage:
 *   node stress-test.mjs --key YOUR_KEY [options]
 *
 * Examples:
 *   # quick check against the local proxy
 *   node stress-test.mjs -k oc-xxxx
 *
 *   # concurrency ramp, 6 requests per level
 *   node stress-test.mjs -k oc-xxxx -c 1,5,10,20 -n 6
 *
 *   # a specific model + save a machine-readable report
 *   node stress-test.mjs -k oc-xxxx -m mimo-v2.5-free -c 5 -n 25 --json report.json
 *
 *   # Responses API (e.g. muse-spark on opencode-zen-free-proxy)
 *   node stress-test.mjs -k oc-xxxx -m muse-spark-1.3-contributor-free --responses
 *
 *   # any OpenAI-compatible server
 *   node stress-test.mjs -b https://api.openai.com/v1 -k sk-xxxx -m gpt-4o-mini -c 3 -n 9
 */

const DEFAULTS = {
  baseUrl: "http://localhost:6446/v1",
  key: process.env.OPENAI_API_KEY || "",
  model: "big-pickle",
  concurrency: "1",
  requests: 10,
  prompt: "Say hi",
  maxTokens: 600,
  timeoutMs: 90_000,
  responses: false,
  stream: false,
  json: "",
  warmup: 1,
  pauseMs: 1_500,
};

const HELP = `load tester for opencode-zen-free-proxy (or any OpenAI-compatible endpoint)

options:
  -b, --base-url URL      API base URL              (default ${DEFAULTS.baseUrl})
  -k, --key KEY           API key                   (env OPENAI_API_KEY also works)
  -m, --model NAME        model name                (default ${DEFAULTS.model})
  -c, --concurrency N     in-flight requests; CSV ramps level by level
                          e.g. 1,5,10,20            (default 1)
  -n, --requests N        total requests per level  (default ${DEFAULTS.requests})
  -p, --prompt TEXT       prompt for every request  (default "${DEFAULTS.prompt}")
  -t, --max-tokens N      completion token cap      (default ${DEFAULTS.maxTokens})
      --timeout MS        per-request timeout (ms)  (default ${DEFAULTS.timeoutMs})
      --responses         call /responses instead of /chat/completions
      --stream            use streaming requests (measures time-to-first-token)
      --warmup N          single warmup request before measuring (default ${DEFAULTS.warmup})
      --pause MS          pause between ramp levels (default ${DEFAULTS.pauseMs})
      --json FILE         write a JSON report to FILE
  -h, --help              show this help

exit codes: 0 = all levels had 0 failures, 1 = some failures, 2 = bad usage`;

// ── args ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const need = (name, val) => {
    if (val === undefined) throw new Error(`${name} requires a value (--help)`);
    return val;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => need(a, argv[++i]);
    switch (a) {
      case "-b": case "--base-url":  opts.baseUrl  = v().replace(/\/+$/, ""); break;
      case "-k": case "--key":       opts.key      = v(); break;
      case "-m": case "--model":     opts.model    = v(); break;
      case "-c": case "--concurrency": opts.concurrencyList = v(); break;
      case "-n": case "--requests":  opts.requests = +v(); break;
      case "-p": case "--prompt":    opts.prompt   = v(); break;
      case "-t": case "--max-tokens": opts.maxTokens = +v(); break;
      case "--responses":            opts.responses = true; break;
      case "--stream":               opts.stream    = true; break;
      case "--timeout":              opts.timeoutMs = +v(); break;
      case "--warmup":               opts.warmup    = +v(); break;
      case "--pause":                opts.pauseMs   = +v(); break;
      case "--json":                 opts.json      = v(); break;
      case "-h": case "--help":      opts.help = true; break;
      default: throw new Error(`unknown option: ${a} (--help)`);
    }
  }
  if (!opts.concurrencyList) opts.concurrencyList = DEFAULTS.concurrency;
  opts.levels = opts.concurrencyList.split(",").map(s => {
    const c = +s.trim();
    if (!Number.isInteger(c) || c < 1) throw new Error(`bad --concurrency value: "${s.trim()}"`);
    return c;
  });
  for (const n of ["requests", "maxTokens", "timeoutMs", "warmup", "pauseMs"]) {
    if (!Number.isFinite(opts[n]) || opts[n] < 0) throw new Error(`bad value for ${n}: ${opts[n]}`);
  }
  return opts;
}

// ── request building / calling ──────────────────────────────────────
const endpoint = o => `${o.baseUrl}${o.responses ? "/responses" : "/chat/completions"}`;

function buildBody(o) {
  return o.responses
    ? { model: o.model, input: o.prompt, stream: o.stream }
    : {
        model: o.model,
        messages: [{ role: "user", content: o.prompt }],
        max_tokens: o.maxTokens,
        stream: o.stream,
      };
}

// Extract visible text from either API shape (handles SSE chunks too).
function extractText(payloads, responses) {
  let text = "";
  for (const j of payloads) {
    if (responses) {
      if (j.type === "response.output_text.delta") text += j.delta || "";
      else if (j.output)
        text += j.output
          .filter(x => x.type === "message")
          .flatMap(x => x.content || [])
          .filter(c => c.type === "output_text")
          .map(c => c.text || "")
          .join("");
    } else {
      if (j.choices?.[0]?.message?.content) text += j.choices[0].message.content;
      else if (j.choices?.[0]?.delta?.content) text += j.choices[0].delta.content;
    }
  }
  return text;
}

async function callOnce(o) {
  const t0 = Date.now();
  let firstTokenMs = null;
  try {
    const res = await fetch(endpoint(o), {
      method: "POST",
      headers: { Authorization: `Bearer ${o.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(o)),
      signal: AbortSignal.timeout(o.timeoutMs),
    });

    const payloads = [];
    if (o.stream && res.ok) {
      // parse SSE so we can measure time-to-first-token
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try { payloads.push(JSON.parse(data)); } catch { /* keep-alive */ }
          if (firstTokenMs === null && extractText(payloads, o.responses)) firstTokenMs = Date.now() - t0;
        }
      }
    } else {
      const txt = await res.text();
      try { payloads.push(JSON.parse(txt)); } catch { /* non-JSON error page */ }
      payloads.raw = txt;
    }

    const text = extractText(payloads, o.responses);
    const ok = res.status === 200 && text.length > 0;
    return {
      ok,
      status: res.status,
      ms: Date.now() - t0,
      ttfbMs: firstTokenMs,
      chars: text.length,
      error: ok ? "" : (payloads.raw || text || payloads[0]?.error?.message || "").slice(0, 120),
    };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, ttfbMs: null, chars: 0, error: `${e.name}: ${e.message}`.slice(0, 120) };
  }
}

// ── level runner + stats ────────────────────────────────────────────
async function runLevel(concurrency, o) {
  const results = new Array(o.requests);
  let next = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let i = next++; i < o.requests; i = next++) results[i] = await callOnce(o);
    }),
  );
  const wallMs = Date.now() - t0;

  const pass = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);
  const p = q => {
    const lat = pass.map(r => r.ms).sort((a, b) => a - b);
    return lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] : 0;
  };
  const errors = {};
  for (const r of fail) {
    const tag = r.status || "network";
    errors[tag] = (errors[tag] || 0) + 1;
  }
  const ttfbs = pass.map(r => r.ttfbMs).filter(Boolean).sort((a, b) => a - b);

  return {
    concurrency,
    requests: o.requests,
    pass: pass.length,
    fail: fail.length,
    wallMs,
    rps: +(pass.length / (wallMs / 1000)).toFixed(2),
    p50ms: p(0.5), p90ms: p(0.9), p99ms: p(0.99), maxMs: p(1),
    ttftP50ms: ttfbs.length ? ttfbs[ttfbs.length >> 1] : null,
    errors: Object.keys(errors).length ? errors : undefined,
    samples: results.map(r => ({ ok: r.ok, status: r.status, ms: r.ms, error: r.error || undefined })),
  };
}

function printLevel(l, o) {
  const pct = (l.pass / (l.pass + l.fail) * 100).toFixed(1);
  const lat = o.stream
    ? `ttft_p50=${l.ttftP50ms ?? "-"}ms total p50=${l.p50ms}ms p99=${l.p99ms}ms`
    : `p50=${l.p50ms}ms p90=${l.p90ms}ms p99=${l.p99ms}ms max=${l.maxMs}ms`;
  console.log(
    `  conc=${String(l.concurrency).padStart(3)}  ${l.pass}/${l.requests} ok (${pct}%)  ` +
    `${l.rps} req/s  ${lat}` + (l.errors ? `  errors=${JSON.stringify(l.errors)}` : ""),
  );
  for (const s of l.samples) {
    if (!s.ok) console.log(`      ✗ ${s.status || "net"} ${s.error || "empty response"}`);
  }
}

// ── main ────────────────────────────────────────────────────────────
async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.key) { console.error("error: an API key is required (-k/--key or env OPENAI_API_KEY)\n"); console.log(HELP); process.exit(2); }

  console.log(`stress-test: ${opts.model} via ${endpoint(opts)}  ` +
    `levels=[${opts.levels.join(",")}] n=${opts.requests} stream=${opts.stream ? "yes" : "no"}`);

  for (let i = 0; i < opts.warmup; i++) {
    const w = await callOnce(opts);
    console.log(`  warmup ${i + 1}/${opts.warmup}: ${w.ok ? "ok" : `FAILED (${w.status}) ${w.error}`} ${w.ms}ms`);
    if (!w.ok && i === 0 && opts.warmup > 0) {
      console.error("  endpoint not healthy — aborting (use --warmup 0 to force run anyway)");
      process.exit(1);
    }
  }

  const report = { target: endpoint(opts), model: opts.model, stream: opts.stream, startedAt: new Date().toISOString(), levels: [] };
  for (const [i, conc] of opts.levels.entries()) {
    const l = await runLevel(conc, opts);
    printLevel(l, opts);
    report.levels.push(l);
    if (i < opts.levels.length - 1 && opts.pauseMs) await new Promise(r => setTimeout(r, opts.pauseMs));
  }

  const total = report.levels.reduce((a, l) => ({ pass: a.pass + l.pass, fail: a.fail + l.fail }), { pass: 0, fail: 0 });
  const best = report.levels.reduce((a, l) => (l.rps > a.rps ? l : a));
  console.log(`\n  total: ${total.pass} passed, ${total.fail} failed` +
    (total.pass + total.fail ? ` (${(total.pass / (total.pass + total.fail) * 100).toFixed(1)}%)` : "") +
    ` | peak ${best.rps} req/s @ conc=${best.concurrency}`);

  report.finishedAt = new Date().toISOString();
  report.summary = { ...total, peakRps: best.rps, peakConcurrency: best.concurrency };
  if (opts.json) {
    const fs = await import("node:fs");
    fs.writeFileSync(opts.json, JSON.stringify(report, null, 2));
    console.log(`  report: ${opts.json}`);
  }
  return total.fail ? 1 : 0;
}

main().then(code => process.exit(code));
