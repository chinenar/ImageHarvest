'use strict';
// Read-only V4.0 provenance capture. Never modifies Mobile, app profiles or Git.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, 'test-results', 'v4-pc-regression-' + new Date().toISOString().slice(0, 10)), 'before-state.json');
function hashFile(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return { sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), bytes: fs.statSync(file).size };
}
function gather(dir, extensions) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return gather(file, extensions);
    return extensions.some(x => file.endsWith(x)) ? [file] : [];
  });
}
const inputs = [
  'package.json', 'src/main.cjs', 'src/chrome-browser.cjs', 'src/chrome-minimal.cjs',
  'src/chrome-standard.cjs', 'src/core.cjs', 'src/scroll.js',
  'mobile/docs/IMAGE_ACQUISITION_V4_REGRESSION_FIRST.md',
  'mobile/docs/ADAPTIVE_ACQUISITION_V3_IMPLEMENTATION.md',
  'mobile/docs/RUST_ACQUISITION_SHADOW_REVIEW.md',
  'mobile/app/build/outputs/apk/debug/app-debug.apk',
  ...gather(path.join(root, 'src', 'collector'), ['.js', '.cjs']),
  ...gather(path.join(root, 'mobile', 'app', 'src', 'main', 'harvest'), ['.js']),
  ...gather(path.join(root, 'mobile', 'app', 'src', 'main', 'assets'), ['.js'])
];
const files = {};
for (const absolute of new Set(inputs.map(x => path.isAbsolute(x) ? x : path.join(root, x)))) {
  const rel = path.relative(root, absolute).replaceAll('\\', '/');
  const result = hashFile(absolute);
  if (result) files[rel] = result;
}
const userData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ImageHarvest');
const preferences = {};
for (const name of ['settings.json']) {
  const value = hashFile(path.join(userData, name));
  if (value) preferences[name] = value;
}
const run = args => { try { return cp.execFileSync('git', args, { cwd: root, encoding:'utf8', timeout:30000 }).trim(); } catch (error) { return 'unavailable:' + error.message; } };
const report = {
  capturedAt: new Date().toISOString(),
  machine: os.hostname(),
  node: process.version,
  repository: root,
  branch: run(['branch','--show-current']),
  head: run(['rev-parse','HEAD']),
  trackedDirtyEntries: run(['status','--porcelain','-uno']).split(/\r?\n/).filter(Boolean),
  packageVersion: JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,
  files,
  productionPreferencesChecksumsOnly: preferences,
  preservation: ['Read-only state capture', 'No profile/cookie reset', 'No Mobile Git operations', 'No production app mutation']
};
fs.mkdirSync(path.dirname(output), { recursive:true });
fs.writeFileSync(output, JSON.stringify(report, null, 2), {flag:'wx'});
console.log(JSON.stringify({output, capturedAt:report.capturedAt, files:Object.keys(files).length, dirty:report.trackedDirtyEntries.length, apk:files['mobile/app/build/outputs/apk/debug/app-debug.apk']?.sha256 || null},null,2));
