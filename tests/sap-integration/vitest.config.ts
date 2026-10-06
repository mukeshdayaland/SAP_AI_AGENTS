import { defineConfig } from 'vitest/config';

/** SAP integration tests: real S/4HANA through the deployed application. Not part of `npm test`. */
export default defineConfig({
  test: {
    include: ['tests/sap-integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
    // The steps of a process build on each other and post to the same system: one at a time, in order.
    fileParallelism: false,
    sequence: { concurrent: false },
    bail: 1,
  },
});
