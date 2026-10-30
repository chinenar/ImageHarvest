'use strict';
const sharp = require('sharp');

// A recognizer often reads the stem and dot of "!" as two bullets. Only
// recover this mark when its two actual ink components support that shape.
async function exclamationMark(image) {
  const {data, info} = await sharp(image).flatten({background:'#fff'}).resize(180,180,{fit:'inside',withoutEnlargement:true}).greyscale().raw().toBuffer({resolveWithObject:true});
  const {width:w,height:h}=info, visited=new Uint8Array(w*h),components=[];
  for(let p=0;p<data.length;p++){
    if(visited[p]||data[p]>100)continue;
    const queue=[p];visited[p]=1;let minX=w,minY=h,maxX=0,maxY=0;
    for(let i=0;i<queue.length;i++){
      const at=queue[i],x=at%w,y=Math.floor(at/w);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]){
        const nx=x+dx,ny=y+dy,n=ny*w+nx;
        if(nx<0||nx>=w||ny<0||ny>=h||visited[n]||data[n]>100)continue;
        visited[n]=1;queue.push(n);
      }
    }
    if(queue.length>=5)components.push({x:minX,y:minY,w:maxX-minX+1,h:maxY-minY+1,size:queue.length});
  }
  const meaningful=components.filter(c=>c.size>=Math.max(5,w*h*.0015)).sort((a,b)=>a.y-b.y);
  if(meaningful.length!==2)return false;
  const [stem,dot]=meaningful,gap=dot.y-stem.y-stem.h;
  return stem.h>=stem.w*2.2&&stem.h>=dot.h*2.3&&dot.w/dot.h>=.5&&dot.w/dot.h<=2&&gap>=0&&gap<=dot.h*3&&Math.abs(stem.x+stem.w/2-dot.x-dot.w/2)<=Math.max(stem.w,dot.w)*.65;
}
module.exports={exclamationMark};
