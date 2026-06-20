# Heartmorrow showcase screenshots

Captures 1920×1080 PNGs of the **Asterfall Bay** mock world by driving the running
web app with a headless Chromium (Playwright). Built for Reddit / press shots.

## One-time setup

```bash
# from the repo root
pnpm mock          # generate the Asterfall Bay world into data/mock (idempotent)

# in this folder
cd tools/screenshots
npm install        # installs Playwright and downloads Chromium
```

## Capture

```bash
# 1) start the app against the mock DB (repo root), leave it running:
pnpm dev:mock      # server (mock DB) + web on http://localhost:5173

# 2) take the shots (this folder):
npm run shoot      # writes PNGs into ./out
```

## What it captures

| # | File | Screen |
|---|------|--------|
| 1 | `01-phone-home` | Phone home screen (app grid) |
| 2 | `02-date` | The in-progress date with Nguyễn Minh An (auto-resumes) |
| 3 | `03-messages` | Messages app — full thread list |
| 4 | `04-thread-minh-an` | Minh An's message thread |
| 5 | `05-faces` | Faces app (the social feed) |
| 6 | `06-people` | People screen (the cast) |
| 7 | `07-sofia-memories` | Sofía's character page, Memories tab |
| 8 | `08-home-dashboard` | World home / relationships dashboard |
| 9 | `09-almanac-calendar` | Almanac — persisted day recaps |
| 10 | `10-market-stocks` | Stock portfolio reacting to the world |
| 11 | `11-property` | Property — owned flat, leased studio, listings |
| 12 | `12-casino` | Casino gambling history |
| 13 | `13-endings` | The realized happy ending (Luca) |
| 14 | `14-luca-profile` | Luca's full character profile |

## Options (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `BASE_URL` | `http://localhost:5173` | web origin to hit |
| `OUT` | `./out` | output directory |
| `SCALE` | `1` | device scale factor — set `2` for crisper retina shots (files become 3840×2160) |
| `HEADED` | – | set `1` to watch the browser drive itself |
| `WORLD` | `Asterfall Bay` | world name to shoot |

Examples:

```bash
SCALE=2 npm run shoot          # retina-crisp
HEADED=1 npm run shoot         # watch it work
```
