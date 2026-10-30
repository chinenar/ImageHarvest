'use strict';
const { inspectDots } = require('./ocr-ellipsis.cjs');
const { agree } = require('./ocr-targeted-recovery.cjs');
const { intersection, area } = require('./ocr-review.cjs');
const compact = (s) => String(s || '').replace(/\s/g, '');
function terminalDot(scan) {
  const found = scan.passes.map((parts) => {
    const letters = parts.filter(
      (c) =>
        c.y0 > 0 &&
        c.y1 < scan.h &&
        c.y1 - c.y0 > scan.height * 0.3 &&
        c.y1 - c.y0 < scan.height * 0.95,
    );
    if (letters.length < 3) return null;
    const heights = letters.map((c) => c.y1 - c.y0).sort((a, b) => a - b),
      height = heights[Math.floor(heights.length / 2)];
    const bottoms = letters.map((c) => c.y1).sort((a, b) => a - b),
      bottom = bottoms[Math.floor(bottoms.length / 2)],
      edge = Math.max(...letters.map((c) => c.x1));
    const dots = parts.filter((c) => {
      const w = c.x1 - c.x0,
        h = c.y1 - c.y0;
      return (
        c.x0 >= edge &&
        c.x0 - edge < height * 0.5 &&
        w <= height * 0.3 &&
        h <= height * 0.3 &&
        w / h >= 0.65 &&
        w / h <= 1.6 &&
        c.size / (w * h) >= 0.5 &&
        Math.abs(c.y1 - bottom) <= height * 0.12
      );
    });
    return dots.length === 1 ? { dot: dots[0], letters } : null;
  });
  if (
    found.some((x) => !x) ||
    ['x0', 'y0', 'x1', 'y1'].some((k) => Math.abs(found[0].dot[k] - found[1].dot[k]) > 2)
  )
    return null;
  const parts = [...found[1].letters, found[1].dot],
    global = (b) => ({
      x0: b.x0 + scan.left,
      y0: b.y0 + scan.top,
      x1: b.x1 + scan.left,
      y1: b.y1 + scan.top,
    });
  return {
    dot: global(found[1].dot),
    bounds: global({
      x0: Math.min(...parts.map((p) => p.x0)),
      y0: Math.min(...parts.map((p) => p.y0)),
      x1: Math.max(...parts.map((p) => p.x1)),
      y1: Math.max(...parts.map((p) => p.y1)),
    }),
  };
}
async function repairTerminalPeriod(
  input,
  chosen,
  readings,
  readLine,
  { width, height, scale = 1 },
) {
  const line = chosen.textLines?.at(-1);
  if (
    !line ||
    chosen.orientation === 'vertical' ||
    !(line.confidence >= 90) ||
    !/[A-Za-z],?$/.test(line.text)
  )
    return chosen;
  const scan = await inspectDots(input, line.bbox),
    proof = scan && terminalDot(scan);
  if (!proof) return chosen;
  const target = line.text.replace(/,?$/, '.'),
    key = compact(target);
  const existing = readings
    .flatMap((r) => r.textLines || [])
    .find(
      (l) =>
        l.confidence >= 90 &&
        compact(l.text) === key &&
        intersection(l.bbox, line.bbox) / Math.max(1, Math.min(area(l.bbox), area(line.bbox))) >
          0.6,
    );
  let probes = [];
  if (!existing) {
    // The connected components already include every ink pixel. External
    // padding can pull a balloon border into the period and make it a comma.
    const a = proof.bounds,
      box = {
        x0: Math.max(0, a.x0),
        y0: Math.max(0, a.y0),
        x1: Math.min(width, a.x1),
        y1: Math.min(height, a.y1),
      };
    probes = await Promise.all(
      ['original', 'contrast'].map((v) =>
        readLine(v, { box, pad: 0, scale: 4, recognizeOnly: true }),
      ),
    );
    if (!agree(probes) || compact(probes[0].text) !== key) return chosen;
  }
  const lines = [
    ...chosen.textLines.slice(0, -1),
    { ...line, text: target, bbox: { ...line.bbox, x1: Math.max(line.bbox.x1, proof.dot.x1) } },
  ];
  return {
    ...chosen,
    text: lines.map((l) => l.text).join('\n'),
    textLines: lines,
    selectionReason: 'source-verified-terminal-period',
    punctuationEvidence: [
      ...(chosen.punctuationEvidence || []),
      { from: line.text, to: target, proof, probes, existing },
    ],
  };
}
module.exports = { terminalDot, repairTerminalPeriod };
