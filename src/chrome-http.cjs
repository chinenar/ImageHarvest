'use strict';
const http = require('node:http');
const https = require('node:https');
const { createLookup } = require('./network.cjs');

// Stream-bounded downloads using cookies ONLY from the app-created Chrome session.
// Personal Chrome profiles, filesystem cookies and external authentication are never read.
async function chromeFetchManual(url, options, context, userAgent, limit, networkMode = 'auto') {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('URL ภาพไม่ปลอดภัย');
  if (options.signal?.aborted) throw new Error('ยกเลิกการดาวน์โหลด');
  const cookies = await context.cookies(target.href);
  const headers = { 'User-Agent': userAgent, 'Accept': 'image/*,*/*;q=0.8', 'Accept-Encoding': 'identity' };
  if (cookies.length) headers.Cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  if (options.referrer) {
    const source = new URL(options.referrer);
    if (!(source.protocol === 'https:' && target.protocol === 'http:'))
      headers.Referer = source.origin === target.origin ? source.href : source.origin + '/';
  }
  return new Promise((resolve, reject) => {
    let settled = false, response;
    const signal = options.signal;
    const lookup = createLookup(networkMode);
    const requestOptions = { method: 'GET', headers };
    if (lookup) requestOptions.lookup = lookup;
    const request = (target.protocol === 'https:' ? https : http).request(target, requestOptions);
    function done(error, value) {
      if (settled) return; settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    }
    function fail(error) { done(error); response?.destroy(); request.destroy(); }
    function abort() { fail(new Error('ยกเลิกคำขอหรือการเชื่อมต่อหมดเวลา')); }
    request.on('error', error => done(error));
    request.on('response', res => {
      response = res;
      const resultHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers))
        if (value !== undefined) for (const v of Array.isArray(value) ? value : [value]) resultHeaders.append(key, v);
      const status = res.statusCode || 0;
      res.on('error', fail); res.on('aborted', () => done(new Error('ข้อมูลภาพถูกตัดก่อนครบ')));
      if (status < 200 || status >= 300) {
        done(null, { status, ok: false, headers: resultHeaders, body: null }); res.destroy(); return;
      }
      if (Number(resultHeaders.get('content-length') || 0) > limit) { fail(new Error('ภาพมีขนาดเกิน 32 MB')); return; }
      if (resultHeaders.has('content-encoding') && resultHeaders.get('content-encoding') !== 'identity') { fail(new Error('เซิร์ฟเวอร์ส่งภาพแบบบีบอัด HTTP ที่ยังไม่รองรับในโหมด Chrome')); return; }
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        if (settled) return;
        size += chunk.length;
        if (size > limit) { fail(new Error('ภาพมีขนาดเกิน 32 MB')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => { if (!settled) done(null, new Response(Buffer.concat(chunks, size), { status, headers: resultHeaders })); });
    });
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true }); request.end();
  });
}
module.exports = { chromeFetchManual };
