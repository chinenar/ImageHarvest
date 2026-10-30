'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sharp = require('sharp');

async function main() {
  const output = path.resolve('test-results/manga-corpus');
  const inventory = JSON.parse(await fs.readFile(path.join(output, 'inventory.json'), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
  if (process.argv.includes('--decode')) {
    const failed = [];
    for (const [index, item] of inventory.entries()) {
      try {
        await sharp(item.file).stats();
      } catch (error) {
        failed.push({ file: item.file, error: error.message });
      }
      if ((index + 1) % 100 === 0) console.log(`Decoded ${index + 1}/${inventory.length}`);
    }
    await fs.writeFile(
      path.join(output, 'image-integrity.json'),
      JSON.stringify(
        { total: inventory.length, decoded: inventory.length - failed.length, failed },
        null,
        2,
      ),
    );
    console.log(`Full image decoding: ${inventory.length - failed.length}/${inventory.length}`);
  }
  const pages = [];
  await fs.mkdir(path.join(output, 'review-images'), { recursive: true });
  for (const c of manifest.cases) {
    const r = await fs
      .readFile(path.join(output, c.id + '.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    if (!r) continue;
    const image = 'review-images/' + c.id + '.jpg';
    await sharp(c.file)
      .resize({ width: 1500, height: 10000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toFile(path.join(output, image));
    const region = (row, rejected = false) => ({
      bbox: row.bbox,
      text: row.text,
      confidence: row.confidence,
      orientation: row.orientation,
      engine: row.recognitionEngine,
      reason: row.selectionReason,
      observedBy: row.observedBy,
      reviewRequired: row.reviewRequired,
      rejected,
      alternatives: (row.alternatives || []).map((a) => ({
        engine: a.engine,
        variant: a.variant || 'baseline',
        text: a.text,
        confidence: a.confidence,
        error: a.error,
      })),
    });
    pages.push({
      id: c.id,
      file: c.file,
      original: pathToFileURL(c.file).href,
      image,
      group: c.group,
      width: c.width,
      height: c.height,
      hint: c.hint,
      ms: r.ms,
      digest: r.digest,
      error: r.result.error,
      regions: (r.result.regions || []).map((row) => region(row)),
      rejected: (r.result.rejectedRegions || []).map((row) => region(row, true)),
    });
  }
  const regions = pages.flatMap((p) => p.regions);
  const summary = {
    totalImages: inventory.length,
    representativePages: pages.length,
    chapterGroups: manifest.cases.length,
    pageErrors: pages.filter((p) => p.error).length,
    regions: regions.length,
    vertical: regions.filter((r) => r.orientation === 'vertical').length,
    reviewRequired: regions.filter((r) => r.reviewRequired).length,
    emptyPages: pages.filter((p) => !p.regions.length).map((p) => p.id),
    groundTruth: false,
    note: 'Representative full-page OCR results; all-image inventory is not all-image OCR. Model confidence is not measured text accuracy.',
  };
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  const payload = JSON.stringify({ summary, pages }).replace(/</g, '\\u003c');
  const html = `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ตรวจผล OCR ชุด manga test ocr</title><style>
*{box-sizing:border-box}body{margin:0;background:#11151d;color:#e9edf4;font:16px system-ui,sans-serif}header{position:sticky;top:0;z-index:2;background:#191f2b;padding:14px 20px;border-bottom:1px solid #394254}h1{font-size:21px;margin:0 0 8px}p{margin:6px 0;line-height:1.6;color:#bec9d9}select,button{font:inherit;padding:7px 10px;background:#253147;color:#fff;border:1px solid #52617a;border-radius:5px}nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}a{color:#93c8ff}main{display:grid;grid-template-columns:minmax(350px,1.4fr) minmax(320px,1fr);gap:20px;padding:20px}.picture{position:relative;align-self:start;line-height:0;background:#fff}.picture img{display:block;width:100%}.picture svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}.picture rect{fill:transparent;stroke-width:3;vector-effect:non-scaling-stroke;cursor:pointer}.picture rect.selected{stroke:#fff;stroke-width:6;fill:#2588ff33}article{border:1px solid #475166;border-left:4px solid #5ccc91;border-radius:6px;padding:12px;margin:0 0 10px;cursor:pointer}article.review{border-left-color:#ffbf65}article.rejected{border-left-color:#ff7474}article.selected{background:#233651}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:18px/1.6 system-ui;margin:8px 0}small{color:#bdc8d8}summary{cursor:pointer;color:#93c8ff}details pre{font-size:14px}#source{font-size:13px;overflow-wrap:anywhere}.legend{color:#ffbf65}@media(max-width:800px){main{grid-template-columns:1fr}header{position:static}}
</style><header><h1>ตรวจผล OCR ชุด manga test ocr</h1><p id="summary"></p><p>ผลตัวอย่างไม่มีเฉลยอ้างอิง จึงยังวัดเปอร์เซ็นต์ความถูกต้องไม่ได้ ค่า confidence เป็นคะแนนจากโมเดล</p><nav><button id="prev">ก่อนหน้า</button><select id="page"></select><button id="next">ถัดไป</button><label><input type="checkbox" id="rejected"> แสดงกรอบที่ไม่ผ่าน</label><span class="legend">ส้ม: ควรตรวจ • เขียว: ผลที่เลือก • แดง: ไม่ผ่าน</span></nav><p id="source"></p></header><main><div class="picture"><img id="image" alt="ภาพต้นฉบับพร้อมกรอบ OCR"><svg id="boxes"></svg></div><section id="rows"></section></main>
<script type="application/json" id="data">${payload}</script><script>
const data=JSON.parse(document.getElementById('data').textContent),pages=data.pages;
const el=id=>document.getElementById(id),s=data.summary;
el('summary').textContent='สำรวจ '+s.totalImages+' ภาพ • OCR เต็มหน้า '+s.representativePages+'/'+s.chapterGroups+' ชุด • พบ '+s.regions+' กรอบ ('+s.vertical+' แนวตั้ง) • ควรตรวจ '+s.reviewRequired+' กรอบ • ข้อผิดพลาด '+s.pageErrors+' หน้า';
pages.forEach((p,i)=>{const o=document.createElement('option');o.value=i;o.textContent=p.id+' • กลุ่ม '+p.group.split(/[\\\\/]/)[0]+' • '+p.hint+' • '+p.regions.length+' กรอบ';el('page').append(o)});
function render(){
 const p=pages[Number(el('page').value)];if(!p)return;
 el('source').replaceChildren(document.createTextNode(p.file+' • '+Math.round(p.ms/1000)+' วินาที • '));
 const a=document.createElement('a');a.href=p.original;a.target='_blank';a.textContent='เปิดภาพต้นฉบับ';el('source').append(a);
 el('image').src=p.image;el('boxes').setAttribute('viewBox','0 0 '+p.width+' '+p.height);el('boxes').replaceChildren();el('rows').replaceChildren();
 const rows=[...p.regions,...(el('rejected').checked?p.rejected:[])];
 if(p.error||!rows.length){const note=document.createElement('p');note.textContent=p.error||'หน้านี้ไม่พบกรอบที่ผ่านเกณฑ์ ต้องดูภาพเพื่อแยกระหว่างไม่มีข้อความและ OCR ตกหล่น';el('rows').append(note)}
 rows.forEach((r,i)=>{
  const b=r.bbox,rect=document.createElementNS('http://www.w3.org/2000/svg','rect');
  for(const [k,v] of Object.entries({x:b.x0,y:b.y0,width:b.x1-b.x0,height:b.y1-b.y0,stroke:r.rejected?'#ff7474':r.reviewRequired?'#ffbf65':'#5ccc91'}))rect.setAttribute(k,v);
  const title=document.createElementNS('http://www.w3.org/2000/svg','title');title.textContent=(i+1)+'. '+r.text;rect.append(title);el('boxes').append(rect);
  const card=document.createElement('article');card.className=r.rejected?'rejected':r.reviewRequired?'review':'';
  const meta=document.createElement('small');meta.textContent=(i+1)+'. '+(r.orientation==='vertical'?'แนวตั้ง':'แนวนอน')+' • '+(r.engine||'OCR')+' • confidence '+(r.confidence==null?'ไม่ระบุ':r.confidence)+' • '+(r.rejected?'ไม่ผ่าน':r.reviewRequired?'ควรตรวจ':'ผลที่เลือก');
  const text=document.createElement('pre');text.textContent=r.text||'(ไม่พบข้อความ)';card.append(meta,text);
  const details=document.createElement('details'),label=document.createElement('summary');label.textContent='ผลอ่านทางเลือก ('+r.alternatives.length+')';details.append(label);
  r.alternatives.forEach(alt=>{const pre=document.createElement('pre');pre.textContent=alt.engine+' / '+alt.variant+' / '+(alt.confidence??'ไม่ระบุ')+String.fromCharCode(10)+(alt.error||alt.text||'(ว่าง)');details.append(pre)});card.append(details);el('rows').append(card);
  const select=()=>{document.querySelectorAll('.selected').forEach(n=>n.classList.remove('selected'));rect.classList.add('selected');card.classList.add('selected')};
  rect.onclick=()=>{select();card.scrollIntoView({behavior:'smooth',block:'center'})};card.onclick=event=>{if(!event.target.closest('details'))select()};
 });
}
el('page').onchange=render;el('rejected').onchange=render;
el('prev').onclick=()=>{el('page').value=Math.max(0,Number(el('page').value)-1);render()};el('next').onclick=()=>{el('page').value=Math.min(pages.length-1,Number(el('page').value)+1);render()};render();
</script></html>`;
  await fs.writeFile(path.join(output, 'review.html'), html);
  console.log(JSON.stringify(summary));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
