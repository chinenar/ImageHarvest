'use strict';
class OcrResultCache {
  constructor({maxBytes=32*1024*1024,maxEntries=12}={}){this.maxBytes=maxBytes;this.maxEntries=maxEntries;this.entries=new Map();this.bytes=0;}
  get(key){const entry=this.entries.get(key);if(!entry)return null;this.entries.delete(key);this.entries.set(key,entry);return structuredClone(entry.value);}
  set(key,value){const bytes=Buffer.byteLength(JSON.stringify(value));if(bytes>this.maxBytes)return;const old=this.entries.get(key);if(old){this.bytes-=old.bytes;this.entries.delete(key);}this.entries.set(key,{value:structuredClone(value),bytes});this.bytes+=bytes;while(this.bytes>this.maxBytes||this.entries.size>this.maxEntries){const oldest=this.entries.keys().next().value;this.bytes-=this.entries.get(oldest).bytes;this.entries.delete(oldest);}}
  clear(){this.entries.clear();this.bytes=0;}
}
module.exports={OcrResultCache};
