import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const vendorChunkGroups = [
  {
    name: 'vendor-vue',
    packages: ['vue', 'vue-router', 'pinia', 'vue-i18n'],
    prefixes: ['@vue/'],
  },
  {
    name: 'vendor-icons',
    packages: ['lucide-vue-next'],
  },
  {
    name: 'vendor-markdown',
    packages: ['markdown-it', 'dompurify', 'entities', 'linkify-it', 'mdurl', 'uc.micro'],
  },
  {
    name: 'vendor-qrcode',
    packages: ['qrcode', 'dijkstrajs', 'pngjs'],
  },
  {
    name: 'vendor-http',
    packages: ['axios'],
  },
]

const getNodeModulePackageName = (id) => {
  const marker = '/node_modules/'
  const markerIndex = id.lastIndexOf(marker)
  if (markerIndex === -1) return ''

  const modulePath = id.slice(markerIndex + marker.length)
  const parts = modulePath.split('/')
  if (parts[0]?.startsWith('@')) return `${parts[0]}/${parts[1] || ''}`
  return parts[0] || ''
}

const findVendorChunkName = (packageName) => {
  for (const group of vendorChunkGroups) {
    if (group.packages.includes(packageName)) return group.name
    if (group.prefixes?.some((prefix) => packageName.startsWith(prefix))) return group.name
  }
  return undefined
}

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 18786,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:18787',
        changeOrigin: true,
      },
      '/s/': {
        target: 'http://127.0.0.1:18787',
        changeOrigin: true,
      },
      '/f/': {
        target: 'http://127.0.0.1:18787',
        changeOrigin: true,
      },
      '/t/': {
        target: 'http://127.0.0.1:18787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined
          return findVendorChunkName(getNodeModulePackageName(id))
        },
      },
    },
  },
})
