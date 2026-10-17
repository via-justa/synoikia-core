import { quickpickle } from 'quickpickle';
import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.ts';

// `pnpm test:coverage`: the security-critical modules must stay well covered (design §13). Floors are
// set a little under the measured coverage, so a change that drops it has to add tests.
const floor = (lines: number, functions: number, branches: number, statements: number) => ({
  lines,
  functions,
  branches,
  statements,
});

export default mergeConfig(
  shared,
  defineConfig({
    plugins: [quickpickle({ todoTags: ['@todo', '@wip', '@backlog'] })],
    test: {
      // Feature files run as tests (docs/workflow.md). Only they load the World, so test files keep their vi.mock calls.
      projects: [
        { extends: true, test: { name: 'unit', include: ['test/**/*.test.ts'] } },
        {
          extends: true,
          test: {
            name: 'features',
            include: ['features/**/*.feature'],
            exclude: ['test/**'],
            setupFiles: ['features/support/index.ts'],
          },
        },
      ],
      coverage: {
        provider: 'v8',
        include: ['src/**/*.ts'],
        reporter: ['text-summary', 'html'],
        thresholds: {
          'src/gate/**': floor(95, 98, 88, 93),
          'src/auth/**': floor(86, 82, 75, 82),
          'src/approvals/**': floor(96, 94, 86, 93),
          'src/sandbox/**': floor(95, 98, 76, 93),
          'src/crypto/**': floor(93, 86, 95, 92),
        },
      },
    },
  }),
);
