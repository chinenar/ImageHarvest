'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { EnhancedMangaOcrPool } = require('../src/enhanced-manga-ocr.cjs');
const { LocalOcrBackend } = require('../src/ocr-backend.cjs');
const { planReadingPage } = require('../src/reader-quality.cjs');
const { contentRole, translationEligible } = require('../src/ocr-content-role.cjs');
const { collectImageInventory, implementationFingerprint } = require('./ocr-corpus-inventory.cjs');

const hash = (data) => createHash('sha256').update(data).digest('hex');
const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const increment = (counts, key) => {
  if (key) counts[key] = (counts[key] || 0) + 1;
};
async function save(file, value) {
  const temporary = file + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2));
  await fs.rename(temporary, file);
}
function metrics(rows, planned) {
  const out = {
    regions: rows.length,
    vertical: 0,
    review: 0,
    eligible: 0,
    excluded: 0,
    placementReview: 0,
    paintable: 0,
    blocked: 0,
    cleanupPatches: 0,
    cleanupPixels: 0,
    cleanupModelErrors: 0,
    refinementErrors: 0,
    reviewReasons: {},
    roles: {},
    engines: {},
  };
  for (const row of rows) {
    const role = contentRole(row),
      placement = row.placement;
    if (row.orientation === 'vertical') out.vertical++;
    if (row.reviewRequired) out.review++;
    if (translationEligible(row)) out.eligible++;
    else out.excluded++;
    if (placement?.reviewRequired) out.placementReview++;
    if (
      planned &&
      placement?.paintMode &&
      placement.paintMode !== 'none' &&
      translationEligible(row)
    )
      out.paintable++;
    if (planned && (!placement || placement.paintMode === 'none' || !translationEligible(row)))
      out.blocked++;
    if (placement?.erasePatch) out.cleanupPatches++;
    out.cleanupPixels += Number(placement?.erasePatch?.cleanupPixels) || 0;
    if (placement?.cleanupModelError) out.cleanupModelErrors++;
    if (row.refinementError) out.refinementErrors++;
    const reasons = new Set([
      role.reason,
      row.layoutIssue,
      placement?.cleanupReview,
      placement?.layoutReview,
      row.refinementError ? 'refinement-error' : '',
      placement?.cleanupModelError ? 'cleanup-model-error' : '',
      row.reviewRequired ? 'ocr-review-required' : '',
      placement?.reviewRequired ? 'placement-review-required' : '',
    ]);
    for (const reason of reasons) increment(out.reviewReasons, reason);
    increment(out.roles, role.role);
    increment(out.engines, row.recognitionEngine || row.engine || 'unknown');
  }
  return out;
}
function compactRegion(row) {
  const p = row.placement,
    role = contentRole(row);
  return {
    id: row.id,
    bbox: row.bbox,
    orientation: row.orientation,
    confidence: row.confidence,
    text: row.text || '',
    textCharacters: String(row.text || '').length,
    textHash: hash(String(row.text || '')),
    recognitionEngine: row.recognitionEngine,
    reviewRequired: Boolean(row.reviewRequired),
    contentRole: role,
    eligible: translationEligible(row),
    layoutIssue: row.layoutIssue,
    refinementError: row.refinementError,
    unitResolution: row.unitResolution,
    ...(p
      ? {
          placement: {
            paintMode: p.paintMode,
            reviewRequired: p.reviewRequired,
            safeBox: p.safeBox,
            eraseBox: p.eraseBox,
            surfaceType: p.surfaceType,
            cleanupReview: p.cleanupReview,
            layoutReview: p.layoutReview,
            cleanupModelError: p.cleanupModelError,
            cleanupPixels: p.erasePatch?.cleanupPixels,
            hasCleanupPatch: Boolean(p.erasePatch),
          },
        }
      : {}),
  };
}
async function saveArtifacts(image, rows, output, id) {
  const patches = rows
    .filter(
      (row) =>
        row.placement?.paintMode !== 'none' &&
        row.placement?.erasePatch?.png &&
        translationEligible(row),
    )
    .map((row) => ({
      input: Buffer.from(row.placement.erasePatch.png, 'base64'),
      left: Math.round(row.placement.erasePatch.bbox.x0),
      top: Math.round(row.placement.erasePatch.bbox.y0),
    }));
  const originalThumbnailPath = `thumbnails/${id}-original.jpg`;
  await sharp(image)
    .resize({ width: 240, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toFile(path.join(output, originalThumbnailPath));
  if (!patches.length)
    return {
      originalThumbnailPath,
      cleanedPath: null,
      cleanedThumbnailPath: null,
      appliedPatchCount: 0,
      error: '',
    };
  const cleanedPath = `cleaned/${id}.png`,
    cleanedThumbnailPath = `thumbnails/${id}-cleaned.jpg`;
  await sharp(image)
    .composite(patches)
    .png({ compressionLevel: 3 })
    .toFile(path.join(output, cleanedPath));
  await sharp(path.join(output, cleanedPath))
    .resize({ width: 240, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toFile(path.join(output, cleanedThumbnailPath));
  return {
    originalThumbnailPath,
    cleanedPath,
    cleanedThumbnailPath,
    appliedPatchCount: patches.length,
    error: '',
  };
}
function aggregate(results, manifest, started, state, backend) {
  const successes = results.filter((r) => !r.error),
    failures = results.filter((r) => r.error);
  const timings = (key) => {
    const values = successes.map((r) => r.timings[key] || 0).sort((a, b) => a - b);
    return {
      totalMs: values.reduce((a, b) => a + b, 0),
      count: values.length,
      medianMs: values.length ? values[Math.floor(values.length / 2)] : null,
      p95Ms: values.length
        ? values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)]
        : null,
      maximumMs: values.at(-1) ?? null,
    };
  };
  const groups = {},
    totals = {},
    reviewReasons = {},
    roles = {};
  for (const result of results) {
    const group = (groups[result.group] ||= {
      total: 0,
      succeeded: 0,
      failed: 0,
      ocrMs: 0,
      planMs: 0,
      regions: 0,
      eligible: 0,
      paintable: 0,
      blocked: 0,
    });
    group.total++;
    result.error ? group.failed++ : group.succeeded++;
    group.ocrMs += result.timings.ocrMs;
    group.planMs += result.timings.planMs;
    const current = result.planMetrics || result.ocrMetrics;
    for (const [key, value] of Object.entries(current || {}))
      if (typeof value === 'number') totals[key] = (totals[key] || 0) + value;
    for (const key of ['regions', 'eligible', 'paintable', 'blocked'])
      group[key] += current?.[key] || 0;
    for (const [key, count] of Object.entries(current?.reviewReasons || {}))
      reviewReasons[key] = (reviewReasons[key] || 0) + count;
    for (const [key, count] of Object.entries(current?.roles || {}))
      roles[key] = (roles[key] || 0) + count;
  }
  return {
    state,
    updatedAt: new Date().toISOString(),
    startedAt: new Date(started).toISOString(),
    elapsedMs: Date.now() - started,
    version: manifest.version,
    implementationDigest: manifest.implementationDigest,
    sourceFingerprint: manifest.sourceFingerprint,
    quality: 'unknown',
    groundTruth: false,
    evaluationScope: manifest.evaluationScope,
    totalImages: manifest.totalImages,
    totalGroups: manifest.totalGroups,
    completed: results.length,
    succeeded: successes.length,
    failed: failures.length,
    remaining: manifest.totalImages - results.length,
    timings: { ocr: timings('ocrMs'), plan: timings('planMs'), total: timings('totalMs') },
    totals,
    reviewReasons,
    roles,
    groups,
    failures: failures.map((r) => ({
      id: r.id,
      file: r.file,
      error: r.error,
      attempts: r.attempts,
    })),
    artifactFailures: results
      .filter((r) => r.artifacts?.error)
      .map((r) => ({ id: r.id, error: r.artifacts.error })),
    workerStats: backend.stats(),
  };
}
async function main() {
  const source = path.resolve(
    args.find((arg) => !arg.startsWith('--')) || 'C:/Users/jinna/Downloads/manga test ocr',
  );
  const output = path.resolve(option('output', 'test-results/full-audit-1.6.95/corpus'));
  const planned = args.includes('--plan');
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(path.join(output, 'cleaned'), { recursive: true });
  await fs.mkdir(path.join(output, 'thumbnails'), { recursive: true });
  const fingerprint = await implementationFingerprint(path.resolve('src'), [
    __filename,
    path.join(__dirname, 'ocr-corpus-inventory.cjs'),
  ]);
  const inventory = await collectImageInventory(source, async (file) => {
    try {
      return await sharp(file).metadata();
    } catch (error) {
      return { metadataError: error.message };
    }
  });
  const cases = [];
  for (const item of inventory) {
    const relative = path.relative(source, item.file).split(path.sep).join('/');
    const sourceHash = await fs
      .readFile(item.file)
      .then(hash)
      .catch(() => null);
    const hint = /[\u3040-\u30ff]/u.test(item.group)
      ? 'ja'
      : /[\u3400-\u9fff]/u.test(item.group)
        ? 'zh'
        : 'auto';
    cases.push({
      ...item,
      relative,
      id: `page-${String(cases.length + 1).padStart(4, '0')}-${hash(relative).slice(0, 8)}`,
      hint,
      sourceHash,
    });
  }
  const sourceFingerprint = hash(
    JSON.stringify(cases.map(({ relative, sourceHash }) => ({ relative, sourceHash }))),
  );
  const manifest = {
    source,
    version: require('../package.json').version,
    ...fingerprint,
    sourceFingerprint,
    totalImages: cases.length,
    totalGroups: new Set(cases.map((c) => c.group)).size,
    groundTruth: false,
    quality: 'unknown',
    evaluationScope: `Fresh sequential full-page OCR on ALL ${cases.length} source images${planned ? ' plus refinement, cleanup-mask and placement planning' : ''}; no translation-provider calls. Eligibility and review counters are operational diagnostics, not measured corpus accuracy or proof of clean visual output.`,
    excludedDirectoryPattern: '^__mobile_pipeline(?:_|$)',
    excludedGeneratedFilePattern: '^__ctd_seg_',
    options: { all: true, planned, concurrency: 1, resume: args.includes('--resume') },
    cases,
  };
  await save(path.join(output, 'manifest.json'), manifest);
  await save(path.join(output, 'inventory.json'), inventory);
  const backend = new LocalOcrBackend({ timeout: Number(option('timeout', 360000)) });
  const pools = new Map(),
    results = [],
    started = Date.now();
  let active = null;
  const heartbeat = setInterval(
    () =>
      console.log(
        JSON.stringify({
          kind: 'heartbeat',
          at: new Date().toISOString(),
          completed: results.length,
          total: cases.length,
          active,
          rssMb: Math.round(process.memoryUsage().rss / 1048576),
          workerPid: backend.child?.pid,
        }),
      ),
    30000,
  );
  const summarize = (state) =>
    save(path.join(output, 'summary.json'), aggregate(results, manifest, started, state, backend));
  const reset = async () => {
    for (const pool of pools.values()) await pool.close().catch(() => {});
    pools.clear();
    backend.close();
  };
  try {
    await save(path.join(output, 'runtime.json'), await backend.status());
    await summarize('running');
    for (const c of cases) {
      active = { id: c.id, file: c.relative, phase: 'start' };
      const dest = path.join(output, c.id + '.json');
      if (args.includes('--resume')) {
        const old = await fs
          .readFile(dest, 'utf8')
          .then(JSON.parse)
          .catch(() => null);
        if (
          old?.sourceHash === c.sourceHash &&
          old.implementationDigest === fingerprint.implementationDigest &&
          old.planned === planned &&
          !old.error
        ) {
          results.push(old);
          await summarize('running');
          console.log(`${results.length}/${cases.length} ${c.id}: verified resume`);
          continue;
        }
      }
      console.log(
        `${results.length + 1}/${cases.length} ${c.id}: start ${c.width}x${c.height} (${c.hint})`,
      );
      const pageStarted = Date.now(),
        attempts = [];
      let result,
        plan,
        error = '',
        ocrMs = 0,
        planMs = 0;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const controller = new AbortController();
        const pageTimer = setTimeout(
          () => controller.abort(Error('Full-page timeout')),
          Number(option('page-timeout', 1800000)),
        );
        try {
          const image = await fs.readFile(c.file);
          if (hash(image) !== c.sourceHash)
            throw Error('Source image changed after inventory fingerprint');
          if (!pools.has(c.hint))
            pools.set(
              c.hint,
              new EnhancedMangaOcrPool({
                langPath: path.resolve('assets/tessdata'),
                languages: c.hint === 'ja' ? ['jpn'] : ['eng', 'fra', 'jpn', 'tha'],
                recognitionLanguage: c.hint,
                concurrency: 1,
                backend,
                detailDetection: true,
              }),
            );
          const ocrStarted = Date.now();
          active.phase = 'ocr';
          try {
            [result] = await pools.get(c.hint).recognizePages([{ filePath: c.file }], {
              signal: controller.signal,
              onRegion: (p) => {
                active.progress = { phase: p.phase || p.engine, index: p.index, total: p.total };
              },
            });
          } finally {
            ocrMs += Date.now() - ocrStarted;
          }
          if (result.error) throw Error(result.error);
          if (planned) {
            const planStarted = Date.now();
            active.phase = 'plan';
            try {
              plan = await planReadingPage(backend, image, result.regions || [], {
                refineText: true,
                sourceLanguage: c.hint,
                signal: controller.signal,
              });
            } finally {
              planMs += Date.now() - planStarted;
            }
            if (plan.error) throw Error(plan.error);
          }
          error = '';
          attempts.push({ attempt, status: 'success' });
          break;
        } catch (failure) {
          error = String(failure.message || failure);
          if (controller.signal.aborted) error = 'Full-page timeout: ' + error;
          attempts.push({
            attempt,
            status: 'error',
            error,
            workerStats: backend.stats(),
            workerLog: backend.logs.slice(-3000),
          });
          const recoverable =
            /out of memory|alloc|CUDA|worker exited|worker closed|นานเกินกำหนด|timeout/i.test(
              error,
            );
          console.log(`${c.id}: attempt ${attempt} ERROR ${error.slice(0, 300)}`);
          if (!recoverable || attempt === 2) break;
          console.log(`${c.id}: reset owned OCR worker and retry once`);
          await reset();
          await backend.status().catch((failure) => {
            attempts.push({ attempt, status: 'recovery-error', error: failure.message });
          });
        } finally {
          clearTimeout(pageTimer);
        }
      }
      const record = {
        ...c,
        implementationDigest: fingerprint.implementationDigest,
        sourceFingerprint,
        planned,
        quality: 'unknown',
        groundTruth: false,
        at: new Date().toISOString(),
        error,
        attempts,
        timings: { ocrMs, planMs, totalMs: Date.now() - pageStarted },
        ocrMetrics: metrics(result?.regions || [], false),
        ...(plan
          ? {
              planMetrics: metrics(plan.regions || [], true),
              planChanges: (plan.changes || []).map(({ id, reason, children }) => ({
                id,
                reason,
                children,
              })),
            }
          : {}),
        ocrRegions: (result?.regions || []).map(compactRegion),
        ...(plan ? { planRegions: plan.regions.map(compactRegion) } : {}),
      };
      const artifactStarted = Date.now();
      try {
        record.artifacts = await saveArtifacts(
          await fs.readFile(c.file),
          plan?.regions || [],
          output,
          c.id,
        );
      } catch (failure) {
        record.artifacts = { cleanedPath: null, appliedPatchCount: 0, error: failure.message };
        console.log(`${c.id}: artifact ERROR ${failure.message.slice(0, 200)}`);
      }
      record.timings.artifactMs = Date.now() - artifactStarted;
      record.timings.totalMs = Date.now() - pageStarted;
      await save(dest, record);
      results.push(record);
      await summarize('running');
      console.log(
        `${results.length}/${cases.length} ${c.id}: ${record.ocrMetrics.regions} OCR regions; plan=${record.planMetrics?.regions ?? 'n/a'}; eligible=${record.planMetrics?.eligible ?? record.ocrMetrics.eligible}; ${Math.round(record.timings.totalMs / 1000)}s${error ? ' ERROR' : ''}`,
      );
      if (error) await reset();
    }
    active = null;
    await summarize('complete');
    if (results.some((r) => r.error)) process.exitCode = 1;
  } catch (error) {
    await summarize('fatal-error');
    throw error;
  } finally {
    clearInterval(heartbeat);
    await reset();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
