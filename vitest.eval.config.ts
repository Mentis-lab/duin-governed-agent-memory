import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Separate config for LIVE evals (`*.eval.ts`). These are deliberately OUTSIDE the default suite
// (vitest.config.ts includes only `*.test.ts`) because they call a real provider API with real
// keys, cost money, and are non-deterministic — none of which belongs in a regression suite.
//
// Run: npx vitest run --config vitest.eval.config.ts
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  test: {
    include: ['electron/**/*.eval.ts'],
    environment: 'node',
    testTimeout: 900_000,
    hookTimeout: 120_000
  }
})
