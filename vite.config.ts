import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * 源码内部 import 带显式 `.ts` / `.tsx` 扩展名 —— 这是为了让
 * `node tests/unit-test.mjs` 能**直接跑 TS 源码**（Node 的 ESM 解析要求显式扩展名）。
 * 打包器默认不带 tsconfig 的 allowImportingTsExtensions 语义，故在此去掉扩展名再交给 Vite 解析。
 */
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

// 库构建：产出可被宿主 import 的 ESM 包（react / react-dom 走 peerDependencies，不打进产物）。
// 唯一入口 = src/index.ts（契约 §1.1：宿主 MUST NOT 从 src/** 深层路径导入）。
export default defineConfig({
  plugins: [stripTsExtension(), react()],
  resolve: {
    alias: {
      '@media-player': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      name: 'MediaPlayer',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    },
  },
})
