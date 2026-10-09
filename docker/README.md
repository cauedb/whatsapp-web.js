# Running in Docker

This runs the library in a container so it's easy to deploy and monitor on a
server (e.g. with `docker compose logs -f`, `docker compose ps`, restart
policies, etc.).

## Prerequisites

- Docker Engine with the Compose plugin (`docker compose version` should
  work — if you only have the old standalone `docker-compose`, replace
  `docker compose` with `docker-compose` in the commands below).
- This repo cloned locally (you're on a fork, so you're building the image
  yourself — see below, not pulling one from Docker Hub or GHCR).

## Build & run (local image)

`docker-compose.yml` sets `build: .` for the `whatsapp-bot` service, so
`docker compose up` always builds from **this repo's own
[`Dockerfile`](../Dockerfile) and source**, never a pre-built image from a
registry — there isn't one published for this fork, and there's no reason
to publish one for a single-server personal deployment.

```sh
cp docker/.env.example .env
# edit .env: at minimum set API_KEY if you're using the HTTP API — see below
docker compose up -d --build
docker compose logs -f
```

`--build` forces a rebuild from the current source every time — cheap
thanks to Docker's layer cache (only `RUN npm ci` re-runs if
`package.json`/`package-lock.json` changed; your own code changes only
re-run the final `COPY` layer). **Whenever you edit `docker/bot.js`,
`package.json`, or anything else in the repo, re-run `docker compose up -d
--build`** so the container picks up the change — a plain `docker compose
up -d` reuses whatever was already built and won't notice source edits.

To force a completely clean rebuild (ignore the layer cache entirely, e.g.
after changing base image versions): `docker compose build --no-cache`.

Scan the QR code printed in the logs with WhatsApp (Linked devices → Link a
device). Session data persists in the `wwebjs_auth` named volume, so restarts
don't require re-scanning.

The default command runs [`docker/bot.js`](bot.js) — a minimal env-configured
bot (replies `pong` to `!ping`). To run your own logic instead, either:

- mount your script over it, e.g. add to `docker-compose.yml`:
    ```yaml
    volumes:
        - ./my-bot.js:/home/pptruser/app/docker/bot.js:ro
    ```
- or build your own `Dockerfile` `FROM` this one and `COPY` your script,
  overriding `CMD`.

Your own script just needs `authStrategy: new LocalAuth({ dataPath: process.env.WWEBJS_DATA_PATH })`
so it persists sessions to the mounted volume — see `docker/bot.js` for a
full example.

## Configuration

Set these in `.env` (see [`docker/.env.example`](.env.example)):

| Variable              | Default   | Description                                                                                                 |
| --------------------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| `WWEBJS_CLIENT_ID`    | _(unset)_ | Distinguishes session folders for multiple clients on one volume.                                           |
| `BROWSER_WS_ENDPOINT` | _(unset)_ | Connect to an already-running CDP browser instead of the bundled Chrome (see [Obscura](#obscura) below).    |
| `PUPPETEER_ARGS`      | _(unset)_ | Comma-separated extra Chrome flags (only used when launching the bundled Chrome).                           |
| `API_PORT`            | _(unset)_ | Set to start the [HTTP API](#http-api) on this port. Unset = no HTTP server at all.                         |
| `API_KEY`             | _(unset)_ | Required if `API_PORT` is set — startup fails otherwise.                                                    |
| `WEBHOOK_URL`         | _(unset)_ | Where incoming messages get POSTed (see [HTTP API](#http-api)). Unset = no forwarding.                      |
| `WEBHOOK_CHAT_IDS`    | _(unset)_ | Comma-separated chat IDs to restrict forwarding to (see [HTTP API](#http-api)). Unset = forward every chat. |

## HTTP API

`whatsapp-web.js` is a Node-only library, so tools like n8n or a Python
script can't call it directly. Setting `API_PORT` starts a small HTTP API
inside the same container that bridges the gap: send messages with a POST
request, and get incoming messages pushed to a webhook URL you control.

It's off by default. Set `API_PORT` (and, since it controls a real WhatsApp
account, the required `API_KEY`) in `.env`, then uncomment the `ports:`
block for `whatsapp-bot` in `docker-compose.yml` if you need to reach it
from outside the container (skip that if the caller — e.g. n8n — runs in
the same Docker network; see [n8n](#n8n) below).

### API keys

There's no external/third-party API key to sign up for anywhere in this
setup. `whatsapp-web.js` talks to WhatsApp the same way your browser does at
web.whatsapp.com — you authenticate by scanning the QR code, not with an API
key from Meta/WhatsApp — and Obscura (if you use it) doesn't need one
either.

The **only** key involved is `API_KEY`, and it's not issued by anyone — you
invent it yourself, it just has to be a long random string only you and
your trusted callers (n8n, your Python script) know. Generate one with
whichever you have available:

```sh
openssl rand -hex 32
# or, without openssl:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the result into `.env` as `API_KEY=...`. Treat it like a password:
don't commit it, don't log it, and rotate it (edit `.env`, `docker compose
up -d --build`) if you ever suspect it leaked.

All endpoints except `/health` require `Authorization: Bearer <API_KEY>`.

| Method | Path                               | Body                                                           | Response                                                                                                                                 |
| ------ | ---------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                          | —                                                              | `{"status":"ok"}` — no auth, for health checks.                                                                                          |
| GET    | `/status`                          | —                                                              | `{"ready": bool, "state": <WAState\|null>}`                                                                                              |
| GET    | `/qr`                              | —                                                              | Current QR as a PNG image. Add `?format=json` for `{"qr": "<string>"}`. 404 once authenticated (no QR pending).                          |
| POST   | `/messages`                        | `{"to": "<number or id>", "body"?: "...", "mediaUrl"?: "..."}` | `{"id", "to", "timestamp"}`                                                                                                              |
| GET    | `/chats`                           | —                                                              | `[{"id", "name", "isGroup"}, ...]` — every chat, useful for finding a group's id (see [Finding chat/group ids](#finding-chatgroup-ids)). |
| GET    | `/contacts/lookup?number=<digits>` | —                                                              | `{"id": "<number>@c.us"}`, or 404 if that number isn't on WhatsApp.                                                                      |

Notes:

- `to` without an `@` is treated as a bare phone number and becomes
  `<to>@c.us` (a 1:1 chat). Groups (`...@g.us`) must be passed in full.
- `mediaUrl` sends whatever's at that URL as media, using `body` (if given)
  as the caption. At least one of `body`/`mediaUrl` is required.
- Incoming messages (not ones the bot itself sent) get POSTed to
  `WEBHOOK_URL` as JSON:
    ```json
    {
        "event": "message",
        "id": "...",
        "from": "...",
        "to": "...",
        "body": "...",
        "hasMedia": false,
        "type": "chat",
        "timestamp": 1700000000,
        "fromMe": false
    }
    ```
    Delivery is fire-and-forget with a 5s timeout — a slow or unreachable
    webhook is logged and skipped, never blocks message handling, and is
    never retried.
- By default **every** incoming chat gets forwarded. If you only care about
  a few conversations (e.g. one group used for alerts, or a handful of
  numbers), set `WEBHOOK_CHAT_IDS` to a comma-separated allowlist and
  everything else is skipped before the HTTP call is even made — no cost
  for the chats you don't care about. Format matches `msg.from`/`to` above:
  `<number>@c.us` for 1:1 chats, `<id>@g.us` for groups — see
  [Finding chat/group ids](#finding-chatgroup-ids) below for how to get the
  exact value.

### Finding chat/group ids

`@c.us` means an individual chat, `@g.us` a group. For an individual, the id
is just `<country code><number, digits only>@c.us` — but **don't guess it
by hand**: some numbers (Brazilian mobiles are a common case) are
registered on WhatsApp with or without an extra digit, and a wrong guess
just silently never matches. Ask the API to resolve it for you instead —
this does a real lookup against WhatsApp, not string concatenation:

```sh
curl -H "Authorization: Bearer $API_KEY" \
     "http://localhost:3000/contacts/lookup?number=5511999999999"
# {"id":"5511999999999@c.us"}      (or 404 if that number isn't on WhatsApp)
```

For a group, there's no shortcut — the id has no relationship to any phone
number, so it has to be read off an actual chat list:

```sh
curl -H "Authorization: Bearer $API_KEY" http://localhost:3000/chats
# [{"id":"5511999999999@c.us","name":"Some Contact","isGroup":false},
#  {"id":"120363012345678901@g.us","name":"My Group","isGroup":true}, ...]
```

Find the group by its `name` in the response and copy its `id` into
`WEBHOOK_CHAT_IDS`. Both endpoints require the client to be `ready` (a
scanned, authenticated session) — they return `503` otherwise.

**Security note:** this API can send messages as you and exposes your
session's QR/state. Keep `API_KEY` secret, keep the port bound to
`127.0.0.1` unless you have a specific reason not to, and put a reverse
proxy with TLS (or a private tunnel like Tailscale/WireGuard/SSH) in front
of it before exposing it beyond your own host.

Quick check with `curl`:

```sh
curl http://localhost:3000/health
curl -H "Authorization: Bearer $API_KEY" http://localhost:3000/status
curl -H "Authorization: Bearer $API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"to":"5511999999999","body":"hello from curl"}' \
     http://localhost:3000/messages
```

### n8n

**Sending (n8n → WhatsApp):** an HTTP Request node, `POST` to
`http://<host>:<API_PORT>/messages`, with a Header Auth credential
(`Authorization: Bearer <API_KEY>`) and a JSON body like
`{"to": "={{ $json.from }}", "body": "={{ $json.reply }}"}`.

**Receiving (WhatsApp → n8n):** add a Webhook node, copy its URL, set it as
`WEBHOOK_URL` in `.env`, and restart the container.

- If n8n runs in the **same Docker network** as this bot (e.g. added to this
  `docker-compose.yml`), use service names directly — no port publishing
  needed: `WEBHOOK_URL=http://n8n:5678/webhook/...` and the HTTP Request
  node targets `http://whatsapp-bot:3000/messages`. This is the simplest
  and most private option.
- If n8n is **elsewhere** (a different host, or n8n.cloud), you'll need to
  publish the API port and point `WEBHOOK_URL` at n8n's public webhook URL —
  see the security note above about not exposing this raw over the internet.

### Python

Sending, with `requests`:

```python
import requests

resp = requests.post(
    "http://localhost:3000/messages",
    headers={"Authorization": "Bearer YOUR_API_KEY"},
    json={"to": "5511999999999", "body": "Hello from Python"},
    timeout=10,
)
resp.raise_for_status()
print(resp.json())
```

Receiving, with the standard library only (no Flask install required just
to try it — swap in Flask/FastAPI for anything more than a quick test):

```python
from http.server import BaseHTTPRequestHandler, HTTPServer
import json

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        event = json.loads(self.rfile.read(length) or b"{}")
        print("Incoming WhatsApp message:", event)
        self.send_response(204)
        self.end_headers()

HTTPServer(("0.0.0.0", 5000), Handler).serve_forever()
```

Set `WEBHOOK_URL=http://<host-running-this>:5000/` in `.env` so incoming
messages reach it.

## Why this image

The `Dockerfile` is based on `ghcr.io/puppeteer/puppeteer:24.38.0`, the
official Puppeteer image pinned to match the `puppeteer` version in
`package.json`, so the bundled Chrome build always matches what Puppeteer
expects. The container runs as the non-root `pptruser` user.

`docker/bot.js` launches Chrome with `--no-sandbox`. Chrome's own internal
sandbox needs unprivileged user namespaces, which most container hosts
(and Docker daemons, depending on config) don't allow by default — without
the flag, Chrome fails to start with "No usable sandbox!". Running as
non-root inside an already-isolated container is the accepted trade-off for
that in most Puppeteer-in-Docker deployments; only drop the flag if you've
confirmed your specific host allows the sandbox to work.

## Obscura

[Obscura](https://github.com/h4ckf0r0day/obscura) is a lightweight Rust
browser engine that speaks the Chrome DevTools Protocol, so it can be used as
a drop-in swap for the bundled Chrome — whatsapp-web.js already supports
connecting to any CDP endpoint via `puppeteer.browserWSEndpoint`, no code
changes needed.

```sh
docker compose --profile obscura up -d
```

This starts an `obscura` sidecar (`serve --port 9222`) alongside the bot. Set
in `.env`:

```
BROWSER_WS_ENDPOINT=ws://obscura:9222/devtools/browser
```

**Caveat — treat this as experimental, not a supported configuration.**
Obscura is an independent rendering engine, not Chromium; its own docs note
that "long-tail CSS, some Web APIs, media playback, compositor effects, and
platform font rasterization may differ from Chromium." WhatsApp Web is a
large, frequently-changing SPA that leans on IndexedDB, WebCrypto (for
end-to-end encryption), Service Workers, and WebRTC/media APIs for voice
notes and calls — none of which are things Obscura's README claims full
parity on. It may work for basic messaging and break on media-heavy features,
or stop working entirely after a WhatsApp Web update. Test against a
disposable/secondary WhatsApp number before pointing it at an account you
care about, and fall back to `docker compose up` (bundled Chrome) if you hit
issues.

If you do try it and it works well for your use case, consider sharing
findings back to the community (the wwebjs Discord or a GitHub issue) — real
compatibility reports are more useful than assumptions here.
