const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const LOG_SCAN_INTERVAL_MS = 2000;
const HISTORY_FILE = path.join(os.homedir(), '.claude', 'usage-history.jsonl');
const SESSION_TITLES_FILE = path.join(os.homedir(), '.claude', 'session-titles.json');
const REFRESH_SCRIPT = path.join(os.homedir(), 'Projects', 'claude-usage-indicator', 'hooks', 'refresh-usage.mjs');

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
  const vt = input.viewType;
  if (typeof vt === 'string' && vt.toLowerCase().includes('claude')) return true;
  return false;
}

function activeClaudeTab(output) {
  for (const group of vscode.window.tabGroups.all) {
    if (!group.isActive) continue;
    for (const tab of group.tabs) {
      if (!tab.isActive) continue;
      if (isClaudeInput(tab.input)) return tab;
    }
  }
  const claudeTabs = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (isClaudeInput(tab.input)) claudeTabs.push(tab);
    }
  }
  if (claudeTabs.length === 1) return claudeTabs[0];
  for (const tab of claudeTabs) if (tab.isActive) return tab;
  if (output && claudeTabs.length === 0) {
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
      } catch {}
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
    this.onNewTitle = null; // callback(sid, title)
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
    try {
      this.logOffset = fs.statSync(this.logFile).size;
    } catch {
      this.logOffset = 0;
    }
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
      if (size < this.logOffset) this.logOffset = 0;
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
      this.onNewTitle?.(sid, title);
    }
  }

  sessionForTitle(title) {
    if (!title) return null;
    if (this.titleToSession.has(title)) return this.titleToSession.get(title);
    const stripped = title.replace(/^Claude[\s—:-]+/, '').trim();
    if (this.titleToSession.has(stripped)) return this.titleToSession.get(stripped);
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

function fmtPct(value) {
  return value == null || value === 0 ? '_' : `${value}%`;
}

function fmtTokens(value) {
  if (value == null || value === 0) return '_';
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

const DEFAULT_FORMAT = 'S: %S% · %5hr%: %5h% · w: %w%';

// Template tokens (wrapped in %…%):
//   S/SP session context %        wS   weekly Sonnet %
//   ST   session context tokens   wO   weekly Opus %
//   5h   5-hour usage %           w    weekly % (max bucket)
//   5hr  5-hour reset countdown   wr   weekly reset countdown
// Unknown tokens are left untouched so typos are visible.
function render(sessionData, limitsData, format) {
  const src = sessionData || limitsData;
  if (!src) return 'Claude: —';
  const limits = limitsData || sessionData || {};
  const tokens = {
    S: fmtPct(src.context_percent),
    SP: fmtPct(src.context_percent),
    ST: fmtTokens(src.context_tokens),
    '5h': fmtPct(limits.five_hour_percent),
    '5hr': formatRemaining(limits.five_hour_resets_at) || '5h',
    w: fmtPct(limits.seven_day_percent),
    wr: formatRemaining(limits.seven_day_resets_at) || '7d',
    wS: fmtPct(limits.seven_day_sonnet_percent),
    wO: fmtPct(limits.seven_day_opus_percent),
  };
  return (format || DEFAULT_FORMAT).replace(
    /%([A-Za-z0-9]+)%/g,
    (m, key) => (key in tokens ? tokens[key] : m)
  );
}

function loadSessionTitles() {
  try { return JSON.parse(fs.readFileSync(SESSION_TITLES_FILE, 'utf8')); } catch { return {}; }
}

function saveSessionTitles(titles) {
  try {
    fs.mkdirSync(path.dirname(SESSION_TITLES_FILE), { recursive: true });
    fs.writeFileSync(SESSION_TITLES_FILE, JSON.stringify(titles));
  } catch {}
}

function readHistory() {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Claude Usage Indicator');
  context.subscriptions.push(output);

  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  item.command = 'claudeUsage.openLog';
  item.tooltip = 'S = context · 5h = 5-hour limit · w = weekly. Click to open history.';
  context.subscriptions.push(item);

  const titleMap = new TitleMap(output);
  let sessionTitles = loadSessionTitles();

  titleMap.onNewTitle = (sid, title) => {
    if (sessionTitles[sid] !== title) {
      sessionTitles[sid] = title;
      saveSessionTitles(sessionTitles);
    }
  };

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
    const format = vscode.workspace.getConfiguration('claudeUsage').get('format') || DEFAULT_FORMAT;
    item.text = render(sessionData, limitsData, format);
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

  // Watch history file to live-update the log panel
  try {
    const claudeDir = path.join(os.homedir(), '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const hw = fs.watch(claudeDir, (_ev, filename) => {
      if (filename === 'usage-history.jsonl') sendLogUpdate();
    });
    context.subscriptions.push({ dispose: () => hw.close() });
  } catch (e) {
    output.appendLine(`[watch-history] ${e.message}`);
  }

  function doRefresh() {
    const ws = workspaceForActiveTab();
    const dir = projectDir(ws);
    if (!dir || !currentSessionId) {
      vscode.window.setStatusBarMessage('Claude: no active session to refresh', 2000);
      return;
    }
    const bp = path.join(dir, `usage-${currentSessionId}.json`);
    const child = spawn('node', [REFRESH_SCRIPT, bp], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => vscode.window.showErrorMessage(`Claude refresh failed: ${e.message}`));
    child.unref();
    vscode.window.setStatusBarMessage('Claude usage: refreshing…', 2000);
  }

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(update),
    vscode.window.tabGroups.onDidChangeTabGroups(update),
    vscode.window.onDidChangeActiveTextEditor(update),
    vscode.workspace.onDidChangeWorkspaceFolders(update),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeUsage.format')) update();
    }),

    vscode.commands.registerCommand('claudeUsage.refresh', doRefresh),

    vscode.commands.registerCommand('claudeUsage.openLog', () => {
      const entries = readHistory();

      function fmtTime(ts) {
        const d = new Date(ts);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
               d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }

      const actionItems = [
        { label: '$(refresh) Refresh', description: 'Update 5h/weekly limits from API', action: 'refresh' },
        { label: '$(file) Open history file', description: HISTORY_FILE, action: 'open' },
        { label: '$(clippy) Export CSV', description: 'Copy history to clipboard', action: 'export' },
        { label: '$(trash) Clear log', description: 'Delete all history', action: 'delete' },
      ];

      const histSeparator = { label: 'History', kind: vscode.QuickPickItemKind.Separator };

      const histItems = [];
      if (entries.length === 0) {
        histItems.push({ label: 'No history yet', description: 'Start a Claude session', action: null });
      } else {
        for (const e of [...entries].reverse().slice(0, 200)) {
          const title = sessionTitles[e.sid] || e.sid.slice(0, 8);
          const badge = e.type === 'submit' ? '→' : '✓';
          histItems.push({
            label: `${fmtTime(e.ts)}  ${badge}  ${title}`,
            description: `S:${fmtPct(e.ctx)} · 5h:${fmtPct(e.h)} · w:${fmtPct(e.w)}  ${e.model || ''}`,
            action: null
          });
        }
      }

      const qp = vscode.window.createQuickPick();
      qp.title = item.text || 'Claude Usage';
      qp.placeholder = 'Select an action';
      qp.items = [...actionItems, histSeparator, ...histItems];
      qp.matchOnDescription = false;

      qp.onDidChangeSelection(([selected]) => {
        if (!selected || !selected.action) return;
        qp.hide();
        if (selected.action === 'refresh') {
          doRefresh();
        } else if (selected.action === 'open') {
          vscode.workspace.openTextDocument(vscode.Uri.file(HISTORY_FILE)).then((doc) =>
            vscode.window.showTextDocument(doc)
          ).then(undefined, () =>
            vscode.window.showErrorMessage('No history file yet — start a Claude session first.')
          );
        } else if (selected.action === 'export') {
          const lines = entries.map((e) => [
            e.ts, e.type, e.sid,
            (sessionTitles[e.sid] || '').replace(/,/g, ' '),
            (e.model || '').replace(/,/g, ' '),
            e.ctx, e.h, e.w, e.h_reset, e.w_reset
          ].join(','));
          const csv = 'timestamp,type,session_id,title,model,ctx%,5h%,7d%,5h_reset,7d_reset\n' + lines.join('\n');
          vscode.env.clipboard.writeText(csv).then(() =>
            vscode.window.setStatusBarMessage('History copied to clipboard', 3000)
          );
        } else if (selected.action === 'delete') {
          vscode.window.showWarningMessage('Delete all Claude usage history?', 'Delete', 'Cancel').then((ans) => {
            if (ans === 'Delete') {
              try { fs.unlinkSync(HISTORY_FILE); } catch {}
              vscode.window.setStatusBarMessage('History deleted', 2000);
            }
          });
        }
      });

      qp.onDidHide(() => qp.dispose());
      qp.show();
    })
  );

  const pollTimer = setInterval(update, 2500);
  context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

  update();
}

function deactivate() {}

module.exports = { activate, deactivate };
