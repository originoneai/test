import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { handleApi } from './api.js';
export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, application: 'issue-tracker-scaffold' })); return;
      }
      if (url.pathname.startsWith('/api/')) { await handleApi(req, res); return; }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      const asset = assets[url.pathname];
      if (!asset) { res.writeHead(404); res.end('Not found'); return; }
      const content = await readFile(new URL('../public/' + asset[0], import.meta.url));
      res.writeHead(200, { 'content-type': asset[1] + '; charset=utf-8' }); res.end(content);
    } catch { res.writeHead(500); res.end('Internal error'); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '127.0.0.1', () => console.log('Issue tracker: http://127.0.0.1:' + port));
}
