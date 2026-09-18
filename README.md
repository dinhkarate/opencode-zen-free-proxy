# opencode-zen-free-proxy

Free AI models from [OpenCode](https://opencode.ai) exposed as standard OpenAI and Anthropic APIs.

One server — works with any tool that speaks OpenAI or Anthropic format: Cursor, Continue, Cline, Claude Code, aider, opencode CLI, raw `curl`, whatever.

## 30-second setup

```bash
git clone https://github.com/dinhkarate/opencode-zen-free-proxy.git
cd opencode-zen-free-proxy
npm install
node server.mjs
```

Done. Server is at `http://localhost:6446`. API keys are in `api-keys.json` (auto-generated on first run).

## What you get

| Model | Endpoint | What it is | Reliability |
|-------|----------|-----------|-------------|
| `big-pickle` | `/v1/chat/completions` | DeepSeek V4 Flash (stealth) | Solid |
| `mimo-v2.5-free` | `/v1/chat/completions` | MiMo V2.5 | Solid |
| `nemotron-3-ultra-free` | `/v1/chat/completions` | NVIDIA Nemotron 3 Ultra | Hit or miss (upstream 503s) |
| `muse-spark-1.3-contributor-free` | `/v1/responses` | Muse Spark 1.3 | Solid |
| `muse-spark-1.2-contributor-free` | `/v1/responses` | Muse Spark 1.2 | Solid |

Chat models also work via `/v1/messages` (Anthropic format).
All models support streaming. Non-streaming is emulated (proxy always
streams upstream and aggregates).

## API

### OpenAI format — `POST /v1/chat/completions`

```bash
curl http://localhost:6446/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### Anthropic format — `POST /v1/messages`

```bash
curl http://localhost:6446/v1/messages \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "system": "You are helpful.",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1024,
    "stream": true
  }'
```

### OpenAI Responses format — `POST /v1/responses` (muse-spark-*)

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

### Other endpoints

| Method | Path | What |
|--------|------|------|
| `GET` | `/v1/models` | List models |
| `GET` | `/health` | Health + version |

### Auth

Both `Authorization: Bearer KEY` and `x-api-key: KEY` work on all endpoints.

## Use with tools

### opencode CLI

Add to `~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "free": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "free",
      "options": {
        "baseURL": "http://localhost:6446/v1",
        "apiKey": "YOUR_KEY"
      },
      "models": {
        "big-pickle": { "name": "big-pickle" },
        "mimo-v2.5-free": { "name": "mimo-v2.5-free" }
      }
    }
  },
  "model": "free/big-pickle"
}
```

### Cursor / Continue / Cline

- Base URL: `http://YOUR_HOST:6446/v1`
- API Key: your key from `api-keys.json`
- Model: `deepseek-v4-flash-free`

### Claude Code (Anthropic format)

- Base URL: `http://YOUR_HOST:6446`
- API Key: your key from `api-keys.json`
- Works with `/v1/messages` endpoint

## Deploy on a VPS

```bash
# On your VPS
git clone https://github.com/dinhkarate/opencode-zen-free-proxy.git
cd opencode-zen-free-proxy
npm install
node server.mjs          # foreground
# or
nohup node server.mjs > proxy.log 2>&1 &   # background
```

If your VPS doesn't expose port 6446, use an SSH tunnel:

```bash
ssh -L 6446:127.0.0.1:6446 user@your-vps
# Now http://localhost:6446 works locally
```

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

## Environment variables

| Variable | Default | What |
|----------|---------|------|
| `PROXY_PORT` | `6446` | Server port |
| `KEYS_FILE` | `./api-keys.json` | API keys file path |

## How it works

```
Your tool (Cursor, CLI, curl, etc.)
        │
        ▼
  opencode-zen-free-proxy    ← this server, translates formats
        │
        ▼  HTTPS
  opencode.ai/zen/v1/       ← free tier API
```

The proxy adds `x-opencode-*` authentication headers that the Zen API requires. These were discovered by reverse engineering the opencode binary — without them, even `Authorization: Bearer public` gets rejected with `FreeTierError` (403).

Since ~Sep 2026 the free tier enforces all of the following (each violation is a 403/426):

1. `User-Agent: opencode/1.18.x ...` — clients older than 1.18.0 get `426 UpgradeRequired`.
2. Valid `x-opencode-session` (`ses_…`) / `x-opencode-request` (`msg_…`) IDs in opencode's exact format (12 hex time chars + 14 base62 chars). The `msg_` ID must be fresh per request; stale or malformed IDs get `FreeTierError`.
3. `stream: true` — non-streaming requests are rejected, so the proxy always streams upstream and aggregates SSE into a single JSON object when the client asked for `stream: false`.
4. A non-empty `tools` array containing tools named exactly `bash` and `read`. The proxy injects minimal dummy `bash`/`read` tools when the client didn't send them.
5. The right endpoint per model: `POST /zen/v1/chat/completions` for chat models, `POST /zen/v1/responses` for `muse-spark-*` (which uses the OpenAI Responses API, not chat completions).

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

## License

MIT
