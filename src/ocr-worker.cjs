'use strict';
// tesseract.js-core 7 relaxed SIMD crashes on float tessdata_best models.
// Restrict this workaround to this worker; keep ordinary SIMD acceleration.
// https://github.com/naptha/tesseract.js/issues/1080
const path=require('node:path');
const originalWorker=require.resolve('tesseract.js/src/worker-script/node/index.js');
const detectPath=require.resolve('wasm-feature-detect',{paths:[path.dirname(originalWorker)]});
const detect=require(detectPath);
require.cache[detectPath].exports={...detect,relaxedSimd:async()=>false};
require(originalWorker);
