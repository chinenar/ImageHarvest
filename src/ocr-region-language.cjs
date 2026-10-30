'use strict';
const {editDistance,intersection,area}=require('./ocr-review.cjs');
const {distinctReadings}=require('./ocr-evidence.cjs');
function smallCjkCandidate(candidate,scale=1){
 const lines=candidate.lines||[];
 if(candidate.detectedLanguage!=='ja'||candidate.orientation==='vertical'||!lines.length)return false;
 const heights=lines.map(l=>{const b=l.coreBbox||l.bbox;return b.y1-b.y0;}).sort((a,b)=>a-b);
 return heights[Math.floor(heights.length/2)]<=18*scale;
}
function confirmedCjk(readings){
 if(readings.length!==2||readings.some(r=>r.error)||distinctReadings(readings).length!==2)return false;
 // A clipped neighbor in the padded crop must not veto several well-read
 // CJK labels. Require exact, positioned agreement of different source lines.
 const cjk=s=>String(s||'').normalize('NFKC').replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu,'');
 const confirmed=(readings[0].textLines||[]).filter(line=>line.confidence>=90&&cjk(line.text).length>=2&&line.bbox&&
  (readings[1].textLines||[]).some(other=>other.confidence>=90&&other.bbox&&cjk(line.text)===cjk(other.text)&&
   intersection(line.bbox,other.bbox)/Math.max(1,Math.max(area(line.bbox),area(other.bbox)))>.65));
 if(new Set(confirmed.map(line=>cjk(line.text))).size>=2)return true;
 if(readings.some(r=>r.confidence<80))return false;
 const text=readings.map(r=>String(r.text||'').normalize('NFKC').replace(/\s/g,''));
 if(text.some(t=>(t.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)||[]).length<3))return false;
 // Han-only table labels do not establish Japanese versus Chinese. Require
 // substantial script evidence and preserve that ambiguity in the caller.
 if(text.some(t=>(t.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)||[]).length/t.length<.25))return false;
 return editDistance(text[0],text[1])/Math.max(1,text[0].length,text[1].length)<.2;
}
module.exports={smallCjkCandidate,confirmedCjk};
