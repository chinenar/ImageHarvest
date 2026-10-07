// Data-only adaptive memory. A successful strategy does not certify chapter completeness.
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { digest } = require('./site-observer.cjs');
const STRATEGIES = ['dom', 'lazy-attributes', 'css-backgrounds', 'conservative-scroll'];
const FAMILIES = ['img', 'canvas', 'background', 'mixed', 'unknown'];
const OUTCOMES = ['usable', 'partial', 'empty', 'cancelled', 'blocked', 'error'];
const MAX_PROFILES = 200, TTL = 90 * 86400000;
const count = value => Math.max(0, Math.min(1000000, Math.floor(Number(value) || 0)));
const hash = value => /^[a-f0-9]{64}$/.test(value || '') ? value : '';
function scopeFor(url, mode) {
  const u = new URL(url);
  const route = u.pathname.split('/').filter(Boolean)[0] || '/';
  // Same origin can have unrelated readers. Do not store chapter names or signed query strings.
  return { key: digest(u.origin + '|' + route + '|' + mode), site: u.hostname, mode };
}
function fingerprint(probe = {}, network = {}) {
  const family = FAMILIES.includes(probe.family) ? probe.family : 'unknown';
  const attrs = (probe.lazyAttributes || []).filter(x => /^data-[a-z][a-z0-9-]{0,50}$/.test(x)).slice(0, 16).sort();
  return { family, structure: family === 'unknown' ? '' : digest(JSON.stringify([family, attrs, (probe.topology || []).slice(0, 20)])),
    scriptIdentity: hash(network.scriptIdentity), scriptMetadata: hash(network.scriptMetadata), scriptBytes: hash(network.scriptBytes),
    scriptCount: count(network.scriptCount), hashedScripts: count(network.hashedScripts) };
}
function sanitizeSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  return { family: FAMILIES.includes(value.family) ? value.family : 'unknown', structure: hash(value.structure),
    scriptIdentity: hash(value.scriptIdentity), scriptMetadata: hash(value.scriptMetadata), scriptBytes: hash(value.scriptBytes),
    scriptCount: count(value.scriptCount), hashedScripts: count(value.hashedScripts) };
}
function classifyChange(before, after) {
  if (!before) return 'first-seen';
  if (before.structure && after.structure && before.structure !== after.structure) return 'reader-change';
  const changed = ['scriptIdentity', 'scriptMetadata'].some(k => before[k] && after[k] && before[k] !== after[k]);
  const bytesChanged = before.hashedScripts > 0 && before.hashedScripts === after.hashedScripts && before.scriptBytes && after.scriptBytes && before.scriptBytes !== after.scriptBytes;
  if (changed || bytesChanged) return 'build-change';
  return after.structure || after.scriptIdentity ? 'stable' : 'observation-unavailable';
}
function contentItems(items) {
  const large = items.filter(x => !x.filterHints?.chrome && Number(x.width) >= 240 && Number(x.height) >= 240);
  return large.filter(x => ['reader', 'main'].includes(x.filterHints?.mainKind) || large.length >= 2);
}
function verification(items) {
  const candidates = contentItems(items);
  const verified = candidates.filter(x => x.capturePath || (x.source === 'img' && x.decoded === true));
  return { candidates: candidates.length, verified: verified.length };
}
class SiteProfiles {
  constructor(file, now = () => Date.now()) { this.file = file; this.now = now; this.profiles = new Map(); this.warning = ''; this.readOnly = false; this.queue = Promise.resolve(); }
  async load() {
    try {
      const stat = await fs.stat(this.file);
      if (stat.size > 1024 * 1024) throw new Error('profile-store-too-large');
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.profiles)) throw new Error('profile-store-schema');
      for (const row of data.profiles.slice(-MAX_PROFILES)) {
        if (!hash(row?.key) || typeof row.site !== 'string' || row.site.length > 255 || typeof row.mode !== 'string' || row.mode.length > 80) continue;
        if (!Number.isFinite(row.updatedAt) || this.now() - row.updatedAt > TTL || row.updatedAt > this.now() + 86400000) continue;
        const stats = {};
        for (const strategy of STRATEGIES) if (row.stats?.[strategy]) stats[strategy] = {
          successes: count(row.stats[strategy].successes), failures: count(row.stats[strategy].failures) };
        const last = row.lastAttempt;
        this.profiles.set(row.key, { key: row.key, site: row.site, mode: row.mode, updatedAt: row.updatedAt,
          lastGood: sanitizeSnapshot(row.lastGood), stats,
          lastAttempt: last && OUTCOMES.includes(last.outcome) ? { outcome: last.outcome, verified: count(last.verified), snapshot: sanitizeSnapshot(last.snapshot) } : null });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { this.warning = 'profile-store-unavailable'; this.readOnly = true; }
    }
  }
  baseline(scope) { const row = this.profiles.get(scope.key); return row?.lastGood || row?.lastAttempt?.snapshot || null; }
  suggest(scope, family, available) {
    const own = this.profiles.get(scope.key);
    const rank = rows => STRATEGIES.filter(x => x !== 'dom' && available.includes(x)).map(strategy => {
      const values = rows.map(x => x.stats[strategy]).filter(Boolean);
      const successes = values.reduce((n, x) => n + x.successes, 0), failures = values.reduce((n, x) => n + x.failures, 0);
      return { strategy, successes, score: (successes + 1) / (successes + failures + 2) };
    }).sort((a, b) => b.score - a.score);
    if (own?.lastGood?.family === family) {
      const best = rank([own]).find(x => x.successes >= 1 && x.score > 0.5);
      if (best) return { strategy: best.strategy, source: 'site-history' };
    }
    const peers = [...this.profiles.values()].filter(x => x.key !== scope.key && x.mode === scope.mode && x.lastGood?.family === family && this.now() - x.updatedAt <= TTL);
    const best = rank(peers).find(x => x.successes >= 2 && x.score >= 0.6);
    return best ? { strategy: best.strategy, source: 'reader-family' } : null;
  }
  async remember(scope, snapshot, result) {
    if (this.readOnly) return;
    const old = this.profiles.get(scope.key);
    const row = old || { ...scope, lastGood: null, stats: {} };
    const outcome = OUTCOMES.includes(result.outcome) ? result.outcome : 'error';
    row.updatedAt = this.now();
    row.lastAttempt = { outcome, verified: count(result.verified), snapshot: sanitizeSnapshot(snapshot) };
    if (outcome === 'usable' && result.verified > 0) row.lastGood = sanitizeSnapshot(snapshot);
    for (const attempt of (result.attempts || []).slice(0, 4)) {
      if (!STRATEGIES.includes(attempt.strategy) || outcome === 'cancelled') continue;
      const stat = row.stats[attempt.strategy] ||= { successes: 0, failures: 0 };
      if (outcome === 'usable' && attempt.verified > 0) stat.successes = Math.min(1000, stat.successes + 1);
      else stat.failures = Math.min(1000, stat.failures + 1);
    }
    this.profiles.delete(scope.key); this.profiles.set(scope.key, row);
    for (const [key, value] of this.profiles) if (this.now() - value.updatedAt > TTL) this.profiles.delete(key);
    while (this.profiles.size > MAX_PROFILES) this.profiles.delete(this.profiles.keys().next().value);
    await this.save();
  }
  save() {
    const payload = JSON.stringify({ version: 1, profiles: [...this.profiles.values()] }, null, 2);
    this.queue = this.queue.then(async () => {
      const temp = this.file + '.' + randomUUID() + '.tmp';
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const handle = await fs.open(temp, 'wx', 0o600);
        try { await handle.writeFile(payload, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temp, this.file);
      } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    }).catch(() => { this.warning = 'profile-save-failed'; });
    return this.queue;
  }
}
module.exports = { SiteProfiles, scopeFor, fingerprint, classifyChange, verification, contentItems, STRATEGIES };
