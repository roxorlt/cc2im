import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: 'src/web/frontend',
  build: {
    outDir: '../../../dist/web-frontend',
    emptyDirOnStart: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3721',
      '/ws': { target: 'ws://127.0.0.1:3721', ws: true },
    },
  },
})
