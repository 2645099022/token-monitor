<p align="right">
   <strong>EN</strong> | <a href="./README.zh-CN.md">简</a> | <a href="./README.zh-TW.md">繁</a>
</p>
<div align="center">
    <img src=".github/assets/app.png" alt="Token Monitor logo" width="120">
    <h1>Token Monitor</h1>
</div>

<p align="center">
    <img src="https://img.shields.io/badge/macOS-14%2B-0A84FF?style=flat-square&logo=apple&logoColor=white" alt="macOS 14 or later" />
    <img src="https://img.shields.io/badge/Windows-10%2B-0078D4?style=flat-square" alt="Windows 10 or later" />
    <a href="docs/API.md"><img src="https://img.shields.io/badge/API-Docs-0B7285?style=flat-square" alt="API Docs" /></a>
    <a href="worker/README.md"><img src="https://img.shields.io/badge/Worker-Cloudflare-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Worker" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-A855F7?style=flat-square" alt="License: MIT" /></a>
</p>

<div align="center">
    <img src=".github/assets/demo.gif">
</div>

## What is Token Monitor?

A desktop widget that shows live token usage across your AI coding tools — Claude Code, Codex, Hermes, OpenCode, OpenClaw, Cursor, and more — with cost breakdowns per client and per model.

It runs entirely on your own machine by default. An optional hub aggregates usage across multiple devices, including iPhones via a Cloudflare Worker.

Only summary numbers ever leave your machine. Raw prompts, source files, and conversation transcripts stay local.

## Features

- Live token tracking for Claude Code, Codex, Hermes, OpenCode, OpenClaw, and Cursor — UI updates within seconds of each turn
- Switch breakdown views — group totals by tool, device, model, or account limits
- Cost breakdown alongside token counts
- Claude Code and Codex limit detection — shows session and weekly windows when local tool credentials are available
- Appearance controls — adjust glass opacity/blur and window look (including transparent glass)
- Local-first — no servers needed for single-device use
- Real-time multi-device sync over Server-Sent Events (self-hosted hub or Cloudflare Worker)
- iOS widget support (Widgy, Scriptable) through the Worker hub
- Privacy-first — only summary numbers ever leave your machine

| Limits View | Devices View | Models View |
|:---:|:---:|:---:|
| ![Limits View](.github/assets/limits-view.png) | ![Devices View](.github/assets/devices-view.png) | ![Models View](.github/assets/models-view.png) | 

## Supported Tools

Token Monitor supports token usage and account-limit checks separately:

| Logo | Tool | Data path | Token Usage | AI Tool Limits |
|:---:|------|-----------|:---:|:---:|
| <img src=".github/assets/tools-icon/claude.png" width="28" alt="Claude Code" /> | Claude Code | `~/.claude/projects/`, `~/.claude/transcripts/` | ✅ | ✅ |
| <img src=".github/assets/tools-icon/codex.png" width="28" alt="Codex" /> | Codex | `~/.codex/sessions/` | ✅ | ✅ |
| <img src=".github/assets/tools-icon/opencode.png" width="28" alt="OpenCode" /> | OpenCode | `~/.local/share/opencode/` | ✅ | — |
| <img src=".github/assets/tools-icon/hermes-agent.png" width="28" alt="Hermes" /> | Hermes | `$HERMES_HOME` or `~/.hermes/` | ✅ | — |
| <img src=".github/assets/tools-icon/openclaw.png" width="28" alt="OpenClaw" /> | OpenClaw | `~/.openclaw/agents/` | ✅ | — |
| <img src=".github/assets/tools-icon/cursor.png" width="28" alt="Cursor" /> | Cursor | `~/.config/tokscale/cursor-cache/` (populated by `tokscale cursor pull`) | ✅ | — |

## Installation

### Local mode — single device

The default. No hub, no agent, no config.

```bash
npm install
npm start
```

Usage is read live from your local AI client directories — see the [Supported Tools](#supported-tools) table for the full list of paths. The widget updates the moment those files change, with a 5-minute fallback poll.

### Multi-device sync

Pick ONE hub backend that all your devices (and any headless agents) connect to. On each device, open the widget and fill in Settings → Multi-device Sync → Hub URL + Secret. The widget contributes this device's usage automatically; run `npm run agent` only on machines without a widget.

See [docs/API.md](docs/API.md) for the hub HTTP API reference.

#### Option A — Self-hosted Node hub (same LAN)

Run the hub once on a machine that stays on, then point each device at it.

```bash
# on the always-on machine
cp .env.example .env
# set TOKEN_MONITOR_SECRET to something private, then:
npm run hub
```

#### Option B — Cloudflare Worker hub (across networks, including iPhone)

A Worker-based deployment that speaks the same protocol as the Node hub.
Public HTTPS, no always-on machine, free tier covers small-team usage,
reachable from Widgy / Scriptable on iOS.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Javis603/token-monitor/tree/main/worker)

One-click deploy — Cloudflare will prompt for the `TOKEN_MONITOR_SECRET` during setup. Or deploy manually:

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put TOKEN_MONITOR_SECRET
npx wrangler deploy
```

Wrangler prints the deployed URL — paste it into each device's widget at Settings → Multi-device Sync. See [worker/README.md](worker/README.md) for full deploy notes, the iOS widget recipe, and endpoint reference.

## How it works

```text
Mode A — Local (default, no setup)
    widget (Electron) ──▶ tokscale ──▶ ~/.claude, ~/.codex, $HERMES_HOME

Mode B — Sync (opt-in, multi-device)
    device A agent ──▶
    device B agent ──▶  hub  ──▶  widget on any device
    device C agent ──▶
```

The widget switches modes automatically based on whether a Hub URL is set in settings. There is no separate "mode" toggle. In sync mode the hub pushes aggregated stats to every connected widget over Server-Sent Events, so updates on one device appear on the others within a few seconds.

## Settings

### Widget (GUI)

Click the `⚙` button in the widget header to open the Settings panel.

- **Multi-device Sync** — Hub URL and secret. Leave Hub URL empty to run in local mode (this device only).
- **Tracked Tools** — checkboxes for each supported AI tool. Toggles take effect immediately and restart the collector with the new client list.
- **AI Tool Limits** — choose Claude Code and Codex limit detection and refresh frequency.
- **Appearance** — system glass, live dot, glass opacity, and glass blur.
- **Advanced** — opens the underlying `settings.json` for less-common options like `allTimeSince`.

The pin button in the widget header toggles "always on top".

### Headless agent and hub (`.env`)

The agent and hub have no UI. Configure them with a `.env` file at the project root (copy from `.env.example`):

```env
TOKEN_MONITOR_HUB_URL=               # required for sync mode — Worker URL or http://<lan-ip>:17321
TOKEN_MONITOR_SECRET=                # shared secret, must match the hub
TOKEN_MONITOR_DEVICE_ID=             # optional — defaults to hostname
TOKEN_MONITOR_CLIENTS=               # optional — defaults to all supported tools
```

The widget reads the same env vars as first-run defaults, then takes over with its own GUI-managed settings.

Every value can also be passed as a CLI flag (`--hub=`, `--secret=`, `--device=`, `--clients=`) — flags win over env. Less-common knobs (`TOKEN_MONITOR_INTERVAL_MS`, `TOKEN_MONITOR_PORT`, `TOKEN_MONITOR_STALE_AFTER_MS`, …) are also accepted via env / flag but kept out of `.env.example` to reduce noise.

AI Tool Limits knobs for headless agents:

- `TOKEN_MONITOR_LIMITS_ENABLED=0` disables limit detection
- `TOKEN_MONITOR_LIMIT_PROVIDERS=claude,codex` selects providers
- `TOKEN_MONITOR_LIMITS_REFRESH_MS=300000` selects refresh frequency

Equivalent CLI flags are `--limits=false`, `--limitProviders=claude,codex`, and `--limitsRefreshMs=300000`.

Example one-off run:

```bash
npm run agent -- --clients=claude,codex,opencode --once
```

## Privacy

The hub and agent only transmit summary fields:

- device id, hostname, platform
- total tokens per period (today / month / all-time)
- cost totals (when `tokscale` returns cost data)
- per-client and per-model breakdowns
- normalized Claude Code/Codex limit status when AI Tool Limits is enabled

They do not transmit raw AI logs, prompts, source code, or conversation
content. They also do not transmit OAuth credentials, access tokens, refresh
tokens, emails, or raw provider responses. `.env`, `data/`, and `node_modules/`
are gitignored.

## Requirements

- macOS or Windows
- Node.js 18.17+
- For sync mode only: network reachability from each agent/widget to the hub

## Acknowledgments

- [tokscale](https://github.com/junhoyeo/tokscale) for log parsing and token accounting.
- [CodexBar](https://github.com/steipete/CodexBar) for AI Tool Limits research.

## License

[MIT](LICENSE) © [@Javis](https://github.com/Javis603)
