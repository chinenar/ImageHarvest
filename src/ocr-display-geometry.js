'use strict';
(function(root){
 function displayBoxes(row){
  const geometry=row.displayGeometry;
  return geometry?.signature===JSON.stringify([row.text,row.bbox])&&geometry.boxes?.length?geometry.boxes:[row.bbox];
 }
 function outline(row){
  const boxes=displayBoxes(row),ys=[...new Set(boxes.flatMap(b=>[b.y0,b.y1]))].sort((a,b)=>a-b),bands=[];
  for(let i=1;i<ys.length;i++){
   const y0=ys[i-1],y1=ys[i],mid=(y0+y1)/2;
   let active=boxes.filter(b=>b.y0<=mid&&b.y1>=mid);
   if(!active.length){
    const above=boxes.filter(b=>b.y1<=y0).sort((a,b)=>b.y1-a.y1)[0],below=boxes.filter(b=>b.y0>=y1).sort((a,b)=>a.y0-b.y0)[0];
    if(above&&below){const split=(y0+y1)/2;bands.push({...above,y0,y1:split},{...below,y0:split,y1});}continue;
   }
   bands.push({x0:Math.min(...active.map(b=>b.x0)),x1:Math.max(...active.map(b=>b.x1)),y0,y1});
  }
  return [...bands.flatMap(b=>[[b.x0,b.y0],[b.x0,b.y1]]),...bands.slice().reverse().flatMap(b=>[[b.x1,b.y1],[b.x1,b.y0]])];
 }
 function contains(row,x,y){
  const points=outline(row);let inside=false;
  for(let i=0,j=points.length-1;i<points.length;j=i++){
   const [xi,yi]=points[i],[xj,yj]=points[j];
   if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;
  }return inside;
 }
 const api={displayBoxes,outline,contains};
 if(typeof module==='object'&&module.exports)module.exports=api;
 else root.ocrDisplayGeometry=api;
})(typeof globalThis==='object'?globalThis:this);
