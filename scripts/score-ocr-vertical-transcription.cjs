'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { evaluateDetection } = require('./ocr-detection-metrics.cjs');
const { editDistance } = require('../src/ocr-review.cjs');
const lexical = text => String(text || '').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
const literal = text => String(text || '').normalize('NFKC').replace(/\s/gu, '');

function score(rows, reference) {
  // Ownership is geometric, never chosen by resemblance to the answer.
  const geometry = evaluateDetection(rows, { ...reference, coverage: 'partial' });
  const units = reference.units.map(unit => {
    const match = geometry.matches.find(m => m.unitId === unit.id);
    const row = match && rows.find(r => r.id === match.outputId);
    const expected = unit.text, actual = row?.text || '';
    const ambiguous = Boolean(match && (
      geometry.splits.some(s => s.unitId === unit.id) ||
      geometry.merges.some(m => m.outputId === match.outputId) ||
      geometry.duplicatePairs.some(pair => pair.includes(match.outputId))));
    const partial = Boolean(row?.partialReadingEvidence);
    const lexicalEdits = editDistance(lexical(actual), lexical(expected));
    return { id: unit.id, expected, actual, outputId: row?.id || null,
      expectedColumns: unit.columns, lexicalEdits,
      expectedCharacters: Array.from(lexical(expected)).length,
      exactTranscription: Boolean(row && literal(actual) === literal(expected)),
      lexicalSequenceExact: Boolean(row && lexicalEdits === 0),
      completeReading: Boolean(row && !partial && !ambiguous && lexicalEdits === 0),
      partial, ambiguous, iou: match?.iou ?? null };
  });
  const expectedCharacters = units.reduce((n, u) => n + u.expectedCharacters, 0);
  const edits = units.reduce((n, u) => n + u.lexicalEdits, 0);
  return { scope: 'Selected annotated units only; not full-page or corpus accuracy',
    units, exact: units.filter(u => u.exactTranscription && u.completeReading).length,
    completeLexicalReadings: units.filter(u => u.completeReading).length,
    expected: units.length, lexicalCer: expectedCharacters ? edits / expectedCharacters : null,
    expectedCharacters, edits, geometry };
}

async function main() {
  const input = process.argv[2];
  if (!input || process.argv.length !== 3) throw Error('Usage: node scripts/score-ocr-vertical-transcription.cjs <detection-run-directory>');
  const root = path.resolve(input);
  const referenceBytes = await fs.readFile(path.join(__dirname, '../test/fixtures/ocr-vertical-transcription-reference.json'));
  const reference = JSON.parse(referenceBytes);
  const results = [];
  for (const c of reference.cases) {
    for (const stage of ['raw', 'planned', 'eligible']) {
      const file = path.join(root, c.id + '-' + stage + '.json');
      const bytes = await fs.readFile(file), saved = JSON.parse(bytes);
      // Eligible files omit sourceHash; the raw file is their source identity.
      const raw = stage === 'raw' ? saved : JSON.parse(await fs.readFile(path.join(root, c.id + '-raw.json')));
      if (raw.sourceHash !== c.sourceHash || (saved.sourceHash && saved.sourceHash !== c.sourceHash)) throw Error('Source hash mismatch: ' + c.id);
      if (raw.result?.error || saved.result?.error) throw Error('Cannot score a failed OCR/planning run: ' + c.id);
      const rows = saved.result?.regions || saved.regions;
      if (!Array.isArray(rows)) throw Error('Missing regions: ' + file);
      results.push({ case: c.id, stage, sourceHash: c.sourceHash,
        inputHash: createHash('sha256').update(bytes).digest('hex'),
        implementationFingerprint: raw.implementationFingerprint,
        ...score(rows, c) });
    }
  }
  const output = { scope: reference.scope, referenceHash: createHash('sha256').update(referenceBytes).digest('hex'), results };
  await fs.writeFile(path.join(root, 'transcription.json'), JSON.stringify(output, null, 2) + '\n');
  for (const r of results) console.log(`${r.case} ${r.stage}: lexical ${r.completeLexicalReadings}/${r.expected}, exact ${r.exact}/${r.expected}, lexical CER ${r.lexicalCer}`);
}
module.exports = { score };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
