import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/__tests__/**/*.test.ts'],
    root: '.'
  }
});
