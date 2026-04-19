# Claude Usage Indicator 📊

VS Code status bar widget that shows usage for the **active Claude chat tab** 🤖:

```
S: 12% · 2:47: 34% · w: 8%
```

- 🧠 **S** — context window used (input + cache tokens / 1M).
- ⏳ **2:47** — time until the 5-hour limit resets, followed by current 5h utilization.
- 📅 **w** — weekly (7-day) utilization.

🖱️ Click the item to force-refresh the 5h/weekly numbers.

## ⚙️ How it works

- A `Stop` / `UserPromptSubmit` hook writes per-session JSON to
  `~/.claude/projects/<cwd-slug>/usage-<sessionId>.json` after each turn.
- The extension watches that directory, picks the file matching the active
  Claude webview tab (by parsing session→title mappings from the Claude VS Code
  extension log), and renders it in the status bar.
- Limits come from Anthropic's OAuth usage endpoint; results are cached in
  `~/.claude/oauth-usage-cache.json` (90 s TTL) so repeated hooks don't hit a
  rate limit.

## 🚀 Install

Requires Node ≥ 18, VS Code ≥ 1.70, and the official
[Claude Code](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code)
extension already logged in (the hook reads
`~/.claude/.credentials.json`).

```sh
git clone https://github.com/senyaak/claude-usage-indicator.git
cd claude-usage-indicator
npm run setup
```

`setup` does two things:

1. 🪝 Merges the hook into `~/.claude/settings.json` (a `.bak` of the previous
   file is kept).
2. 📦 Packages the repo as a `.vsix` via `@vscode/vsce` and installs it with
   `code --install-extension`.

🔁 Reload the VS Code window once after install.

## 🧹 Uninstall

- `code --uninstall-extension local.claude-usage-indicator`
- Remove the `Stop` and `UserPromptSubmit` entries that point at
  `hooks/stop-bridge.mjs` from `~/.claude/settings.json`.

## ⚠️ Notes

This extension talks to an **internal, beta** Anthropic endpoint
(`/api/oauth/usage`, `anthropic-beta: oauth-2025-04-20`). The endpoint is not
documented and can change or disappear at any time — if the 5h/weekly numbers
stop updating, that's probably why. 🤷

🔒 No telemetry. The extension only reads files under `~/.claude/` and the VS
Code extension log to map tab titles to session IDs.
