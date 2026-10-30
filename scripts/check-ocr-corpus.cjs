'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { createHash } = require('node:crypto');
const { EnhancedMangaOcrPool } = require('../src/enhanced-manga-ocr.cjs');
const { LocalOcrBackend } = require('../src/ocr-backend.cjs');
const {
  collectImageInventory,
  representativeCases,
  implementationFingerprint,
} = require('./ocr-corpus-inventory.cjs');

async function main() {
  const source = path.resolve(
    process.argv.slice(2).find((arg) => !arg.startsWith('--')) ||
      'C:/Users/jinna/Downloads/manga test ocr',
  );
  const output = path.resolve('test-results/manga-corpus');
  await fs.mkdir(output, { recursive: true });
  const { implementationDigest, implementationFiles } = await implementationFingerprint(
    path.resolve('src'),
    [__filename, path.join(__dirname, 'ocr-corpus-inventory.cjs')],
  );
  const inventory = await collectImageInventory(source, (file) => sharp(file).metadata());
  // Include dialogue pages rather than repeatedly benchmarking covers.
  const cases = representativeCases(inventory);
  await fs.writeFile(
    path.join(output, 'manifest.json'),
    JSON.stringify(
      {
        source,
        implementationDigest,
        implementationFiles,
        totalImages: inventory.length,
        evaluationScope: 'Representative full-page OCR: one deterministic sample per source directory; not all-image OCR or measured corpus accuracy.',
        groundTruth: false,
        excludedDirectoryPattern: '^__mobile_pipeline(?:_|$)',
        cases,
      },
      null,
      2,
    ),
  );
  await fs.writeFile(path.join(output, 'inventory.json'), JSON.stringify(inventory, null, 2));
  const backend = new LocalOcrBackend({ timeout: 360000 });
  const pools = new Map();
  try {
    await fs.writeFile(
      path.join(output, 'runtime.json'),
      JSON.stringify(await backend.status(), null, 2),
    );
    for (let index = 0; index < cases.length; index++) {
      const c = cases[index],
        dest = path.join(output, c.id + '.json');
      const selectedCases = process.argv
        .find((arg) => arg.startsWith('--case='))
        ?.slice(7)
        .split(',');
      if (selectedCases && !selectedCases.includes(c.id)) continue;
      const digest = createHash('sha256')
        .update(await fs.readFile(c.file))
        .digest('hex');
      if (process.argv.includes('--resume')) {
        const old = await fs
          .readFile(dest, 'utf8')
          .then(JSON.parse)
          .catch(() => null);
        if (
          old?.digest === digest &&
          old.implementationDigest === implementationDigest &&
          !old.result.error
        ) {
          console.log(`${index + 1}/${cases.length} ${c.id}: existing result`);
          continue;
        }
      }
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
      const started = Date.now();
      console.log(`${index + 1}/${cases.length} ${c.id}: start ${c.width}x${c.height} (${c.hint})`);
      let progress;
      const [result] = await pools.get(c.hint).recognizePages([{ filePath: c.file }], {
        onRegion: (p) => {
          progress = p;
          if (p.engine === 'enhanced' || p.index === 1 || p.index === p.total)
            console.log(`${c.id}: ${p.phase || p.engine} ${p.index}/${p.total}`);
        },
      });
      await fs.writeFile(
        dest,
        JSON.stringify(
          {
            ...c,
            digest,
            implementationDigest,
            ms: Date.now() - started,
            result,
            ...(result.error
              ? { diagnostics: { progress, workerStats: backend.stats(), workerLog: backend.logs } }
              : {}),
          },
          null,
          2,
        ),
      );
      const regions = result.regions || [];
      console.log(
        `${index + 1}/${cases.length} ${c.id}: ${regions.length} regions, ${regions.filter((r) => r.orientation === 'vertical').length} vertical, ${regions.filter((r) => r.reviewRequired).length} review; ${Math.round((Date.now() - started) / 1000)}s${result.error ? ' ERROR ' + result.error : ''}`,
      );
    }
  } finally {
    for (const pool of pools.values()) await pool.close();
    backend.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
