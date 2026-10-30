'use strict';
const fs=require('node:fs/promises');
const {randomUUID}=require('node:crypto');
// Workers share a content-addressed directory. Never truncate a module that
// another Python process may be importing while a second worker starts.
async function materializeWorkerFile(file,bytes){
 const expected=Buffer.from(bytes);
 const matches=async()=>{try{return (await fs.readFile(file)).equals(expected);}catch(error){if(error.code==='ENOENT')return false;throw error;}};
 if(await matches())return;
 const temp=file+'.'+process.pid+'.'+randomUUID()+'.tmp';
 try{
  await fs.writeFile(temp,expected,{flag:'wx'});
  try{await fs.rename(temp,file);}catch(error){if(!await matches())throw error;}
 }finally{await fs.rm(temp,{force:true});}
}
module.exports={materializeWorkerFile};
