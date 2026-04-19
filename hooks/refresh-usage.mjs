#!/usr/bin/env node
// Manual 5h/weekly refresh. Invoked by the status-bar click.
// Usage: node refresh-usage.mjs <bridge_path>

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_FILE = join(homedir(), '.claude', 'oauth-usage-cache.json');
const CACHE_TTL_MS = 30 * 1000; // shorter for manual clicks

const bridge = process.argv[2];
if (!bridge) {
  console.error('usage: refresh-usage.mjs <bridge_path>');
  process.exit(1);
}

function readBridge() {
  try { return JSON.parse(readFileSync(bridge, 'utf8')); } catch { return {}; }
}

function readCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { return null; }
}

function writeCache(limits) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ ...limits, fetched_at: Date.now() }));
  } catch {}
}

function pickLimits(body) {
  return {
    five_hour_percent: Math.floor(body?.five_hour?.utilization ?? 0),
    seven_day_percent: Math.floor(body?.seven_day?.utilization ?? 0),
    five_hour_resets_at: body?.five_hour?.resets_at ?? '',
    seven_day_resets_at: body?.seven_day?.resets_at ?? ''
  };
}

async function fetchLimitsFresh() {
  const creds = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'));
  const token = creds?.claudeAiOauth?.accessToken;
  if (!token) throw new Error('no oauth token');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
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

async function getLimits() {
  const cache = readCache();
  if (cache && Date.now() - (cache.fetched_at ?? 0) < CACHE_TTL_MS) {
    const { fetched_at, ...limits } = cache;
    return limits;
  }
  try {
    const limits = await fetchLimitsFresh();
    writeCache(limits);
    return limits;
  } catch (e) {
    if (cache) {
      const { fetched_at, ...limits } = cache;
      return limits;
    }
    throw e;
  }
}

async function main() {
  const prev = readBridge();
  const limits = await getLimits();
  const out = {
    context_percent: prev.context_percent ?? 0,
    ...limits,
    session_id: prev.session_id ?? '',
    updated_at: new Date().toISOString()
  };
  mkdirSync(dirname(bridge), { recursive: true });
  writeFileSync(bridge, JSON.stringify(out));
}

main().catch((e) => {
  console.error(`[refresh-usage] ${e.message}`);
  process.exit(2);
});
