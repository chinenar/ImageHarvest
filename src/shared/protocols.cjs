'use strict';
const { protocol, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const sourceDir = path.resolve(__dirname, '..');
function registerAppProtocols(features) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
  };
  const handleEiwRequest = async (request) => {
    const url = new URL(request.url);
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    // Serve persistent Offline Library page images without exposing arbitrary local files.
    if (url.host === 'offline') {
      const parts = url.pathname
        .split('/')
        .filter(Boolean)
        .map((x) => decodeURIComponent(x));
      if (
        parts.length !== 2 ||
        !/^[0-9a-f]{24}$/.test(parts[0]) ||
        path.basename(parts[1]) !== parts[1]
      )
        return new Response('', { status: 404 });
      try {
        const saved = await features.offlineLibrary.harvestOfflineReadProject(parts[0]),
          page = saved.manifest.pages.find((p) => p.file === parts[1] && !p.error);
        if (!page) return new Response('', { status: 404 });
        const buffer = await fs.readFile(path.join(saved.dir, parts[1])),
          ext = path.extname(parts[1]).toLowerCase();
        const mime =
          page.mime ||
          {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
          }[ext] ||
          'application/octet-stream';
        return new Response(buffer, {
          headers: {
            'Content-Type': mime,
            'Cache-Control': 'private, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch {
        return new Response('', { status: 404 });
      }
    }
    // Serve already-acquired image bytes on the UI origin for local pixel analysis only.
    // Website sessions, CORS and Canvas origin-clean rules remain unchanged.
    if (url.host === 'app' && /^image\/[a-f0-9]{24}$/.test(name)) {
      const id = name.slice(6),
        owner = features.collectorCollection.records;
      try {
        const data = await features.collectorFiles.getImage(id);
        return new Response(data.buffer, {
          headers: {
            'Content-Type': data.mime,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch (error) {
        if (owner === features.collectorCollection.records)
          features.host.emit('image-failed', {
            id,
            message: error.message,
            scope: 'preview',
          });
        return new Response('', { status: 502 });
      }
    }
    if (
      url.host !== 'app' ||
      ![
        'index.html',
        'renderer.js',
        'collector/renderer.js',
        'harvestts/renderer.js',
        'content-filter.js',
        'style.css',
        'history.html',
        'history.css',
        'history.js',
      ].includes(name)
    )
      return new Response('Not found', { status: 404 });
    return new Response(await fs.readFile(path.join(sourceDir, name)), {
      headers: { 'Content-Type': types[path.extname(name)] || 'text/plain' },
    });
  };
  protocol.handle('eiw', handleEiwRequest);
  session.fromPartition('harvest-internal').protocol.handle('eiw', handleEiwRequest);
  protocol.handle('eiw-image', async (request) => {
    const url = new URL(request.url),
      id = url.pathname.slice(1);
    if (url.host !== 'cache' || !/^[a-f0-9]{24}$/.test(id))
      return new Response('', { status: 404 });
    try {
      const data = await features.collectorFiles.getImage(id);
      return new Response(data.buffer, {
        headers: {
          'Content-Type': data.mime,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      features.host.emit('image-failed', {
        id,
        message: error.message,
        scope: 'preview',
      });
      return new Response('', { status: 502 });
    }
  });
}
module.exports = { registerAppProtocols };
