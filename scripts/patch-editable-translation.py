from pathlib import Path

root=Path(r"E:\Shared\ExportImagefromWeb")
store=root/"src"/"region-style-store.cjs"
overlay=root/"src"/"translation-overlay.cjs"
reader=root/"src"/"offline-reader.js"
test=root/"test"/"translation-overlay.test.cjs"

def once(s,old,new,label):
    if old not in s: raise SystemExit("missing "+label)
    return s.replace(old,new,1)

# Persist translation text override with box/font settings.
s=store.read_text(encoding="utf-8")
old="""  if(value?.box!==undefined&&value?.box!==null){
    const source=value.box,box={};"""
new="""  if(value?.text!==undefined&&value?.text!==null){
    const text=String(value.text);
    if(text.length>10000)throw Error('ข้อความแปลยาวเกินไป');
    style.text=text;
  }
  if(value?.box!==undefined&&value?.box!==null){
    const source=value.box,box={};"""
s=once(s,old,new,"store text")
store.write_text(s,encoding="utf-8")

s=overlay.read_text(encoding="utf-8")
# Editor CSS: readable original + editable translation textarea.
old=""".editor-preview{white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0;padding:9px;background:#10121a;border-radius:7px;max-height:150px;overflow:auto;user-select:text}.editor-range"""
new=""".editor-label{display:block;margin:10px 0 5px;color:#aeb4c8;font-size:11px;font-weight:600}.editor-original{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:9px;background:#10121a;border:1px solid #292d3d;border-radius:7px;max-height:105px;overflow:auto;user-select:text;color:#bfc5d5}.editor-text{display:block;width:100%;min-height:72px;max-height:170px;resize:vertical;margin:0;padding:9px 10px;background:#0e1119;border:1px solid #4a4262;border-radius:7px;color:#f5f3ff;font:13px/1.5 "Segoe UI",Tahoma,sans-serif;outline:none}.editor-text:focus{border-color:#907de0;box-shadow:0 0 0 2px #907de026}.editor-range"""
s=once(s,old,new,"editor css")

old="""  const editorPreview=document.createElement('div');editorPreview.className='editor-preview';
  const fontLabel=document.createElement('label');fontLabel.textContent='ขนาดตัวอักษร';"""
new="""  const originalLabel=document.createElement('label');originalLabel.className='editor-label';originalLabel.textContent='ข้อความต้นฉบับ';
  const editorOriginal=document.createElement('div');editorOriginal.className='editor-original';
  const translationLabel=document.createElement('label');translationLabel.className='editor-label';translationLabel.textContent='ข้อความแปล';
  const editorText=document.createElement('textarea');editorText.className='editor-text';editorText.rows=3;editorText.maxLength=10000;editorText.dataset.action='region-text';
  const fontLabel=document.createElement('label');fontLabel.className='editor-label';fontLabel.textContent='ขนาดตัวอักษร';"""
s=once(s,old,new,"editor elements")
old="""  editor.append(editorHead,editorPreview,fontLabel,fontRow,editorActions,editorHint,editorStatus);root.append(editor);"""
new="""  editor.append(editorHead,originalLabel,editorOriginal,translationLabel,editorText,fontLabel,fontRow,editorActions,editorHint,editorStatus);root.append(editor);"""
s=once(s,old,new,"editor append")

old="""  const currentStyle=(page,r)=>{const k=styleKeyFor(page,r);return styleOverrides.has(k)?styleOverrides.get(k):r.userStyle||null;};
  const effectiveBox=(page,r)=>{const b=currentStyle(page,r)?.box;return validBox(b)?b:r.safeBox;};
  const mergedStyle=(item,patch,remove=[])=>{const next={...(currentStyle(item.page,item.region)||{}),...patch};for(const key of remove)delete next[key];return Object.keys(next).length?next:null;};
  function closeEditor(){for(const e of entries)for(const t of e.texts)t.text.classList.remove('selected');selectedText=null;editor.hidden=true;}
  function openEditor(item){closeEditor();selectedText=item;item.text.classList.add('selected');editorPreview.textContent=item.region.text;fontRange.value=String(Math.max(6,Math.min(72,Number(item.text.dataset.fontSize)||12)));fontValue.textContent=fontRange.value+' px';editorStatus.textContent='';editor.hidden=false;}
  function setRegionStyle(pageId,regionId,value){const page=pages.get(pageId),r=page?.regions.find(x=>x.id===regionId);if(!r)return false;const k=styleKeyFor(page,r);if(value===null)styleOverrides.set(k,null);else{const next={};if(value.fontSizeImagePx!==undefined){const n=Number(value.fontSizeImagePx);if(!Number.isFinite(n)||n<1||n>4096)return false;next.fontSizeImagePx=n;}if(value.box!==undefined){const b={x0:Number(value.box?.x0),y0:Number(value.box?.y0),x1:Number(value.box?.x1),y1:Number(value.box?.y1)};if(!validBox(b))return false;next.box=b;}styleOverrides.set(k,Object.keys(next).length?next:null);}styleRevision++;refresh();return true;}"""
new="""  const currentStyle=(page,r)=>{const k=styleKeyFor(page,r);return styleOverrides.has(k)?styleOverrides.get(k):r.userStyle||null;};
  const effectiveBox=(page,r)=>{const b=currentStyle(page,r)?.box;return validBox(b)?b:r.safeBox;};
  const effectiveText=(page,r)=>currentStyle(page,r)?.text!==undefined?String(currentStyle(page,r).text):r.text;
  const mergedStyle=(item,patch,remove=[])=>{const next={...(currentStyle(item.page,item.region)||{}),...patch};for(const key of remove)delete next[key];return Object.keys(next).length?next:null;};
  function closeEditor(){for(const e of entries)for(const t of e.texts)t.text.classList.remove('selected');selectedText=null;editor.hidden=true;}
  function openEditor(item){closeEditor();selectedText=item;item.text.classList.add('selected');editorOriginal.textContent=item.region.original||'';editorText.value=effectiveText(item.page,item.region);fontRange.value=String(Math.max(6,Math.min(72,Number(item.text.dataset.fontSize)||12)));fontValue.textContent=fontRange.value+' px';editorStatus.textContent='';editor.hidden=false;}
  function setRegionStyle(pageId,regionId,value){const page=pages.get(pageId),r=page?.regions.find(x=>x.id===regionId);if(!r)return false;const k=styleKeyFor(page,r);if(value===null)styleOverrides.set(k,null);else{const next={};if(value.text!==undefined){const t=String(value.text);if(t.length>10000)return false;next.text=t;}if(value.fontSizeImagePx!==undefined){const n=Number(value.fontSizeImagePx);if(!Number.isFinite(n)||n<1||n>4096)return false;next.fontSizeImagePx=n;}if(value.box!==undefined){const b={x0:Number(value.box?.x0),y0:Number(value.box?.y0),x1:Number(value.box?.x1),y1:Number(value.box?.y1)};if(!validBox(b))return false;next.box=b;}styleOverrides.set(k,Object.keys(next).length?next:null);}for(const entry of entries)for(const item of entry.texts)if(item.page===page&&item.region===r){item.span.textContent=effectiveText(page,r);item.text.title=(r.original||'')+'\\n────────\\n'+effectiveText(page,r);entry.lastSize='';}styleRevision++;refresh();return true;}"""
s=once(s,old,new,"effective text")

# Text change is live, save on blur/change.
old="""  fontRange.addEventListener('input',()=>{if(!selectedText)return;const css=Number(fontRange.value);fontValue.textContent=css+' px';setRegionStyle(selectedText.page.id,selectedText.region.id,mergedStyle(selectedText,{fontSizeImagePx:css/Math.max(.001,selectedText.imageScale||1)}));editorStatus.textContent=selectedText.text.dataset.fitWarning==='true'?'ข้อความใหญ่กว่ากรอบ — ขยายกรอบหรือลดตัวอักษรได้':'ขนาดนี้ใช้เฉพาะกล่องที่เลือก';});"""
new="""  editorText.addEventListener('input',()=>{if(!selectedText)return;setRegionStyle(selectedText.page.id,selectedText.region.id,mergedStyle(selectedText,{text:editorText.value}));editorStatus.textContent='กำลังแก้ข้อความ…';});
  editorText.addEventListener('change',()=>saveRegionStyle());
  editorText.addEventListener('blur',()=>{if(selectedText)saveRegionStyle();});
  fontRange.addEventListener('input',()=>{if(!selectedText)return;const css=Number(fontRange.value);fontValue.textContent=css+' px';setRegionStyle(selectedText.page.id,selectedText.region.id,mergedStyle(selectedText,{fontSizeImagePx:css/Math.max(.001,selectedText.imageScale||1)}));editorStatus.textContent=selectedText.text.dataset.fitWarning==='true'?'ข้อความใหญ่กว่ากรอบ — ขยายกรอบหรือลดตัวอักษรได้':'ขนาดนี้ใช้เฉพาะกล่องที่เลือก';});"""
s=once(s,old,new,"text listeners")

old="""    const {text,span}=item;item.imageScale=imageScale;
    const styleKey=styleKeyFor(item.page,item.region),manual=styleOverrides.has(styleKey)?styleOverrides.get(styleKey):item.region.userStyle;
    if(manual){const size=manual.fontSizeImagePx*imageScale;text.style.fontSize=size+'px';text.dataset.fontSize=size.toFixed(2);text.dataset.manualFont='true';text.dataset.fitWarning=String(span.scrollHeight>text.clientHeight-4||span.scrollWidth>text.clientWidth-4);return;}"""
new="""    const {text,span}=item;item.imageScale=imageScale;
    const styleKey=styleKeyFor(item.page,item.region),manual=styleOverrides.has(styleKey)?styleOverrides.get(styleKey):item.region.userStyle,manualSize=Number(manual?.fontSizeImagePx);
    if(manualSize>0){const size=manualSize*imageScale;text.style.fontSize=size+'px';text.dataset.fontSize=size.toFixed(2);text.dataset.manualFont='true';text.dataset.fitWarning=String(span.scrollHeight>text.clientHeight-4||span.scrollWidth>text.clientWidth-4);return;}"""
s=once(s,old,new,"fit manual")

old="""      const span=document.createElement('span');span.textContent=r.text;text.append(span);image.append(text);"""
new="""      const span=document.createElement('span');span.textContent=effectiveText(page,r);text.append(span);text.title=r.original+'\\n────────\\n'+effectiveText(page,r);image.append(text);"""
s=once(s,old,new,"mount effective text")
overlay.write_text(s,encoding="utf-8")

# Offline reader honors saved text overrides too.
s=reader.read_text(encoding="utf-8")
s=s.replace("t.textContent=r.text;", "t.textContent=r.userStyle?.text!==undefined?String(r.userStyle.text):r.text;", 1)
s=s.replace("for(const paragraph of String(text||'').split('\\\\n'))", "for(const paragraph of String(text??'').split('\\\\n'))", 1)
s=s.replace("const lines=wrapChars(ctx,r.text,W);", "const lines=wrapChars(ctx,r.userStyle?.text!==undefined?String(r.userStyle.text):r.text,W);", 1)
reader.write_text(s,encoding="utf-8")

# Unit coverage.
s=test.read_text(encoding="utf-8")
old=""" assert.deepEqual(normalizeRegionStyle({fontSizeImagePx:18.25,box}),{fontSizeImagePx:18.25,box});
 assert.throws(()=>normalizeRegionStyle({box:{x0:-.1,y0:0,x1:.5,y1:.5}}),/กรอบข้อความ/);"""
new=""" assert.deepEqual(normalizeRegionStyle({fontSizeImagePx:18.25,box}),{fontSizeImagePx:18.25,box});
 assert.deepEqual(normalizeRegionStyle({text:'แก้คำแปลแล้ว',box}),{text:'แก้คำแปลแล้ว',box});
 assert.throws(()=>normalizeRegionStyle({box:{x0:-.1,y0:0,x1:.5,y1:.5}}),/กรอบข้อความ/);"""
s=once(s,old,new,"text unit")
test.write_text(s,encoding="utf-8")
print("patched editable translation text + original preview")
