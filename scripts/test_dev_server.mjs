// 短命冒烟测试：起 dev_server，拉几个关键路径，断言 200/正确 mime，结束。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { request } from 'node:http';

const PORT = 8765; // 用一个不太可能冲突的端口
const proc = spawn(process.execPath, ['scripts/dev_server.mjs'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
});
proc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));

await sleep(400);

// 用原始 http.request 避免 fetch 的客户端 URL 标准化
function rawGet(path) {
    return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: PORT, path, method: 'GET' }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
    });
}

const targets = [
    { url: `/`,                                 mime: 'text/html', label: 'root → index.html' },
    { url: `/index.html`,                       mime: 'text/html', label: 'index.html' },
    { url: `/src/main.js`,                      mime: 'text/javascript', label: 'ES module main.js' },
    { url: `/src/worker.js`,                    mime: 'text/javascript', label: 'worker.js' },
    { url: `/src/i18n.js`,                      mime: 'text/javascript', label: 'i18n.js' },
    { url: `/src/gl/shaders.js`,                mime: 'text/javascript', label: 'gl/shaders.js' },
    { url: `/_does_not_exist.foo`,              status: 404, label: '404 行为' },
    // URL 编码的 .. 才能绕过客户端标准化；服务器侧应拒绝
    { url: `/%2e%2e/%2e%2e/README.md`,          statusOneOf: [403, 404], label: '路径穿越被拦截' },
];

let pass = 0, fail = 0;
for (const t of targets) {
    try {
        const r = await rawGet(t.url);
        let ok;
        if (t.statusOneOf) {
            ok = t.statusOneOf.includes(r.status);
        } else {
            const expectedStatus = t.status ?? 200;
            ok = r.status === expectedStatus
                && (!t.mime || (r.headers['content-type'] || '').includes(t.mime));
        }
        if (ok) { pass++; console.log(`  ok: ${t.label} → ${r.status} ${r.headers['content-type'] || ''}`); }
        else    { fail++; console.error(`  FAIL: ${t.label} → ${r.status} ${r.headers['content-type'] || ''}`); }
    } catch (e) {
        fail++; console.error(`  FAIL: ${t.label} → ${e.message}`);
    }
}

proc.kill();
console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
