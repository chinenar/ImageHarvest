'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),asar=require('@electron/asar');
const installed=path.join(process.env.LOCALAPPDATA,'Programs/ImageHarvest'),archive=process.argv.includes('--packaged')?path.resolve('installer-dist/win-unpacked/resources/app.asar'):path.join(installed,'resources/app.asar');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex'),checked=[];
function inspect(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory()){if(entry.name!=='__pycache__')inspect(file);continue;}if(!/\.(?:cjs|js|py|css|html)$/.test(file))continue;const relative=path.relative(process.cwd(),file),source=fs.readFileSync(file),actual=asar.extractFile(archive,path.normalize(relative));if(!source.equals(actual))throw Error('ASAR differs: '+relative);checked.push({file:relative,sha256:digest(source)});}}
inspect(path.resolve('src'));
const version=JSON.parse(asar.extractFile(archive,'package.json')).version;if(version!==require('../package.json').version)throw Error('Version mismatch');
const installer=path.resolve('installer-dist/ImageHarvest-Setup-'+version+'.exe'),installerBuffer=fs.readFileSync(installer);
const result={version,archive,checked,installer:{path:installer,bytes:installerBuffer.length,sha256:digest(installerBuffer)},verifiedAt:new Date().toISOString()};
fs.mkdirSync('test-results/ocr-speed',{recursive:true});fs.writeFileSync('test-results/ocr-speed/'+(process.argv.includes('--packaged')?'packaged':'install')+'-verification.json',JSON.stringify(result,null,2));console.log('PASS: '+checked.length+' source files match '+archive+'; v'+version);
