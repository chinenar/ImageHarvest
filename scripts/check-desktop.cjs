'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sourceDir = path.resolve(__dirname, '..', 'src');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(?:cjs|js)$/.test(entry.name) ? [file] : [];
  });
}

const files = sourceFiles(sourceDir);
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log(`Checked syntax of ${files.length} desktop JavaScript files.`);
