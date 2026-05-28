// 极小静态服务器（零依赖，Node 18+）。
// 默认服务 ../web/，端口 8000；可通过 PORT 环境变量改端口。
//
// 用法:  node scripts/dev_server.mjs
// 或:    npm run dev

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = parseInt(process.env.PORT || '8000', 10);
const ROOT = fileURLToPath(new URL('../web/', import.meta.url));

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.mjs':  'text/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.txt':  'text/plain; charset=utf-8',
    '.map':  'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
    try {
        let urlPath = decodeURIComponent(req.url.split('?')[0]);
        if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
        const fp = normalize(join(ROOT, urlPath));
        if (!fp.startsWith(ROOT.replace(/[\\/]$/, ''))) {
            res.writeHead(403); res.end('forbidden');
            return;
        }
        const s = await stat(fp);
        if (s.isDirectory()) {
            const data = await readFile(join(fp, 'index.html'));
            res.writeHead(200, { 'content-type': MIME['.html'] });
            res.end(data);
            return;
        }
        const data = await readFile(fp);
        const mime = MIME[extname(fp).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, {
            'content-type': mime,
            // 避免开发期被 Service Worker / 浏览器缓存钉住
            'cache-control': 'no-cache',
        });
        res.end(data);
    } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end(`404: ${req.url}`);
        } else {
            console.error('[dev_server] error:', e);
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end(`500: ${e.message}`);
        }
    }
});

server.listen(PORT, () => {
    console.log(`✓ depth_map web/ → http://127.0.0.1:${PORT}/`);
    console.log(`  press Ctrl+C to stop`);
});
