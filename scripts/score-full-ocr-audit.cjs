'use strict';
const fs=require('node:fs'),path=require('node:path');
const {evaluateDetection}=require('./ocr-detection-metrics.cjs');
const {createHash}=require('node:crypto');
const {implementationFingerprint}=require('./ocr-corpus-inventory.cjs');
const root=path.resolve('test-results/full-audit-1.6.95'),corpus=path.join(root,'corpus');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const manifest=read(path.join(corpus,'manifest.json'));
const historical=read('test-results/corpus-audit-1791304158829/manual-reference.json');
const references=[{id:'historical-partial',scope:historical.provenance,pages:historical.pages.map(p=>({digest:p.digest,label:p.id,reference:{coverage:'partial',units:p.truth,negative:p.negative||[]}}))}];
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mappingChecks=[];
for(const [referenceFile,artifactFile,evidenceFile] of [
 ['ocr-new-plant-reference.json','new-plant-before.json','scripts/report-ocr-1.6.79.cjs'],
 ['ocr-romance-reference.json','new-romance-before.json','scripts/report-ocr-1.6.82.cjs'],
 ['ocr-table-reference.json','holdout/angled-dialogue-page.json','scripts/report-ocr-1.6.76.cjs'],
 ['ocr-table-left-reference.json','holdout/angled-dialogue-page.json','scripts/report-ocr-1.6.76.cjs'],
]){
 const artifact=path.join('test-results/ocr-accuracy',artifactFile),refPath=path.join('test/fixtures',referenceFile);
 if(!fs.existsSync(artifact)||!fs.existsSync(refPath)){mappingChecks.push({referenceFile,status:'missing-provenance-artifact'});continue;}
 const data=read(artifact),reference=read(refPath),source=data.source;
 if(!source||!fs.existsSync(source)){mappingChecks.push({referenceFile,status:'missing-source',source});continue;}
 const digest=hash(source),mapped=manifest.cases.find(c=>c.sourceHash===digest);
 mappingChecks.push({referenceFile,status:mapped?'hash-mapped':'outside-corpus',source,sourceHash:digest,corpusId:mapped?.id||null,artifact,evidenceFile,referenceHash:hash(refPath),limitation:'Historical targeted reference has no frozen source hash. Mapping is established by the existing report script pairing this reference with this source artifact, then hashing the current source bytes and matching the current corpus manifest.'});
 references.push({id:referenceFile,scope:reference.scope,pages:[{digest,label:referenceFile,reference:{...reference,coverage:'partial',units:reference.units||[{id:'left-status-labels',box:reference.box,text:reference.text}],negative:reference.negative||[]}}]});
}
for(const file of ['ocr-detection-reference.json','ocr-detection-vertical-reference.json']){
 const reference=read(path.join('test/fixtures',file));
 references.push({id:file,scope:reference.scope,pages:reference.cases.map(p=>({digest:p.sourceHash,label:p.id,reference:p}))});
}
(async()=>{
const current=await implementationFingerprint(path.resolve('src'),[path.resolve('scripts/check-ocr-full-corpus.cjs'),path.resolve('scripts/ocr-corpus-inventory.cjs')]);
const groups=references.map(g=>({...g,pages:g.pages.map(p=>{
 const source=manifest.cases.find(c=>c.sourceHash===p.digest);
 const base={id:source?.id||null,label:p.label,coverage:p.reference.coverage,annotatedUnits:p.reference.units.length,sourceHash:p.digest};
 if(!source)return {...base,status:'outside-corpus',note:'Separate crop or missing source; evaluate separately, not as a passing page.'};
 if(!fs.existsSync(source.file)||hash(source.file)!==p.digest)return {...base,status:'stale-source'};
 const file=path.join(corpus,source.id+'.json');if(!fs.existsSync(file))return {...base,status:'pending'};
 const data=read(file);
 if(data.sourceHash!==p.digest||data.implementationDigest!==manifest.implementationDigest||current.implementationDigest!==manifest.implementationDigest||data.sourceFingerprint!==manifest.sourceFingerprint)return {...base,status:'stale'};
 if(data.error)return {...base,status:'failed',error:data.error};
 if(!Array.isArray(data.ocrRegions)||!Array.isArray(data.planRegions))return {...base,status:'invalid-schema',note:'Expected compact ocrRegions and planRegions arrays.'};
 const planned=data.planRegions||data.ocrRegions;
 return {...base,status:'scored',raw:evaluateDetection(data.ocrRegions,p.reference),planned:evaluateDetection(planned,p.reference),eligible:evaluateDetection(planned.filter(r=>r.eligible),p.reference),partialReadings:planned.filter(r=>r.contentRole?.reason==='incomplete-japanese-reading-needs-review').length};
})}));
const overlaps=[...new Set(groups.flatMap(g=>g.pages.map(p=>p.sourceHash)))].map(sourceHash=>({sourceHash,sets:groups.filter(g=>g.pages.some(p=>p.sourceHash===sourceHash)).map(g=>g.id)})).filter(p=>p.sets.length>1);
const corpusHashes=new Map();for(const page of manifest.cases){if(!corpusHashes.has(page.sourceHash))corpusHashes.set(page.sourceHash,[]);corpusHashes.get(page.sourceHash).push(page.id);}
const corpusDuplicateSources=[...corpusHashes].filter(([,ids])=>ids.length>1).map(([sourceHash,ids])=>({sourceHash,ids}));
const referenceStatuses={};for(const page of groups.flatMap(g=>g.pages))referenceStatuses[page.status]=(referenceStatuses[page.status]||0)+1;
const report={generatedAt:new Date().toISOString(),implementationDigest:manifest.implementationDigest,currentImplementationDigest:current.implementationDigest,implementationCurrent:current.implementationDigest===manifest.implementationDigest,referenceHashes:references.map(g=>({id:g.id,sha256:g.id==='historical-partial'?hash('test-results/corpus-audit-1791304158829/manual-reference.json'):hash(path.join('test/fixtures',g.id))})),mappingChecks,overlappingReferenceSources:overlaps,combinedAccuracy:null,combinedDenominator:null,scope:'Reference sets may overlap. No combined accuracy or denominator is emitted: do not add their denominators or treat partial annotations as full-page accuracy. Geometry matches do not prove complete transcription. Targeted historical source associations are documented separately from frozen sourceHash references.',groups};
Object.assign(report,{corpusFiles:manifest.cases.length,uniqueCorpusSourceHashes:corpusHashes.size,corpusDuplicateSources,referenceStatuses,inProgress:!!referenceStatuses.pending});
fs.writeFileSync(path.join(root,'annotated-scores.json'),JSON.stringify(report,null,2));
console.log(groups.map(g=>({id:g.id,pages:g.pages.map(p=>({id:p.label,status:p.status,matched:p.eligible?.matches.length,expected:p.annotatedUnits}))})));
})().catch(error=>{console.error(error);process.exitCode=1;});
