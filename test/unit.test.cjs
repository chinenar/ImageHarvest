'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pageURL, imageURL, safeName, imageType, orderItems, uniqueItems, renamePlan, chooseNextChapter, chooseNextAction, chapterIndexLink, nextFromChapterListing, chapterNumber, chapterParts, compareChapterParts, idFor, ByteCache } = require('../src/core.cjs');
test('normalizes plain domain; keeps http loopback for development', () => {
  assert.equal(pageURL('example.com/a'), 'https://example.com/a');
  assert.equal(pageURL('http://127.0.0.1:123/a'), 'http://127.0.0.1:123/a');
});
test('rejects privileged schemes and inline credentials', () => {
  for (const value of ['file:///C:/test', 'javascript:alert(1)', 'https://user:pass@example.com', '', 'data:text/html,x']) assert.throws(() => pageURL(value));
});
test('image URLs preserve signed query strings and resolve relative paths', () => {
  assert.equal(imageURL('../img.png?token=a%2Fb&v=1', 'https://example.com/ch/1'), 'https://example.com/img.png?token=a%2Fb&v=1');
  assert.equal(imageURL('file:///etc/passwd'), null);
  assert.equal(imageURL('data:text/html,x'), null);
  assert.ok(imageURL('data:image/png;base64,aGVsbG8='));
});
test('safe output names reject Windows path hazards and devices', () => {
  assert.equal(safeName('CON'), '_CON'); assert.equal(safeName('LPT1.txt'), '_LPT1.txt');
  assert.equal(safeName('ทดสอบ / test:*?'), 'ทดสอบ _ test___');
  assert.equal(safeName('..'), 'images'); assert.ok(safeName('../unsafe').includes('_'));
});
test('identifies real image bytes instead of trusting filename or MIME', () => {
  assert.equal(imageType(Buffer.from([137,80,78,71,13,10,26,10]), 'text/html').ext, 'png');
  assert.equal(imageType(Buffer.from('GIF89a')).ext, 'gif');
  assert.equal(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).ext, 'svg');
  assert.throws(() => imageType(Buffer.from('<html>access denied</html>'), 'image/png'));
});
test('visual, DOM and natural filename order are independent', () => {
  const rows = [{url:'https://a/10.png',top:1,left:5,order:0}, {url:'https://a/2.png',top:0,left:8,order:1}, {url:'https://a/1.png',top:0,left:1,order:2}];
  assert.deepEqual(orderItems(rows).map(x=>x.order), [2,1,0]);
  assert.deepEqual(orderItems(rows,'dom').map(x=>x.order), [0,1,2]);
  assert.deepEqual(orderItems(rows,'name').map(x=>x.order), [2,1,0]);
  assert.deepEqual(orderItems(rows,'right').map(x=>x.order), [1,2,0]);
});
test('deduplicates exact URLs only, preserving differing query strings', () => {
  const rows = [{url:'https://a/1?t=x'},{url:'https://a/1?t=x'},{url:'https://a/1?t=y'}];
  assert.equal(uniqueItems(rows).length,2);
  assert.notEqual(idFor(rows[0].url),idFor(rows[2].url));
});
test('bounded LRU cache accounts for replacement and eviction', () => {
  const c = new ByteCache(5); c.set('a',{buffer:Buffer.alloc(3)}); c.set('b',{buffer:Buffer.alloc(2)});
  c.get('a'); c.set('c',{buffer:Buffer.alloc(2)});
  assert.equal(c.get('b'), undefined); assert.ok(c.get('a')); assert.equal(c.bytes,5);
  c.set('a',{buffer:Buffer.alloc(1)}); assert.equal(c.bytes,3);
  c.set('z',{buffer:Buffer.alloc(10)}); assert.equal(c.bytes,3);
  c.clear(); assert.equal(c.bytes,0);
});

test('page rename plan uses natural order and can reverse it', () => {
  const files = ['10.jpg','2.png','1.webp','note.txt'];
  assert.deepEqual(renamePlan(files).map(x=>[x.from,x.to]), [['1.webp','0001.webp'],['2.png','0002.png'],['10.jpg','0003.jpg']]);
  assert.deepEqual(renamePlan(files,{reverse:true,start:5,padding:3}).map(x=>[x.from,x.to]), [['10.jpg','005.jpg'],['2.png','006.png'],['1.webp','007.webp']]);
});
test('chapter numbering accepts dotted and hyphenated subchapters', () => {
  assert.deepEqual(chapterParts('/series/chapter-1.1'), [1,1]);
  assert.deepEqual(chapterParts('/series/chapter-1.2'), [1,2]);
  assert.deepEqual(chapterParts('/series/chapter-1.10'), [1,10]);
  assert.deepEqual(chapterParts('/manga/title/ตอนที่-6-3/'), [6,3]);
  assert.equal(compareChapterParts([1,10],[1,9]), 1);
  assert.equal(compareChapterParts([2],[1,99]), 1);
  assert.equal(chapterNumber('/series/chapter-9.5'), 9.5);
  assert.equal(chapterNumber('ตอนที่ 12'), 12);
});
test('next chapter chooser prefers chapter navigation over next page', () => {
  const page = { title:'Series — Chapter 9', headings:['Chapter 9'], links:[
    { href:'/series/chapter-9?page=2', text:'Next Page', rel:'next' },
    { href:'/series/chapter-10', text:'Next Chapter', className:'chapter-next' },
    { href:'/series/chapter-8', text:'Previous Chapter', className:'chapter-prev' }
  ]};
  const next = chooseNextChapter('https://example.com/series/chapter-9', page);
  assert.equal(next.url, 'https://example.com/series/chapter-10');
  assert.ok(next.confidence >= 65);
});
test('next chapter chooser rejects a page-next-only reader', () => {
  const page = { title:'Reader — Chapter 9', headings:['Chapter 9'], links:[
    { href:'/series/chapter-9?page=2', text:'Next Page', rel:'next', className:'next-page' }
  ]};
  assert.equal(chooseNextChapter('https://example.com/series/chapter-9', page).url, '');
});
test('icon-only chapter navigation recognizes right UUID and rejects left UUID', () => {
  const current='https://example.com/chapter/11111111-1111-1111-1111-111111111111/1';
  const page={title:'Chapter 1',headings:['Chapter 1'],links:[
    {href:'/chapter/00000000-0000-0000-0000-000000000000',desc:'feather feather-chevron-left'},
    {href:'/chapter/22222222-2222-2222-2222-222222222222',desc:'feather feather-chevron-right'}
  ]};
  assert.equal(chooseNextChapter(current,page).url,'https://example.com/chapter/22222222-2222-2222-2222-222222222222');
});
test('disabled semantic next control is never selected', () => {
  assert.equal(chooseNextAction({controls:[{title:'Next chapter',disabled:true}]}),null);
});
test('series breadcrumb can provide a generic chapter-index fallback', () => {
  const page={title:'อ่านมังงะ Tale of a Scribe Who Retires to the Countryside ตอนที่ 163',links:[
    {href:'/manga/tale-of-a-scribe-who-retires-to-the-countryside/',text:'Tale of a Scribe Who Retires to the Countryside'}
  ]};
  assert.equal(chapterIndexLink('https://example.com/tale-of-a-scribe-who-retires-to-the-countryside-ตอนที่-163/',page).url,
    'https://example.com/manga/tale-of-a-scribe-who-retires-to-the-countryside/');
});
test('chapter dropdown chooses the nearest higher chapter and ignores numeric IDs', () => {
  const page = { title:'Series — Chapter 1.1', headings:['Chapter 1.1'], links:[], selects:[{
    label:'Chapter', selectedIndex:3, options:[
      { text:'Chapter 2', value:'/series/chapter-2', selected:false },
      { text:'Chapter 1.10', value:'/series/chapter-1.10', selected:false },
      { text:'Chapter 1.2', value:'/series/chapter-1.2', selected:false },
      { text:'Chapter 1.1', value:'/series/chapter-1.1', selected:true },
      { text:'Chapter 1', value:'12345', selected:false }
    ]
  }]};
  assert.equal(chooseNextChapter('https://example.com/series/chapter-1.1', page).url, 'https://example.com/series/chapter-1.2');
});
test('numeric chapter selector can infer a sibling URL without confusing page selectors', () => {
  const chapterPage = { title:'Series — Chapter 9.5', headings:[], links:[], selects:[{
    label:'', selectedIndex:0, options:[
      { text:'9.5', value:'9.5', selected:true },
      { text:'10', value:'10', selected:false }
    ]
  }]};
  assert.equal(chooseNextChapter('https://example.com/manga/17675/9.5', chapterPage).url, 'https://example.com/manga/17675/10');
  const pageSelector = { title:'Chapter 1', headings:[], links:[], selects:[{
    label:'', selectedIndex:0, options:[{text:'1',value:'1',selected:true},{text:'2',value:'2',selected:false}]
  }]};
  assert.equal(chooseNextChapter('https://example.com/chapter/uuid-value/1', pageSelector).url, '');
});
test('same-series sibling URLs work even when the link has no Next label', () => {
  const page = { title:'Long title ตอนที่ 1', headings:[], links:[
    { href:'/very-long-series-name-level-9999-a-2/', text:'' },
    { href:'/manga/colorless/', text:'COLORLESS ตอนที่ 4' }
  ], selects:[] };
  assert.equal(chooseNextChapter('https://example.com/very-long-series-name-level-9999-a-1/', page).url,
    'https://example.com/very-long-series-name-level-9999-a-2/');
});
test('chapter resource right-arrow navigation handles opaque chapter IDs', () => {
  const page = { title:'1 | Chapter 1 - Example', headings:[], links:[
    { href:'/title/example', text:'', desc:'feather chevron-left' },
    { href:'/chapter/next-opaque-id', text:'', desc:'feather chevron-right',
      parentText:'Chapter 1 None Chapter 36 Chapter 35 Chapter 34' }
  ], selects:[] };
  const next = chooseNextChapter('https://example.com/chapter/current-opaque-id/1', page);
  assert.equal(next.url, 'https://example.com/chapter/next-opaque-id');
  assert.ok(next.confidence >= 65);
});
test('semantic chapter controls allow chapter buttons but reject page-next or disabled controls', () => {
  const manga168 = chooseNextChapter('https://example.com/manga/story/chapter/ch-37', {
    title:'Story ตอนที่ 37', links:[], selects:[], controls:[
      { text:'ตอนก่อนหน้า', className:'prev', desc:'chevron-left' },
      { text:'ตอนถัดไป', className:'next', desc:'chevron-right' }
    ]
  });
  assert.equal(manga168.action, 'click');
  const pageOnly = chooseNextChapter('https://example.com/chapter/1', {
    title:'Chapter 1', links:[], selects:[], controls:[{ text:'หน้าถัดไป', className:'next-page' }]
  });
  assert.equal(pageOnly.action, undefined);
  const disabled = chooseNextChapter('https://example.com/chapter/9.5', {
    title:'Chapter 9.5', links:[], selects:[], controls:[{ text:'Next chapter', className:'chapter-next disabled', disabled:true }]
  });
  assert.equal(disabled.action, undefined);
  const hashNext = chooseNextChapter('https://example.com/series-a-1/', {
    title:'Series A ตอนที่ 1', links:[
      { href:'https://example.com/series-a-1/#/next/', rel:'next', text:'ถัดไป', className:'ch-next-btn' }
    ], selects:[], controls:[]
  });
  assert.equal(hashNext.action, 'click');
});
test('chapter selector prefers inferred sibling URL when option value is stale or relative', () => {
  const page = { title:'Story - ตอนที่ 6.3', headings:[], links:[], selects:[{
    label:'Chapter', selectedIndex:0, options:[
      { text:'ตอนที่ 6.3', value:'ตอนที่-6-3', selected:true },
      { text:'ตอนที่ 6.4', value:'ตอนที่-6-3', selected:false }
    ]
  }]};
  assert.equal(chooseNextChapter('https://example.com/manga/story/%E0%B8%95%E0%B8%AD%E0%B8%99%E0%B8%97%E0%B8%B5%E0%B9%88-6-3/', page).url,
    'https://example.com/manga/story/%E0%B8%95%E0%B8%AD%E0%B8%99%E0%B8%97%E0%B8%B5%E0%B9%88-6-4/');
});
test('SPA chapter button wins over an inferred selector URL', () => {
  const page = { title:'Reader', headings:[], links:[], selects:[{
    label:'เลือกตอน', selectedIndex:0, options:[
      { text:'ตอนที่ 1.1', value:'1.1', selected:true },
      { text:'ตอนที่ 1.2', value:'1.2', selected:false }
    ]
  }], controls:[{ text:'ตอนถัดไป', className:'primary', desc:'chevron-right', disabled:false }]};
  const next = chooseNextChapter('https://example.com/read/story/1.1', page);
  assert.equal(next.action,'click');
  assert.equal(next.inferredUrl,'https://example.com/read/story/1.2');
});
test('chapter index fallback identifies the series index and nearest real subchapter', () => {
  const currentUrl = 'https://example.com/very-long-series-9.2/';
  const currentPage = { title:'Very Long Series ตอนที่ 9.2', headings:['Very Long Series ตอนที่ 9.2'], links:[
    { href:'https://example.com/manga/very-long-series/', text:'Very Long Series',
      parentText:'All chapters are in Very Long Series' }
  ]};
  assert.equal(chapterIndexLink(currentUrl,currentPage).url,'https://example.com/manga/very-long-series/');
  const listing = { url:'https://example.com/manga/very-long-series/', links:[
    { href:'/very-long-series-10-1/', text:'ตอนที่ 10.1' },
    { href:'/related-story-99/', text:'Related Story ตอนที่ 99' },
    { href:'/very-long-series-9-1/', text:'ตอนที่ 9.1' },
    { href:'/very-long-series-10-2/', text:'ตอนที่ 10.2' }
  ]};
  const next = nextFromChapterListing(currentUrl,currentPage,listing);
  assert.equal(next.url,'https://example.com/very-long-series-10-1/');
  assert.deepEqual(next.parts,[10,1]);
});
test('chapter index fallback identifies current subchapter despite percent-encoding case', () => {
  const currentUrl = 'https://example.com/series/%E0%B8%95%E0%B8%AD%E0%B8%99/';
  const currentPage = { title:'Very Long Series 9.1 - Reader', headings:[] };
  const listing = { url:'https://example.com/manga/very-long-series/', links:[
    { href:'/opaque-series-next/', text:'ตอนที่ 9.2' },
    { href:'/series/%e0%b8%95%e0%b8%ad%e0%b8%99/', text:'ตอนที่ 9.1' },
    { href:'/opaque-series-later/', text:'ตอนที่ 10' }
  ]};
  const next = nextFromChapterListing(currentUrl,currentPage,listing);
  assert.equal(next.url,'https://example.com/opaque-series-next/');
  assert.deepEqual(next.parts,[9,2]);
});

const filters = require('../src/content-filter.js');
test('metadata filter recognizes explicit logo names without inspecting host or signed query', () => {
  assert.equal(filters.classify({ url: 'https://cdn.test/site-logo@2x.png' }).chrome, true);
  assert.equal(filters.classify({ url: 'https://logo.example/logo-story/page-02.png?avatar=yes' }).chrome, false);
  assert.equal(filters.classify({ url: 'https://example.com/dialogo.png' }).chrome, false);
  assert.equal(filters.classify({ identity: 'siteLogo' }).chrome, true);
  assert.equal(filters.classify({ alt: 'โลโก้เว็บไซต์' }).chrome, true);
});
test('confidence filter removes support/donation CTA assets outside readers without hostname rules', () => {
  const support = filters.classify({ url:'https://cdn.test/img/support-us-1.png', mainKind:'unknown' });
  assert.equal(support.chrome, true); assert.equal(support.category, 'promo'); assert.ok(support.chromeScore >= 70);
  const contextOnly = filters.classify({ url:'https://cdn.test/asset-123.png', context:'support creator donate button', mainKind:'main' });
  assert.equal(contextOnly.chrome, true); assert.equal(contextOnly.category, 'promo');
  const readerPage = filters.classify({ url:'https://cdn.test/support-us-1.png', mainKind:'reader' });
  assert.equal(readerPage.chrome, false);
});test('main-content scope prefers reader regions but unknown layouts retain uncertain images', () => {
  const items = ['unknown', 'main', 'reader'].map(mainKind => ({ filterHints: filters.classify({ mainKind }) }));
  assert.equal(filters.mainScope(items), 'reader');
  assert.equal(filters.mainScope(items.slice(0, 2)), 'main');
  assert.equal(filters.mainScope(items.slice(0, 1)), 'unknown');
  assert.equal(filters.matches(items[0], { mainOnly: true, mainScope: 'unknown' }), true);
  assert.equal(filters.matches(items[1], { mainOnly: true, mainScope: 'reader' }), false);
});
test('metadata filtering is opt-in and does not reject short or wide reader pages', () => {
  const logo = { source: 'img', filterHints: filters.classify({ alt: 'Logo', mainKind: 'reader' }) };
  assert.equal(filters.matches(logo), true); assert.equal(filters.matches(logo, { hideChrome: true }), false);
  const short = { width: 1400, height: 100, source: 'canvas', filterHints: filters.classify({ mainKind: 'reader' }) };
  assert.equal(filters.matches(short, { mainOnly: true, mainScope: 'reader' }), true);
  assert.equal(filters.matches(short, { source: 'img' }), false);
  assert.equal(filters.matches(short, { source: 'canvas', minHeight: 300 }), false);
});

const network = require('../src/network.cjs');
test('network modes normalize and expose deterministic DNS settings', () => {
  assert.equal(network.normalizeNetworkMode('CLOUDFLARE'), 'cloudflare');
  assert.equal(network.normalizeNetworkMode('unknown'), 'auto');
  assert.deepEqual(network.electronResolverOptions('cloudflare').secureDnsServers, ['https://cloudflare-dns.com/dns-query']);
  assert.deepEqual(network.electronResolverOptions('google').secureDnsServers, ['https://dns.google/dns-query']);
  assert.deepEqual(network.electronResolverOptions('adguard').secureDnsServers, ['https://dns.adguard-dns.com/dns-query']);
  assert.ok(network.chromeArgs('adguard').some(x => x.includes('dns.adguard-dns.com')));
  assert.equal(network.electronResolverOptions('auto').secureDnsMode, 'automatic');
  assert.deepEqual(network.electronResolverOptions('auto').secureDnsServers, ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query']);
});
test('compatibility mode disables HTTP2 and QUIC only when selected', () => {
  assert.deepEqual(network.chromeArgs('auto'), []);
  assert.ok(network.chromeArgs('cloudflare').some(x => x.startsWith('--dns-over-https-templates=')));
  assert.ok(network.chromeArgs('compat').includes('--disable-http2'));
  assert.ok(network.chromeArgs('compat').includes('--disable-quic'));
  assert.equal(network.isCompatibility('compat'), true);
  assert.equal(network.isCompatibility('google'), false);
});
test('Smart Auto retries only retryable network failures and remembers public DNS order', () => {
  for (const error of [
    new Error('net::ERR_CONNECTION_TIMED_OUT'),
    new Error('net::ERR_NAME_NOT_RESOLVED'),
    new Error('ETIMEDOUT'),
    new Error('page.goto: Timeout 45000ms exceeded')
  ]) assert.equal(network.isRetryableNetworkError(error), true);
  assert.equal(network.isRetryableNetworkError(new Error('HTTP 403')), false);
  assert.deepEqual(network.autoFallbackModes(''), ['cloudflare', 'google']);
  assert.deepEqual(network.autoFallbackModes('cloudflare'), ['cloudflare', 'google']);
  assert.deepEqual(network.autoFallbackModes('google'), ['google', 'cloudflare']);
});