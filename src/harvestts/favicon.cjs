'use strict';
const { nativeImage } = require('electron');

// Return a small local image so the browser chrome never needs remote img-src access.
async function loadFavicon(session, urls, signal) {
  for (const url of urls.slice(0, 4)) {
    if (!/^https?:\/\//i.test(url) && !/^data:image\//i.test(url)) continue;
    try {
      if (url.length > 350000) continue;
      const response = await (/^data:/i.test(url)
        ? fetch(url, { signal })
        : session.fetch(url, { signal }));
      if (!response.ok) continue;
      const reader = response.body.getReader(),
        chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 256 * 1024) throw new Error('Favicon too large');
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const bytes = Buffer.concat(chunks);
      let icon = nativeImage.createFromBuffer(bytes);
      if (icon.isEmpty()) {
        const png = await require('sharp')(bytes, { limitInputPixels: 1024 * 1024 })
          .resize(32, 32, { fit: 'inside' })
          .png()
          .toBuffer();
        icon = nativeImage.createFromBuffer(png);
      }
      if (!icon.isEmpty()) return icon.resize({ width: 32, height: 32 }).toDataURL();
    } catch {
      if (signal.aborted) return '';
    }
  }
  return '';
}

module.exports = { loadFavicon };
