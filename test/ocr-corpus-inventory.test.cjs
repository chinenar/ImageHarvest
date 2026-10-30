'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  collectImageInventory,
  representativeCases,
  implementationFingerprint,
} = require('../scripts/ocr-corpus-inventory.cjs');

async function temporaryTree(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-corpus-inventory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function write(root, name, contents = '') {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

test('source inventory excludes generated pipeline folders and samples deterministically', async (t) => {
  const root = await temporaryTree(t);
  for (const name of [
    '2/chapter/0003.webp',
    '2/chapter/0001.webp',
    '2/chapter/0002.webp',
    '6/にほんご/0002.avif',
    '6/にほんご/0003.avif',
    '6/にほんご/0001.avif',
    '__mobile_pipeline_v2_results_round46/hitomi/01_source.avif',
    '2/__mobile_pipeline_stage/preview.png',
    '__ctd_seg_hitomi_r53.png',
    '2/chapter/__CTD_SEG_generated.webp',
    '2/chapter/source.json',
  ])
    await write(root, name);
  const inventory = await collectImageInventory(root, async () => ({ width: 100, height: 200 }));
  assert.equal(inventory.length, 6);
  assert.deepEqual(
    representativeCases([...inventory].reverse()).map((c) => [c.id, c.name, c.hint]),
    [
      ['case-01', '0002.webp', 'auto'],
      ['case-02', '0003.avif', 'ja'],
    ],
  );
  assert.deepEqual(
    inventory.slice(0, 3).map((c) => c.name),
    ['0001.webp', '0002.webp', '0003.webp'],
  );
  assert.ok(await fs.stat(path.join(root, '__ctd_seg_hitomi_r53.png')));
});

test('resume fingerprint includes nested helpers and file identity but ignores caches', async (t) => {
  const root = await temporaryTree(t);
  await write(root, 'main.cjs', 'main');
  await write(root, 'shared/ownership.js', 'helper');
  await write(root, 'backend/ocr.py', 'backend');
  const initial = await implementationFingerprint(root);
  assert.deepEqual(initial.implementationFiles, [
    'backend/ocr.py',
    'main.cjs',
    'shared/ownership.js',
  ]);
  await write(root, '__pycache__/copy.py', 'cached');
  await write(root, '.cache/copy.js', 'cached');
  assert.equal(
    (await implementationFingerprint(root)).implementationDigest,
    initial.implementationDigest,
  );
  await write(root, 'shared/ownership.js', 'changed helper');
  const changed = await implementationFingerprint(root);
  assert.notEqual(changed.implementationDigest, initial.implementationDigest);
  await fs.rename(path.join(root, 'backend/ocr.py'), path.join(root, 'backend/renamed.py'));
  assert.notEqual(
    (await implementationFingerprint(root)).implementationDigest,
    changed.implementationDigest,
  );
});
