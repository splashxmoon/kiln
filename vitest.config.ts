import { defineConfig } from 'vitest/config'

// Unit tests for the parts that don't need a browser: file format migrations, codegen,
// shortcut labels. Run with `npm test`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
