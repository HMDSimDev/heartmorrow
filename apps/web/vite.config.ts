import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8787';

const appVersion = createRequire(import.meta.url)('./package.json').version as string;

// Short commit of the build. Falls back to "untracked" when there's no git repo
// (e.g. a packaged/downloaded copy) so the footer can say so instead of crashing.
// execFileSync (no shell) with fixed args — nothing here is interpolated, so there's
// no injection surface, and skipping the shell keeps it that way by construction.
function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return 'untracked';
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __GIT_COMMIT__: JSON.stringify(gitCommit()),
  },
  plugins: [react()],
  resolve: {
    alias: {
      // Resolve the shared workspace package straight to its TS source.
      '@dsim/shared': path.resolve(rootDir, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/uploads': { target: apiTarget, changeOrigin: true },
    },
  },
});
