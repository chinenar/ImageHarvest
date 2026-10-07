'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../src/content-filter.js');
const base = {mainKind:'main',displayWidth:48,displayHeight:48};
test('large intrinsic Google login icon is classified using rendered control context',()=>{
 assert.equal(f.classify({...base,url:'https://fixture.test/images/sns/google.svg',alt:'google authen',width:800,height:800,control:true}).category,'icon');
});
test('payment service names are contextual, not a ban on SVG or brands in book content',()=>{
 for(const name of ['visa-white-X.svg','mastercard-dark-X.svg','amex-X.svg']) assert.equal(f.classify({...base,url:'https://fixture.test/assets/'+name}).chrome,true);
 assert.equal(f.classify({url:'https://fixture.test/page.svg',alt:'Page 1',displayWidth:600,displayHeight:800}).chrome,false);
 assert.equal(f.classify({url:'https://fixture.test/google-story.jpg',alt:'Google story',displayWidth:600,displayHeight:800}).chrome,false);
});
test('banner plus outbound-link evidence hides advertisements even inside main',()=>{
 assert.equal(f.classify({...base,url:'https://fixture.test/random.gif',alt:'Banner 3',externalLink:true}).category,'ad');
 assert.equal(f.classify({...base,url:'https://fixture.test/unknown.png',sponsored:true}).category,'ad');
});
test('wide images, foreign CDNs, and external links alone are never ad evidence',()=>{
 for(const externalLink of [false,true]) assert.equal(f.classify({url:'https://ads.test/content/01.png?banner=true',alt:'Page 1',externalLink,width:1500,height:100}).chrome,false);
 assert.equal(f.classify({url:'https://fixture.test/banner-art.jpg',alt:'Book illustration'}).chrome,false);
});
test('known placeholder resources differ from genuine blank pages and bonus artwork',()=>{
 for(const file of ['img_loading_dummy-123.png','spinner-sunny.svg','placeholder.png','preview-end-123.png']) assert.equal(f.classify({url:'https://fixture.test/assets/'+file}).placeholder,true);
 assert.equal(f.classify({...base,url:'https://fixture.test/label_benefit-x.svg'}).category,'icon');
 for(const file of ['p-019.jpg','purchase_bonus.jpeg','chapter-placeholder-01.png']) assert.equal(f.classify({url:'https://fixture.test/'+file}).chrome,false);
});
test('small book preview, sparse pages and short end strips remain content',()=>{
 for(const [width,height] of [[157,224],[1500,80],[80,12000]]) {
  const item={width,height,source:'img',filterHints:f.classify({mainKind:'reader'})};
  assert.equal(f.matches(item,{hideChrome:true,mainOnly:true,mainScope:'reader'}),true);
 }
});
test('white gray and transparent samples are marked only as an opt-in blank candidate',()=>{
 for(const pixel of [[255,255,255,255],[205,205,205,255],[0,0,0,0]]) {
  const hints=f.inspectPixels(Uint8ClampedArray.from(Array(64).fill(pixel).flat())); assert.equal(hints.blank,true);
  const item={pixelHints:hints}; assert.equal(f.matches(item),true); assert.equal(f.matches(item,{hideBlank:true}),false);
 }
});
test('a single dark or faint mark preserves sparse content; malformed pixels fail open',()=>{
 for(const value of [0,245]) {const p=new Uint8ClampedArray(32*32*4).fill(255); p[100]=value; assert.equal(f.inspectPixels(p).blank,false);}
 assert.equal(f.inspectPixels(null).blank,false); assert.equal(f.inspectPixels([1]).unknown,true);
});
test('unknown scopes retain uncertain images, and explicit filter switches restore everything',()=>{
 const content={filterHints:f.classify({url:'https://fixture.test/chapter.png'})};
 assert.equal(f.matches(content,{mainOnly:true,mainScope:'unknown'}),true);
 const ad={filterHints:f.classify({adRegion:true})}; assert.equal(f.matches(ad,{hideChrome:true}),false); assert.equal(f.matches(ad),true);
});
