'use strict';
const { createHash } = require('node:crypto');
const RULE_VERSION = '2026-09-18.2', MAX_SCRIPT = 2 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Content-only recognition: URLs, filenames and library names never authorize a patch.
const RULES = Object.freeze([
  Object.freeze({ id: 'disable-devtool-0.3.9-umd', family: 'disable-devtool', version: '0.3.9', hash: '5a7b9b2c807f85575c9ebc1f508e849b53430870b2d0fb6c02b2de3df661cb63', action: 'suspend-entrypoint' }),
  Object.freeze({ id: 'devtools-detect-modified-2.1-esm', family: 'devtools-detect', version: 'modified-2.1', hash: '3a86139fcada194deca1fa4f9f6ba14b80c6fb81694071d63e399abc8ac7feb5', action: 'inert-default-export' }),
  Object.freeze({ id: 'reviewed-reader-guard-build-1', family: 'devtools-detector / integrated reader', version: 'reviewed-build-1', hash: '0f2664ca4e355babe279bae104d53c93ead7b5bc4dded70666e539090c805dd6', action: 'isolate-reviewed-guard' })
]);
const byHash = new Map(RULES.map(rule => [rule.hash, rule]));
function inspectScript(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('Expected script bytes');
  if (bytes.length > MAX_SCRIPT) return { kind: 'size-limit' };
  const hash = sha256(bytes), rule = byHash.get(hash);
  if (rule) return { kind: 'known', hash, rule };
  const text = bytes.toString('utf8');
  // Hints are diagnostic only, not permission to rewrite unknown code.
  const family = /DisableDevtool|disable-devtool/.test(text) ? 'disable-devtool' : /DevtoolsDetector|debuggerChecker|devtoolsFormatterChecker/.test(text) ? 'devtools-detector' : /devtoolschange|devtools-detect/.test(text) ? 'devtools-detect' : '';
  const unsafe = /window\.startBoom/.test(text) && /new Array\(5e6\)/.test(text) && /for\(;;\)/.test(text);
  return { kind: unsafe ? 'unsafe-unknown' : family ? 'unknown' : 'unrelated', hash, family };
}
function once(text, before, after) {
  if (text.split(before).length !== 2) throw new Error('จุดปรับสคริปต์ไม่ตรงกับกฎที่ตรวจแล้ว');
  return text.replace(before, after);
}
function patchScript(bytes) {
  const analysis = inspectScript(bytes);
  if (analysis.kind !== 'known') throw new Error('ไม่แก้สคริปต์ที่ลายเซ็นไม่ตรงกับรุ่นที่ตรวจแล้ว');
  const { rule, hash } = analysis; let text = bytes.toString('utf8');
  if (rule.action === 'suspend-entrypoint') {
    // Retain UMD exports, helpers and version; skip detector startup only.
    text = once(text, 'var n;if(R.isRunning)', 'var n;return t();if(R.isRunning)');
  } else if (rule.action === 'inert-default-export') {
    text = 'const devtools={isOpen:false,orientation:undefined};export default devtools;\n';
  } else if (rule.action === 'isolate-reviewed-guard') {
    const startMark = 'Pe(()=>{if(document.visibilityState==="visible"&&ne.value&&document.visibilityState==="visible"){';
    const endMark = 'startBoom()}},1e3)';
    const start = text.indexOf(startMark), end = text.indexOf(endMark, start);
    if (start < 0 || end < start || text.indexOf(startMark, start + 1) !== -1 || text.indexOf(endMark, end + 1) !== -1) throw new Error('โครงสร้างส่วนป้องกันไม่ตรงกับรุ่นที่ตรวจแล้ว');
    text = text.slice(0, start) + 'void 0' + text.slice(end + endMark.length);
    text = once(text, 'ut.launch()', 'void 0');
    if (text.includes('new Array(5e6)') || text.includes('window.startBoom')) throw new Error('การแยกส่วนที่ทำให้แท็บค้างไม่สมบูรณ์');
  } else throw new Error('Unsupported compatibility rule');
  return { body: Buffer.from(text, 'utf8'), rule, hash };
}
function modifiedHeaders(headers, length) {
  const removed = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'etag', 'content-md5', 'digest', 'content-digest', 'repr-digest']);
  return [...headers.filter(h => !removed.has(h.name.toLowerCase())), { name: 'Content-Length', value: String(length) }];
}
module.exports = { RULE_VERSION, RULES, MAX_SCRIPT, sha256, inspectScript, patchScript, modifiedHeaders };
