# Claude Usage Indicator 📊

VS Code status bar widget that shows real-time usage for the **active Claude chat tab** 🤖:

```
S: 12% · 2:47: 34% · w: 8%
```

- 🧠 **S** — context window used (input + cache tokens vs. model limit).
- ⏳ **2:47** — time until the 5-hour limit resets, followed by current 5h utilization.
- 📅 **w** — weekly (7-day) utilization (the highest of the per-model weekly buckets).

🖱️ Click the status bar item to open the **usage history popup**.

## 🎨 Custom format

The status bar string is configurable via the `claudeUsage.format` setting. The default reproduces the layout above:

```
S: %S% · %5hr%: %5h% · w: %w%
```

Tokens (wrapped in `%…%`):

| Token | Meaning |
|---|---|
| `%S%` / `%SP%` | session context % |
| `%ST%` | session context tokens (e.g. `258k`) |
| `%5h%` | 5-hour utilization % |
| `%5hr%` | countdown until the 5-hour limit resets (e.g. `2:47`) |
| `%w%` | weekly % (max across buckets) |
| `%wr%` | countdown until the weekly limit resets |
| `%wS%` | weekly Sonnet % |
| `%wO%` | weekly Opus % |

Unknown tokens are left untouched so typos stay visible. Percentages and token counts render as `_` when zero/unavailable. Examples:

```
%ST%                          →  258k
SP: %SP% (%ST%) · w: %w%      →  SP: 25% (258k) · w: 47%
%S%                           →  25%
```

## 📋 History popup

Clicking the indicator opens a quick-pick panel with:

| Action | Description |
|---|---|
| ⟳ **Refresh** | Fetch fresh 5h/weekly limits from the API |
| 📄 **Open history file** | Open `~/.claude/usage-history.jsonl` in the editor |
| 📋 **Export CSV** | Copy full history as CSV to clipboard |
| 🗑 **Clear log** | Delete all history (with confirmation) |

Below the actions, the last 200 history entries are shown newest-first, grouped by chat session. Each entry shows the timestamp, event type (send/stop), per-session context %, 5h %, weekly %, and model.

## ⚙️ How it works

- A `Stop` / `UserPromptSubmit` hook runs after each Claude turn and writes:
  - A per-session file to `~/.claude/projects/<cwd-slug>/usage-<sessionId>.json`
  - An append-only log entry to `~/.claude/usage-history.jsonl`
- The extension watches the project directory, matches the active Claude tab to its session file (via session→title mappings parsed from the Claude VS Code extension log), and renders the status bar.
- API limits are fetched from Anthropic's OAuth usage endpoint and cached in `~/.claude/oauth-usage-cache.json` (90 s TTL).
- Session titles are persisted in `~/.claude/session-titles.json` so they survive VS Code restarts.

## 🚀 Install

Requires Node ≥ 18, VS Code ≥ 1.70, and the official
[Claude Code](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code)
extension already logged in (the hook reads `~/.claude/.credentials.json`).

```sh
git clone https://github.com/senyaak/claude-usage-indicator.git
cd claude-usage-indicator
npm run setup
```

`setup` does two things:

1. 🪝 Merges the hook into `~/.claude/settings.json` (a `.bak` of the previous file is kept).
2. 📦 Packages the repo as a `.vsix` via `@vscode/vsce` and installs it with `code --install-extension`.

🔁 Reload the VS Code window once after install.

## 🧹 Uninstall

```sh
code --uninstall-extension local.claude-usage-indicator
```

Then remove the `Stop` and `UserPromptSubmit` entries pointing at `hooks/stop-bridge.mjs` from `~/.claude/settings.json`.

## ⚠️ Notes

This extension uses an **internal, beta** Anthropic endpoint (`/api/oauth/usage`, `anthropic-beta: oauth-2025-04-20`). It is undocumented and may change — if 5h/weekly numbers stop updating, that is likely the cause. 🤷

🔒 No telemetry. The extension only reads files under `~/.claude/` and the VS Code extension log to map tab titles to session IDs.
