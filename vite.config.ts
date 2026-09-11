import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// A unique id per build, baked into the bundle and also written to a
// version.json that the app fetches (uncached) on load. If they differ, the
// running page is a stale cache and reloads itself — see src/main.tsx.
const BUILD_ID = Date.now().toString(36)

function emitVersionFile(): Plugin {
  return {
    name: 'emit-version-file',
    apply: 'build',
    closeBundle() {
      writeFileSync(resolve(__dirname, 'dist/version.json'), JSON.stringify({ v: BUILD_ID }))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: '/Code-test/',
  plugins: [react(), emitVersionFile()],
  define: {
    __APP_VERSION__: JSON.stringify(BUILD_ID),
  },
})
