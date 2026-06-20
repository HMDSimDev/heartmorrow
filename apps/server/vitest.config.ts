import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests share module-level singletons (db, run store); keep them serial.
    fileParallelism: false,
  },
});
