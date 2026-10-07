'use strict';
const { ChromeBrowser: StandardChrome } = require('./chrome-standard.cjs');
const { MinimalChrome } = require('./chrome-minimal.cjs');
class ChromeBrowser {
  constructor(notify=()=>{}, options={}) { this.notify=notify; this.options=options; this.controlMode='standard'; this.backend=new StandardChrome(notify,options); }
  async setControlMode(mode) {
    mode=mode==='minimal'?'minimal':'standard'; if(mode===this.controlMode)return false;
    const network=this.backend.networkMode, adblockEnabled=this.backend.adblockEnabled !== false;
    await this.backend.close(); this.controlMode=mode;
    this.options={...this.options,adblockEnabled};
    this.backend=mode==='minimal'?new MinimalChrome(this.notify,this.options):new StandardChrome(this.notify,this.options);
    await this.backend.setNetworkMode(network); return true;
  }
  async openLogin() {
    await this.setControlMode('minimal');
    return this.backend.open('https://accounts.google.com/');
  }
}
for(const key of ['context','page','cdp','profile','lastStatus','lastTitle','navigation','networkMode','userAgent'])
  Object.defineProperty(ChromeBrowser.prototype,key,{get(){return this.backend[key];}});
for(const method of ['alive','url','start','open','compatibilityInfo','observationInfo','loadedImage','settleImages','evaluate','evaluateMain','setNetworkMode','setAdblockEnabled','reloadAdblocker','show','title','fetchManual','close'])
  ChromeBrowser.prototype[method]=function(...args){return this.backend[method](...args);};
module.exports={ChromeBrowser};
