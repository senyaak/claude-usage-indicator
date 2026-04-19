const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const LOG_SCAN_INTERVAL_MS = 2000;

function slugify(p) {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

function workspaceForActiveTab() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  const active = vscode.window.activeTextEditor?.document?.uri;
  if (active) {
    const match = vscode.workspace.getWorkspaceFolder(active);
    if (match) return match;
  }
  return folders[0];
}

function projectDir(workspaceFolder) {
  if (!workspaceFolder) return null;
  return path.join(
    os.homedir(),
    '.claude',
    'projects',
    slugify(workspaceFolder.uri.fsPath)
  );
}

function readUsage(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function findUsageFileForSession(sid) {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  try {
    for (const dir of fs.readdirSync(projectsRoot)) {
      const file = path.join(projectsRoot, dir, `usage-${sid}.json`);
      try { fs.statSync(file); return file; } catch {}
    }
  } catch {}
  return null;
}

function listUsageFiles(dir) {
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.startsWith('usage-') && n.endsWith('.json'))
      .map((n) => {
        const full = path.join(dir, n);
        const m = fs.statSync(full).mtimeMs;
        const sid = n.slice('usage-'.length, -'.json'.length);
        return { sessionId: sid, file: full, mtime: m };
      });
  } catch {
    return [];
  }
}

function isClaudeInput(input) {
  if (!input || typeof input !== 'object') return false;
  // TabInputWebview: viewType is usually "mainThreadWebview-<id>".
  // TabInputCustom: viewType = custom editor id. Match by 'claude' substring.
  const vt = input.viewType;
  if (typeof vt === 'string' && vt.toLowerCase().includes('claude')) return true;
  return false;
}

function activeClaudeTab(output) {
  // First look for the active tab in the active group — the one actually in focus.
  for (const group of vscode.window.tabGroups.all) {
    if (!group.isActive) continue;
    for (const tab of group.tabs) {
      if (!tab.isActive) continue;
      if (isClaudeInput(tab.input)) return tab;
    }
  }
  // Fallback: the only Claude tab across all groups. Useful when focus is on a code
  // editor but we care about the open Claude session.
  const claudeTabs = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (isClaudeInput(tab.input)) claudeTabs.push(tab);
    }
  }
  if (claudeTabs.length === 1) return claudeTabs[0];
  // Multiple Claude tabs: if one is active in some group, use it.
  for (const tab of claudeTabs) if (tab.isActive) return tab;
  if (output && claudeTabs.length === 0) {
    // Dump all tabs once to see real viewTypes.
    if (!activeClaudeTab._dumped) {
      activeClaudeTab._dumped = true;
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const vt = tab.input && typeof tab.input === 'object' ? tab.input.viewType : undefined;
          output.appendLine(`[tabs] group=${group.viewColumn} active=${tab.isActive} label="${tab.label}" viewType=${vt}`);
        }
      }
    }
  }
  return null;
}

function findClaudeLogFile(output) {
  // ~/.config/Code/logs/<timestamp>/window*/exthost/Anthropic.claude-code/Claude VSCode.log
  // Many timestamp dirs may only contain cli.log (when VS Code was launched from CLI)
  // — skip those and find the one that actually has the Claude extension log.
  const logsRoot = path.join(os.homedir(), '.config', 'Code', 'logs');
  if (!fs.existsSync(logsRoot)) return null;
  let candidates = [];
  let timestamps;
  try {
    timestamps = fs.readdirSync(logsRoot);
  } catch {
    return null;
  }
  for (const name of timestamps) {
    const dir = path.join(logsRoot, name);
    let windows;
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      windows = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const w of windows) {
      if (!w.startsWith('window')) continue;
      const logPath = path.join(dir, w, 'exthost', 'Anthropic.claude-code', 'Claude VSCode.log');
      try {
        const st = fs.statSync(logPath);
        candidates.push({ path: logPath, mtime: st.mtimeMs });
      } catch {
        // no Claude log in this window
      }
    }
  }
  if (!candidates.length) {
    output?.appendLine('[log] no Claude VSCode.log found in any logs/<timestamp>/window*/');
    return null;
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  output?.appendLine(`[log] using ${candidates[0].path}`);
  return candidates[0].path;
}

class TitleMap {
  constructor(output) {
    this.output = output;
    this.titleToSession = new Map();
    this.sessionToTitle = new Map();
    this.logFile = null;
    this.logOffset = 0;
    this.timer = null;
  }

  start() {
    this.resolveLogFile();
    this.timer = setInterval(() => {
      if (!this.logFile) this.resolveLogFile();
      else this.poll();
    }, LOG_SCAN_INTERVAL_MS);
  }

  resolveLogFile() {
    const found = findClaudeLogFile(this.output);
    if (!found) return;
    this.logFile = found;
    // Start from the end of the file to avoid retroactively parsing a huge log
    try {
      this.logOffset = fs.statSync(this.logFile).size;
    } catch {
      this.logOffset = 0;
    }
    // Also scan the tail (~last 200 KB) right away — may contain recent titles
    this.scanTail(200 * 1024);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  scanTail(bytes) {
    if (!this.logFile) return;
    try {
      const size = fs.statSync(this.logFile).size;
      const start = Math.max(0, size - bytes);
      const fd = fs.openSync(this.logFile, 'r');
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      this.parseChunk(buf.toString('utf8'));
    } catch (e) {
      this.output?.appendLine(`[log] tail scan failed: ${e.message}`);
    }
  }

  poll() {
    if (!this.logFile) return;
    try {
      const size = fs.statSync(this.logFile).size;
      if (size < this.logOffset) {
        // log was rotated
        this.logOffset = 0;
      }
      if (size === this.logOffset) return;
      const fd = fs.openSync(this.logFile, 'r');
      const len = size - this.logOffset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.logOffset);
      fs.closeSync(fd);
      this.logOffset = size;
      this.parseChunk(buf.toString('utf8'));
    } catch (e) {
      this.output?.appendLine(`[log] poll failed: ${e.message}`);
    }
  }

  parseChunk(text) {
    // Look for: "sessionId":"UUID", ... "title":"..." in a single JSON payload
    const re = /"sessionId"\s*:\s*"([0-9a-f-]{36})"[^{}]*?"title"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const sid = m[1];
      const title = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      if (!title) continue;
      const prev = this.sessionToTitle.get(sid);
      if (prev === title) continue;
      if (prev) this.titleToSession.delete(prev);
      this.sessionToTitle.set(sid, title);
      this.titleToSession.set(title, sid);
      this.output?.appendLine(`[map] ${sid} <- "${title}"`);
    }
  }

  sessionForTitle(title) {
    if (!title) return null;
    // Try full title, then strip possible "Claude — " prefix
    if (this.titleToSession.has(title)) return this.titleToSession.get(title);
    const stripped = title.replace(/^Claude[\s—:-]+/, '').trim();
    if (this.titleToSession.has(stripped)) return this.titleToSession.get(stripped);
    // fuzzy: find a key that is a suffix/prefix of the label
    for (const [t, sid] of this.titleToSession.entries()) {
      if (title.includes(t) || t.includes(title)) return sid;
    }
    return null;
  }
}

function formatRemaining(isoStr) {
  if (!isoStr) return null;
  const resetMs = Date.parse(isoStr);
  if (isNaN(resetMs)) return null;
  const secs = Math.max(0, Math.floor((resetMs - Date.now()) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}`;
  return `${m}m`;
}

function render(sessionData, limitsData) {
  // S comes from the active session data (context_percent — per-session),
  // 5h/weekly from the freshest usage file: account-wide limits, need latest values.
  const src = sessionData || limitsData;
  if (!src) return 'Claude: —';
  const s = src.context_percent ?? '?';
  const limits = limitsData || sessionData || {};
  const h = limits.five_hour_percent ?? '?';
  const w = limits.seven_day_percent ?? '?';
  const fiveLeft = formatRemaining(limits.five_hour_resets_at);
  const fiveLabel = fiveLeft || '5h';
  return `S: ${s}% · ${fiveLabel}: ${h}% · w: ${w}%`;
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Claude Usage Indicator');
  context.subscriptions.push(output);

  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  item.command = 'claudeUsage.refresh';
  item.tooltip = 'S = context · 5h = 5-hour limit · w = weekly limit. Click to refresh 5h/w.';
  context.subscriptions.push(item);

  const titleMap = new TitleMap(output);
  titleMap.start();
  context.subscriptions.push({ dispose: () => titleMap.stop() });

  const watchers = new Map();
  let currentSessionId = null;

  function pickFiles(dir) {
    const files = listUsageFiles(dir);
    if (!files.length) return { sessionFile: null, sessionId: null, limitsFile: null, reason: 'no files' };

    files.sort((a, b) => b.mtime - a.mtime);
    const freshest = files[0];

    const tab = activeClaudeTab(output);
    if (tab) {
      const sid = titleMap.sessionForTitle(tab.label);
      if (sid) {
        const inDir = files.find((f) => f.sessionId === sid);
        const sessionFile = inDir?.file ?? findUsageFileForSession(sid);
        if (sessionFile) {
          return {
            sessionFile,
            sessionId: sid,
            limitsFile: freshest.file,
            reason: `tab->${sid.slice(0, 8)}${inDir ? '' : '(cross-project)'}`
          };
        }
      } else {
        output.appendLine(`[pick] tab "${tab.label}" not in titleMap`);
      }
    }

    return {
      sessionFile: freshest.file,
      sessionId: freshest.sessionId,
      limitsFile: freshest.file,
      reason: `fallback most recent ${freshest.sessionId.slice(0, 8)}`
    };
  }

  function update() {
    const ws = workspaceForActiveTab();
    const dir = projectDir(ws);
    if (!dir) { item.hide(); return; }
    ensureDirWatcher(dir);
    const { sessionFile, sessionId, limitsFile, reason } = pickFiles(dir);
    currentSessionId = sessionId;
    if (!sessionFile) { item.hide(); return; }
    const sessionData = readUsage(sessionFile);
    const limitsData = limitsFile === sessionFile ? sessionData : readUsage(limitsFile);
    if (!sessionData && !limitsData) { item.hide(); return; }
    item.text = render(sessionData, limitsData);
    item.show();
    output.appendLine(`[update] ${reason}`);
  }

  function ensureDirWatcher(dir) {
    if (watchers.has(dir)) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const w = fs.watch(dir, (_ev, filename) => {
        if (filename && filename.startsWith('usage-')) update();
      });
      watchers.set(dir, w);
      context.subscriptions.push({ dispose: () => w.close() });
    } catch (e) {
      output.appendLine(`[watch] ${e.message}`);
    }
  }

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(update),
    vscode.window.tabGroups.onDidChangeTabGroups(update),
    vscode.window.onDidChangeActiveTextEditor(update),
    vscode.workspace.onDidChangeWorkspaceFolders(update),
    vscode.commands.registerCommand('claudeUsage.refresh', () => {
      const ws = workspaceForActiveTab();
      const dir = projectDir(ws);
      if (!dir || !currentSessionId) {
        vscode.window.setStatusBarMessage('Claude: nothing to refresh', 2000);
        return;
      }
      const bp = path.join(dir, `usage-${currentSessionId}.json`);
      const script = path.join(
        os.homedir(),
        'Projects',
        'claude-usage-indicator',
        'hooks',
        'refresh-usage.mjs'
      );
      const child = spawn('node', [script, bp], {
        detached: true,
        stdio: 'ignore'
      });
      child.on('error', (e) =>
        vscode.window.showErrorMessage(`Claude refresh failed: ${e.message}`)
      );
      child.unref();
      vscode.window.setStatusBarMessage('Claude usage: refreshing…', 2000);
    })
  );

  // periodic update in case the log caught up but no tab change fired
  const pollTimer = setInterval(update, 2500);
  context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

  update();
}

function deactivate() {}

module.exports = { activate, deactivate };
