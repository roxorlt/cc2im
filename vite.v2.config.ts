import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: 'src/web/frontend-v2',
  build: {
    outDir: '../../../dist/web-frontend-v2',
    emptyDirOnStart: true,
  },
  server: {
    port: 3722,
    proxy: {
      '/api': 'http://127.0.0.1:3721',
      '/ws': { target: 'ws://127.0.0.1:3721', ws: true },
    },
  },
})
