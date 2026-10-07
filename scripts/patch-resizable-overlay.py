from pathlib import Path

root = Path(r"E:\Shared\ExportImagefromWeb")
overlay = root / "src" / "translation-overlay.cjs"
store = root / "src" / "region-style-store.cjs"
test = root / "test" / "translation-overlay.test.cjs"
e2e = root / "test" / "translation-overlay.e2e.cjs"

def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"missing patch anchor: {label}")
    return text.replace(old, new, 1)

# --- region style persistence: font + normalized editable box ---
s = store.read_text(encoding="utf-8")
old = """function normalizeRegionStyle(value){
  if(value===null)return null;
  const fontSizeImagePx=Number(value?.fontSizeImagePx);
  if(!Number.isFinite(fontSizeImagePx)||fontSizeImagePx<1||fontSizeImagePx>4096)throw Error('ขนาดตัวอักษรไม่ถูกต้อง');
  return {fontSizeImagePx:Math.round(fontSizeImagePx*1000)/1000};
}"""
new = """function normalizeRegionStyle(value){
  if(value===null)return null;
  const style={};
  if(value?.fontSizeImagePx!==undefined&&value?.fontSizeImagePx!==null){
    const fontSizeImagePx=Number(value.fontSizeImagePx);
    if(!Number.isFinite(fontSizeImagePx)||fontSizeImagePx<1||fontSizeImagePx>4096)throw Error('ขนาดตัวอักษรไม่ถูกต้อง');
    style.fontSizeImagePx=Math.round(fontSizeImagePx*1000)/1000;
  }
  if(value?.box!==undefined&&value?.box!==null){
    const source=value.box,box={};
    for(const key of ['x0','y0','x1','y1']){
      const n=Number(source[key]);
      if(!Number.isFinite(n)||n<0||n>1)throw Error('ตำแหน่งกรอบข้อความไม่ถูกต้อง');
      box[key]=Math.round(n*1000000)/1000000;
    }
    if(box.x1-box.x0<.002||box.y1-box.y0<.002)throw Error('กรอบข้อความเล็กเกินไป');
    style.box=box;
  }
  return Object.keys(style).length?style:null;
}"""
s = replace_once(s, old, new, "normalizeRegionStyle")
s = s.replace("ID ขนาดตัวอักษรไม่ถูกต้อง", "ID การตั้งค่ากล่องข้อความไม่ถูกต้อง")
store.write_text(s, encoding="utf-8")

# --- overlay UI / geometry ---
s = overlay.read_text(encoding="utf-8")
old = """  const editCss=new CSSStyleSheet();editCss.replaceSync('.text{pointer-events:auto;cursor:pointer;touch-action:pan-y pinch-zoom}.text.selected{outline:2px solid #a996ff;outline-offset:2px}.region-editor{position:fixed;left:12px;bottom:64px;width:320px;max-width:calc(100vw - 24px);max-height:70vh;overflow:auto;overscroll-behavior:contain;padding:14px;background:#171a24;border:1px solid #75688e;border-radius:12px;color:#eee;font:13px/1.5 "Segoe UI",Tahoma,sans-serif;pointer-events:auto;z-index:4;box-shadow:0 10px 35px #0008}.region-editor[hidden]{display:none}.editor-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.region-editor button{border:1px solid #6a6085;border-radius:7px;background:#30273f;color:white;padding:6px 9px;cursor:pointer;font:inherit}.editor-preview{white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0;padding:9px;background:#10121a;border-radius:7px;max-height:150px;overflow:auto;user-select:text}.editor-range{display:flex;gap:10px;align-items:center;margin:10px 0}.editor-range input{flex:1;min-width:0}.editor-status{font-size:11px;color:#bfb5d4}.region-editor small{display:block;color:#b6afc3}.controls{z-index:3}');root.adoptedStyleSheets=[...root.adoptedStyleSheets,editCss];"""
new = """  const editCss=new CSSStyleSheet();editCss.replaceSync('.text{pointer-events:auto;cursor:pointer;touch-action:pan-y pinch-zoom}.text.selected{outline:2px solid #a996ff;outline-offset:2px;cursor:move}.resize-handle{position:absolute;width:12px;height:12px;border:2px solid #fff;background:#8d79da;border-radius:50%;box-shadow:0 0 0 1px #312a45;pointer-events:auto;touch-action:none;z-index:5}.text:not(.selected) .resize-handle{display:none}.resize-handle[data-dir="nw"]{left:0;top:0;cursor:nwse-resize}.resize-handle[data-dir="n"]{left:calc(50% - 6px);top:0;cursor:ns-resize}.resize-handle[data-dir="ne"]{right:0;top:0;cursor:nesw-resize}.resize-handle[data-dir="e"]{right:0;top:calc(50% - 6px);cursor:ew-resize}.resize-handle[data-dir="se"]{right:0;bottom:0;cursor:nwse-resize}.resize-handle[data-dir="s"]{left:calc(50% - 6px);bottom:0;cursor:ns-resize}.resize-handle[data-dir="sw"]{left:0;bottom:0;cursor:nesw-resize}.resize-handle[data-dir="w"]{left:0;top:calc(50% - 6px);cursor:ew-resize}.region-editor{position:fixed;left:12px;bottom:64px;width:320px;max-width:calc(100vw - 24px);max-height:70vh;overflow:auto;overscroll-behavior:contain;padding:14px;background:#171a24;border:1px solid #75688e;border-radius:12px;color:#eee;font:13px/1.5 "Segoe UI",Tahoma,sans-serif;pointer-events:auto;z-index:4;box-shadow:0 10px 35px #0008}.region-editor[hidden]{display:none}.editor-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.region-editor button{border:1px solid #6a6085;border-radius:7px;background:#30273f;color:white;padding:6px 9px;cursor:pointer;font:inherit}.editor-preview{white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0;padding:9px;background:#10121a;border-radius:7px;max-height:150px;overflow:auto;user-select:text}.editor-range{display:flex;gap:10px;align-items:center;margin:10px 0}.editor-range input{flex:1;min-width:0}.editor-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px}.editor-status{font-size:11px;color:#bfb5d4;margin-top:7px}.region-editor small{display:block;color:#b6afc3}.controls{z-index:3}');root.adoptedStyleSheets=[...root.adoptedStyleSheets,editCss];"""
s = replace_once(s, old, new, "edit css")

old = """  const resetFont=document.createElement('button');resetFont.type='button';resetFont.textContent='คืนขนาดอัตโนมัติ';resetFont.dataset.action='reset-region-font';
  const editorHint=document.createElement('small');editorHint.textContent='ปรับเฉพาะกล่องที่เลือก ไม่ต้องอ่านภาพหรือแปลใหม่';const editorStatus=document.createElement('div');editorStatus.className='editor-status';editorStatus.setAttribute('aria-live','polite');
  editor.append(editorHead,editorPreview,fontLabel,fontRow,resetFont,editorHint,editorStatus);root.append(editor);
  const styleKeyFor=(page,r)=>r.styleKey||[page.imageDigest,page.targetLanguage,r.original,r.bbox.x0,r.bbox.y0,r.bbox.x1,r.bbox.y1].join('|');
  function closeEditor(){for(const e of entries)for(const t of e.texts)t.text.classList.remove('selected');selectedText=null;editor.hidden=true;}
  function openEditor(item){closeEditor();selectedText=item;item.text.classList.add('selected');editorPreview.textContent=item.region.text;fontRange.value=String(Math.max(6,Math.min(72,Number(item.text.dataset.fontSize)||12)));fontValue.textContent=fontRange.value+' px';editorStatus.textContent='';editor.hidden=false;}
  function setRegionStyle(pageId,regionId,value){const page=pages.get(pageId),r=page?.regions.find(x=>x.id===regionId);if(!r)return false;const k=styleKeyFor(page,r);if(value===null)styleOverrides.set(k,null);else{const n=Number(value?.fontSizeImagePx);if(!Number.isFinite(n)||n<1||n>4096)return false;styleOverrides.set(k,{fontSizeImagePx:n});}styleRevision++;refresh();return true;}
  function saveFont(){if(!selectedText)return;const item=selectedText,value=styleOverrides.get(styleKeyFor(item.page,item.region))??null,token=String(++saveSequence);editorStatus.textContent='กำลังบันทึก…';editor.dataset.saveToken=token;document.dispatchEvent(new CustomEvent('__harvestts_region_style_change',{detail:JSON.stringify({token,pageId:item.page.id,regionId:item.region.id,imageDigest:item.page.imageDigest,style:value})}));}
  fontRange.addEventListener('input',()=>{if(!selectedText)return;const css=Number(fontRange.value);fontValue.textContent=css+' px';setRegionStyle(selectedText.page.id,selectedText.region.id,{fontSizeImagePx:css/Math.max(.001,selectedText.imageScale||1)});editorStatus.textContent=selectedText.text.dataset.fitWarning==='true'?'ข้อความใหญ่กว่ากรอบ — อ่านฉบับเต็มด้านบนได้':'ขนาดนี้ใช้เฉพาะกล่องที่เลือก';});
  fontRange.addEventListener('change',saveFont);resetFont.onclick=()=>{if(!selectedText)return;setRegionStyle(selectedText.page.id,selectedText.region.id,null);fontRange.value=selectedText.text.dataset.fontSize;fontValue.textContent=fontRange.value+' px';saveFont();};editorClose.onclick=closeEditor;
"""
new = """  const resetFont=document.createElement('button');resetFont.type='button';resetFont.textContent='คืนขนาดอัตโนมัติ';resetFont.dataset.action='reset-region-font';
  const resetBox=document.createElement('button');resetBox.type='button';resetBox.textContent='คืนกรอบอัตโนมัติ';resetBox.dataset.action='reset-region-box';
  const editorActions=document.createElement('div');editorActions.className='editor-actions';editorActions.append(resetFont,resetBox);
  const editorHint=document.createElement('small');editorHint.textContent='ลากกล่องที่เลือกเพื่อย้าย • ใช้จุด 8 จุดรอบกรอบเพื่อขยาย/ย่อ';const editorStatus=document.createElement('div');editorStatus.className='editor-status';editorStatus.setAttribute('aria-live','polite');
  editor.append(editorHead,editorPreview,fontLabel,fontRow,editorActions,editorHint,editorStatus);root.append(editor);
  const styleKeyFor=(page,r)=>r.styleKey||[page.imageDigest,page.targetLanguage,r.original,r.bbox.x0,r.bbox.y0,r.bbox.x1,r.bbox.y1].join('|');
  const validBox=b=>b&&['x0','y0','x1','y1'].every(k=>Number.isFinite(Number(b[k])))&&b.x0>=0&&b.y0>=0&&b.x1<=1&&b.y1<=1&&b.x1>b.x0&&b.y1>b.y0;
  const currentStyle=(page,r)=>{const k=styleKeyFor(page,r);return styleOverrides.has(k)?styleOverrides.get(k):r.userStyle||null;};
  const effectiveBox=(page,r)=>{const b=currentStyle(page,r)?.box;return validBox(b)?b:r.safeBox;};
  const mergedStyle=(item,patch,remove=[])=>{const next={...(currentStyle(item.page,item.region)||{}),...patch};for(const key of remove)delete next[key];return Object.keys(next).length?next:null;};
  function closeEditor(){for(const e of entries)for(const t of e.texts)t.text.classList.remove('selected');selectedText=null;editor.hidden=true;}
  function openEditor(item){closeEditor();selectedText=item;item.text.classList.add('selected');editorPreview.textContent=item.region.text;fontRange.value=String(Math.max(6,Math.min(72,Number(item.text.dataset.fontSize)||12)));fontValue.textContent=fontRange.value+' px';editorStatus.textContent='';editor.hidden=false;}
  function setRegionStyle(pageId,regionId,value){const page=pages.get(pageId),r=page?.regions.find(x=>x.id===regionId);if(!r)return false;const k=styleKeyFor(page,r);if(value===null)styleOverrides.set(k,null);else{const next={};if(value.fontSizeImagePx!==undefined){const n=Number(value.fontSizeImagePx);if(!Number.isFinite(n)||n<1||n>4096)return false;next.fontSizeImagePx=n;}if(value.box!==undefined){const b={x0:Number(value.box?.x0),y0:Number(value.box?.y0),x1:Number(value.box?.x1),y1:Number(value.box?.y1)};if(!validBox(b))return false;next.box=b;}styleOverrides.set(k,Object.keys(next).length?next:null);}styleRevision++;refresh();return true;}
  function saveRegionStyle(item=selectedText){if(!item)return;const value=currentStyle(item.page,item.region),token=String(++saveSequence);editorStatus.textContent='กำลังบันทึก…';editor.dataset.saveToken=token;document.dispatchEvent(new CustomEvent('__harvestts_region_style_change',{detail:JSON.stringify({token,pageId:item.page.id,regionId:item.region.id,imageDigest:item.page.imageDigest,style:value})}));}
  fontRange.addEventListener('input',()=>{if(!selectedText)return;const css=Number(fontRange.value);fontValue.textContent=css+' px';setRegionStyle(selectedText.page.id,selectedText.region.id,mergedStyle(selectedText,{fontSizeImagePx:css/Math.max(.001,selectedText.imageScale||1)}));editorStatus.textContent=selectedText.text.dataset.fitWarning==='true'?'ข้อความใหญ่กว่ากรอบ — ขยายกรอบหรือลดตัวอักษรได้':'ขนาดนี้ใช้เฉพาะกล่องที่เลือก';});
  fontRange.addEventListener('change',()=>saveRegionStyle());resetFont.onclick=()=>{if(!selectedText)return;setRegionStyle(selectedText.page.id,selectedText.region.id,mergedStyle(selectedText,{},['fontSizeImagePx']));refresh();fontRange.value=selectedText.text.dataset.fontSize;fontValue.textContent=fontRange.value+' px';saveRegionStyle();};resetBox.onclick=()=>{if(!selectedText)return;setRegionStyle(selectedText.page.id,selectedText.region.id,mergedStyle(selectedText,{},['box']));saveRegionStyle();};editorClose.onclick=closeEditor;
"""
s = replace_once(s, old, new, "editor helpers")

s = s.replace("editorStatus.textContent=r.ok?'บันทึกแล้ว • ใช้ขนาดนี้เมื่อเปิดภาพเดิม':'บันทึกไม่ได้: '+(r.error||'ไม่ทราบสาเหตุ');",
              "editorStatus.textContent=r.ok?'บันทึกแล้ว • จำกรอบและขนาดไว้กับภาพนี้':'บันทึกไม่ได้: '+(r.error||'ไม่ทราบสาเหตุ');")

old = """      const span=document.createElement('span');span.textContent=r.text;text.append(span);image.append(text);
      const item={text,span,region:r,page};texts.push(item);text.tabIndex=0;text.setAttribute('role','button');text.setAttribute('aria-label','ปรับขนาดคำแปล: '+r.text.slice(0,80));
      let press=null;text.addEventListener('pointerdown',e=>{press={x:e.clientX,y:e.clientY};});
      text.addEventListener('click',e=>{e.stopPropagation();if(!press||Math.hypot(e.clientX-press.x,e.clientY-press.y)<8)openEditor(item);press=null;});
      text.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();openEditor(item);}});
"""
new = """      const span=document.createElement('span');span.textContent=r.text;text.append(span);image.append(text);
      const item={text,span,region:r,page,drawW:0,drawH:0,currentBox:null};texts.push(item);text.tabIndex=0;text.setAttribute('role','button');text.setAttribute('aria-label','ปรับกรอบคำแปล: '+r.text.slice(0,80));
      for(const dir of ['nw','n','ne','e','se','s','sw','w']){const handle=document.createElement('i');handle.className='resize-handle';handle.dataset.dir=dir;handle.setAttribute('aria-hidden','true');text.append(handle);}
      let press=null;
      const beginDrag=(e,dir='move')=>{if(!text.classList.contains('selected'))return;const b=effectiveBox(page,r);if(!validBox(b)||!(item.drawW>0&&item.drawH>0))return;e.preventDefault();e.stopPropagation();press={x:e.clientX,y:e.clientY,drag:true};text.setPointerCapture?.(e.pointerId);item.drag={pointerId:e.pointerId,dir,startX:e.clientX,startY:e.clientY,startBox:{...b},baseStyle:{...(currentStyle(page,r)||{})},moved:false};};
      text.addEventListener('pointerdown',e=>{if(e.target?.classList?.contains('resize-handle'))return;press={x:e.clientX,y:e.clientY};if(text.classList.contains('selected'))beginDrag(e,'move');});
      for(const handle of text.querySelectorAll('.resize-handle'))handle.addEventListener('pointerdown',e=>beginDrag(e,handle.dataset.dir));
      text.addEventListener('pointermove',e=>{const d=item.drag;if(!d||d.pointerId!==e.pointerId)return;const dx=(e.clientX-d.startX)/item.drawW,dy=(e.clientY-d.startY)/item.drawH,b={...d.startBox},minW=Math.max(.01,10/page.width),minH=Math.max(.01,10/page.height);if(Math.abs(e.clientX-d.startX)+Math.abs(e.clientY-d.startY)>2)d.moved=true;if(d.dir==='move'){const w=b.x1-b.x0,h=b.y1-b.y0;b.x0=Math.max(0,Math.min(1-w,d.startBox.x0+dx));b.y0=Math.max(0,Math.min(1-h,d.startBox.y0+dy));b.x1=b.x0+w;b.y1=b.y0+h;}else{if(d.dir.includes('w'))b.x0=Math.max(0,Math.min(b.x1-minW,d.startBox.x0+dx));if(d.dir.includes('e'))b.x1=Math.min(1,Math.max(b.x0+minW,d.startBox.x1+dx));if(d.dir.includes('n'))b.y0=Math.max(0,Math.min(b.y1-minH,d.startBox.y0+dy));if(d.dir.includes('s'))b.y1=Math.min(1,Math.max(b.y0+minH,d.startBox.y1+dy));}if(setRegionStyle(page.id,r.id,{...d.baseStyle,box:b}))editorStatus.textContent='กำลังปรับกรอบ…';});
      const endDrag=e=>{const d=item.drag;if(!d||d.pointerId!==e.pointerId)return;item.drag=null;text.releasePointerCapture?.(e.pointerId);if(d.moved){press=null;saveRegionStyle(item);editorStatus.textContent='บันทึกตำแหน่งกรอบแล้ว';}};
      text.addEventListener('pointerup',endDrag);text.addEventListener('pointercancel',endDrag);
      text.addEventListener('click',e=>{e.stopPropagation();if(item.drag)return;if(!press||Math.hypot(e.clientX-press.x,e.clientY-press.y)<8)openEditor(item);press=null;});
      text.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();openEditor(item);}});
"""
s = replace_once(s, old, new, "mount drag handles")

old = """      else if(entry.lastSize!==size){for(const item of entry.texts){const b=item.region.safeBox,w=(b.x1-b.x0)*g.drawW,h=(b.y1-b.y0)*g.drawH;Object.assign(item.text.style,{left:b.x0*g.drawW+'px',top:b.y0*g.drawH+'px',width:w+'px',height:h+'px'});fitText(item,w,h,g.drawH/entry.page.height);}entry.lastSize=size;}"""
new = """      else if(entry.lastSize!==size){for(const item of entry.texts){const b=effectiveBox(item.page,item.region),w=(b.x1-b.x0)*g.drawW,h=(b.y1-b.y0)*g.drawH;item.drawW=g.drawW;item.drawH=g.drawH;item.currentBox={...b};Object.assign(item.text.style,{left:b.x0*g.drawW+'px',top:b.y0*g.drawH+'px',width:w+'px',height:h+'px'});fitText(item,w,h,g.drawH/entry.page.height);}entry.lastSize=size;}"""
s = replace_once(s, old, new, "refresh effective box")
overlay.write_text(s, encoding="utf-8")

# --- unit tests for persisted layout ---
s = test.read_text(encoding="utf-8")
if "normalizeRegionStyle" not in s:
    s = s.replace("const {overlayPage}=require('../src/translation-overlay.cjs');",
                  "const {overlayPage}=require('../src/translation-overlay.cjs');\nconst {normalizeRegionStyle}=require('../src/region-style-store.cjs');")
    s += """
test('region style accepts normalized box overrides with or without a manual font size',()=>{
 const box={x0:.1,y0:.2,x1:.7,y1:.8};
 assert.deepEqual(normalizeRegionStyle({box}),{box});
 assert.deepEqual(normalizeRegionStyle({fontSizeImagePx:18.25,box}),{fontSizeImagePx:18.25,box});
 assert.throws(()=>normalizeRegionStyle({box:{x0:-.1,y0:0,x1:.5,y1:.5}}),/กรอบข้อความ/);
});
"""
test.write_text(s, encoding="utf-8")

# --- E2E exercise the real east resize handle and movement ---
s = e2e.read_text(encoding="utf-8")
anchor = """ let state=await read();assert.equal(state.stats.drawn,1);assert.ok(state.font>8);assert.ok(state.height<=state.available+1);assert.ok(Math.abs(state.box.x-(state.image.x+140/600*state.image.width))<1);
 await page.screenshot({path:path.join(out,'translated.png')});"""
replacement = """ let state=await read();assert.equal(state.stats.drawn,1);assert.ok(state.font>8);assert.ok(state.height<=state.available+1);assert.ok(Math.abs(state.box.x-(state.image.x+140/600*state.image.width))<1);
 const textLocator=page.locator('#__harvestts_translation_overlay__ .text');await textLocator.click();const handles=page.locator('#__harvestts_translation_overlay__ .resize-handle');assert.equal(await handles.count(),8,'selected translation must expose eight resize handles');
 const beforeResize=await textLocator.boundingBox(),east=page.locator('#__harvestts_translation_overlay__ .resize-handle[data-dir="e"]'),eastBox=await east.boundingBox();await page.mouse.move(eastBox.x+eastBox.width/2,eastBox.y+eastBox.height/2);await page.mouse.down();await page.mouse.move(eastBox.x+eastBox.width/2+55,eastBox.y+eastBox.height/2,{steps:4});await page.mouse.up();const afterResize=await textLocator.boundingBox();assert.ok(afterResize.width>beforeResize.width+35,'east handle must widen the text box');
 const beforeMove=await textLocator.boundingBox();await page.mouse.move(beforeMove.x+beforeMove.width/2,beforeMove.y+beforeMove.height/2);await page.mouse.down();await page.mouse.move(beforeMove.x+beforeMove.width/2+28,beforeMove.y+beforeMove.height/2+20,{steps:4});await page.mouse.up();const afterMove=await textLocator.boundingBox();assert.ok(afterMove.x>beforeMove.x+15&&afterMove.y>beforeMove.y+10,'selected text box must be draggable');
 await page.evaluate(()=>overlay.setRegionStyle('image','speech',null));state=await read();assert.ok(Math.abs(state.box.x-(state.image.x+140/600*state.image.width))<1,'reset style must restore detected safe box');
 await page.screenshot({path:path.join(out,'translated.png')});"""
s = replace_once(s, anchor, replacement, "e2e resize")
s = s.replace("console.log('PASS: translated text, strict CSP, font fitting, scroll, responsive resize, object-fit, original toggle, image replacement and SPA clearing');",
              "console.log('PASS: translated text, 8-handle resize, drag move, strict CSP, font fitting, scroll, responsive resize, object-fit, original toggle, image replacement and SPA clearing');")
e2e.write_text(s, encoding="utf-8")

print("patched resizable translation boxes")
