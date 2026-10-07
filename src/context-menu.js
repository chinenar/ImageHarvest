'use strict';
const host=document.getElementById('menu'),errorBox=document.getElementById('error');
function showError(message){
  errorBox.textContent=message||'ทำรายการไม่สำเร็จ';
  errorBox.hidden=false;
  clearTimeout(showError.timer);
  showError.timer=setTimeout(()=>{errorBox.hidden=true},2200);
}
async function run(id){
  try{
    const result=await window.harvestContext.action(id);
    if(result?.ok===false) throw new Error(result.error||'ทำรายการไม่สำเร็จ');
  }catch(error){showError(error?.message||String(error))}
}
function render(model){
  const fragment=document.createDocumentFragment();
  for(const row of model?.items||[]){
    if(row.type==='separator'){
      const sep=document.createElement('div');sep.className='separator';sep.setAttribute('role','separator');fragment.append(sep);continue;
    }
    if(row.type==='section'){
      const sec=document.createElement('div');sec.className='section';sec.textContent=row.label||'';fragment.append(sec);continue;
    }
    const button=document.createElement('button');
    button.className='item'+(row.accent?' accent':'')+(row.danger?' danger':'');
    button.type='button';button.disabled=Boolean(row.disabled);button.dataset.id=row.id||'';
    button.setAttribute('role','menuitem');
    const label=document.createElement('span');label.className='label';label.textContent=row.label||'';
    button.append(label);
    if(row.shortcut){const shortcut=document.createElement('span');shortcut.className='shortcut';shortcut.textContent=row.shortcut;button.append(shortcut)}
    if(row.title)button.title=row.title;
    button.addEventListener('click',()=>run(row.id));
    fragment.append(button);
  }
  host.replaceChildren(fragment);
  requestAnimationFrame(()=>host.querySelector('.item:not(:disabled)')?.focus({preventScroll:true}));
}
document.addEventListener('keydown',event=>{
  const items=[...host.querySelectorAll('.item:not(:disabled)')];
  const index=Math.max(0,items.indexOf(document.activeElement));
  if(event.key==='Escape'){event.preventDefault();window.harvestContext.close();return}
  if(event.key==='ArrowDown'){event.preventDefault();items[(index+1)%items.length]?.focus();return}
  if(event.key==='ArrowUp'){event.preventDefault();items[(index-1+items.length)%items.length]?.focus();return}
});
window.harvestContext.model().then(render).catch(error=>showError(error?.message||String(error)));
