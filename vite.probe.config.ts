import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/** 源码内部 import 带显式 `.ts`/`.tsx` 扩展名（Node 原生跑 TS 单测需要）：去掉扩展名再交给 Vite 解析 */
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

// 运行态探针页构建：examples/runtime-probe/** → build/probe/**
//
// 页面直接消费 **dist**（库产物）而不是 src —— 验收脚本因此同时覆盖"构建产物可用"，
// 避免"源码能跑、打包产物坏掉"这类只在交付时暴露的问题。
// 素材来自 demo/public/**（由 scripts/gen-placeholder-assets.mjs 本地生成），零外网。
// `base: './'`：构建产物可直接 file:// 打开做离线自检。
export default defineConfig({
  root: fileURLToPath(new URL('./examples/runtime-probe', import.meta.url)),
  base: './',
  plugins: [stripTsExtension(), react()],
  build: {
    outDir: fileURLToPath(new URL('./build/probe', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        // 汇总探针（headless 可跑）
        index: fileURLToPath(new URL('./examples/runtime-probe/index.html', import.meta.url)),
        // 交互式探针（需有头窗口 + 真实用户手势）
        interactive: fileURLToPath(new URL('./examples/runtime-probe/interactive.html', import.meta.url)),
      },
    },
  },
})
