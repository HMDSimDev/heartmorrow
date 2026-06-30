import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LlmSettingsSchema, type LlmSettings } from '@dsim/shared';

/**
 * Central server configuration. Paths are anchored to the server package root
 * (not the current working directory) so the server behaves the same whether
 * launched from the repo root or the package directory.
 */

const SERVER_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '../..');

/** Load .env from the repo root or server root, if present (Node built-in). */
function tryLoadEnv(): void {
  for (const candidate of [path.join(REPO_ROOT, '.env'), path.join(SERVER_ROOT, '.env')]) {
    try {
      if (fs.existsSync(candidate) && typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(candidate);
      }
    } catch {
      // Ignore malformed/missing env files — defaults below still apply.
    }
  }
}
tryLoadEnv();

function resolveDir(value: string | undefined, fallback: string): string {
  const v = value && value.trim().length > 0 ? value : fallback;
  return path.isAbsolute(v) ? v : path.join(SERVER_ROOT, v);
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Mock mode: launch the server or the generator with `--mock` (or DSIM_MOCK=1)
 * and everything is redirected to a self-contained `data/mock` directory — a
 * separate SQLite database and uploads folder — so the showcase mock world
 * never touches the normal `data/dsim.sqlite`. Explicit DATA_DIR/UPLOADS_DIR/
 * DB_PATH env vars still win if set.
 */
const MOCK_MODE = process.env.DSIM_MOCK === '1' || process.argv.includes('--mock');

const dataDir = resolveDir(process.env.DATA_DIR, MOCK_MODE ? './data/mock' : './data');
const uploadsDir = resolveDir(process.env.UPLOADS_DIR, MOCK_MODE ? './data/mock/uploads' : './data/uploads');

/**
 * LLM defaults seeded from the environment. These only set the INITIAL
 * settings row; afterwards settings are edited live and stored in SQLite.
 */
function buildEnvLlmDefaults(): LlmSettings {
  const candidate = {
    baseUrl: process.env.LLM_BASE_URL,
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
    visionModel: process.env.LLM_VISION_MODEL,
    temperature: process.env.LLM_TEMPERATURE ? Number(process.env.LLM_TEMPERATURE) : undefined,
    maxTokens: process.env.LLM_MAX_TOKENS ? Number(process.env.LLM_MAX_TOKENS) : undefined,
    structuredMode: process.env.LLM_STRUCTURED_MODE,
    endpointMode: process.env.LLM_ENDPOINT_MODE,
    anthropicVersion: process.env.LLM_ANTHROPIC_VERSION,
    ollamaThink: process.env.LLM_OLLAMA_THINK,
    maxRetries: process.env.LLM_MAX_RETRIES ? Number(process.env.LLM_MAX_RETRIES) : undefined,
  };
  // Drop undefined keys so schema defaults take over.
  const cleaned = Object.fromEntries(
    Object.entries(candidate).filter(([, v]) => v !== undefined && !(typeof v === 'number' && Number.isNaN(v))),
  );
  const parsed = LlmSettingsSchema.safeParse(cleaned);
  return parsed.success ? parsed.data : LlmSettingsSchema.parse({});
}

export const config = {
  serverRoot: SERVER_ROOT,
  repoRoot: REPO_ROOT,
  mockMode: MOCK_MODE,
  port: num(process.env.PORT, 8787),
  host: process.env.HOST ?? '127.0.0.1',
  dataDir,
  uploadsDir,
  dbPath: process.env.DB_PATH ?? path.join(dataDir, 'dsim.sqlite'),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  llmDefaults: buildEnvLlmDefaults(),
} as const;

/** Ensure data + uploads directories exist. Safe to call repeatedly. */
export function ensureDirectories(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });
}
