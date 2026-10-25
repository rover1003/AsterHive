import { defineConfig } from 'vite';

// 开发态：Vite 端口代理到本机分派服务器；生产态由服务器静态托管 dist（单容器）。
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/health': 'http://127.0.0.1:8067',
      '/events': 'http://127.0.0.1:8067',
      '/api': 'http://127.0.0.1:8067',
      '/boards': 'http://127.0.0.1:8067',
      '/tasks': 'http://127.0.0.1:8067',
      '/agents': 'http://127.0.0.1:8067',
      '/overview': 'http://127.0.0.1:8067',
      '/settings': 'http://127.0.0.1:8067',
    },
  },
});
