'use strict';
// Keep all observations for review, but identical inference is one vote.
function distinctReadings(readings=[]){
 const seen=new Set();
 return readings.filter(read=>{
  if(!read.inferenceFingerprint)return true; // Older observations have no pixel identity.
  const key=read.engine+':'+read.inferenceFingerprint;
  if(seen.has(key))return false;
  seen.add(key);return true;
 });
}
module.exports={distinctReadings};
