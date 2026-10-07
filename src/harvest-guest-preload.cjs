'use strict';
const { ipcRenderer } = require('electron');

let translateSymbolDataUrl = '';

let suggestionHost = null;
let suggestionShadow = null;
let activeField = null;
let lastSuggestions = [];
let lastZoomWheelAt = 0;
addEventListener('wheel',event=>{
  if(!event.ctrlKey)return;
  event.preventDefault();
  const now=Date.now();if(now-lastZoomWheelAt<90)return;lastZoomWheelAt=now;
  ipcRenderer.invoke('harvest-guest:zoom',{direction:event.deltaY<0?1:-1}).catch(()=>{});
},{capture:true,passive:false});

let zoomToastHost=null,zoomToastValue=null,zoomToastTimer=null;
function showZoomToast(percent){
  const value=Math.max(50,Math.min(300,Math.round(Number(percent)||100)));
  if(!document.documentElement){addEventListener('DOMContentLoaded',()=>showZoomToast(value),{once:true});return;}
  if(!zoomToastHost||!zoomToastHost.isConnected){
    zoomToastHost=document.createElement('div');zoomToastHost.id='__harvestts_zoom_toast__';
    Object.assign(zoomToastHost.style,{all:'initial',position:'fixed',right:'18px',top:'18px',zIndex:'2147483647',pointerEvents:'none'});
    const root=zoomToastHost.attachShadow({mode:'closed'}),box=document.createElement('div');zoomToastValue=document.createElement('span');
    box.append(zoomToastValue);Object.assign(box.style,{minWidth:'58px',padding:'8px 12px',borderRadius:'10px',background:'rgba(24,27,38,.94)',border:'1px solid rgba(164,145,232,.55)',boxShadow:'0 8px 28px rgba(0,0,0,.38)',color:'#f2efff',font:'600 13px/1.2 "Segoe UI",Tahoma,sans-serif',textAlign:'center',transition:'opacity .16s ease,transform .16s ease',opacity:'0',transform:'translateY(-3px)'});root.append(box);zoomToastHost.__box=box;document.documentElement.append(zoomToastHost);
  }
  zoomToastHost.dataset.percent=String(value);zoomToastValue.textContent=value+'%';const box=zoomToastHost.__box;box.style.opacity='1';box.style.transform='translateY(0)';clearTimeout(zoomToastTimer);zoomToastTimer=setTimeout(()=>{if(!zoomToastHost?.isConnected)return;box.style.opacity='0';box.style.transform='translateY(-3px)';},850);
}
ipcRenderer.on('harvest-guest:zoom-display',(_event,payload)=>showZoomToast(payload?.percent));

function visible(el){
  if(!el || !(el instanceof Element)) return false;
  const r=el.getBoundingClientRect(), s=getComputedStyle(el);
  return r.width>1 && r.height>1 && s.display!=='none' && s.visibility!=='hidden';
}
function formInfo(target){
  if(!(target instanceof HTMLInputElement)) return null;
  const type=(target.type||'text').toLowerCase();
  if(!['password','text','email','tel'].includes(type)) return null;
  const scope=target.form || document;
  const passwords=[...scope.querySelectorAll('input[type="password"]')].filter(visible);
  if(!passwords.length) return null;
  const userCandidates=[...scope.querySelectorAll('input')].filter(x=>{
    if(passwords.includes(x)||!visible(x)||x.disabled) return false;
    return ['text','email','tel'].includes((x.type||'text').toLowerCase());
  });
  const username=userCandidates.find(x=>/user|email|login|account/i.test((x.autocomplete||'')+' '+(x.name||'')+' '+(x.id||'')+' '+(x.placeholder||''))) || userCandidates[0];
  return {origin:location.origin,url:location.href,username:username?.value||'',hasPassword:true};
}
function candidateFromForm(form){
  const scope=form || document;
  const password=[...scope.querySelectorAll('input[type="password"]')].find(x=>x.value);
  if(!password?.value) return null;
  const users=[...scope.querySelectorAll('input')].filter(x=>{
    if(x===password||x.disabled) return false;
    return ['text','email','tel'].includes((x.type||'text').toLowerCase());
  });
  const username=users.find(x=>/user|email|login|account/i.test((x.autocomplete||'')+' '+(x.name||'')+' '+(x.id||'')+' '+(x.placeholder||''))&&x.value)
    || users.find(x=>x.value) || users[0];
  return {
    origin:location.origin,url:location.href,
    username:String(username?.value||'').slice(0,512),
    password:String(password.value||'').slice(0,4096)
  };
}
function ensureSuggestionHost(){
  if(suggestionHost?.isConnected) return;
  suggestionHost=document.createElement('div');
  suggestionHost.id='__harvestts_password_suggestions__';
  Object.assign(suggestionHost.style,{
    position:'fixed',zIndex:'2147483647',display:'none',
    pointerEvents:'auto',margin:'0',padding:'0'
  });
  suggestionShadow=suggestionHost.attachShadow({mode:'closed'});
  const style=document.createElement('style');
  style.textContent=`
    :host{all:initial}
    .box{width:320px;max-width:min(420px,calc(100vw - 16px));overflow:hidden;
      background:#171a24;color:#eef1fb;border:1px solid #3b4054;border-radius:10px;
      box-shadow:0 14px 34px rgba(0,0,0,.48);font-family:"Segoe UI",Tahoma,sans-serif}
    .head{padding:9px 11px 7px;font-size:10px;color:#9ca3ba;border-bottom:1px solid #2b3040}
    button{all:unset;box-sizing:border-box;display:grid;grid-template-columns:30px 1fr;gap:8px;
      width:100%;padding:9px 11px;cursor:pointer}
    button:hover,button:focus{background:#24293a}
    .icon{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;
      background:#242a3b;color:#b9c5ff;font-size:13px}
    .copy{display:grid;gap:2px;min-width:0}.user{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .pass{font-size:9px;color:#7e879f;letter-spacing:1px}
  `;
  suggestionShadow.append(style);
  document.documentElement.append(suggestionHost);
}
function hideSuggestions(){
  if(suggestionHost) suggestionHost.style.display='none';
}
function positionSuggestions(){
  if(!suggestionHost || suggestionHost.style.display==='none' || !activeField?.isConnected || !visible(activeField)) return;
  const r=activeField.getBoundingClientRect();
  const width=Math.max(260,Math.min(420,r.width||320));
  const viewportH=window.innerHeight, viewportW=window.innerWidth;
  const estimated=Math.min(250,54+Math.max(1,lastSuggestions.length)*48);
  let top=r.bottom+5;
  if(top+estimated>viewportH-8 && r.top-estimated-5>8) top=r.top-estimated-5;
  const left=Math.max(8,Math.min(viewportW-width-8,r.left));
  Object.assign(suggestionHost.style,{left:left+'px',top:Math.max(8,top)+'px',width:width+'px'});
}
function renderSuggestions(payload){
  ensureSuggestionHost();
  if(payload?.origin!==location.origin || !activeField || !visible(activeField)){
    hideSuggestions(); return;
  }
  const accounts=Array.isArray(payload.accounts)?payload.accounts:[];
  lastSuggestions=accounts;
  suggestionHost.dataset.accountCount=String(accounts.length);
  if(!accounts.length){hideSuggestions();return}
  suggestionShadow.querySelector('.box')?.remove();
  const box=document.createElement('div');box.className='box';
  const head=document.createElement('div');head.className='head';head.textContent='ใช้บัญชีที่บันทึกไว้';
  box.append(head);
  for(const account of accounts){
    const button=document.createElement('button');button.type='button';button.tabIndex=0;
    const icon=document.createElement('span');icon.className='icon';icon.textContent='⌘';
    const copy=document.createElement('span');copy.className='copy';
    const user=document.createElement('span');user.className='user';user.textContent=account.username||'(ไม่มีชื่อบัญชี)';
    const pass=document.createElement('span');pass.className='pass';pass.textContent='••••••••';
    copy.append(user,pass);button.append(icon,copy);
    button.addEventListener('pointerdown',e=>e.preventDefault());
    button.addEventListener('click',async()=>{
      button.style.opacity='.55';
      try{
        const result=await ipcRenderer.invoke('harvest-guest:choose-account',{credentialId:account.id});
        if(result?.filled!==false) hideSuggestions();
      }finally{button.style.opacity='1'}
    });
    box.append(button);
  }
  suggestionShadow.append(box);
  suggestionHost.style.display='block';
  positionSuggestions();
}
ipcRenderer.on('harvest-guest:account-suggestions',(_event,payload)=>renderSuggestions(payload));

window.addEventListener('DOMContentLoaded',()=>{
  ensureSuggestionHost();
  document.addEventListener('focusin',event=>{
    const info=formInfo(event.target);
    if(!info){if(!suggestionHost?.contains?.(event.target))hideSuggestions();return}
    activeField=event.target;
    ipcRenderer.send('harvest-guest:password-focus',info);
  },true);
  document.addEventListener('focusout',()=>{
    setTimeout(()=>{
      if(document.activeElement!==activeField && !suggestionHost?.matches?.(':hover')) hideSuggestions();
    },120);
  },true);
  document.addEventListener('submit',event=>{
    const candidate=candidateFromForm(event.target);
    if(candidate){hideSuggestions();ipcRenderer.send('harvest-guest:password-submit',candidate)}
  },true);
  document.addEventListener('click',event=>{
    const button=event.target?.closest?.('button,input[type="submit"],input[type="button"]');
    if(!button) return;
    const form=button.form || button.closest?.('form');
    if(!form) return;
    const candidate=candidateFromForm(form);
    if(candidate){hideSuggestions();ipcRenderer.send('harvest-guest:password-submit',candidate)}
  },true);
  addEventListener('scroll',positionSuggestions,true);
  addEventListener('resize',positionSuggestions,true);
});

let translationHost = null;
let translationShadow = null;
let translationRunning = false;
let translationJobId = '';
document.addEventListener('__harvestts_reader_cancel',event=>{
  if(translationRunning&&event.detail?.jobId===translationJobId)ipcRenderer.invoke('harvest-guest:translation-cancel').catch(()=>{});
});
document.addEventListener('__harvestts_region_style_change',async event=>{
  let input;try{if(typeof event.detail!=='string'||event.detail.length>3000)return;input=JSON.parse(event.detail);if(typeof input.token!=='string'||typeof input.pageId!=='string'||typeof input.regionId!=='string')return;}catch{return;}
  let result;try{await ipcRenderer.invoke('harvest-guest:region-style-save',input);result={token:input.token,ok:true};}catch(e){result={token:input.token,ok:false,error:e.message};}
  document.dispatchEvent(new CustomEvent('__harvestts_region_style_result',{detail:JSON.stringify(result)}));
});
let translationPages = [];
let translationModelText = 'โมเดล: ยังไม่ได้ทดสอบ';
let translationScanProgress = 0;
let translateSettings = {
  engine:'ai',
  sourceLanguage:'auto',
  targetLanguage:'th',
  contentType:'manga',
  fontScale:1,
  showOriginal:false
};
let screenLensState = { enabled:false, frames:0, lastAt:0, width:0, height:0, bytes:0, error:'' };
let launcherMenuOpen = false;

function ensureTranslationLauncher() {
  if (translationHost?.isConnected) return;
  translationHost = document.createElement('div');
  translationHost.id = '__harvestts_manga_translate__';
  Object.assign(translationHost.style, {
    position:'fixed', right:'20px', bottom:'20px', zIndex:'2147483646',
    width:'54px', height:'54px', pointerEvents:'auto', margin:'0', padding:'0'
  });
  translationShadow = translationHost.attachShadow({ mode:'closed' });

  const style = document.createElement('style');
  style.textContent = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.launcher{all:unset;width:var(--launcher-size,54px);height:var(--launcher-size,54px);border-radius:50%;display:grid;place-items:center;cursor:grab;background:#09090d;color:white;border:1px solid rgba(255,255,255,.24);box-shadow:0 10px 28px rgba(15,12,40,.42);user-select:none;touch-action:none;overflow:hidden}',
    '.launcher:active{cursor:grabbing}.launcher.running{box-shadow:0 0 0 3px rgba(122,104,255,.45),0 10px 28px rgba(15,12,40,.42)}',
    '.launcher img{width:100%;height:100%;display:block;object-fit:cover;pointer-events:none}.launcher .fallback-mark{font:800 17px/1 Georgia,serif;color:#ff9fca}',
    '.quickmenu{position:absolute;inset:0;z-index:5;overflow:visible;pointer-events:none}.quickmenu[hidden]{display:none}',
    '.toolbtn{all:unset;box-sizing:border-box;position:absolute;width:var(--tool-size,48px);height:var(--tool-size,48px);border-radius:50%;display:grid;grid-template-rows:var(--icon-row,21px) var(--caption-row,10px);place-content:center;text-align:center;cursor:pointer;pointer-events:auto;background:#171a24;color:#eef1fb;border:1px solid #3a4055;box-shadow:0 8px 22px rgba(0,0,0,.36);font-family:"Segoe UI",Tahoma,sans-serif;transition:transform .13s ease,opacity .13s ease}',
    '.quickmenu.opening .toolbtn{animation:tool-reveal .24s cubic-bezier(.2,.8,.2,1) both;animation-delay:var(--delay,0ms)}',
    '@keyframes tool-reveal{from{opacity:0;transform:translate(var(--from-x),var(--from-y)) scale(.35)}to{opacity:1;transform:translate(0,0) scale(1)}}',
    '@media(prefers-reduced-motion:reduce){.quickmenu.opening .toolbtn{animation:none}}',
    '.toolbtn:hover{background:#222638}.toolbtn.active{border-color:#d95391;background:#372033;box-shadow:0 0 0 2px rgba(217,83,145,.16),0 8px 22px rgba(0,0,0,.36)}',
    '.toolicon{font-size:var(--icon-size,18px);line-height:var(--icon-row,21px)}.toolcaption{font-size:var(--caption-size,8px);color:#aeb6ca;white-space:nowrap}.toolbtn.active .toolcaption{color:#ffb5d5}',
    '.panel{position:absolute;right:0;bottom:64px;width:348px;max-width:calc(100vw - 16px);max-height:min(560px,70vh);overflow:hidden;background:#151823;color:#eef1fb;border:1px solid #363b51;border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.52);font:12px/1.45 "Segoe UI",Tahoma,sans-serif}',
    '.panel{display:flex;flex-direction:column}.panel[hidden]{display:none}.head{flex-shrink:0;display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:13px 14px 10px;border-bottom:1px solid #292e41}',
    '.head b{font-size:13px}.head span{display:block;color:#949db5;font-size:9px;margin-top:2px}',
    '.head-actions{display:flex;align-items:center;gap:6px}.head-start{all:unset;box-sizing:border-box;min-width:64px;text-align:center;padding:6px 10px;border-radius:8px;background:#7a68ff;color:white;font-weight:700;font-size:10px;cursor:pointer}.head-start:hover{filter:brightness(1.06)}.head-start:disabled{opacity:.55;cursor:default}',
    '.close{all:unset;width:28px;height:28px;display:grid;place-items:center;border-radius:7px;cursor:pointer;color:#9da5ba}.close:hover{background:#252a3b;color:#fff}',
    '.body{overscroll-behavior:contain;min-height:0;padding:12px 14px 14px;display:grid;gap:10px;max-height:500px;overflow:auto}',
    '.model,.status{padding:8px 9px;border:1px solid #2c3245;border-radius:9px;background:#11141d;color:#aab2c8;font-size:9px}',
    '.model.ok{border-color:#315f54;color:#9ee8d6}.model.bad{border-color:#603742;color:#ffb1bd}',
    '.overall{display:grid;gap:5px}.overallline{height:6px;border-radius:999px;background:#282d3e;overflow:hidden}.overallbar{height:100%;width:0;background:#7a68ff;transition:width .16s ease}',
    '.pages{display:grid;gap:7px}.empty{padding:13px;text-align:center;border:1px dashed #30364a;border-radius:9px;color:#7f879e;font-size:9px}',
    '.page{display:grid;grid-template-columns:34px 1fr;gap:8px;align-items:center;padding:7px 8px;border:1px solid #2b3042;border-radius:9px;background:#12151e}',
    '.num{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:#222739;color:#c6ccef;font-size:9px;font-weight:700}',
    '.copy{min-width:0;display:grid;gap:4px}.row{display:flex;gap:6px;justify-content:space-between;min-width:0}.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e8ebf5;font-size:9px}.state{flex:0 0 auto;color:#9199b1;font-size:8px}',
    '.barline{height:5px;border-radius:999px;background:#262b3b;overflow:hidden}.bar{height:100%;width:0;background:#7a68ff;transition:width .16s ease}.page.error .bar{background:#c85b70}.page.ready .bar{background:#62bfa6}',
    '.actions{display:grid;grid-template-columns:1fr;gap:7px}.start{all:unset;box-sizing:border-box;text-align:center;padding:10px 12px;border-radius:9px;background:#7a68ff;color:white;font-weight:700;font-size:11px;cursor:pointer}.start:hover{filter:brightness(1.06)}.start:disabled{opacity:.55;cursor:default}.start.head-start{min-width:64px;padding:6px 10px;border-radius:8px;font-size:10px}',
    '.settings-panel{width:324px}.settings-body{min-height:0;padding:12px 14px 14px;display:grid;gap:12px;max-height:520px;overflow:auto}',
    '.setting{display:grid;gap:6px}.setting-label{font-size:9px;color:#98a1b8}.setting-title{font-size:11px;color:#eef1fb;font-weight:600}',
    '.seg{display:grid;grid-template-columns:1fr 1fr;gap:6px}.segbtn{all:unset;box-sizing:border-box;text-align:center;padding:8px 7px;border-radius:8px;background:#10131c;border:1px solid #30364a;color:#9da6bb;font-size:9px;cursor:pointer}.segbtn.active{background:#2c2449;border-color:#7568d8;color:#fff}',
    '.langrow{display:grid;grid-template-columns:1fr 18px 1fr;gap:6px;align-items:center}.arrow{text-align:center;color:#717b94;font-size:12px}',
    'select{appearance:none;width:100%;background:#10131c;color:#eef1fb;border:1px solid #30364a;border-radius:8px;padding:8px 26px 8px 9px;font:9px/1.2 "Segoe UI",Tahoma,sans-serif;outline:none}select:focus{border-color:#7568d8}',
    '.google-config{display:grid;gap:7px;padding:9px;border:1px solid #2d3346;background:#10131c;border-radius:9px}.google-config[hidden]{display:none}',
    '.key-row{display:grid;grid-template-columns:1fr auto;gap:6px}.text-input{all:unset;box-sizing:border-box;width:100%;background:#0c0f17;color:#eef1fb;border:1px solid #30364a;border-radius:8px;padding:8px 9px;font:9px/1.2 "Segoe UI",Tahoma,sans-serif}.text-input:focus{border-color:#7568d8}',
    '.small-action[hidden]{display:none}.small-action{all:unset;box-sizing:border-box;padding:8px 9px;border-radius:8px;background:#29233f;border:1px solid #51477b;color:#fff;font:9px/1.2 "Segoe UI",Tahoma,sans-serif;cursor:pointer}.small-action:hover{filter:brightness(1.08)}',
    '.provider-row{display:flex;justify-content:space-between;gap:8px;align-items:center}.provider-status{font-size:8px;color:#8f99b2}.provider-status.ok{color:#9ee8d6}.provider-status.bad{color:#ff9ead}',
    '.range-row{display:grid;grid-template-columns:1fr 44px;gap:8px;align-items:center}.range-row input[type=range]{width:100%;accent-color:#d95391}.range-value{font-size:9px;text-align:right;color:#ffafd2}',
    '.lens-status{padding:9px;border-radius:9px;background:#10131c;border:1px solid #30364a;color:#8f99b2;font-size:8px}.lens-status.on{border-color:#3a675b;color:#9ee8d6}',
    '.privacy{font-size:8px;line-height:1.5;color:#747e96;padding-top:1px}',
    '.note{color:#727b92;font-size:8px;text-align:center}',
    '@media(max-width:420px){.panel{width:calc(100vw - 16px)}.settings-panel{width:calc(100vw - 16px)}}'
  ].join('\n');

  const make = (tag, className = '', text = '') => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  };

  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'launcher';
  launcher.setAttribute('aria-label', 'Translate tools');
  launcher.setAttribute('aria-expanded', 'false');
  if (translateSymbolDataUrl) {
    const logo = document.createElement('img');
    logo.alt = '';
    logo.src = translateSymbolDataUrl;
    launcher.append(logo);
  } else {
    launcher.append(make('span', 'fallback-mark', 'TS'));
  }

  const panel = make('section', 'panel');
  panel.hidden = true;

  const head = make('div', 'head');
  const headCopy = make('div');
  headCopy.append(make('b', '', 'Harvest Translate'), make('span', '', 'HarvestTS → Harvest → Local Model'));
  const startButton = make('button', 'start head-start', 'Start');
  startButton.type = 'button';
  const closeButton = make('button', 'close', '✕');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'ปิด');
  const headActions = make('div', 'head-actions');
  headActions.append(startButton, closeButton);
  head.append(headCopy, headActions);

  const body = make('div', 'body');
  const modelState = make('div', 'model', 'โมเดล: ยังไม่ได้ทดสอบ');

  const overall = make('div', 'overall');
  const statusState = make('div', 'status', 'พร้อมเริ่ม • จะสแกนเฉพาะภาพที่เข้าเกณฑ์หน้ามังงะ');
  const overallLine = make('div', 'overallline');
  overallLine.append(make('div', 'overallbar'));
  overall.append(statusState, overallLine);

  const pagesState = make('div', 'pages');
  pagesState.append(make('div', 'empty', 'กด Start แล้วรายการหน้ามังงะจะขึ้นตรงนี้'));

  const actions = make('div', 'actions');
  const labButton = make('button', 'small-action', 'เปิด OCR Lab • ตรวจข้อความและตำแหน่ง');
  labButton.type = 'button';
  labButton.addEventListener('click', () => ipcRenderer.invoke('harvest-guest:ocr-lab').catch(error => { statusState.textContent = error.message; }));
  actions.append(labButton);

  const note = make('div', 'note', 'ทดสอบโมเดลตรงที่ http://127.0.0.1:1234 • Harvest และ OCR พร้อมใช้งาน');
  body.append(modelState, overall, pagesState, actions, note);
  panel.append(head, body);

  const quickMenu = make('div', 'quickmenu');
  quickMenu.hidden = true;
  const makeToolButton = (iconText, caption, aria) => {
    const button = make('button', 'toolbtn');
    button.type = 'button';
    button.setAttribute('aria-label', aria);
    button.append(make('span', 'toolicon', iconText), make('span', 'toolcaption', caption));
    return button;
  };
  const backendTool = makeToolButton('☰', 'แปลหลังบ้าน', 'Harvest translate');
  backendTool.classList.add('backend-tool');
  const screenTool = makeToolButton('▣', 'แปลหน้าจอ', 'Screen Lens');
  screenTool.classList.add('screen-tool');
  const settingsTool = makeToolButton('⚙', 'ตั้งค่า', 'Translate settings');
  settingsTool.classList.add('settings-tool');
  quickMenu.append(backendTool, screenTool, settingsTool);

  const settingsPanel = make('section', 'panel settings-panel');
  settingsPanel.hidden = true;
  const settingsHead = make('div', 'head');
  const settingsHeadCopy = make('div');
  settingsHeadCopy.append(make('b', '', 'Translate Settings'), make('span', '', 'รูปแบบการแปลและการแสดงผล'));
  const settingsClose = make('button', 'close', '✕');
  settingsClose.type = 'button';
  settingsClose.setAttribute('aria-label', 'ปิด');
  settingsHead.append(settingsHeadCopy, settingsClose);

  const settingsBody = make('div', 'settings-body');
  const enableWheelScroll = scroller => scroller.addEventListener('wheel', event => {
    if (event.ctrlKey) return;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (!max) return;
    const unit = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? Math.max(1, scroller.clientHeight) : 1;
    const before = scroller.scrollTop;
    scroller.scrollTop = Math.max(0, Math.min(max, before + event.deltaY * unit));
    if (scroller.scrollTop !== before || (event.deltaY < 0 && before > 0) || (event.deltaY > 0 && before < max)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { passive:false });
  enableWheelScroll(body);
  enableWheelScroll(settingsBody);

  const engineSetting = make('div', 'setting');
  engineSetting.append(make('div', 'setting-title', 'Mode'));
  const engineSeg = make('div', 'seg');
  const aiEngine = make('button', 'segbtn', 'AI');
  aiEngine.type = 'button';
  aiEngine.dataset.value = 'ai';
  const googleEngine = make('button', 'segbtn', 'Google Translate');
  googleEngine.type = 'button';
  googleEngine.dataset.value = 'google';
  engineSeg.append(aiEngine, googleEngine);
  engineSetting.append(engineSeg);

  const languageSetting = make('div', 'setting');
  languageSetting.append(make('div', 'setting-title', 'Language'));
  const langRow = make('div', 'langrow');
  const sourceSelect = document.createElement('select');
  const targetSelect = document.createElement('select');
  const sourceLanguages = [
    ['auto','ตรวจอัตโนมัติ'],['th','ไทย'],['en','English'],['ja','日本語'],
    ['fr','Français'],['ko','한국어'],['zh','中文']
  ];
  const targetLanguages = [
    ['th','ไทย'],['en','English'],['ja','日本語'],['fr','Français'],['ko','한국어'],['zh','中文']
  ];
  const fillSelect = (select, rows) => {
    for (const [value, label] of rows) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
  };
  fillSelect(sourceSelect, sourceLanguages);
  fillSelect(targetSelect, targetLanguages);
  langRow.append(sourceSelect, make('div', 'arrow', '→'), targetSelect);
  languageSetting.append(make('div', 'setting-label', 'ต้นฉบับ → ภาษาที่ต้องการแปล'), langRow);

  const typeSetting = make('div', 'setting');
  typeSetting.append(make('div', 'setting-title', 'Type'));
  const typeSeg = make('div', 'seg');
  const mangaType = make('button', 'segbtn', 'Manga');
  mangaType.type = 'button';
  mangaType.dataset.value = 'manga';
  const novelType = make('button', 'segbtn', 'Novel');
  novelType.type = 'button';
  novelType.dataset.value = 'novel';
  typeSeg.append(mangaType, novelType);
  typeSetting.append(typeSeg);

  const scaleSetting = make('div', 'setting');
  scaleSetting.append(make('div', 'setting-title', 'Scale'));
  const scaleLabel = make('div', 'setting-label', 'Font size');
  const rangeRow = make('div', 'range-row');
  const fontScale = document.createElement('input');
  fontScale.type = 'range';
  fontScale.min = '70';
  fontScale.max = '180';
  fontScale.step = '5';
  const rangeValue = make('div', 'range-value', '100%');
  rangeRow.append(fontScale, rangeValue);
  scaleSetting.append(scaleLabel, rangeRow);

  const viewSetting = make('div', 'setting');
  viewSetting.append(make('div', 'setting-title', 'View'));
  const viewSeg = make('div', 'seg');
  const translatedView = make('button', 'segbtn', 'คำแปล');
  translatedView.type = 'button';
  translatedView.dataset.value = 'translated';
  const originalView = make('button', 'segbtn', 'ดูต้นฉบับ');
  originalView.type = 'button';
  originalView.dataset.value = 'original';
  viewSeg.append(translatedView, originalView);
  viewSetting.append(make('div', 'setting-label', 'สลับภาพที่แสดงโดยไม่ต้องแปลใหม่'), viewSeg);

  const lensStatus = make('div', 'lens-status', 'Screen Lens: ปิด');
  const privacy = make('div', 'privacy', 'Screen Lens จับเฉพาะภาพที่มองเห็นอยู่ในแท็บ HarvestTS ของ ImageHarvest เท่านั้น และเก็บเฟรมล่าสุดไว้ในหน่วยความจำ ไม่บันทึกลงดิสก์');

  const settingsLabButton = make('button', 'small-action', 'เปิด OCR Lab • ตรวจข้อความและตำแหน่ง');
  settingsLabButton.type = 'button';
  settingsLabButton.addEventListener('click', () => ipcRenderer.invoke('harvest-guest:ocr-lab').catch(error => { lensStatus.textContent = error.message; }));
  settingsBody.append(engineSetting, languageSetting, typeSetting, scaleSetting, viewSetting, lensStatus, privacy, settingsLabButton);
  settingsPanel.append(settingsHead, settingsBody);

  translationShadow.append(style, quickMenu, launcher, panel, settingsPanel);
  document.documentElement.append(translationHost);

  ipcRenderer.invoke('harvest-guest:translate-symbol').then(value => {
    if (!value || !translationHost?.isConnected) return;
    translateSymbolDataUrl = value;
    const logo = document.createElement('img');
    logo.alt = '';
    logo.src = value;
    launcher.replaceChildren(logo);
  }).catch(() => {});

  const $ = selector => translationShadow.querySelector(selector);
  const start = $('.start');
  const close = $('.close');

  let launcherAnchor = null;
  let uiScale = 1;
  function updateLauncherScale() {
    uiScale = Math.min(1.12, Math.max(.82, Math.min(innerWidth / 900, innerHeight / 700)));
    uiScale = Math.min(uiScale, Math.max(.1, (Math.min(innerWidth, innerHeight) - 16) / 180));
    const size = 54 * uiScale;
    translationHost.style.width = size + 'px';
    translationHost.style.height = size + 'px';
    for (const [name, value] of Object.entries({
      'launcher-size':size, 'tool-size':48 * uiScale, 'icon-size':18 * uiScale,
      'icon-row':22 * uiScale, 'caption-row':11 * uiScale, 'caption-size':8 * uiScale
    })) translationHost.style.setProperty('--' + name, value + 'px');
  }
  function clampLauncher(left, top) {
    const size = 54 * uiScale, pad = 8;
    return {
      left: Math.max(pad, Math.min(innerWidth - size - pad, left)),
      top: Math.max(pad, Math.min(innerHeight - size - pad, top))
    };
  }
  function rememberLauncherAnchor() {
    const r = translationHost.getBoundingClientRect();
    launcherAnchor = {
      x:(r.left - 8) / Math.max(1, innerWidth - r.width - 16),
      y:(r.top - 8) / Math.max(1, innerHeight - r.height - 16)
    };
  }
  updateLauncherScale();
  function positionSurface(surface, widthGuess = 348) {
    if (!surface || surface.hidden) return;
    const r = translationHost.getBoundingClientRect();
    const pad = 8, gap = 12;
    surface.style.width = Math.min(widthGuess, Math.max(0, innerWidth - pad * 2)) + 'px';
    surface.style.maxHeight = Math.max(0, innerHeight - pad * 2) + 'px';
    surface.style.right = 'auto';
    surface.style.bottom = 'auto';
    const { width, height } = surface.getBoundingClientRect();
    // Prefer above/below the launcher, then use a side when it fits better.
    const candidates = [
      { left:r.right - width, top:r.top - gap - height },
      { left:r.right - width, top:r.bottom + gap },
      { left:r.left - gap - width, top:r.bottom - height },
      { left:r.right + gap, top:r.bottom - height }
    ];
    const fits = p => p.left >= pad && p.top >= pad &&
      p.left + width <= innerWidth - pad && p.top + height <= innerHeight - pad;
    const overflow = p => Math.max(0, pad - p.left) + Math.max(0, pad - p.top) +
      Math.max(0, p.left + width - innerWidth + pad) + Math.max(0, p.top + height - innerHeight + pad);
    const chosen = candidates.find(fits) || candidates.reduce((best, p) => overflow(p) < overflow(best) ? p : best);
    const left = Math.max(pad, Math.min(innerWidth - pad - width, chosen.left));
    const top = Math.max(pad, Math.min(innerHeight - pad - height, chosen.top));
    surface.style.left = (left - r.left) + 'px';
    surface.style.top = (top - r.top) + 'px';
  }
  function positionQuickMenu() {
    if (quickMenu.hidden) return;
    const r = translationHost.getBoundingClientRect();
    const size = 48 * uiScale, radius = 84 * uiScale, pad = 8;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // Aim into the available viewport; score the whole fan instead of moving its anchor.
    const ideal = Math.atan2(innerHeight / 2 - cy, innerWidth / 2 - cx);
    let best;
    for (let step = 0; step < 72; step++) {
      const angle = ideal + step * Math.PI / 36;
      const points = [-Math.PI / 4, 0, Math.PI / 4].map(offset => ({
        x:cx + Math.cos(angle + offset) * radius - size / 2,
        y:cy + Math.sin(angle + offset) * radius - size / 2
      }));
      const overflow = points.reduce((sum, p) => sum + Math.max(0, pad - p.x) +
        Math.max(0, pad - p.y) + Math.max(0, p.x + size - innerWidth + pad) +
        Math.max(0, p.y + size - innerHeight + pad), 0);
      const deviation = Math.abs(Math.atan2(Math.sin(angle - ideal), Math.cos(angle - ideal)));
      const score = overflow * 1000 + deviation;
      if (!best || score < best.score) best = { points, score };
    }
    [backendTool, screenTool, settingsTool].forEach((button, index) => {
      const p = best.points[index];
      button.style.left = (p.x - r.left) + 'px';
      button.style.top = (p.y - r.top) + 'px';
      button.style.setProperty('--from-x', (cx - size / 2 - p.x) + 'px');
      button.style.setProperty('--from-y', (cy - size / 2 - p.y) + 'px');
      button.style.setProperty('--delay', (index * 30) + 'ms');
    });
  }
  function positionAll() {
    positionQuickMenu();
    positionSurface(panel, 348);
    positionSurface(settingsPanel, 324);
  }
  function toggleQuickMenu(force) {
    launcherMenuOpen = typeof force === 'boolean' ? force : !launcherMenuOpen;
    quickMenu.hidden = !launcherMenuOpen;
    launcher.setAttribute('aria-expanded', String(launcherMenuOpen));
    quickMenu.classList.toggle('opening', launcherMenuOpen);
    if (launcherMenuOpen) positionQuickMenu();
  }
  quickMenu.addEventListener('animationend', event => {
    if (event.target === settingsTool) quickMenu.classList.remove('opening');
  });
  function openTranslatePanel() {
    settingsPanel.hidden = true;
    panel.hidden = false;
    toggleQuickMenu(false);
    positionSurface(panel, 348);
  }
  function openSettingsPanel() {
    panel.hidden = true;
    settingsPanel.hidden = false;
    toggleQuickMenu(false);
    positionSurface(settingsPanel, 324);
  }
  function closePanels() {
    panel.hidden = true;
    settingsPanel.hidden = true;
  }
  function renderSettings() {
    aiEngine.classList.toggle('active', translateSettings.engine === 'ai');
    googleEngine.classList.toggle('active', translateSettings.engine === 'google');
    mangaType.classList.toggle('active', translateSettings.contentType === 'manga');
    novelType.classList.toggle('active', translateSettings.contentType === 'novel');
    translatedView.classList.toggle('active', !translateSettings.showOriginal);
    originalView.classList.toggle('active', Boolean(translateSettings.showOriginal));
    sourceSelect.value = translateSettings.sourceLanguage || 'auto';
    targetSelect.value = translateSettings.targetLanguage || 'th';
    const scale = Math.round((Number(translateSettings.fontScale) || 1) * 100);
    fontScale.value = String(scale);
    rangeValue.textContent = scale + '%';
    positionAll();
  }
  function renderLensStatus() {
    screenTool.classList.toggle('active', Boolean(screenLensState.enabled));
    lensStatus.classList.toggle('on', Boolean(screenLensState.enabled));
    if (screenLensState.enabled) {
      const size = screenLensState.width && screenLensState.height ? ` • ${screenLensState.width}×${screenLensState.height}` : '';
      const frames = Number(screenLensState.frames) || 0;
      lensStatus.textContent = screenLensState.error
        ? 'Screen Lens: มีปัญหา • ' + screenLensState.error
        : `Screen Lens: กำลังจับภาพ • ${frames} เฟรม${size}`;
    } else {
      lensStatus.textContent = 'Screen Lens: ปิด';
    }
  }
  async function saveSettings(patch) {
    try {
      translateSettings = await ipcRenderer.invoke('harvest-guest:translate-settings-update', patch);
      renderSettings();
      return translateSettings;
    } catch { return null; }
  }

  close.addEventListener('click', () => { panel.hidden = true; });
  settingsClose.addEventListener('click', () => { settingsPanel.hidden = true; });
  backendTool.addEventListener('click', openTranslatePanel);
  settingsTool.addEventListener('click', openSettingsPanel);
  screenTool.addEventListener('click', async () => {
    screenTool.style.opacity = '.55';
    try {
      screenLensState = await ipcRenderer.invoke('harvest-guest:screen-lens-toggle', { enabled:!screenLensState.enabled });
      renderLensStatus();
    } catch (error) {
      screenLensState = { ...screenLensState, error:error?.message || String(error) };
      renderLensStatus();
    } finally {
      screenTool.style.opacity = '1';
    }
  });

  for (const button of [aiEngine, googleEngine]) {
    button.addEventListener('click', () => saveSettings({ engine:button.dataset.value }));
  }
  for (const button of [mangaType, novelType]) {
    button.addEventListener('click', () => saveSettings({ contentType:button.dataset.value }));
  }
  translatedView.addEventListener('click', () => saveSettings({ showOriginal:false }));
  originalView.addEventListener('click', () => saveSettings({ showOriginal:true }));
  sourceSelect.addEventListener('change', () => saveSettings({ sourceLanguage:sourceSelect.value }));
  targetSelect.addEventListener('change', () => saveSettings({ targetLanguage:targetSelect.value }));
  fontScale.addEventListener('input', () => { rangeValue.textContent = fontScale.value + '%'; });
  fontScale.addEventListener('change', () => saveSettings({ fontScale:Number(fontScale.value) / 100 }));

  ipcRenderer.invoke('harvest-guest:translate-settings-get').then(value => {
    if (value) translateSettings = value;
    renderSettings();
  }).catch(() => renderSettings());
  ipcRenderer.invoke('harvest-guest:screen-lens-status').then(value => {
    if (value) screenLensState = value;
    renderLensStatus();
  }).catch(() => renderLensStatus());

  translationShadow.__renderLensStatus = renderLensStatus;
  translationShadow.__renderSettings = renderSettings;

  let drag = null;
  launcher.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const r = translationHost.getBoundingClientRect();
    drag = { id:event.pointerId, x:event.clientX, y:event.clientY, left:r.left, top:r.top, moved:false };
    launcher.setPointerCapture?.(event.pointerId);
  });
  launcher.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    quickMenu.classList.remove('opening');
    const next = clampLauncher(drag.left + dx, drag.top + dy);
    Object.assign(translationHost.style, { left:next.left + 'px', top:next.top + 'px', right:'auto', bottom:'auto' });
    rememberLauncherAnchor();
    positionAll();
  });
  launcher.addEventListener('pointerup', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) {
      closePanels();
      toggleQuickMenu();
    }
  });
  launcher.addEventListener('pointercancel', () => { drag = null; });

  addEventListener('resize', () => {
    if (!translationHost?.isConnected) return;
    updateLauncherScale();
    if (launcherAnchor) {
      const next = clampLauncher(8 + launcherAnchor.x * Math.max(0, innerWidth - 54 * uiScale - 16),
        8 + launcherAnchor.y * Math.max(0, innerHeight - 54 * uiScale - 16));
      Object.assign(translationHost.style, { left:next.left + 'px', top:next.top + 'px' });
    }
    quickMenu.classList.remove('opening');
    positionAll();
  });

  start.addEventListener('click', async () => {
    if (translationRunning) {
      start.disabled = true;
      start.textContent = 'กำลังหยุด…';
      try { await ipcRenderer.invoke('harvest-guest:translation-cancel'); }
      catch {}
      finally {
        translationRunning = false;
        start.disabled = false;
        start.textContent = 'Start ใหม่';
        launcher.classList.remove('running');
      }
      return;
    }
    // Starting a fresh translation should always reveal the translated view.
    // A stale "ดูต้นฉบับ" preference from inspection must not make a completed
    // job look empty even though translations were produced successfully.
    if (translateSettings.showOriginal) await saveSettings({ showOriginal:false });
    translationRunning = true;
    translationPages = [];
    translationScanProgress = 0;
    launcher.classList.add('running');
    start.textContent = 'Stop';
    renderTranslationPanel();
    try {
      await ipcRenderer.invoke('harvest-guest:translation-start');
    } catch (error) {
      if (translationRunning) {
        translationRunning = false;
        launcher.classList.remove('running');
        start.textContent = 'Start ใหม่';
        $('.status').textContent = error?.message || String(error);
      }
    }
  });

  function renderTranslationPanel() {
    const model = $('.model');
    model.textContent = translationModelText;
    const overall = $('.overallbar');
    overall.style.width = Math.round(Math.max(0, Math.min(1, translationScanProgress)) * 100) + '%';
    const pages = $('.pages');
    if (!translationPages.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'กำลังรอ Harvest ตรวจพบหน้ามังงะ…';
      pages.replaceChildren(empty);
      return;
    }
    pages.replaceChildren(...translationPages.map((page, index) => {
      const box = document.createElement('div');
      box.className = 'page' + (page.error ? ' error' : page.progress >= 1 ? ' ready' : '');
      const num = document.createElement('div');
      num.className = 'num';
      num.textContent = String(index + 1).padStart(2, '0');
      const copy = document.createElement('div');
      copy.className = 'copy';
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = page.label || ('หน้า ' + (index + 1));
      const state = document.createElement('span');
      state.className = 'state';
      state.textContent = page.status || 'รอ';
      const line = document.createElement('div');
      line.className = 'barline';
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.width = Math.round(Math.max(0, Math.min(1, Number(page.progress) || 0)) * 100) + '%';
      row.append(label, state);
      line.append(bar);
      copy.append(row, line);
      box.append(num, copy);
      return box;
    }));
  }
  translationShadow.__renderTranslationPanel = renderTranslationPanel;
}

function handleTranslationProgress(payload = {}) {
  ensureTranslationLauncher();
  const $ = selector => translationShadow.querySelector(selector);
  const render = translationShadow.__renderTranslationPanel || (() => {});
  const start = $('.start');
  const status = $('.status');

  const lock=document.getElementById('__harvestts_reader_lock__');
  const lockStatus=lock?.shadowRoot?.querySelector('[data-status]');
  if(lockStatus&&(payload.message||payload.status))lockStatus.textContent='ล็อกหน้าอ่าน • '+(payload.message||payload.status);
  if (payload.type === 'job-start') {
    translationJobId=payload.jobId;
    translationRunning = true;
    translationPages = [];
    translationScanProgress = 0;
    status.textContent = payload.message || 'กำลังเริ่ม…';
    start.textContent = 'Stop';
  } else if (payload.type === 'model') {
    if (payload.ok === true) {
      translationModelText = payload.message || ('โมเดลพร้อม: ' + (payload.model || 'ไม่ทราบชื่อ') + (payload.sample ? ' • test: ' + payload.sample : ''));
      $('.model').className = 'model ok';
    } else if (payload.ok === false) {
      translationModelText = 'โมเดลยังไม่พร้อม: ' + (payload.error || payload.message || 'เชื่อมต่อไม่ได้');
      $('.model').className = 'model bad';
    } else {
      translationModelText = payload.message || 'กำลังเชื่อมโมเดล…';
      $('.model').className = 'model';
    }
  } else if (payload.type === 'scan') {
    translationScanProgress = 0.04 + 0.20 * Math.max(0, Math.min(1, Number(payload.progress) || 0));
    status.textContent = payload.message || 'กำลังสแกน…';
  } else if (payload.type === 'pages') {
    translationScanProgress = 0.26;
    translationPages = (payload.pages || []).map(x => ({ ...x, progress:0, status:'รอเตรียมภาพ' }));
    status.textContent = payload.message || ('พบ ' + translationPages.length + ' หน้า');
  } else if (payload.type === 'stage') {
    translationScanProgress = Math.max(0, Math.min(1, Number(payload.progress) || translationScanProgress));
    status.textContent = payload.message || status.textContent;
  } else if (payload.type === 'page') {
    const index = Number(payload.index);
    if (translationPages[index]) {
      translationPages[index].progress = Number(payload.progress) || 0;
      translationPages[index].status = payload.status || translationPages[index].status;
      translationPages[index].error = Boolean(payload.error);
    }
  } else if (payload.type === 'complete') {
    translationRunning = false;
    translationScanProgress = 1;
    status.textContent = payload.message || 'OCR พร้อม';
    start.textContent = 'Start';
    translationHost && translationShadow.querySelector('.launcher')?.classList.remove('running');
    const unresolved = Number(payload.translationFailed) > 0 || translationPages.some(page => page.error);
    const translatePanel = translationShadow.querySelector('.panel:not(.settings-panel)');
    // Successful jobs collapse like before. If anything is still red after
    // automatic retries, keep the panel visible so the failure cannot vanish.
    if (translatePanel) translatePanel.hidden = !unresolved;
    const launcher = translationShadow.querySelector('.launcher');
    if (launcher) {
      launcher.dataset.hasErrors = unresolved ? 'true' : 'false';
      launcher.title = unresolved ? 'แปลเสร็จแล้ว • ยังมีบางจุดที่ไม่สำเร็จ กดเพื่อดูรายละเอียด' : 'แปลเสร็จแล้ว';
    }
  } else if (payload.type === 'cancelled') {
    translationRunning = false;
    status.textContent = 'หยุดการทำงานแล้ว';
    start.textContent = 'Start ใหม่';
    translationHost && translationShadow.querySelector('.launcher')?.classList.remove('running');
  } else if (payload.type === 'error') {
    translationRunning = false;
    status.textContent = payload.message || 'เกิดข้อผิดพลาด';
    start.textContent = 'Start ใหม่';
    translationHost && translationShadow.querySelector('.launcher')?.classList.remove('running');
  }
  render();
}

ipcRenderer.on('harvest-guest:translation-progress', (_event, payload) => handleTranslationProgress(payload));
ipcRenderer.on('harvest-guest:screen-lens-status', (_event, payload = {}) => {
  screenLensState = { ...screenLensState, ...payload };
  ensureTranslationLauncher();
  translationShadow?.__renderLensStatus?.();
});
window.addEventListener('DOMContentLoaded', ensureTranslationLauncher);
