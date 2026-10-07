'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process');
async function main(){
 const root=path.resolve(process.argv[2]||'C:/Users/jinna/Downloads/manga test ocr'),out=path.resolve(process.argv[3]||'test-results/new-sets');
 await fs.mkdir(out,{recursive:true});
 const sets=(await fs.readdir(root,{withFileTypes:true})).filter(e=>e.isDirectory()&&/^\d+$/.test(e.name)&&Number(e.name)>1).map(e=>e.name).sort((a,b)=>Number(a)-Number(b));
 const reports=[];
 for(const set of sets){
  console.log(`START set ${set}`);const dest=path.join(out,'set-'+set);
  await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[path.join(__dirname,'benchmark-manga-ocr.cjs'),path.join(root,set),dest],{cwd:path.resolve(__dirname,'..'),windowsHide:true,stdio:['ignore','pipe','pipe']});
   let pending='';child.stdout.on('data',data=>{pending+=data;const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines){const m=line.match(/^(\d+)\/(\d+):/);if(m&&(Number(m[1])%10===0||m[1]===m[2]))console.log(`set ${set}: ${line}`);}});
   child.stderr.on('data',data=>process.stderr.write(data));child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`set ${set} failed: ${code}`)));
  });
  const report=JSON.parse(await fs.readFile(path.join(dest,'report.json'),'utf8'));reports.push({set,...report});
  console.log(`DONE set ${set}: ${report.images} images, ${report.errors} errors, ${report.regions} regions, ${report.tiledImages} tiled images`);
  await fs.writeFile(path.join(out,'summary.json'),JSON.stringify({sets:reports,images:reports.reduce((n,r)=>n+r.images,0),errors:reports.reduce((n,r)=>n+r.errors,0),regions:reports.reduce((n,r)=>n+r.regions,0),rejected:reports.reduce((n,r)=>n+r.rejected,0),note:'No complete reference exists for these new sets; detection and character accuracy are unverified.'},null,2));
 }
 const md=['# ผลทดสอบ OCR ชุดใหม่','', 'รันด้วยเอนจินปัจจุบันในเครื่อง จำนวนกรอบไม่ใช่ความแม่นยำ ชุดใหม่ยังไม่มีเฉลยที่ตรวจยืนยันครบ จึงยังวัดเป้าหมาย 99% ไม่ได้','', '| ชุด | ภาพ | เอนจินล้มเหลว | กรอบที่เก็บ | ผลไม่แน่ใจที่พักไว้ | ภาพที่แบ่งช่วงตรวจ |','|---|---:|---:|---:|---:|---:|',...reports.map(r=>`| ${r.set} | ${r.images} | ${r.errors} | ${r.regions} | ${r.rejected} | ${r.tiledImages} |`),'','แต่ละโฟลเดอร์ set-N มี review.json สำหรับเปิดใน OCR Lab พร้อมภาพต้นฉบับ พิกัด ผลดิบ และผลแต่ละขั้นตอน ไม่ได้นำเฉลยของชุดแรกไปใช้กับภาพชุดใหม่'];
 await fs.writeFile(path.join(out,'report.md'),md.join('\n'));console.log('COMPLETE '+path.join(out,'report.md'));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
