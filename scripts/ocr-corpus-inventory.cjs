'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const compareNames = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const generatedDirectory = (name) => /^__mobile_pipeline(?:_|$)/i.test(name);
const cacheDirectory = (name) =>
  [
    '__pycache__',
    'node_modules',
    '.git',
    '.cache',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
  ].includes(name);

async function collectImageInventory(source, readMetadata) {
  const inventory = [];
  async function walk(dir) {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
      compareNames(a.name, b.name),
    );
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!generatedDirectory(entry.name)) await walk(file);
      } else if (
        entry.isFile() &&
        !/^__ctd_seg_/i.test(entry.name) &&
        /\.(png|jpe?g|webp|avif)$/i.test(entry.name)
      ) {
        const metadata = await readMetadata(file);
        inventory.push({
          file,
          group: path.relative(source, dir),
          name: entry.name,
          width: metadata.width,
          height: metadata.height,
        });
      }
    }
  }
  await walk(source);
  return inventory;
}

function representativeCases(inventory) {
  const groups = [...new Set(inventory.map((item) => item.group))].sort(compareNames);
  return groups.map((group, index) => {
    const files = inventory
      .filter((item) => item.group === group)
      .sort((a, b) => compareNames(a.name, b.name));
    const item = files[group.startsWith('6') ? 2 : 1] || files[0];
    const hint = /[\u3040-\u30ff]/u.test(group)
      ? 'ja'
      : /[\u3400-\u9fff]/u.test(group)
        ? 'zh'
        : 'auto';
    return { ...item, id: `case-${String(index + 1).padStart(2, '0')}`, hint };
  });
}

async function implementationFingerprint(sourceRoot, extraFiles = []) {
  const files = [];
  async function walk(dir) {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
      compareNames(a.name, b.name),
    );
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!cacheDirectory(entry.name)) await walk(file);
      } else if (entry.isFile() && /\.(cjs|js|py)$/i.test(entry.name)) {
        files.push(file);
      }
    }
  }
  await walk(sourceRoot);
  const digest = createHash('sha256');
  const sourceFiles = [];
  for (const file of [...new Set([...files, ...extraFiles.map((file) => path.resolve(file))])].sort(
    compareNames,
  )) {
    const name = path.relative(sourceRoot, file).split(path.sep).join('/');
    const content = await fs.readFile(file);
    // Include path and content lengths so additions, removals and renames invalidate resume.
    digest.update(`${Buffer.byteLength(name)}:${name}:${content.length}:`);
    digest.update(content);
    sourceFiles.push(name);
  }
  return { implementationDigest: digest.digest('hex'), implementationFiles: sourceFiles };
}

module.exports = { collectImageInventory, representativeCases, implementationFingerprint };
