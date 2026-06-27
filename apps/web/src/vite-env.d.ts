/// <reference types="vite/client" />

// Build-time constants injected by Vite `define` (see vite.config.ts).
/** App version from package.json, e.g. "0.1.0". */
declare const __APP_VERSION__: string;
/** Short git commit of the build, or "untracked" outside a git checkout. */
declare const __GIT_COMMIT__: string;
