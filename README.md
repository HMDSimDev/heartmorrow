![Heartmorrow Logo](https://github.com/Heartmorrow/heartmorrow-sim/raw/master/gh/heartmorrow.svg)

# Heartmorrow — Local-First LLM Dating Simulator 💞

Heartmorrow is a fully local dating + world simulator powered by **your own** language
model. You build the cast and the world they live in, then *live* a relationship sim in
your browser: go on dates with streamed, in-character dialogue, text back and forth on an
in-game phone, play minigames, shop for gifts, and watch relationships grow, drift, define
themselves, or fall apart across a living in-game calendar.

Everything runs on your machine. The browser **never** talks to the model — it talks to a
small local server, and that server talks to whatever OpenAI-API-compatible endpoint you
point it at (LM Studio, Ollama, llama.cpp, vLLM, etc.). Your characters, saves, art, and API
keys never leave your computer.

> **No model? No problem to start.** You can install, seed, create characters, upload art,
> and explore the entire UI without an LLM connected. You only need one running to actually
> *talk* to characters and simulate the world.

---

![Screenshot of Heartmorrow dating gameplay.](https://github.com/Heartmorrow/heartmorrow-sim/raw/master/gh/1.png)

## Why you'd want to play

It's a dating sim where the people feel *authored by humans and improvised by a model* - not a
rigid, branching script. You write who they are; the model gives them a voice; and a strict rules
engine turns every conversation into real, persistent consequences. Charm someone and their
friends warm to you. Neglect them and they cool, text you "we need to talk," and eventually
leave. Make it official and the whole social web reacts. Then keep playing - there's no
forced ending.

---

## What you can do

 ![Screenshot of Heartmorrow Faces app.](https://github.com/Heartmorrow/heartmorrow-sim/raw/master/gh/6.png)

### 🗓️ Live an in-game life

A repeating **112-day year** (4 seasons × 28 days, each season starting on a Monday) with
**morning → afternoon → evening → night** phases, a day-of-week, and four fixed annual
holidays — **First Bloom** (Spring), **Midsummer Night** (Summer), the **Lantern Festival**
(Autumn, the most romantic night of the year), and the **Long Night** (Winter) — that color
the calendar, the social feed, and your dates.

- **Energy economy.** Each day gives you a small action pool — **3 actions (4 on
  weekends)**. A date, a paid event, a work shift, time spent with someone (Together), and a minigame each spend one;
  plain texting and chatting are free. Time-of-day phases aren't just decor — they advance as
  you spend energy, get pinned as hard facts in date scenes, and gate when characters' texts
  arrive. When you're out of energy, **Sleep** to end the day: you get a written recap, the
  day's events around town, and a fresh morning with new weather. Money isn't handed out —
  you earn it from work and minigames (or from wealth holdings you own).
- **Deterministic weather + moods.** Every world day has forecastable weather (browse a
  5-day forecast in the Weather app), and every character has a **mood of the day** plus
  weather they love or hate — which nudges how a date goes.
  
 ![Screenshot of Heartmorrow Messages app.](https://github.com/Heartmorrow/heartmorrow-sim/raw/master/gh/7.png)

### 💬 Go on dates

Pick a character and a place, then have a real, **streamed** conversation, one message at a
time. The model stays in character (no chatbot tics, no "happy to help"), and on a genuine
first date *they* break the ice instead of making you message a stranger.

- **Read the room.** Optional **intent chips** (Flirt, Tease, Open Up — plus Reassure and
  Apologize when there's tension) let you signal *how* you mean a line. They never move a
  stat by themselves; they make the moment land — or backfire if you misread it.
- **See how it's landing.** A live **rapport trajectory bar** ("warming to you," "a bit
  awkward," "losing interest") and a **reactive portrait** that shifts expression in
  real time tell you, without numbers, exactly how you're doing.
- **Real stakes.** Each character secretly wants something from the evening; read it well and
  you're rewarded. Be hostile or proposition crudely and they can **walk out**; let the vibe
  crater and they'll quietly make an excuse and leave early.
- **Save-safe scoring.** When you end a date, a separate validated pass turns the *whole*
  evening into relationship changes, a mood, and memories — and a flat or hurtful date won't
  help you. Start a date but never speak and it simply doesn't count.

Dates are server-truth: refresh or switch tabs and the exact conversation **auto-resumes**.

![Screenshot of a dating profile in Heartmarrow.](https://github.com/Heartmorrow/heartmorrow-sim/raw/master/gh/4.png)

### ❤️ Grow (or break) relationships

Every bond tracks **seven dimensions** — affection, trust, chemistry, comfort, respect,
curiosity, and tension. Five of them average into **warmth** (closeness), which climbs
through six stages: *near-strangers → acquaintances → warming up → getting close → close →
sweethearts*.

- **Define the Relationship.** A player-driven ladder — **Ask them out** (Dating) → **Become
  exclusive** (Exclusive) → **Move in together** (Living together) — unlocked at rising
  warmth. The character actually decides: they can accept, deflect, or **backfire** on a
  badly-timed ask.
- **Milestones** fire when you cross into a new band - a banner, a keepsake memory, a
  next-morning text, and a ripple through their social circle.
- **Breakups & reconciliation.** A committed relationship that's neglected, too tense, or hit
  by a catastrophic date goes "on the rocks" (a warning and a few days to fix it) and can
  break up. You can also end things yourself (with a confirmation, so a joke doesn't blow up
  your relationship). A broken-up partner goes cold but can be **won back** on a deliberate
  reconciliation date — though every breakup scars the bond.
- **Happy endings.** Take a romance all the way (living together, sweethearts-level, calm)
  and earn a once-per-relationship **epilogue** in the Endings gallery. It's a
  soft win - you keep playing and can pursue others if you want!
  
![Screenshot of Heartmorrow phone UI.](https://github.com/Heartmorrow/heartmorrow-sim/raw/master/gh/2.png)

### 📱 Use the in-game phone

A whole home screen of apps:

- **Messages** — text anyone you've actually dated; they text *you* between dates (and rarely
  send a gift to claim). You can start texts, attach a **photo** (read by a vision model), or
  attach a **gift** from your bag.
- **Faces** — a living social feed where the *whole cast* posts about their day and big news,
  comments on and reacts to each other based on who likes whom, and where you can post too.
- **Mail** — a (currently) read-only inbox of in-world mail, randomly generated by the LLM.
- **Almanac** — a season calendar with weather, holidays, and a per-day record of what
  happened.
- **Weather** — today's sky, a forecast, and how each character feels about it.
- **Social** — a browsable map of the cast's ties to each other and to you.
- **Moments** — a polaroid scrapbook of your relationship highlights.
- **Endings** — your gallery of earned epilogues.
- **Work** — pick up shifts for money.
- **Together** — give an afternoon to someone: time spent grows a bond, but who they are
  (fit), how bold the outing is (risk), and how often you've leaned on them that day (a
  daily cap) all shape it — and casual time alone never reaches the romantic bands, only a
  real date does.
- **Settings** — accent colors, wallpaper, play/creator mode, and a total reset.
- Plus optional, world-gated money apps (**Property**, **Market**, **Casino** — see below)
  and quick access to **Shop**, **Games**, and your **Bag**.

### 🎮 Play six minigames

Spend time with a character and grow your bond while earning a little money: **Memory Match**,
**Timing Meter**, **Lore Quiz**, **Sweet & Sour**, **Read Between the Lines**, and **Heartbeat
Serenade**. Each is graded **S → F**, and the grade scales your payout (relationship stats,
dating stats, and money). They're built from the character's *actual* likes, goals, and
boundaries - so you're literally testing how well you know them - and a good play leaves a
real reaction and a remembered moment. (Memory Match's board even grows as you get closer!)

### 🛍️ Shop, gifts & inventory

Buy gifts, consumables, and trinkets from the world's catalog with your per-world purse.
Items can boost a relationship stat, permanently raise a character's base dating stat, grant
a temporary buff, set a story flag, or give/cost money. Your **Bag is a viewer** — you give
gifts **in person on a date** or **by text**, and the character reacts *in their own voice*
based on their authored likes, dislikes, and love language. The same rare gift can delight
one person and bore another.

![Screenshot of Heartmorrow memory UI.](https://github.com/Heartmorrow/heartmorrow-sim/raw/master/gh/3.png)

### 🧠 A world with memory

Dates produce **memories** that roll up into a per-relationship narrative **chronicle** the
character references later. A hand-authored **social graph** (friends, rivals, exes, family,
partners) plus an off-screen world-sim means the cast knows each other:

- **Gossip spreads.** Word about you and about the cast travels NPC-to-NPC (getting a little
  garbled each retelling) and reaches you as gossip texts and feed posts.
- **Named jealousy.** A monogamous partner can find out you've been seeing someone else — and
  if that someone is their own ex or rival, it stings far more.
- **Recognition & vouching.** A friend you meet later might recognize you ("wait, you're the
  one Mara mentioned?"), and making things official ripples warmth through that person's
  friends and family — and chills their rivals.

### 💰 Optional money systems

Work and **Together** (time spent with people) are always on. Each world's creator can also switch on
three richer, opt-in systems (all **OFF by default**):

- **Property** — lease or buy in-world places, collect rent, and date somewhere you hold for
  a relationship buff (free venue, too).
- **Stock Market** — trade shares of fictional in-world companies whose prices drift daily —
  and a company linked to a character even **reacts to your relationship** with them.
- **Casino** — four games of chance (**Slots**, **Blackjack**, **Roulette**, and
  **Video Poker**), kept honest by a real house edge and strict per-bet and per-day wager
  caps so it can't become a money engine.

Every money move and every random draw is computed on the server — the client can never
grant itself a cent.

![Screenshot of Heartmorrow character creation.](https://github.com/Heartmorrow/heartmorrow-sim/raw/master/gh/5.png)

### 🎨 Bring your own art & author your cast

- **Upload portraits** plus per-expression face variants (happy, shy, hurt, etc.) so the right
  face shows during a date.
- **Author characters and worlds** in full editors: identity, personality, likes/goals/
  boundaries, dating stats, connections, employment, weather tastes, locations, lore, and
  content/feature flags.
- **Let the model help.** Roll a set of dating stats, draft the narrative profile, or — with a
  vision-capable model - **draft an entire character from an uploaded portrait**, fitted to
  your world's tone. You review and edit every field before saving. *(Image → text only;
  Heartmorrow does **not** currently generate images.)*

---

## Requirements

- **Node.js 20+** (developed on Node 24). Uses Node's built-in `node:sqlite`, so installation
  never compiles a native C addon.
- **pnpm** — the repo pins **`pnpm@11.7.0`** via `packageManager`, so running `corepack
  enable` once will fetch the right version automatically (or `npm i -g pnpm`).
- *(Optional, but basically needed to actually play)* an **OpenAI-API-compatible** LLM server, either local or a cloud API.

---

## Quick start

```bash
# 1. Install everything
pnpm install

# 2. (optional) create a config file — sane defaults apply without it
cp .env.example .env

# 3. Seed sample data (1 world + notes, 3 characters, shop items, properties, companies)
pnpm seed

# 4. Run the server + web client together
pnpm dev
```

Then open **http://localhost:5173**.

Next steps in the app:

1. Open **Settings** (or the phone's Settings app) and point Heartmorrow at your LLM — base
   URL, model name, etc. Use **Test connection** to confirm it works.
2. Tweak your player **persona** (name, pronouns) while you're there.
3. Go to **Date**, pick a character and a location, and start talking.

The Vite dev server proxies `/api` and `/uploads` to the API server on
**http://localhost:8787**, so you only ever need to open the one URL.

> **Want a furnished demo?** `pnpm mock` builds an isolated showcase world in `data/mock`
> (a separate save), and `pnpm dev:mock` runs against it — handy for screenshots without
> touching your real game.

### Run only the API (no frontend)

If you just want the backend — to drive it from your own client, hit the HTTP API
directly, or run headless — start the server package on its own:

```bash
# API with auto-reload (tsx watch), the way `pnpm dev` runs it
pnpm --filter @dsim/server run dev

# API once, no file watching (good for scripts / production-ish runs)
pnpm --filter @dsim/server run start

# Against the mock showcase world
pnpm --filter @dsim/server run dev:mock     # watch
pnpm --filter @dsim/server run start:mock   # no watch
```

The API listens on **http://localhost:8787** by default (`PORT` / `HOST` in `.env`). No
build step is needed — everything runs straight from TypeScript source via `tsx`. Without
the Vite dev server you won't get its `/api` and `/uploads` proxy, so call the API at its
own origin and set `CORS_ORIGINS` to match wherever your client is served from.

---

## Connecting your model

Heartmorrow works with any endpoint that speaks the OpenAI Chat Completions API. Common
choices and their default URLs:

| Provider             | Base URL                    |
| -------------------- | --------------------------- |
| **LM Studio**        | `http://localhost:1234/v1`  |
| **Ollama**           | `http://localhost:11434/v1` |
| **llama.cpp / vLLM** | `http://localhost:8000/v1`  |

Configure it once in **Settings** — base URL, API key (usually a
dummy for local servers), model name, an optional separate **vision model**, temperature,
max tokens, the structured-output mode, and the live date-feedback cadence. API keys stay
server-side and are never sent to the browser.

> **Tip:** Reasoning models spend tokens "thinking" before answering. Give them room —
> **2048+ max tokens** — or structured steps may run out mid-response.

In the future, more API-schemes will be supported.

---

## How the rules & restrictions work

Heartmorrow is built so a small or unreliable local model can never corrupt your save or
break the rules — and so heavier content is strictly opt-in.

### The server owns every rule

Plain dialogue streams as free text. But **every** change to game state - relationship
deltas, mood/expression, memories, summaries, minigame content - comes from a separate
**structured** call that is validated *before* anything is persisted. The model and the
client can only ever **propose**; the server computes and clamps the result.

The central `callStructuredLlm` helper:

1. Asks the model for JSON in your configured structured-output mode.
2. Parses **strictly** with `JSON.parse` - no regex extraction, no partial-JSON repair, no
   prose stripping.
3. Validates the result against a **Zod** schema.
4. On failure, re-prompts the model with a stricter repair prompt (the task, the schema, the
   validation errors, and its own bad output), lowering temperature each retry — and
   auto-downgrades the output mode (`json_schema → json_object → prompt_only`) if your
   endpoint rejects the format.
5. After the retry budget is exhausted, it **fails safely** — the caller does **not** mutate
   your save.

All stat changes clamp to 0–100, money is debited only when you can afford it, and prices,
item effects, and minigame rewards are all computed server-side.

### Content & safety gating

- **Everyone is an adult.** Characters must be 18+; the game refuses to save anyone younger,
  and AI-drafted characters are clamped to 18+. There is no in-game minor. Any PRs to change this will be rejected for obvious reasons.
- **Orientation-aware romance** *(opt-in).* If you set fully-specified, clearly incompatible
  orientations on both sides, romance simply won't deepen past "acquaintances" — you can stay
  friendly, but dating, milestones, and intimacy won't unlock, and the character gently says
  so. Anyone bisexual, non-binary, or unspecified is never gated.
- **Intimacy gate.** Intimate content is only permissible once you're genuinely close (high
  warmth) *and* calm (low tension) — and only if you've turned on the adult-content setting
  and are using a capable model. Character boundaries always apply.
- **Optional adult content** *(off by default).* Yes, this can support adult content. But it is gated behind an explicit toggle, and the evaluator will still be active if you try to do this on dates... so your skills will still be evaluated.
- **No AI image generation.** You bring your own art, currently. A vision model can *read* an uploaded
  portrait to draft text; nothing in the app currently synthesizes pictures.

---

## Recommended models

Any model that can reliably follow structured-output (JSON) instructions will work — since the
endpoint is OpenAI-API-compatible, you can plug in almost anything. Modern **instruct/chat**
models in the ~7B–30B range (Qwen, Llama, Mistral, Gemma families, etc.) are a good fit. For
the **optional adult content**, an *abliterated / uncensored* model is recommended. Give
reasoning models plenty of `max tokens` (2048+) so structured steps don't get cut off.

My personal recommendation is Gemma 4 26B A4B. It works quite well for this and is fast if you have a modern rig. The Qwen 3.X series is also, of course, great, I have tested both Qwen 3.6 9B and Qwen 3.6 27B and they worked acceptably. Be careful with smaller models, though, the more likely they are to start providing nonsense. In the future, it would be interesting to try this with DiffusionGemma due to its high level of speed, but I haven't personally tested it.

I also recommend turning *OFF* reasoning. Reasoning, in my experience with Gemma 4 and Qwen, seemingly has no improvement to this particular use case but makes responses take way longer.

---

## Commands

| Command          | What it does                                                                       |
| ---------------- | --------------------------------------------------------------------------------- |
| `pnpm install`   | Install all workspace dependencies.                                                |
| `pnpm dev`       | Run the API server (tsx watch) **and** the web client (Vite) in parallel.         |
| `pnpm --filter @dsim/server run dev` | Run **only** the API server (tsx watch), no frontend.                 |
| `pnpm --filter @dsim/server run start` | Run **only** the API server once, without file watching.            |
| `pnpm seed`      | Seed the database with a sample world, characters, shop items, properties & stocks.|
| `pnpm mock`      | Build the isolated showcase world (separate `data/mock` save).                     |
| `pnpm dev:mock`  | Run the app against the mock showcase world.                                       |
| `pnpm typecheck` | Type-check every package.                                                          |
| `pnpm test`      | Run all unit tests (Vitest).                                                       |
| `pnpm build`     | Build all three packages (shared, server type-check, web bundle).                 |
| `pnpm clean`     | Remove build artifacts.                                                            |

Per-package: `pnpm --filter @dsim/server run dev|start|seed|test|typecheck`,
`pnpm --filter @dsim/web run dev|build|preview`.

---

## Configuration (`.env`)

All values are optional — defaults apply when unset, and LLM settings can be changed live
from the in-app **Settings** page afterward. The `.env` only seeds the *initial* settings
row. See [`.env.example`](.env.example) for the annotated full list.

```dotenv
# Server
PORT=8787
HOST=127.0.0.1
DATA_DIR=./data
UPLOADS_DIR=./data/uploads
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173

# Default LLM provider (seeds the initial settings row only)
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio            # optional / dummy for local servers
LLM_MODEL=local-model
LLM_VISION_MODEL=                # optional; blank reuses the main model
LLM_TEMPERATURE=0.8
LLM_MAX_TOKENS=2048              # reasoning models need plenty of room
LLM_STRUCTURED_MODE=json_schema  # json_schema | json_object | prompt_only
LLM_ENDPOINT_MODE=chat_completions
LLM_MAX_RETRIES=3

# Web (Vite dev proxy target)
VITE_API_PROXY_TARGET=http://127.0.0.1:8787
```

Your save lives in `DATA_DIR/dsim.sqlite` and uploaded art in `UPLOADS_DIR` (both under
`./data` by default, created at runtime). Back up that folder to back up your game.

---

## Make it your own

- **Add a character** → [docs/ADDING_CHARACTERS.md](docs/ADDING_CHARACTERS.md)
- **Add art** → [docs/ADDING_ART.md](docs/ADDING_ART.md)
- **Add a minigame** → [docs/ADDING_MINIGAMES.md](docs/ADDING_MINIGAMES.md)
- **Add a shop item** → [docs/ADDING_SHOP_ITEMS.md](docs/ADDING_SHOP_ITEMS.md)

The character and world editors can also ask the LLM to draft a profile, roll a set of
dating stats, or build a whole character from a portrait — so you can go from idea to
dateable character in a couple of clicks.

---

## Project layout

```
packages/shared   Zod schemas, game types, stat defs, LLM/minigame/item contracts
apps/server       Fastify API, LLM adapters + structured caller, SQLite, game logic
apps/web          Vite + React client (responsive)
docs              Architecture + how-to guides
data/             Local SQLite DB + uploads (gitignored, created at runtime)
```

## Why did I make this?
So many LLM games I see try to do too much (have the LLM drive the whole game state, which is fragile) or do too little (LLMs can only provide maybe some flavor text, but not much else) or just really aren't much of a game and are just glorified chat interfaces.

I wanted to see if I could create something that is satisfying to play and actually provides enough fun side content that isn't just chatting with AI. Plus, I just wanted to see how realistic I could get it feeling. I think I got something feeling pretty good here, I am regularly surprised by how well even weak models like Gemma 4 26B A4B can generate engaging and fun dates, even if it is brutally critical of your dating skills when it acts as the turn evaluator, lol. Additionally the living breathing world, while still a heavy WIP with rough edges, is pretty cool.

## What is coming in the future?
I would like to continue improving the "world sim" aspect. Ideally the end state of this will be something so realistic you cannot really tell is actually just AI, let alone cheap local models. I think that will naturally happen as models improve, but I think there is a lot we can do to achieve that in the meantime.

Additionally, I would like to integrate image gen, video gen, TTS, etc. It would be really cool if it could generate images of the date as they play out, and have characters send you voice messages and what not. It's all possible to do, I have just never wired any of it up.

## Why am I an anonymous dev?
To be honest, I just do not want anyone to know that I made an AI dating simulator, especially not one that explicitly allows NSFW.

If you are interested in directly reaching out to me, please send me an email, which is on my GitHub profile.