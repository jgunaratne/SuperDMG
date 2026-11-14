// Tiny HTTP server for SuperDMG and its server-side Gemini tile colorization and
// AI autoplay endpoints (no external dependencies).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgraderStatus, upgradeScreenTiles, clearDiskCache } from './tools/tile_upgrader.mjs';
import { aiPlayerStatus, planNextMoves } from './tools/ai_player.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile?.(path.join(ROOT, '.env'));
} catch { /* optional .env */ }
const PORT = Number(process.env.PORT || 8740);
const HOST = process.env.HOST || '0.0.0.0';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.gb': 'application/octet-stream',
  '.gbc': 'application/octet-stream',
};
// Only the app itself is served: no dotfiles, tooling, tests or downloaded test ROMs,
// and not roms/local/, where you may keep games of your own.
const PUBLIC = /^\/(index\.html$|src\/|assets\/instruments\/|roms\/demo\.gb$)/;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400); res.end('bad request'); return;
  }

  if (p === '/api/tiles/status' && req.method === 'GET') {
    sendJson(res, 200, upgraderStatus());
    return;
  }

  if (p === '/api/tiles/upgrade' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const result = await upgradeScreenTiles(payload);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 502, { ok: false, error: err.message || 'Tile upgrade failed' });
    }
    return;
  }

  if (p === '/api/tiles/clear' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req, 16 * 1024);
      clearDiskCache(payload.cartId, payload.style);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (p === '/api/ai/status' && req.method === 'GET') {
    sendJson(res, 200, aiPlayerStatus());
    return;
  }

  if (p === '/api/ai/act' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const result = await planNextMoves(payload);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 502, { ok: false, error: err.message || 'AI autoplay failed' });
    }
    return;
  }

  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep) || !PUBLIC.test(p) || /\/\./.test(p)) {
    res.writeHead(404); res.end('not found'); return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, HOST, () => console.log(`SuperDMG -> http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`));
