'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
(async () => {
  const { packager } = await import('@electron/packager');
  const root = path.resolve(__dirname, '..');
  const output = await packager({ dir: root, name: 'ImageHarvest', platform: 'win32', arch: 'x64',
    out: path.join(root, 'release'), overwrite: true, asar: true, prune: true,
    icon: path.join(root, 'assets', 'icon.ico'),
    appVersion: '1.0.2', appCopyright: 'Personal image collection tool',
    win32metadata: { ProductName: 'ImageHarvest', FileDescription: 'Ordered website image collector' },
    ignore: [/^\/release($|\/)/, /^\/installer-dist($|\/)/, /^\/test($|\/)/, /^\/scripts($|\/)/, /^\/\.git($|\/)/,
      /^\/test-results($|\/)/, /\.b64$/, /^\/deploy\.py$/, /^\/node_modules($|\/)/, /^\/package-lock\.json$/,
      /^\/.*\.log$/, /^\/.*\.zip$/] });
  console.log('PACKAGED:', output.join('\n'));
  await fs.writeFile(path.join(root, 'PACKAGE_PATH.txt'), path.join(output[0], 'ImageHarvest.exe'), 'utf8');
})().catch(error => { console.error(error); process.exitCode = 1; });
