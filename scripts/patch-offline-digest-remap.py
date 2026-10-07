from pathlib import Path
p=Path(r"E:\Shared\ExportImagefromWeb\src\main.cjs")
s=p.read_text(encoding="utf-8")
old="""  return best;
}
function harvestOfflineMatchLivePages(savedPages,livePages){
  const used=new Set(),result=[];
  const size=item=>({w:Math.max(Number(item?.width)||0,Number(item?.filterHints?.displayWidth)||0),h:Math.max(Number(item?.height)||0,Number(item?.filterHints?.displayHeight)||0)});
  for(let i=0;i<savedPages.length;i++){
    const page=savedPages[i];let match=-1;
    match=livePages.findIndex((x,j)=>!used.has(j)&&String(x.url||'')===String(page.sourceUrl||''));"""
new="""  if(!best.length)return best;
  try{
    const urls=best.map(x=>x.url);
    const digests=await wc.executeJavaScript(`(async()=>{const urls=${JSON.stringify(urls)},out={};for(let i=0;i<urls.length;i+=4){await Promise.all(urls.slice(i,i+4).map(async url=>{try{const r=await fetch(url);const b=await r.arrayBuffer();const h=await crypto.subtle.digest('SHA-256',b);out[url]=Array.from(new Uint8Array(h),x=>x.toString(16).padStart(2,'0')).join('');}catch{}}));}return out;})()`,true).catch(()=>null);
    if(digests)best=best.map(x=>({...x,imageDigest:digests[x.url]||''}));
  }catch{}
  return best;
}
function harvestOfflineMatchLivePages(savedPages,livePages){
  const used=new Set(),result=[];
  const size=item=>({w:Math.max(Number(item?.width)||0,Number(item?.filterHints?.displayWidth)||0),h:Math.max(Number(item?.height)||0,Number(item?.filterHints?.displayHeight)||0)});
  for(let i=0;i<savedPages.length;i++){
    const page=savedPages[i];let match=-1;
    if(page.imageDigest)match=livePages.findIndex((x,j)=>!used.has(j)&&x.imageDigest&&x.imageDigest===page.imageDigest);
    if(match<0)match=livePages.findIndex((x,j)=>!used.has(j)&&String(x.url||'')===String(page.sourceUrl||''));"""
if old not in s: raise SystemExit("digest anchor missing")
s=s.replace(old,new,1)
p.write_text(s,encoding="utf-8")
print("patched offline image digest remap")
