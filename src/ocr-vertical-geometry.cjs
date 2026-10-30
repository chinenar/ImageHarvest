'use strict';
const { intersection, area } = require('./ocr-review.cjs');
const { mergeLineObservations, refineBlocks } = require('./comic-text-detector.cjs');
const core = line => line.coreBbox || line.bbox;

// The line-map can connect parallel columns into one wide component. Recover
// their boundaries only from complete, independently positioned thin columns.
function refineVerticalGeometry(ctd, observations) {
  const columns = mergeLineObservations(observations).filter(l => {
    const b = core(l);
    return l.orientation === 'vertical' && b.y1-b.y0 > (b.x1-b.x0)*4;
  });
  let changed = false;
  const recovered = [];
  // A weak row spanning column heads can prevent discovery from extending
  // the existing columns to their actual starts. Establish both owners first.
  for(const block of ctd.rawBlocks||[]){
    if(block.orientation==='vertical'||block.detectionConfidence>=.7)continue;
    const heads=columns.filter(l=>intersection(core(l),block.bbox)/Math.max(1,area(block.bbox))>.2&&
      (ctd.lines||[]).some(other=>{const a=core(other),b=core(l);return other.orientation==='vertical'&&
        (a.x1-a.x0)<(b.x1-b.x0)*1.8&&intersection(a,b)/Math.max(1,area(a))>.8;}));
    if(heads.length>=2){recovered.push(...heads);changed=true;}
  }
  const lines = (ctd.lines || []).flatMap(line => {
    const a = core(line), aw = a.x1-a.x0, ah = a.y1-a.y0;
    if (line.orientation !== 'vertical' || ah < aw*4) return [line];
    const candidates = columns.filter(l => {
      const b = core(l), bw = b.x1-b.x0, bh = b.y1-b.y0;
      const along = Math.max(0, Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0));
      return bw < aw*.8 && along/ah > .75 && bh > ah*.75 && bh < ah*1.4 &&
        intersection(l.bbox,line.bbox)/Math.max(1,area(l.bbox)) > .65;
    }).sort((a,b) => (core(a).x1-core(a).x0)-(core(b).x1-core(b).x0));
    const thin = [];
    for (const l of candidates) {
      const b = core(l);
      if (!thin.some(other => {
        const q = core(other);
        return Math.max(0,Math.min(b.x1,q.x1)-Math.max(b.x0,q.x0))/Math.min(b.x1-b.x0,q.x1-q.x0) > .25;
      })) thin.push(l);
    }
    if (thin.length < 2) return [line];
    changed = true;
    recovered.push(...thin);
    return thin.map(l => ({ ...l, kind: line.kind, lineOnly: true,
      geometryEvidence: 'independent-complete-vertical-columns', replacedLineObservation: line }));
  });
  if (!changed) return ctd;
  const canonical = mergeLineObservations([...lines,...recovered]);
  const rawBlocks = ctd.rawBlocks.filter(block => {
    if (block.orientation === 'vertical' || block.detectionConfidence >= .7) return true;
    const hits = recovered.filter(l => intersection(core(l),block.bbox)/Math.max(1,area(block.bbox)) > .2);
    // A weak horizontal block at the heads of two complete columns has no
    // independent row evidence. Retain any actual horizontal line proposal.
    return hits.length < 2 || canonical.some(l => l.orientation !== 'vertical' && intersection(core(l),block.bbox)/Math.max(1,area(core(l))) > .6);
  });
  return { ...ctd, lines: canonical, boxes: refineBlocks(rawBlocks, canonical),
    verticalGeometryRefined: true };
}
module.exports = { refineVerticalGeometry };
