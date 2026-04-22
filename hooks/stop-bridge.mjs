#!/usr/bin/env node
// Stop / UserPromptSubmit hook.
// Reads JSON from stdin ({session_id, cwd, transcript_path}),
// writes per-session usage.json under ~/.claude/projects/<slug>/.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const MODEL_LIMITS = {
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-5': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
};
const DEFAULT_LIMIT = 200_000;
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_FILE = join(homedir(), '.claude', 'oauth-usage-cache.json');
const CACHE_TTL_MS = 90 * 1000;
const HISTORY_FILE = join(homedir(), '.claude', 'usage-history.jsonl');

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function slugify(p) {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

function pickLimits(body) {
  return {
    five_hour_percent: Math.floor(body?.five_hour?.utilization ?? 0),
    seven_day_percent: Math.floor(body?.seven_day?.utilization ?? 0),
    five_hour_resets_at: body?.five_hour?.resets_at ?? '',
    seven_day_resets_at: body?.seven_day?.resets_at ?? ''
  };
}

function readCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { return null; }
}

function writeCache(limits) {
  try { writeJson(CACHE_FILE, { ...limits, fetched_at: Date.now() }); } catch {}
}

function readExisting(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function limitsFromExisting(prev) {
  if (!prev) return null;
  if (prev.five_hour_resets_at || prev.seven_day_resets_at ||
      prev.five_hour_percent || prev.seven_day_percent) {
    return {
      five_hour_percent: prev.five_hour_percent ?? 0,
      seven_day_percent: prev.seven_day_percent ?? 0,
      five_hour_resets_at: prev.five_hour_resets_at ?? '',
      seven_day_resets_at: prev.seven_day_resets_at ?? ''
    };
  }
  return null;
}

async function lastUsageAndModel(transcriptPath) {
  try {
    const rl = createInterface({ input: createReadStream(transcriptPath) });
    let lastUsageLine = null;
    let lastModel = null;
    for await (const line of rl) {
      if (line.includes('"model"')) {
        try { lastModel = JSON.parse(line)?.message?.model ?? lastModel; } catch {}
      }
      if (line.includes('"usage"')) lastUsageLine = line;
    }
    if (!lastUsageLine) return { tokens: 0, model: lastModel };
    const obj = JSON.parse(lastUsageLine);
    const u = obj.message?.usage ?? obj.usage ?? {};
    const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    return { tokens, model: obj.message?.model ?? lastModel };
  } catch {
    return { tokens: 0, model: null };
  }
}

async function fetchLimitsFresh() {
  const creds = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'));
  const token = creds?.claudeAiOauth?.accessToken;
  if (!token) throw new Error('no oauth token');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  const resp = await fetch(USAGE_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20'
    },
    signal: ctrl.signal
  });
  clearTimeout(timer);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return pickLimits(await resp.json());
}

async function fetchLimits() {
  const cache = readCache();
  if (cache && Date.now() - (cache.fetched_at ?? 0) < CACHE_TTL_MS) {
    const { fetched_at, ...limits } = cache;
    return limits;
  }
  try {
    const limits = await fetchLimitsFresh();
    writeCache(limits);
    return limits;
  } catch {
    if (cache) {
      const { fetched_at, ...limits } = cache;
      return limits;
    }
    return null;
  }
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj));
}

function appendHistory(entry) {
  try {
    mkdirSync(dirname(HISTORY_FILE), { recursive: true });
    appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n');
  } catch {}
}

async function main() {
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw); } catch {}

  const transcript = input.transcript_path;
  const cwd = input.cwd;
  const sid = input.session_id;

  const out = cwd && sid
    ? join(homedir(), '.claude', 'projects', slugify(cwd), `usage-${sid}.json`)
    : null;

  const isUserPromptSubmit = 'prompt' in input;
  const existing = out ? readExisting(out) : null;

  let ctx, model;
  if (isUserPromptSubmit) {
    ctx = existing?.context_percent ?? 0;
    model = existing?.model ?? null;
  } else {
    const result = transcript ? await lastUsageAndModel(transcript) : { tokens: 0, model: null };
    model = result.model;
    const limit = MODEL_LIMITS[model] ?? DEFAULT_LIMIT;
    ctx = Math.floor((result.tokens * 100) / limit);
  }

  const limits =
    (await fetchLimits()) ??
    limitsFromExisting(existing) ?? {
      five_hour_percent: 0,
      seven_day_percent: 0,
      five_hour_resets_at: '',
      seven_day_resets_at: ''
    };

  // Legacy global bridge (kept for backwards-compat with the old extension).
  writeJson(join(homedir(), '.claude', 'context-bridge.json'), {
    context_percent: ctx
  });

  if (out) {
    writeJson(out, {
      context_percent: ctx,
      model: model ?? existing?.model ?? null,
      ...limits,
      session_id: sid,
      updated_at: new Date().toISOString()
    });
  }

  if (sid) {
    appendHistory({
      ts: new Date().toISOString(),
      type: isUserPromptSubmit ? 'submit' : 'stop',
      sid,
      model: model ?? existing?.model ?? null,
      ctx,
      h: limits.five_hour_percent,
      w: limits.seven_day_percent,
      h_reset: limits.five_hour_resets_at,
      w_reset: limits.seven_day_resets_at
    });
  }
}

main().catch((e) => {
  console.error(`[stop-bridge] ${e.message}`);
  process.exit(0); // never block the Claude turn
});
