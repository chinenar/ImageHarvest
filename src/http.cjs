'use strict';
const { net } = require('electron');

// Electron net.fetch rejects manual redirects; ClientRequest exposes them safely.
function fetchManual(url, options, session, limit) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, session, credentials: 'include', redirect: 'manual',
      referrerPolicy: 'strict-origin-when-cross-origin' });
    let settled = false;
    const signal = options.signal;
    function done(error, value) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    }
    function fail(error) { done(error); request.abort(); }
    function abort() { fail(new Error('ยกเลิกคำขอหรือการเชื่อมต่อหมดเวลา')); }
    const headersOf = raw => {
      const headers = new Headers();
      for (const [key, values] of Object.entries(raw))
        for (const value of Array.isArray(values) ? values : [values]) headers.append(key, value);
      return headers;
    };
    request.on('error', error => done(error));
    request.on('abort', () => done(new Error('คำขอถูกยกเลิก')));
    request.on('login', (_info, callback) => callback());
    request.on('redirect', (status, _method, next, raw) => {
      const headers = headersOf(raw); headers.set('location', next);
      done(null, { status, ok: false, headers, body: null });
      request.abort();
    });
    request.on('response', response => {
      const headers = headersOf(response.headers), status = response.statusCode;
      response.on('error', error => fail(error));
      response.on('aborted', () => done(new Error('ข้อมูลภาพถูกตัดก่อนครบ')));
      if (status < 200 || status >= 300) {
        done(null, { status, ok: false, headers, body: null }); request.abort(); return;
      }
      if (Number(headers.get('content-length') || 0) > limit) {
        fail(new Error('ภาพมีขนาดเกิน 32 MB')); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        if (settled) return;
        size += chunk.length;
        if (size > limit) { fail(new Error('ภาพมีขนาดเกิน 32 MB')); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        if (!settled) done(null, new Response(Buffer.concat(chunks, size), { status, headers }));
      });
    });
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    if (options.referrer) {
      const source = new URL(options.referrer), target = new URL(url);
      if (!(source.protocol === 'https:' && target.protocol === 'http:'))
        request.setHeader('Referer', source.origin === target.origin ? source.href : source.origin + '/');
    }
    request.end();
  });
}
module.exports = { fetchManual };
