// 截图专用本地代理：转发到上游（SSH 隧道后的 AsterHive），但把 /events SSE 请求
// 改回 204——无头截图会被 EventSource 长连接挂住永不退出，掐断后页面其余功能照常。
// 用法：node tools/shot-proxy.mjs <上游端口> <本机监听端口>
import http from 'node:http';

const [, , upstreamArg = '18067', listenArg = '18068'] = process.argv;
const upstream = { host: '127.0.0.1', port: Number(upstreamArg) };

http
  .createServer((req, res) => {
    if (req.url === '/events' || req.url === '/api/events/stream') {
      res.writeHead(204);
      res.end();
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
    console.log(`shot-proxy: 127.0.0.1:${listenArg} -> ${upstream.port} (SSE 已掐断)`);
  });
