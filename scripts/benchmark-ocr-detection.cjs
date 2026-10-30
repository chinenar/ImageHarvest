'use strict';

// Local-only detection audit. Truth boxes are never supplied to OCR or planning.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { EnhancedMangaOcrPool } = require('../src/enhanced-manga-ocr.cjs');
const { LocalOcrBackend } = require('../src/ocr-backend.cjs');
const { planReadingPage } = require('../src/reader-quality.cjs');
const { translationEligible, contentRole } = require('../src/ocr-content-role.cjs');
const { implementationFingerprint } = require('./ocr-corpus-inventory.cjs');
const { evaluateDetection } = require('./ocr-detection-metrics.cjs');

const repo = path.resolve(__dirname, '..');
const references = ['ocr-detection-reference.json', 'ocr-detection-vertical-reference.json'];
const stages = ['raw', 'planned', 'eligible'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function options(args) {
  const result = { phase: 'before', only: null, reuse: null, rescore: false };
  for (let i = 0; i < args.length; i++) {
    const [key, inline] = args[i].split('=', 2);
    if (key === '--rescore' && inline === undefined) { result.rescore = true; continue; }
    if (!['--phase', '--case', '--reuse'].includes(key)) throw Error('Unknown option: ' + key);
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw Error('Missing value for ' + key);
    if (key === '--case') result.only = value.split(',');
    else result[key.slice(2)] = value;
  }
  for (const phase of [result.phase, result.reuse].filter(Boolean)) {
    if (!/^[a-z][a-z0-9-]{0,50}$/.test(phase)) throw Error('Phase must be a simple lowercase name');
  }
  if (result.phase === result.reuse) throw Error('Reuse must name a different phase');
  if (result.rescore && result.reuse) throw Error('--rescore evaluates saved outputs and cannot use --reuse');
  return result;
}

async function fingerprint() {
  return implementationFingerprint(path.join(repo, 'src'), [__filename, path.join(__dirname, 'ocr-detection-metrics.cjs'), path.join(__dirname, 'ocr-corpus-inventory.cjs')]);
}

function rectangle(box, color, label) {
  const b = Array.isArray(box) ? { x0: box[0], y0: box[1], x1: box[2], y1: box[3] } : box;
  if (!b) return '';
  return `<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" fill="none" stroke="${color}" stroke-width="2"><title>${escapeHtml(label)}</title></rect>`;
}

function overlay(c, stage, rows) {
  return `<figure><figcaption>${stage}</figcaption><svg viewBox="0 0 ${c.width} ${c.height}" role="img" aria-label="${escapeHtml(c.id + ' ' + stage + ' overlay')}"><image href="${encodeURIComponent(c.id)}.png" width="${c.width}" height="${c.height}"/><g class="ignore">${(c.ignore || []).map((b, i) => rectangle(b, '#999', 'Ignore ' + i)).join('')}</g><g class="truth">${c.units.map(u => rectangle(u.box, '#00b8ff', u.id + (u.text == null ? ': untranscribed' : ': ' + u.text))).join('')}</g><g class="prediction">${rows.map(r => rectangle(r.bbox, '#f33', r.id + ': ' + (r.text || ''))).join('')}</g></svg></figure>`;
}

function metricRow(stage, m) {
  if (!m) return `<tr><td>${stage}</td><td colspan="8">Stage failed or not run</td></tr>`;
  return `<tr><td>${stage}</td><td>${m.rawOutputs}</td><td>${m.matches.length}/${m.annotatedUnits}</td><td>${m.missing.length}</td><td>${m.falsePositives.length}</td><td>${m.splits.length}</td><td>${m.merges.length}</td><td>${m.duplicatePairs.length}</td><td>${m.cer.value == null ? 'unknown' : m.cer.value.toFixed(4)}</td></tr>`;
}

async function writeReport(out, summary, details) {
  const sections = details.map(d => `<section><h2>${escapeHtml(d.id)}</h2><p>${escapeHtml(d.reference.coverage)} · ${d.reference.units.length} annotated units · ${escapeHtml(d.reference.language)} · ${d.ocrReused ? 'Raw OCR reused from ' + escapeHtml(d.reusedFromPhase) + '; current planning rerun' : 'Fresh OCR'} · OCR ${(d.ocrMs / 1000).toFixed(1)}s · planning ${(d.planningMs / 1000).toFixed(1)}s</p><p>${escapeHtml(d.reference.notes)}</p>${d.error ? '<p class="error">' + escapeHtml(d.error) + '</p>' : ''}${d.sourceChangedDuringCase ? '<p class="error">Source implementation changed during this case; timing/provenance is mixed.</p>' : ''}<table><thead><tr><th>Stage</th><th>Outputs</th><th>Matches/truth</th><th>Missing</th><th>False positives</th><th>Splits</th><th>Merges</th><th>Duplicates</th><th>CER</th></tr></thead><tbody>${stages.map(s => metricRow(s, d.metrics[s])).join('')}</tbody></table><div class="views">${stages.map(s => overlay(d.reference, s, d.rows[s] || [])).join('')}</div></section>`).join('');
  await fs.writeFile(path.join(out, 'report.html'), `<!doctype html><meta charset="utf-8"><title>OCR detection ${escapeHtml(summary.phase)}</title><style>body{font:15px system-ui;margin:24px;color:#222}section{margin:32px 0}p{max-width:1100px}table{border-collapse:collapse}td,th{padding:6px 12px;border:1px solid #ddd}.views{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}figure{margin:12px 0}figcaption{font-weight:bold}svg{width:100%;display:block}.error{color:#b00}@media(max-width:850px){.views{grid-template-columns:1fr}}</style><h1>OCR detection: ${escapeHtml(summary.phase)}</h1><p>Local images and manually annotated geometry. Blue: truth; red: predictions; gray: ignored effects. Hover boxes for IDs. Null reference text means unknown CER. Chinese is a complete isolated crop, with partial coverage of its original page. Scores do not measure all corpus pages or translation accuracy.</p><p>Eligibility uses production translationEligible with its default review gate, without translation. Timings are observed wall time on this machine, including model work; reused OCR has no fresh inference timing.</p><label><input type="checkbox" checked data-layer="truth"> Truth</label> <label><input type="checkbox" checked data-layer="prediction"> Predictions</label> <label><input type="checkbox" checked data-layer="ignore"> Ignore</label>${sections}<script>document.querySelectorAll('[data-layer]').forEach(e=>e.addEventListener('change',()=>document.querySelectorAll('.'+e.dataset.layer).forEach(g=>g.style.display=e.checked?'':'none')))</script>`);
}

async function rescorePhase(out, selected, loaded) {
  const summary = JSON.parse(await fs.readFile(path.join(out, 'summary.json'), 'utf8'));
  const updated = new Map(selected.map(c => [c.id, c]));
  const details = [];
  const evaluationFingerprint = await fingerprint();
  for (const old of summary.cases) {
    const d = { ...old, rows: {} };
    for (const stage of stages) {
      const saved = await fs.readFile(path.join(out, d.id + '-' + stage + '.json'), 'utf8').then(JSON.parse).catch(error => {
        if (error.code === 'ENOENT' && !d.metrics[stage]) return null;
        throw error;
      });
      if (saved) d.rows[stage] = stage === 'eligible' ? saved.regions : saved.result.regions;
    }
    const c = updated.get(d.id);
    if (c) {
      const currentSourceHash = digest(await fs.readFile(path.resolve(repo, c.source)));
      if (currentSourceHash !== d.sourceHash || (c.sourceHash && c.sourceHash !== currentSourceHash) || c.width !== d.reference.width || c.height !== d.reference.height || c.language !== d.reference.language) throw Error('Rescore input does not match saved inference: ' + c.id);
      d.reference = c;
      d.evaluationFingerprint = evaluationFingerprint;
      d.reevaluatedAt = new Date().toISOString();
      for (const stage of stages) if (d.rows[stage]) {
        d.metrics[stage] = evaluateDetection(d.rows[stage], c);
        await json(path.join(out, d.id + '-' + stage + '-metrics.json'), d.metrics[stage]);
      }
      const { rows, ...compact } = d;
      await json(path.join(out, d.id + '-result.json'), compact);
    }
    details.push(d);
  }
  summary.cases = details.map(({ rows, ...compact }) => compact);
  summary.reassessment = { reevaluatedAt: new Date().toISOString(), caseIds: selected.map(c => c.id), evaluationFingerprint, referenceFiles: loaded.map(r => ({ name: r.name, hash: r.hash, scope: r.scope })), inferenceRerun: false, planningRerun: false, eligibilityRerun: false };
  await json(path.join(out, 'summary.json'), summary);
  await writeReport(out, summary, details);
  console.log('Reevaluated saved outputs against current reference: ' + path.join(out, 'summary.json'));
}

async function main(args = process.argv.slice(2)) {
  const config = options(args);
  const loaded = await Promise.all(references.map(async name => {
    const bytes = await fs.readFile(path.join(repo, 'test', 'fixtures', name));
    return { name, hash: digest(bytes), ...JSON.parse(bytes) };
  }));
  const all = loaded.flatMap(r => r.cases.map(c => ({ ...c, referenceFile: r.name, referenceHash: r.hash })));
  if (new Set(all.map(c => c.id)).size !== all.length) throw Error('Duplicate reference case IDs');
  if (config.only?.some(id => !all.some(c => c.id === id))) throw Error('Unknown --case ID');
  const selected = all.filter(c => !config.only || config.only.includes(c.id));
  const root = path.join(repo, 'test-results', 'ocr-detection');
  const out = path.join(root, config.phase);
  if (config.rescore) return rescorePhase(out, selected, loaded);
  await fs.mkdir(out, { recursive: true });
  const started = Date.now();
  const initialFingerprint = await fingerprint();
  const summary = { schema: 1, phase: config.phase, generatedAt: new Date().toISOString(), selectedCaseIds: selected.map(c => c.id), reusePhase: config.reuse, implementationFingerprint: initialFingerprint, referenceFiles: loaded.map(r => ({ name: r.name, hash: r.hash, scope: r.scope })), evaluationScope: 'Selected manually annotated pages and crop only. Untranscribed units have unknown CER; partial Chinese crop has no full original-page denominator.', eligibility: 'translationEligible(plannedRegion), includeUncertain=false, no translation', cases: [] };
  const backend = new LocalOcrBackend({ timeout: 360000 });
  let pool, activeLanguage;
  const details = [];
  try {
    const runtimeStart = Date.now();
    await json(path.join(out, 'runtime.json'), await backend.status());
    summary.runtimeStartupMs = Date.now() - runtimeStart;
    for (const c of selected) {
      if (!/^[a-zA-Z0-9_-]+$/.test(c.id)) throw Error('Unsafe case ID: ' + c.id);
      const caseStart = Date.now();
      const caseFingerprint = await fingerprint();
      const d = { id: c.id, reference: c, source: path.resolve(repo, c.source), implementationFingerprint: caseFingerprint, ocrReused: Boolean(config.reuse), reusedFromPhase: config.reuse, ocrMs: 0, planningMs: 0, rows: {}, metrics: {} };
      console.log(`${config.phase} ${c.id}: start (${c.language}, ${c.coverage})`);
      try {
        const image = await fs.readFile(d.source);
        d.sourceHash = digest(image);
        if (c.sourceHash && c.sourceHash !== d.sourceHash) throw Error('Reference source hash mismatch');
        const metadata = await sharp(image).metadata();
        if (metadata.width !== c.width || metadata.height !== c.height) throw Error('Reference dimensions do not match input');
        await sharp(image).png().toFile(path.join(out, c.id + '.png'));
        let raw;
        if (config.reuse) {
          const reusedPath = path.join(root, config.reuse, c.id + '-raw.json');
          const old = JSON.parse(await fs.readFile(reusedPath, 'utf8'));
          if (old.sourceHash !== d.sourceHash || old.language !== c.language || old.width !== c.width || old.height !== c.height || old.result?.error) throw Error('Reused OCR source, language, dimensions or success state mismatch');
          raw = old.result;
          d.reusedRaw = { file: reusedPath, sourceHash: old.sourceHash, implementationFingerprint: old.implementationFingerprint, originalOcrMs: old.ocrMs, originallyReused: old.ocrReused };
        } else {
          if (!pool || activeLanguage !== c.language) {
            await pool?.close();
            activeLanguage = c.language;
            pool = new EnhancedMangaOcrPool({ backend, langPath: path.join(repo, 'assets', 'tessdata'), languages: [c.language === 'ja' ? 'jpn' : 'eng'], recognitionLanguage: c.language, concurrency: 1, detailDetection: true });
          }
          const ocrStart = Date.now();
          [raw] = await pool.recognizePages([{ filePath: d.source }], { onRegion: p => {
            if (p.engine === 'enhanced' || p.index === 1 || p.index === p.total) console.log(`${c.id}: ${p.phase || p.engine} ${p.index}/${p.total}`);
          } });
          d.ocrMs = Date.now() - ocrStart;
        }
        await json(path.join(out, c.id + '-raw.json'), { source: d.source, sourceHash: d.sourceHash, language: c.language, width: c.width, height: c.height, implementationFingerprint: caseFingerprint, ocrMs: d.ocrMs, ocrReused: d.ocrReused, reusedRaw: d.reusedRaw, result: raw });
        if (raw.error) throw Error(raw.error);
        d.rows.raw = raw.regions || [];
        d.metrics.raw = evaluateDetection(d.rows.raw, c);
        await json(path.join(out, c.id + '-raw-metrics.json'), d.metrics.raw);
        const planStart = Date.now();
        const planned = await planReadingPage(backend, image, structuredClone(d.rows.raw), { sourceLanguage: c.language, refineText: true });
        d.planningMs = Date.now() - planStart;
        await json(path.join(out, c.id + '-planned.json'), { source: d.source, sourceHash: d.sourceHash, implementationFingerprint: caseFingerprint, planningMs: d.planningMs, ocrReused: d.ocrReused, result: planned });
        if (planned.error) throw Error(planned.error);
        d.rows.planned = planned.regions || [];
        d.rows.eligible = d.rows.planned.filter(r => translationEligible(r));
        d.excludedFromEligibility = d.rows.planned.filter(r => !translationEligible(r)).map(r => ({ id: r.id, ...contentRole(r) }));
        for (const stage of ['planned', 'eligible']) {
          d.metrics[stage] = evaluateDetection(d.rows[stage], c);
          await json(path.join(out, c.id + '-' + stage + '-metrics.json'), d.metrics[stage]);
        }
        await json(path.join(out, c.id + '-eligible.json'), { regions: d.rows.eligible, excluded: d.excludedFromEligibility });
      } catch (error) {
        d.error = error.stack || error.message;
        d.workerStats = backend.stats();
        d.workerLog = backend.logs;
        process.exitCode = 1;
      }
      d.ms = Date.now() - caseStart;
      d.endImplementationFingerprint = await fingerprint();
      d.sourceChangedDuringCase = caseFingerprint.implementationDigest !== d.endImplementationFingerprint.implementationDigest;
      details.push(d);
      const { rows, ...compact } = d;
      summary.cases.push(compact);
      await json(path.join(out, c.id + '-result.json'), compact);
      summary.ms = Date.now() - started;
      await json(path.join(out, 'summary.json'), summary);
      await writeReport(out, summary, details);
      console.log(`${c.id}: OCR ${d.ocrMs}ms, planning ${d.planningMs}ms; ` + stages.map(s => `${s} ${d.metrics[s]?.matches.length ?? '?'}/${c.units.length}`).join(', ') + (d.error ? ' ERROR' : ''));
    }
  } finally {
    await pool?.close();
    backend.close();
    summary.endImplementationFingerprint = await fingerprint();
    summary.sourceChangedDuringRun = initialFingerprint.implementationDigest !== summary.endImplementationFingerprint.implementationDigest;
    summary.ms = Date.now() - started;
    await json(path.join(out, 'summary.json'), summary);
    await writeReport(out, summary, details);
  }
  console.log('Saved ' + path.join(out, 'summary.json'));
}

module.exports = { main, options };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
