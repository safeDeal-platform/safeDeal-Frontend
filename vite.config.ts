import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxy = { '/api': { target: env.SAFEDEAL_API_ORIGIN || 'http://127.0.0.1:8080', changeOrigin: true } }
  // The backend's local profile allows http://localhost:3000 by default.
  const local = { port: 3000, strictPort: true, proxy }
  return { esbuild: { jsx: 'automatic' }, server: local, preview: local }
})
