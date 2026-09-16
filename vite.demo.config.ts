import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/** 源码内部 import 带显式 `.ts` 扩展名（Node 原生跑 TS 单测需要）：去掉扩展名再交给 Vite 解析 */
function stripTsExtension(): Plugin {
  return {
    name: 'media-player-strip-ts-extension',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!/\.tsx?$/.test(source)) return null
      const stripped = source.replace(/\.tsx?$/, '')
      return this.resolve(stripped, importer, { ...options, skipSelf: true })
    },
  }
}

// 独立示例页构建：demo/index.html + demo/main.tsx → build/demo/**
// 用**相对 base**，构建产物可以直接 file:// 打开做离线自检（零外网、零后端）。
// 素材来自 demo/public/**（由 scripts/gen-placeholder-assets.mjs 本地生成）。
export default defineConfig({
  root: fileURLToPath(new URL('./demo', import.meta.url)),
  base: './',
  plugins: [stripTsExtension(), react()],
  resolve: {
    alias: {
      '@media-player': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./build/demo', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  server: {
    port: 5181,
    strictPort: false,
  },
})
