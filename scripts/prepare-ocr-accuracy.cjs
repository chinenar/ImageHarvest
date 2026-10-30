'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

async function main() {
  const inventory = JSON.parse(await fs.readFile('test-results/manga-corpus/inventory.json', 'utf8'));
  const files = inventory.filter(r => r.group.startsWith('8') && r.group.includes('Trapped in a Crazy'));
  const output = path.resolve('test-results/ocr-accuracy');
  await fs.mkdir(output, {recursive: true});
  let tiles = [];
  for (const [i, f] of files.entries()) {
    const image = await sharp(f.file).resize(180, 1000, {fit: 'inside'}).png().toBuffer();
    const label = Buffer.from(`<svg width="200" height="30"><text x="5" y="22" font-size="20">${f.name}</text></svg>`);
    tiles.push({input: image, left: i % 9 * 200, top: 30});
    tiles.push({input: label, left: i % 9 * 200, top: 0});
    if (i % 9 === 8 || i === files.length - 1) {
      await sharp({create: {width: 1800, height: 1050, channels: 3, background: '#ddd'}})
        .composite(tiles).png().toFile(path.join(output, `chapter-${Math.floor(i / 9)}.png`));
      tiles = [];
    }
  }
  console.log(files.map(f => ({name: f.name, width: f.width, height: f.height})));
}
main().catch(e => {console.error(e); process.exitCode = 1;});
