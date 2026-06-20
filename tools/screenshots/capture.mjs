/**
 * Capture 1920×1080 screenshots of the DSim showcase ("Asterfall Bay") mock world
 * by driving the running web app with a headless Chromium.
 *
 * PREREQUISITES (run these once, from the repo root):
 *   1. pnpm mock                 # generate the Asterfall Bay world into data/mock
 *   2. pnpm dev:mock             # start server (mock DB) + web on http://localhost:5173
 *   3. cd tools/screenshots && npm install   # installs Playwright + Chromium
 *
 * THEN:
 *   npm run shoot                # writes PNGs into ./out
 *
 * Options (env vars):
 *   BASE_URL   web origin to hit            (default http://localhost:5173)
 *   OUT        output directory             (default ./out)
 *   SCALE      device scale factor 1|2|3    (default 1 → exact 1920×1080 files;
 *                                            set 2 for crisper retina shots)
 *   HEADED     set to 1 to watch it run     (default headless)
 *   WORLD      world name to shoot          (default "Asterfall Bay")
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const OUT = process.env.OUT ?? path.join(process.cwd(), 'out');
const SCALE = Number(process.env.SCALE ?? '1') || 1;
const HEADED = process.env.HEADED === '1';
const WORLD_NAME = process.env.WORLD ?? 'Asterfall Bay';

const WIDTH = 1920;
const HEIGHT = 1080;
const ACTIVE_WORLD_KEY = 'dsim.activeWorldId';
const CREATOR_KEY = 'dsim.creatorMode';

const log = (...a) => console.log('•', ...a);

/** Discover world + character ids straight from the API (via the web proxy). */
async function discover() {
  const api = async (p) => {
    const res = await fetch(`${BASE_URL}/api${p}`);
    if (!res.ok) throw new Error(`GET /api${p} → ${res.status}`);
    return res.json();
  };
  let worlds;
  try {
    worlds = await api('/worlds');
  } catch (e) {
    throw new Error(
      `Could not reach the app at ${BASE_URL} (${e.message}).\n` +
        `Is it running? Start it with:  pnpm dev:mock   (from the repo root)`,
    );
  }
  const world = worlds.find((w) => w.name === WORLD_NAME);
  if (!world) {
    throw new Error(
      `World "${WORLD_NAME}" not found. Generate it first with:  pnpm mock\n` +
        `(and make sure the server is running in --mock mode: pnpm dev:mock)`,
    );
  }
  const chars = await api(`/characters?worldId=${encodeURIComponent(world.id)}`);
  const byName = (needle) => chars.find((c) => c.name.includes(needle));
  return {
    worldId: world.id,
    sofia: byName('Sof'),
    minhAn: byName('Minh An'),
    luca: byName('Luca'),
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const ids = await discover();
  log(`World "${WORLD_NAME}" → ${ids.worldId}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: SCALE,
  });
  // Boot straight into the world (the app keeps the active world in localStorage),
  // and turn OFF creator mode so every app shows its player-facing surface (the
  // Market portfolio, not the company-authoring form, etc.) and the chrome stays clean.
  await context.addInitScript((args) => {
    localStorage.setItem(args.key, args.worldId);
    localStorage.setItem(args.creatorKey, 'false');
  }, { key: ACTIVE_WORLD_KEY, creatorKey: CREATOR_KEY, worldId: ids.worldId });

  const page = await context.newPage();

  let n = 0;
  const shot = async (name) => {
    n += 1;
    const file = path.join(OUT, `${String(n).padStart(2, '0')}-${name}.png`);
    // Fonts + lazy images settle before the frame is grabbed.
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.waitForTimeout(450);
    await page.screenshot({ path: file }); // viewport-only ⇒ exactly 1920×1080 (× SCALE)
    log(`saved ${path.basename(file)}`);
  };

  const go = async (route) => {
    // The app uses a history-API router (createBrowserRouter): clean paths, no hash.
    await page.goto(`${BASE_URL}${route}`, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(600);
  };

  // Open the phone and (optionally) tap into one of its apps by visible label.
  const openPhoneApp = async (label) => {
    await go('/phone');
    if (label) {
      await page.locator(`button.ph-app[title="${label}"]`).first().click();
      await page.waitForTimeout(700);
    }
  };

  // 1) Phone home screen ----------------------------------------------------
  await openPhoneApp(null);
  await shot('phone-home');

  // 2) Date screen (the in-progress date with Minh An auto-resumes here) -----
  await go('/chat');
  await page.waitForTimeout(900); // let the resumed transcript paint
  await shot('date');

  // 3) Messages app — the full thread list ----------------------------------
  await openPhoneApp('Messages');
  await shot('messages');

  // 4) Minh An's thread (shows the texted naked-banana photo) ----------------
  await page.locator('button.pcom-row', { hasText: 'Minh An' }).first().click();
  await page.waitForTimeout(500);
  // Wait for the attached image to actually decode before the grab.
  await page
    .locator('.phone-app img[src*="/uploads"], .pcom-thread img')
    .last()
    .waitFor({ state: 'visible', timeout: 4000 })
    .catch(() => {});
  await page.waitForTimeout(500);
  await shot('thread-minh-an');

  // 5) Faces app (the social feed) ------------------------------------------
  await openPhoneApp('Faces');
  await shot('faces');

  // 6) People screen ---------------------------------------------------------
  await go('/characters');
  await shot('people');

  // 7) Sofía's character page — Memories tab --------------------------------
  if (ids.sofia) {
    await go(`/characters/${ids.sofia.id}`);
    await page.getByRole('button', { name: 'Memories' }).first().click().catch(async () => {
      await page.locator('.prof-tab', { hasText: 'Memories' }).first().click();
    });
    await page.waitForTimeout(600);
    await shot('sofia-memories');
  }

  // --- Bonus shots worth highlighting on Reddit ----------------------------

  // 8) Dashboard / world home (relationships at a glance)
  await go('/');
  await shot('home-dashboard');

  // 9) Almanac (Calendar) — persisted day recaps
  await openPhoneApp('Almanac');
  await shot('almanac-calendar');

  // 10) Market — the stock portfolio reacting to the world
  await openPhoneApp('Market');
  await shot('market-stocks');

  // 11) Property — owned flat, leased studio, listings
  await openPhoneApp('Property');
  await shot('property');

  // 12) Casino — the gambling history
  await openPhoneApp('Casino');
  await shot('casino');

  // 13) Endings — the realized happy ending (Luca)
  await openPhoneApp('Endings');
  await shot('endings');

  // 14) Luca's character page (the full, lived-in profile + chronicle)
  if (ids.luca) {
    await go(`/characters/${ids.luca.id}`);
    await shot('luca-profile');
  }

  await browser.close();
  log(`Done — ${n} screenshots in ${OUT}`);
}

main().catch((e) => {
  console.error('\n✗', e.message, '\n');
  process.exit(1);
});
