// Build stamp, surfaced in the sidebar footer + Help → Support so bug reports can
// name an exact build. Values are injected by Vite `define` (see vite.config.ts);
// __GIT_COMMIT__ is "untracked" when built outside a git checkout.
export const DISCORD_URL = 'https://discord.com/invite/S9NUYM82tP';
export const GITHUB_URL = 'https://github.com/HMDSimDev/heartmorrow';

// "v0.1" — major.minor from package.json; the patch is noise for a player-facing
// label, and the exact build is pinned by the commit shown beside it.
export const APP_VERSION = `v${__APP_VERSION__.split('.').slice(0, 2).join('.')}`;
export const GIT_COMMIT = __GIT_COMMIT__;
