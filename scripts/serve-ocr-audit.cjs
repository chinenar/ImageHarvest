'use strict';
// Local review surface. It reads completed audit artifacts and never invokes OCR/models.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const within = (root, file) => { const r = path.relative(root, file); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
async function json(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } }
function createAuditServer({ output = path.join(ROOT, 'test-results/full-audit-1.6.95/corpus'), assets = path.join(ROOT, 'tools/ocr-audit') } = {}) {
  output = path.resolve(output);
  const suiteRoot = path.join(path.dirname(output), 'suites');
  const cacheRoot = path.join(output, '.web-cache');
  let conversions = 0; const queue = [], pending = new Map();
  async function limited(fn) { if (conversions >= 2) await new Promise(resolve => queue.push(resolve)); conversions++; try { return await fn(); } finally { conversions--; queue.shift()?.(); } }
  async function image(file, key, thumbnail) {
    const cached = path.join(cacheRoot, createHash('sha256').update(key).digest('hex') + (thumbnail ? '.jpg' : '.png'));
    try { return await fs.readFile(cached); } catch {}
    if (!pending.has(cached)) pending.set(cached, limited(async () => {
      const pipeline = sharp(file).rotate();
      if (thumbnail) pipeline.resize({ width: 240, height: 320, fit: 'inside', withoutEnlargement: true });
      const buffer = await (thumbnail ? pipeline.jpeg({ quality: 75 }) : pipeline.png()).toBuffer();
      await fs.mkdir(cacheRoot, { recursive: true }); await fs.writeFile(cached, buffer); return buffer;
    }).finally(() => pending.delete(cached)));
    return pending.get(cached);
  }
  async function manifest() { return await json(path.join(output, 'manifest.json')); }
  async function result(id, m) { const r = await json(path.join(output, id + '.json')); const current = m || await manifest(); const c = current?.cases?.find(c => c.id === id); return r && c && r.implementationDigest === current.implementationDigest && r.sourceHash === c.sourceHash ? { ...r, cleanedPath: r.cleanedPath ?? r.artifacts?.cleanedPath, appliedPatchCount: r.appliedPatchCount ?? r.artifacts?.appliedPatchCount, cleanupPreviewError: r.cleanupPreviewError || r.artifacts?.error } : null; }
  const server = http.createServer(async (req, res) => {
    function send(status, type, body) { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'" }); res.end(body); }
    const reply = (status, value) => send(status, 'application/json; charset=utf-8', JSON.stringify(value));
    try {
      if (req.method !== 'GET') return reply(405, { error: 'GET only' });
      if (req.headers.host !== `127.0.0.1:${req.socket.localPort}`) return reply(403, { error: 'Local host only' });
      // Reject cross-origin browser access to this local file viewer.
      if (req.headers.origin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(req.headers.origin)) return reply(403, { error: 'Local origin only' });
      const url = new URL(req.url, 'http://127.0.0.1');
      const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (staticFiles[url.pathname]) { const [file, type] = staticFiles[url.pathname]; return send(200, type + '; charset=utf-8', await fs.readFile(path.join(assets, file))); }
      if (url.pathname === '/api/catalog') {
        const m = await manifest();
        if (!m) return reply(200, { state: 'waiting', cases: [], totalImages: 589 });
        const cases = await Promise.all(m.cases.map(async c => { const r = await result(c.id, m); const metrics = r?.planMetrics || r?.ocrMetrics; return { id: c.id, relative: c.relative, group: c.group, width: c.width, height: c.height, sourceHash: c.sourceHash, state: r ? (r.error ? 'error' : 'done') : 'pending', at: r?.at, error: r?.error, timings: r?.timings, metrics, cleaned: Boolean(r?.cleanedPath), cleanupError: r?.cleanupPreviewError, text: [...(r?.ocrRegions || []), ...(r?.planRegions || [])].map(row => row.text).join('\n') }; }));
        const annotations = await json(path.join(path.dirname(output), 'annotated-scores.json'));
        const score = value => value ? { matched: value.matches?.length || 0, annotatedUnits: value.annotatedUnits, cer: value.cer, missing: value.missing?.length || 0 } : null;
        const references = annotations?.groups?.map(g => ({ id: g.id, scope: g.scope, pages: g.pages.map(p => ({ id: p.id, label: p.label, coverage: p.coverage, annotatedUnits: p.annotatedUnits, status: annotations.implementationDigest === m.implementationDigest ? p.status : 'stale', raw: score(p.raw), planned: score(p.planned), eligible: score(p.eligible) })) }));
        return reply(200, { state: 'ready', totalImages: m.totalImages, totalGroups: m.totalGroups, version: m.version, sourceFingerprint: m.sourceFingerprint, summary: await json(path.join(output, 'summary.json')), suites: await json(path.join(suiteRoot, 'summary.json')), references, cases });
      }
      if (url.pathname === '/api/summary') return reply(200, await json(path.join(output, 'summary.json')));
      const suiteMatch = url.pathname.match(/^\/suite\/([a-zA-Z0-9_-]+)$/);
      if (suiteMatch) { const suite = (await json(path.join(suiteRoot, 'summary.json')))?.suites?.find(s => s.name === suiteMatch[1]); if (!suite) return reply(404, { error: 'Unknown suite' }); const log = path.resolve(suiteRoot, path.basename(suite.log)); if (!within(suiteRoot, log)) return reply(403, {}); return send(200, 'text/plain; charset=utf-8', await fs.readFile(log)); }
      const match = url.pathname.match(/^\/(api\/result|image|clean|thumb)\/(page-\d+-[a-f0-9]+)$/);
      if (!match) return reply(404, { error: 'Unknown route' });
      const [ , kind, id ] = match; const m = await manifest(), c = m?.cases?.find(item => item.id === id);
      if (!c) return reply(404, { error: 'Unknown manifest page' });
      const r = await result(id, m);
      if (kind === 'api/result') return reply(r ? 200 : 202, r || { id, pending: true });
      let file;
      if (kind === 'clean') { if (!r?.cleanedPath) return reply(404, { error: 'Cleanup preview pending' }); file = path.resolve(output, r.cleanedPath); if (!within(output, file)) return reply(403, { error: 'Invalid clean path' }); }
      else { file = path.resolve(c.file); if (!within(path.resolve(m.source), file)) return reply(403, { error: 'Invalid source path' }); }
      // Real paths also guard against a symlink escaping the approved root.
      const real = await fs.realpath(file), approved = await fs.realpath(kind === 'clean' ? output : m.source);
      if (!within(approved, real)) return reply(403, { error: 'Invalid image path' });
      const stat = await fs.stat(real);
      return send(200, kind === 'thumb' ? 'image/jpeg' : 'image/png', await image(real, `${id}:${kind}:${c.sourceHash}:${stat.size}:${stat.mtimeMs}`, kind === 'thumb'));
    } catch (error) { send(500, 'application/json', JSON.stringify({ error: error.message })); }
  });
  return server;
}
if (require.main === module) {
  const arg = name => process.argv.slice(2).find(s => s.startsWith('--' + name + '='))?.split('=').slice(1).join('=');
  const port = Number(arg('port') || 8789);
  const server = createAuditServer({ ...(arg('output') ? { output: arg('output') } : {}) });
  server.listen(port, '127.0.0.1', () => console.log(`OCR audit viewer: http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { createAuditServer, within };
