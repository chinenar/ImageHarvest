'use strict';

// Standalone geometry audit. Text never determines detection ownership.
const {area, intersection, iou, editDistance} = require('../src/ocr-review.cjs');
const chars = s => Array.from(String(s || '').normalize('NFC').replace(/\u0e4d\u0e32/g,'\u0e33').replace(/\s+/gu, '')).length;
const bbox = b => Array.isArray(b) ? {x0:b[0], y0:b[1], x1:b[2], y1:b[3]} : b;
const normalize = (r, i, prefix) => {
  const b = bbox(r.bbox || r.box || r);
  if (!b || !['x0','y0','x1','y1'].every(k => Number.isFinite(b[k])) || area(b) <= 0) throw new Error('Invalid bounding box: ' + prefix + i);
  return {...r, id:r.id ?? prefix + i, bbox:b};
};
// Exact union of axis-aligned rectangles clipped to the reference extent.
function unionCoverage(unit, rows) {
  const clips = rows.map(r => ({x0:Math.max(unit.x0,r.bbox.x0), y0:Math.max(unit.y0,r.bbox.y0), x1:Math.min(unit.x1,r.bbox.x1), y1:Math.min(unit.y1,r.bbox.y1)})).filter(b => area(b) > 0);
  const xs = [...new Set(clips.flatMap(b => [b.x0,b.x1]))].sort((a,b) => a-b);
  let covered = 0;
  for (let i=1; i<xs.length; i++) {
    const intervals = clips.filter(b => b.x0 < xs[i] && b.x1 > xs[i-1]).map(b => [b.y0,b.y1]).sort((a,b) => a[0]-b[0]);
    let total=0, end=-Infinity;
    for (const [lo,hi] of intervals) {total += Math.max(0,hi-Math.max(lo,end)); end=Math.max(end,hi);}
    covered += total*(xs[i]-xs[i-1]);
  }
  return covered/area(unit);
}
function evaluateDetection(rows=[], reference={}) {
  if (!['complete-page','partial'].includes(reference.coverage)) throw new Error('Explicit reference.coverage is required');
  const complete = reference.coverage === 'complete-page';
  const raw = rows.map((r,i) => normalize(r,i,'output-'));
  const truth = (reference.units || []).map((r,i) => normalize(r,i,'truth-'));
  const negatives = (reference.negative || []).map((r,i) => normalize(r,i,'negative-'));
  const ignores = (reference.ignore || []).map((r,i) => normalize(r,i,'ignore-'));
  const ignored = raw.filter(r => !truth.some(t => intersection(t.bbox,r.bbox)>0) && ignores.some(b => intersection(b.bbox,r.bbox)/area(r.bbox) >= .5));
  const predicted = raw.filter(r => !ignored.includes(r));
  const edges = truth.map(t => predicted.map((p,i) => ({i,score:iou(t.bbox,p.bbox)})).filter(e => e.score >= .5).sort((a,b) => b.score-a.score || a.i-b.i));
  const owners = new Map();
  function assign(t, seen) {
    for (const {i} of edges[t]) {
      if (seen.has(i)) continue;
      seen.add(i);
      if (!owners.has(i) || assign(owners.get(i),seen)) {owners.set(i,t); return true;}
    }
    return false;
  }
  truth.forEach((_,i) => assign(i,new Set()));
  const matches = [...owners].map(([p,t]) => {
    const coverage=intersection(predicted[p].bbox,truth[t].bbox)/area(truth[t].bbox);
    return {outputId:predicted[p].id, unitId:truth[t].id, iou:iou(predicted[p].bbox,truth[t].bbox), coverage, incompleteCrop:coverage < .95, edits:truth[t].text == null ? null : editDistance(predicted[p].text,truth[t].text)};
  });
  const matchedTruth=new Set([...owners.values()]);
  const missing=truth.filter((_,i) => !matchedTruth.has(i)).map(t => t.id);
  const unmatchedOutputs=predicted.filter((_,i) => !owners.has(i)).map(p => ({id:p.id, explicitNegative:negatives.some(n => intersection(n.bbox,p.bbox)/area(p.bbox) >= .5), touchesIgnore:ignores.some(n => intersection(n.bbox,p.bbox)>0), text:p.text || ''}));
  // An unmatched box crossing an ignored extent cannot establish a false positive,
  // even on a complete page. Matches to known truth remain evaluated above.
  const falsePositives=unmatchedOutputs.filter(p => !p.touchesIgnore && (complete || p.explicitNegative)).map(p => p.id);
  const unscoredOutputs=unmatchedOutputs.filter(p => p.touchesIgnore || (!complete && !p.explicitNegative)).map(p => p.id);
  const duplicatePairs=[];
  for(let i=0;i<predicted.length;i++) for(let j=i+1;j<predicted.length;j++) if(iou(predicted[i].bbox,predicted[j].bbox)>=.8) duplicatePairs.push([predicted[i].id,predicted[j].id]);
  const merges=predicted.map(p => ({outputId:p.id,unitIds:truth.filter(t => intersection(p.bbox,t.bbox)/area(t.bbox)>.5).map(t => t.id)})).filter(p => p.unitIds.length>1);
  const splits=truth.map(t => {
    const hits=predicted.filter(p => intersection(p.bbox,t.bbox)/area(p.bbox)>.5 && intersection(p.bbox,t.bbox)/area(t.bbox)>=.1);
    // Coincident output boxes are duplicates, not evidence of split text.
    const distinct=[];
    for(const p of hits) if(!distinct.some(r => iou(p.bbox,r.bbox)>=.8)) distinct.push(p);
    return {unitId:t.id,outputIds:distinct.map(p => p.id)};
  }).filter(t => t.outputIds.length>1);
  const unitCoverage=truth.map(t => {const fraction=unionCoverage(t.bbox,predicted); return {unitId:t.id, fraction, incompleteCrop:fraction>0 && fraction<.95, noCoverage:fraction===0};});
  const expectedCharacters=truth.reduce((n,t) => n+chars(t.text),0);
  const untranscribedUnits=truth.filter(t => t.text == null).map(t => t.id);
  const matchedEdits=matches.reduce((n,m) => n+m.edits,0);
  const missingCharacters=truth.filter((_,i) => !matchedTruth.has(i)).reduce((n,t) => n+chars(t.text),0);
  const extraCharacters=unmatchedOutputs.filter(p => falsePositives.includes(p.id)).reduce((n,p) => n+chars(p.text),0);
  const errors=matchedEdits+missingCharacters+extraCharacters;
  return {
    scope:complete?'Complete annotated page':'Partial annotations; full-page denominator and accuracy are unknown', coverage:reference.coverage,
    thresholds:{matchIou:.5,cropCoverage:.95,duplicateIou:.8,negativeOutputCoverage:.5},
    rawOutputs:raw.length, evaluatedOutputs:predicted.length, ignoredOutputs:ignored.map(p=>p.id), annotatedUnits:truth.length, fullPageUnits:complete?truth.length:null,
    matches, missing, unmatchedOutputs, falsePositives, unscoredOutputs, duplicatePairs, splits, merges, unitCoverage,
    annotatedRecall:truth.length?matches.length/truth.length:null, recall:complete&&truth.length?matches.length/truth.length:null,
    precision:complete&&(predicted.length-unscoredOutputs.length)>0?matches.length/(predicted.length-unscoredOutputs.length):null,
    cer:{scope:complete?'complete-page':'annotated-units-and-explicit-negatives', expectedCharacters, untranscribedUnits, matchedEdits, missingCharacters, extraCharacters, errors:untranscribedUnits.length?null:errors, knownErrors:errors, value:!untranscribedUnits.length&&expectedCharacters?errors/expectedCharacters:null},
    limitations:['Axis-aligned box coverage approximates text extent; it does not verify glyph crops.', 'Split and duplicate classifications use geometry and may be ambiguous for overlapping real text.', 'Run raw and caller-filtered eligible outputs separately; eligibility errors require annotated roles.']
  };
}
module.exports={evaluateDetection};
