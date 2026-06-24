import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      'obsidian':            resolve(__dirname, 'src/__tests__/stubs/obsidian.ts'),
      '@codemirror/state':   resolve(__dirname, 'src/__tests__/stubs/codemirror-state.ts'),
      '@codemirror/view':    resolve(__dirname, 'src/__tests__/stubs/codemirror-view.ts'),
      '@codemirror/language': resolve(__dirname, 'src/__tests__/stubs/codemirror-language.ts'),
    },
  },
})
