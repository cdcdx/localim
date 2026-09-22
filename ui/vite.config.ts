import { defineConfig } from 'vite'

// LocalIM WebUI 开发服务器。
// - 默认 5173 端口，可通过 `npm run dev -- --port 5174` 覆盖。
// - 生产形态：由 native 嵌入器以本地资源方式加载本目录的构建产物（out/webui）。
export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: 'out/webui',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
})