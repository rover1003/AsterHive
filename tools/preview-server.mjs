// 预览服务器：本地静态（apps/web/dist 新构建的 UI）+ 其余请求代理到上游（SSH 隧道后的 199），
// SSE /events 就地掐断供无头浏览器使用。新 UI 迭代不用先部署。
// 用法：node tools/preview-server.mjs <上游端口 18067> <监听端口 18069>
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const [, , upstreamArg = '18067', listenArg = '18069'] = process.argv;
const upstream = { host: '127.0.0.1', port: Number(upstreamArg) };
const DIST = join(process.cwd(), 'apps', 'web', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

http
  .createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(204);
      res.end();
      return;
    }
    // 本地静态优先：/ 与 /assets/*
    const path = req.url === '/' || req.url.startsWith('/#') ? '/index.html' : req.url.split('?')[0];
    const file = join(DIST, path);
    if ((path === '/index.html' || path.startsWith('/assets/')) && existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      createReadStream(file).pipe(res);
      return;
    }
    const proxied = http.request({ ...upstream, path: req.url, method: req.method, headers: { ...req.headers, host: '127.0.0.1' } }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    proxied.on('error', () => {
      res.writeHead(502);
      res.end('proxy error');
    });
    req.pipe(proxied);
  })
  .listen(Number(listenArg), '127.0.0.1', () => {
    console.log(`preview: 127.0.0.1:${listenArg} 静态=${DIST} 上游=${upstream.port}（SSE 已掐断）`);
  });
