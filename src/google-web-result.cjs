'use strict';
// A reply is usable only when bounded by this request's unique adjacent markers.
// Missing/reordered IDs stay missing; never shift translations to another region.
function extractMarkedTranslations(value,items,batchId){
  const escaped=String(batchId).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern=new RegExp('\\[\\s*\\[\\s*IH\\s*'+escaped+'\\s*_\\s*(\\d{4})\\s*\\]\\s*\\]','g');
  const text=String(value||''),marks=[...text.matchAll(pattern)],counts=new Map();
  for(const m of marks)counts.set(Number(m[1]),(counts.get(Number(m[1]))||0)+1);
  const out=new Map();
  for(let i=0;i+1<marks.length;i++){
    const a=marks[i],b=marks[i+1],n=Number(a[1]);
    if(n<1||n>items.length||Number(b[1])!==n+1||counts.get(n)!==1||counts.get(n+1)!==1)continue;
    const translation=text.slice(a.index+a[0].length,b.index).trim();
    if(translation&&!/\[\s*\[\s*IH/i.test(translation))out.set(n-1,translation);
  }
  return items.map((item,i)=>({id:String(item.id||''),translation:out.get(i)||''}));
}
function googleInteractionRequired(text,url=''){
  return /(?:google\.[^/]+\/(?:sorry|recaptcha)|consent\.google\.)/i.test(url)||/unusual traffic|not a robot|verify (?:that )?you are human|before you continue to google|too many requests/i.test(text);
}
function reusableTranslation(region,{provider,targetLanguage,sourceLanguage,imageDigest}={}){
  const t=region.translationRecord;
  return Boolean(region.translation?.trim()&&t?.status==='translated'&&t.sourceText===region.text&&t.imageDigest===imageDigest&&t.provider===provider&&t.targetLanguage===targetLanguage&&t.sourceLanguage===sourceLanguage&&['x0','y0','x1','y1'].every(k=>t.bbox?.[k]===region.bbox?.[k]));
}
module.exports={extractMarkedTranslations,googleInteractionRequired,reusableTranslation};
