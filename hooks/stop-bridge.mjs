#!/usr/bin/env node
// Stop / UserPromptSubmit hook.
// Reads JSON from stdin ({session_id, cwd, transcript_path}),
// writes per-session usage.json under ~/.claude/projects/<slug>/.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const MODEL_LIMITS = {
  'claude-fable-5': 1_000_000,
  'claude-mythos-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-5': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
};
const DEFAULT_LIMIT = 200_000;

// Model ids arrive in several shapes: bare ("claude-opus-4-8"), date-pinned
// ("claude-haiku-4-5-20251001"), or with a context-variant suffix
// ("claude-opus-4-8[1m]"). Normalize, look up, then fall back by family so a
// date bump or a new minor version of a known family doesn't reset to default.
function contextLimit(model) {
  if (!model) return DEFAULT_LIMIT;
  // A "[1m]"/"[200k]" variant suffix states the window directly.
  const variant = /\[(\d+)\s*([mk])\]/i.exec(model);
  if (variant) {
    return Number(variant[1]) * (variant[2].toLowerCase() === 'm' ? 1_000_000 : 1_000);
  }
  // Strip bracketed suffixes and a trailing -YYYYMMDD date pin.
  const base = model.replace(/\[[^\]]*\]/g, '').replace(/-\d{8}$/, '');
  if (MODEL_LIMITS[base]) return MODEL_LIMITS[base];
  if (/opus|fable|mythos/.test(base)) return 1_000_000;
  return DEFAULT_LIMIT; // sonnet/haiku and unknown families default to 200k
}
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

// The weekly limit is now reported across several buckets
// (seven_day, seven_day_opus, seven_day_sonnet, …). The figure the user
// actually hits first is the highest of them, so take the max and use that
// bucket's reset time (falling back to the overall seven_day reset).
function pickWeekly(body) {
  if (!body || typeof body !== 'object') return { percent: 0, resets_at: '' };
  let percent = 0;
  let resets_at = body?.seven_day?.resets_at ?? '';
  for (const [key, val] of Object.entries(body)) {
    if (!key.startsWith('seven_day')) continue;
    const u = val && typeof val === 'object' ? val.utilization : null;
    if (typeof u === 'number' && u > percent) {
      percent = u;
      resets_at = val.resets_at ?? resets_at;
    }
  }
  return { percent: Math.floor(percent), resets_at };
}

function bucketPct(body, key) {
  const u = body?.[key]?.utilization;
  return typeof u === 'number' ? Math.floor(u) : 0;
}

function pickLimits(body) {
  const weekly = pickWeekly(body);
  return {
    five_hour_percent: Math.floor(body?.five_hour?.utilization ?? 0),
    seven_day_percent: weekly.percent,
    seven_day_sonnet_percent: bucketPct(body, 'seven_day_sonnet'),
    seven_day_opus_percent: bucketPct(body, 'seven_day_opus'),
    five_hour_resets_at: body?.five_hour?.resets_at ?? '',
    seven_day_resets_at: weekly.resets_at
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
      seven_day_sonnet_percent: prev.seven_day_sonnet_percent ?? 0,
      seven_day_opus_percent: prev.seven_day_opus_percent ?? 0,
      five_hour_resets_at: prev.five_hour_resets_at ?? '',
      seven_day_resets_at: prev.seven_day_resets_at ?? ''
    };
  }
  return null;
}

async function lastUsageAndModel(transcriptPath) {
  try {
    const rl = createInterface({ input: createReadStream(transcriptPath) });
    let lastUsage = null;
    let lastModel = null;
    for await (const line of rl) {
      if (!line.includes('"usage"') && !line.includes('"model"')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const m = obj?.message?.model;
      if (m) lastModel = m;
      const u = obj?.message?.usage ?? obj?.usage;
      if (u && typeof u === 'object') {
        const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        if (tokens > 0) lastUsage = { tokens, model: m ?? lastModel };
      }
    }
    return { usage: lastUsage, model: lastModel };
  } catch {
    return { usage: null, model: null };
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

  // Always read transcript when available — UserPromptSubmit can use the previous
  // assistant turn's usage to keep S accurate even if Stop never fires.
  const result = transcript ? await lastUsageAndModel(transcript) : { usage: null, model: null };
  const model = result.usage?.model ?? result.model ?? existing?.model ?? null;
  let ctx;
  let ctxTokens;
  if (result.usage) {
    ctx = Math.floor((result.usage.tokens * 100) / contextLimit(model));
    ctxTokens = result.usage.tokens;
  } else {
    ctx = existing?.context_percent ?? null;
    ctxTokens = existing?.context_tokens ?? null;
  }

  const limits =
    (await fetchLimits()) ??
    limitsFromExisting(existing) ?? {
      five_hour_percent: 0,
      seven_day_percent: 0,
      seven_day_sonnet_percent: 0,
      seven_day_opus_percent: 0,
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
      context_tokens: ctxTokens,
      model,
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
      model,
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
