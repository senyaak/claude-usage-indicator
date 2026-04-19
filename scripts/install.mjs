#!/usr/bin/env node
// Idempotent setup:
//  1) Merges Stop/UserPromptSubmit hooks into ~/.claude/settings.json.
//  2) Packages this repo as a VSIX and installs it into VS Code.
//
// Safe to run multiple times — it only adds the hook entry if missing.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const settingsPath = join(homedir(), '.claude', 'settings.json');
const hookCmd = `node ${join(repoRoot, 'hooks', 'stop-bridge.mjs')}`;
// Any previously-installed variant of our hook that we want to clean up
// (old bash script, absolute vs ~ path, etc.) identified by this path fragment.
const OUR_HOOK_MARKER = /claude-usage-indicator[\/\\]hooks[\/\\]stop-bridge\.(sh|mjs)\b/;

function log(msg) {
  console.log(`[claude-usage-indicator] ${msg}`);
}

// ---------- 1. settings.json ----------
function upsertHook(cfg, event, command) {
  cfg.hooks ??= {};
  cfg.hooks[event] ??= [];
  const before = cfg.hooks[event].length;
  // Drop every group that mentions our hook file (old bash or different path variants).
  // We'll re-add exactly one canonical entry below.
  cfg.hooks[event] = cfg.hooks[event].filter((group) =>
    !(group.hooks || []).some(
      (h) => h.type === 'command' && OUR_HOOK_MARKER.test(h.command)
    )
  );
  const removed = before - cfg.hooks[event].length;
  cfg.hooks[event].push({ hooks: [{ type: 'command', command }] });
  return { added: true, removed };
}

function updateSettings() {
  let cfg = {};
  let original = '';
  if (existsSync(settingsPath)) {
    original = readFileSync(settingsPath, 'utf8');
    try {
      cfg = JSON.parse(original);
    } catch (e) {
      throw new Error(`failed to parse ${settingsPath}: ${e.message}`);
    }
  }

  upsertHook(cfg, 'Stop', hookCmd);
  upsertHook(cfg, 'UserPromptSubmit', hookCmd);

  const next = JSON.stringify(cfg, null, 2) + '\n';
  if (next === original) {
    log('settings.json already has the hooks — skip');
    return;
  }

  if (existsSync(settingsPath)) {
    copyFileSync(settingsPath, `${settingsPath}.bak`);
  }
  writeFileSync(settingsPath, next);
  log('settings.json updated');
}

// ---------- 2. VSIX ----------
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
}

function packageAndInstallVsix() {
  const vsixName = 'claude-usage-indicator.vsix';
  const vsixPath = join(repoRoot, vsixName);

  log('packaging VSIX…');
  run('npx', [
    '--yes',
    '@vscode/vsce',
    'package',
    '--out',
    vsixPath,
    '--allow-missing-repository',
    '--skip-license'
  ]);

  log('installing VSIX into VS Code…');
  run('code', ['--install-extension', vsixPath, '--force']);
  log('done');
}

// ---------- main ----------
try {
  updateSettings();
  packageAndInstallVsix();
} catch (e) {
  console.error(`[claude-usage-indicator] FAILED: ${e.message}`);
  process.exit(1);
}
