import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'fs';

function copyManifestPlugin() {
  return {
    name: 'copy-manifest',
    closeBundle() {
      const outDir = resolve(__dirname, 'dist');
      // Copy manifest.json to dist
      copyFileSync(
        resolve(__dirname, 'manifest.json'),
        resolve(outDir, 'manifest.json')
      );
      // Fix offscreen HTML path: move dist/src/offscreen/ -> dist/offscreen/
      const wrongPath = resolve(outDir, 'src/offscreen/index.html');
      const correctPath = resolve(outDir, 'offscreen/index.html');
      if (existsSync(wrongPath)) {
        mkdirSync(resolve(outDir, 'offscreen'), { recursive: true });
        copyFileSync(wrongPath, correctPath);
        rmSync(resolve(outDir, 'src'), { recursive: true, force: true });
      }
    },
  };
}

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
        offscreen: resolve(__dirname, 'src/offscreen/index.html'),
        inject: resolve(__dirname, 'src/inject/index.ts'),
      },
      output: {
        entryFileNames: '[name]/index.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
        manualChunks(id) {
          if (
            id.includes('src/inject/') ||
            id.includes('src/core/stealth/')
          ) {
            return undefined;
          }
        },
      },
      preserveEntrySignatures: 'allow-extension',
    },
    target: 'esnext',
    minify: 'esbuild',
    sourcemap: process.env.NODE_ENV === 'development',
  },
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@mcp': resolve(__dirname, 'src/mcp'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  plugins: [copyManifestPlugin()],
});
