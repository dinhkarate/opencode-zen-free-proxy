# opencode-zen-free-proxy

<p>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518-brightgreen">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="endpoints" src="https://img.shields.io/badge/endpoints-OpenAI%20%C2%B7%20Anthropic%20%C2%B7%20Responses-orange">
  <img alt="tested" src="https://img.shields.io/badge/last%20tested-2026--09--19-success">
</p>

Free AI models from [OpenCode Zen](https://opencode.ai) exposed as standard **OpenAI**, **Anthropic**, and **OpenAI Responses** APIs.

One server — works with any tool that speaks those formats: Cursor, Continue, Cline, Claude Code, aider, opencode CLI, raw `curl`, whatever.

## Why this repo exists

> ⚠️ **Due to opencode's new `403 FreeTierError`, this repo was born.**

Starting ~September 2026, the OpenCode Zen free tier began rejecting every client that isn't the opencode CLI itself. Any direct call to `https://opencode.ai/zen/v1/...` — even with the valid public bearer token — now fails with:

```
403 {"error":{"type":"FreeTierError", ...}}
```

The free tier silently started enforcing a set of undocumented client checks (exact `User-Agent`, fake-but-valid `x-opencode-session`/`x-opencode-request` IDs, mandatory streaming, required `bash`/`read` tools, per-model endpoints). This proxy reverse-engineered all of them and replays a compliant request upstream, so you get your free models back through **any** OpenAI/Anthropic-compatible client.

## 30-second setup

```bash
git clone https://github.com/dinhkarate/opencode-zen-free-proxy.git
cd opencode-zen-free-proxy
npm install
npm start          # node server.mjs
```

Done. Server listens on `http://localhost:6446`. API keys are auto-generated on first run into `api-keys.json` (git-ignored — check it for your keys).

Smoke test:

```bash
curl http://localhost:6446/health
# {"status":"ok","version":"v11","models":6,...}
```

## Models

| Model | Endpoint | What it is | Notes |
|-------|----------|-----------|-------|
| `big-pickle` | `/v1/chat/completions` | DeepSeek V4 Flash (stealth) | Solid |
| `mimo-v2.5-free` | `/v1/chat/completions` | MiMo V2.5 | Solid, streams reasoning |
| `nemotron-3-ultra-free` | `/v1/chat/completions` | NVIDIA Nemotron 3 Ultra | Slower, occasional upstream 503s |
| `ling-3.0-flash-fin-free` | `/v1/chat/completions` | Ling 3.0 Flash | Solid |
| `muse-spark-1.3-contributor-free` | `/v1/responses` | Muse Spark 1.3 | Solid |
| `muse-spark-1.2-contributor-free` | `/v1/responses` | Muse Spark 1.2 | Solid |

- Chat models are **also** served on `/v1/messages` (Anthropic format).
- `muse-spark-*` **only** work on `/v1/responses` (OpenAI Responses API).
- All models support streaming; `stream: false` is emulated (the proxy always streams upstream and aggregates — the free tier rejects non-streaming requests).

## API

### OpenAI chat — `POST /v1/chat/completions`

```bash
curl http://localhost:6446/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "big-pickle",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### Anthropic messages — `POST /v1/messages`

```bash
curl http://localhost:6446/v1/messages \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "big-pickle",
    "system": "You are helpful.",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1024,
    "stream": true
  }'
```

### OpenAI Responses — `POST /v1/responses` (`muse-spark-*`)

```bash
curl http://localhost:6446/v1/responses \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-spark-1.3-contributor-free",
    "input": "Hello",
    "stream": false
  }'
```

### Meta endpoints

| Method | Path | What |
|--------|------|------|
| `GET` | `/v1/models` | List models |
| `GET` | `/health` | Health + version |

### Auth

Your local proxy demands a key from `api-keys.json`. Both `Authorization: Bearer KEY` and `x-api-key: KEY` work on all endpoints. Missing/bad key → `401`.

## Use with your tools

All setups below are **tested end-to-end** (opencode CLI + Claude Code verified live on 2026-09-19).

### opencode CLI ✅ tested

Add a `localzen` provider to `~/.config/opencode/opencode.jsonc` (useful when the hosted Zen endpoint 403s you):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "localzen": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local Zen Free Proxy",
      "options": {
        "baseURL": "http://localhost:6446/v1",
        "apiKey": "YOUR_KEY"          // from api-keys.json
      },
      "models": {
        "big-pickle": { "name": "big-pickle" },
        "mimo-v2.5-free": { "name": "mimo-v2.5-free" },
        "nemotron-3-ultra-free": { "name": "nemotron-3-ultra-free" },
        "ling-3.0-flash-fin-free": { "name": "ling-3.0-flash-fin-free" }
      }
    }
  }
}
```

Then run through the proxy:

```bash
opencode run -m localzen/big-pickle "Hello!"     # ✅ works, incl. tool calls
# or set it as default: "model": "localzen/big-pickle" at top level
```

### Claude Code ✅ tested

Claude Code speaks the Anthropic format, so point it at the proxy with two env vars:

```bash
export ANTHROPIC_BASE_URL=http://localhost:6446
export ANTHROPIC_AUTH_TOKEN=YOUR_KEY             # from api-keys.json
claude -p "Hello!" --model big-pickle            # ✅ works
```

> Claude Code prints a harmless warning that `big-pickle` "isn't described by
> this version's model catalog" — it still calls the proxy and gets answers.
> The proxy maps the request to `/v1/messages` → upstream chat models.

### Muse Spark (`muse-spark-*`)

These are **Responses-API models** — served only on `POST /v1/responses`, not
`/v1/chat/completions` (calling them on the chat endpoint returns `400` listing
both groups). Use any client that speaks the OpenAI Responses format:

```bash
curl -s http://localhost:6446/v1/responses \
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"model":"muse-spark-1.3-contributor-free","input":"Explain SSE in one line."}'
```

```python
# openai>=1.40 python sdk — ✅ verified
from openai import OpenAI
client = OpenAI(base_url="http://localhost:6446/v1", api_key="YOUR_KEY")
r = client.responses.create(model="muse-spark-1.3-contributor-free", input="Hello")
print(r.output_text)          # reasoning model: supports streaming + multi-turn input arrays
```

opencode's `@ai-sdk/openai-compatible` provider speaks chat-completions, so add
`muse-spark-*` to your config **only** if your provider supports `/v1/responses`.
For chat-in-opencode use `big-pickle` / `mimo-v2.5-free` / `nemotron-3-ultra-free`.

### Cursor / Continue / Cline / aider

- Base URL: `http://YOUR_HOST:6446/v1`
- API Key: your key from `api-keys.json`
- Model: `big-pickle` (or any chat model from the table)
- `muse-spark-*` appear in `/v1/models` but return `400` on the chat endpoint — they need `/v1/responses` clients.

### Chaining behind cli-proxy-api (advanced)

This is the vina2 production topology: CPA fronts dozens of upstream CLIs/APIs
and treats this proxy as one more upstream provider (the zen free-tier models
become `oc/*` chat models plus `muse-spark-*` on the responses side):

```yaml
# CPA config.yaml — the proxy handles all zen-specific headers itself,
# CPA just talks plain OpenAI/Responses to it:
openai-compatibility:
  - name: OpenCode-zen-via-local-proxy
    base-url: http://127.0.0.1:6446/v1
    api-key-entries:
      - api-key: <key from api-keys.json>
    models:
      - { name: big-pickle, alias: "" }
codex-api-key:
  - api-key: <key from api-keys.json>
    base-url: http://127.0.0.1:6446/v1
    disable-cooling: true
    models:
      - { name: muse-spark-1.3-contributor-free, alias: muse-spark-1.3, is-compat: true }
```

When chained on the same box, run the proxy with `PROXY_HOST=127.0.0.1` so the
free-tier gateway never gets exposed publicly.

### Raw curl sanity check

```bash
curl -s http://localhost:6446/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"ping"}]}'
```

## Load testing

Bundled zero-dep tool (also works against any OpenAI-compatible API — OpenAI,
OpenRouter, vLLM, LM Studio...):

```bash
node stress-test.mjs -k YOUR_KEY                       # smoke: conc=1, 10 reqs
node stress-test.mjs -k YOUR_KEY -c 1,5,10,20 -n 10   # concurrency ramp
node stress-test.mjs -k YOUR_KEY -m muse-spark-1.3-contributor-free --responses
node stress-test.mjs -k YOUR_KEY --stream             # measures time-to-first-token
node stress-test.mjs --help                           # all options / machine-readable --json report
```

Exit code 0 = clean run, 1 = failures observed — safe to wire into CI or agent loops.

## Deploy on a VPS

```bash
git clone https://github.com/dinhkarate/opencode-zen-free-proxy.git
cd opencode-zen-free-proxy
npm install
node server.mjs                              # foreground
# or
nohup node server.mjs > proxy.log 2>&1 &     # background
```

On a public VPS, bind loopback only (`PROXY_HOST=127.0.0.1`) and tunnel in:

```bash
PROXY_HOST=127.0.0.1 nohup node server.mjs > proxy.log 2>&1 &
ssh -L 6446:127.0.0.1:6446 user@your-vps
# Now http://localhost:6446 works locally
```

Local tools on the same box (e.g. cli-proxy-api) can just point at
`http://127.0.0.1:6446/v1`.

### systemd service (optional)

```ini
# /etc/systemd/system/opencode-zen-proxy.service
[Unit]
Description=OpenCode Free Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/opencode-zen-free-proxy
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5
Environment=PROXY_PORT=6446

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now opencode-zen-proxy
```

## Configuration

| Variable | Default | What |
|----------|---------|------|
| `PROXY_PORT` | `6446` | Server port |
| `PROXY_HOST` | `0.0.0.0` | Bind address — use `127.0.0.1` on public VPSes |
| `KEYS_FILE` | `./api-keys.json` | API keys file path |

## How it works

```
Your tool (Cursor, CLI, curl, etc.)
        │   OpenAI / Anthropic / Responses format
        ▼
  opencode-zen-free-proxy     ← translates formats, injects auth
        │   HTTPS + Zen free-tier headers
        ▼
  opencode.ai/zen/v1/         ← free tier API
```

Since the ~Sep 2026 lockdown, a request without **all** of the following gets `403 FreeTierError` (or `426 UpgradeRequired`):

1. `User-Agent: opencode/1.18.x ...` — clients older than 1.18.0 get `426 UpgradeRequired`.
2. Valid `x-opencode-session` (`ses_…`) / `x-opencode-request` (`msg_…`) IDs in opencode's exact format (12 hex time chars + 14 base62 chars). The `msg_` ID must be fresh per request; stale or malformed IDs get `FreeTierError`.
3. `stream: true` — non-streaming requests are rejected, so the proxy always streams upstream and aggregates SSE into a single JSON object when the client asked for `stream: false`.
4. A non-empty `tools` array containing tools named exactly `bash` and `read`. The proxy injects minimal dummy `bash`/`read` tools when the client didn't send them.
5. The right endpoint per model: `POST /zen/v1/chat/completions` for chat models, `POST /zen/v1/responses` for `muse-spark-*`.

The proxy also rotates sessions per API key (every 30 min) and transparently retries once with a fresh `msg_` ID on transient upstream 5xx.

### Zen API auth headers (for the curious)

```
Authorization: Bearer public
User-Agent: opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
x-opencode-client: cli
x-opencode-project: global
x-opencode-request: msg_<12 hex time><14 base62>
x-opencode-session: ses_<~12 hex time><14 base62>
```

(Responses endpoint uses `ai-sdk/provider-utils/4.0.40` in the UA.)

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `401` from the proxy | Key not in `api-keys.json` — copy it from the file |
| `403 FreeTierError` from upstream | opencode tightened the free-tier checks again — compare headers above with upstream expectations and update `UA_CHAT`/`UA_RESPONSES`/`OC_VERSION` in `server.mjs` |
| `426` from upstream | `OC_VERSION` fell below the enforced minimum — bump it |
| Upstream `503` (often `nemotron-3-ultra-free`) | Free-tier capacity, just retry |
| Port already in use | `PROXY_PORT=6500 npm start` |

## License

MIT
