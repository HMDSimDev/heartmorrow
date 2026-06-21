import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CharacterCreateSchema, LumberjackConfigSchema, WriterConfigSchema, type ShopItemCreate } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { playerIdForWorld } from '../lib/ids';
import { setAdapterOverride } from '../llm/provider';
import { createShopItem, purchaseItem, useItem } from './shop-service';
import { getOrCreatePlayer, addMoney } from './player-service';
import { getRelationship } from './relationship-service';
import { getCharacter } from './character-service';
import { applyRelationshipChange } from './stat-service';
import { effectiveDatingStats } from './buffs';
import { startMinigame, finishMinigame } from './minigame-service';
import { ensureWorldState } from './world-clock-service';
import { safeUploadsPath, saveUploadedAsset, deleteAsset } from './asset-service';
import { createSession, addPlayerMessage, endSession } from './conversation-service';
import { exportAll, importAll } from './data-service';
import { charactersRepo, worldsRepo } from '../db/repositories';

function item(partial: Partial<ShopItemCreate> & { name: string }): ShopItemCreate {
  return {
    name: partial.name,
    description: partial.description ?? '',
    price: partial.price ?? 0,
    category: partial.category ?? 'gift',
    rarity: partial.rarity ?? 'common',
    effects: partial.effects ?? [],
    infiniteStock: partial.infiniteStock ?? true,
    stock: partial.stock ?? 0,
    assetId: partial.assetId ?? null,
  };
}

// A 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('shop purchase', () => {
  it('validates money', () => {
    addMoney(200); // fund the wallet — money is no longer handed out
    const player = getOrCreatePlayer();
    const flowers = createShopItem(item({ name: 'Flowers', price: 50 }));
    const res = purchaseItem(flowers.id, 1);
    expect(res.player.money).toBe(player.money - 50);
    expect(res.inventoryItem.quantity).toBe(1);
    // Too expensive now.
    expect(() => purchaseItem(flowers.id, 999)).toThrow(/Insufficient funds/);
  });

  it('validates stock', () => {
    addMoney(10); // fund the wallet for the purchase
    const rare = createShopItem(item({ name: 'Rare', price: 1, infiniteStock: false, stock: 1 }));
    purchaseItem(rare.id, 1); // ok, stock -> 0
    expect(() => purchaseItem(rare.id, 1)).toThrow(/stock/i);
  });
});

describe('inventory item use applies typed effects', () => {
  it('applies a relationship effect', () => {
    const { character } = seedWorldAndCharacter();
    const baseline = getRelationship(character.id).affection;
    const gift = createShopItem(item({ name: 'Bouquet', effects: [{ kind: 'relationship', stat: 'affection', delta: 5 }] }));
    const inv = purchaseItem(gift.id, 1).inventoryItem;
    const result = useItem(inv.id, character.id);
    expect(result.relationship?.affection).toBe(baseline + 5);
    expect(result.inventoryItem.quantity).toBe(0);
  });

  it('applies a dating-stat effect to the character', () => {
    const { character } = seedWorldAndCharacter();
    const before = getCharacter(character.id).datingStats.intellect;
    const book = createShopItem(item({ name: 'Book', effects: [{ kind: 'dating', stat: 'intellect', delta: 3 }] }));
    const inv = purchaseItem(book.id, 1).inventoryItem;
    const result = useItem(inv.id, character.id);
    expect(result.character?.datingStats.intellect).toBe(before + 3);
  });

  it('applies a temporary buff to effective stats only', () => {
    const { character } = seedWorldAndCharacter();
    const baseStyle = getCharacter(character.id).datingStats.style;
    const outfit = createShopItem(
      item({ name: 'Outfit', effects: [{ kind: 'temp_buff', stat: 'style', delta: 8, durationSessions: 2 }] }),
    );
    const inv = purchaseItem(outfit.id, 1).inventoryItem;
    const result = useItem(inv.id, character.id);
    // Base stat unchanged; effective stat reflects the buff.
    expect(getCharacter(character.id).datingStats.style).toBe(baseStyle);
    const eff = effectiveDatingStats(getCharacter(character.id).datingStats, result.relationship!.flags);
    expect(eff.style).toBe(baseStyle + 8);
  });

  it('applies a money effect without requiring a character', () => {
    const money = createShopItem(item({ name: 'Cash', effects: [{ kind: 'money', delta: 100 }] }));
    const inv = purchaseItem(money.id, 1).inventoryItem;
    const before = getOrCreatePlayer().money;
    useItem(inv.id, null);
    expect(getOrCreatePlayer().money).toBe(before + 100);
  });
});

describe('item effect bounds', () => {
  it('rejects an unbounded money effect (no minting)', () => {
    expect(() => createShopItem(item({ name: 'Cheat', effects: [{ kind: 'money', delta: 1_000_000 }] }))).toThrow();
  });
  it('accepts a sane money effect', () => {
    const created = createShopItem(item({ name: 'Allowance', effects: [{ kind: 'money', delta: 100 }] }));
    expect(created.effects).toHaveLength(1);
  });
});

describe('data export / import', () => {
  it('round-trips local data faithfully', () => {
    const { character } = seedWorldAndCharacter();
    createShopItem(item({ name: 'Gift', price: 10 }));
    const bundle = exportAll();
    expect(bundle.worlds).toHaveLength(1);
    expect(bundle.characters).toHaveLength(1);
    expect(bundle.shopItems.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(bundle.minigameResults)).toBe(true);

    importAll(bundle);
    expect(worldsRepo.list()).toHaveLength(1);
    expect(charactersRepo.list()[0]?.id).toBe(character.id);
  });
});

describe('central stat service clamps', () => {
  it('clamps relationship stats to [0,100]', () => {
    const { character } = seedWorldAndCharacter();
    applyRelationshipChange(character.id, { affection: 999 }, { source: 'test' });
    expect(getRelationship(character.id).affection).toBe(100);
    applyRelationshipChange(character.id, { affection: -999 }, { source: 'test' });
    expect(getRelationship(character.id).affection).toBe(0);
  });
});

describe('character age validation', () => {
  it('rejects characters under 18', () => {
    expect(() => CharacterCreateSchema.parse({ name: 'Too Young', age: 17 })).toThrow();
  });
  it('accepts adults', () => {
    const parsed = CharacterCreateSchema.parse({ name: 'Adult', age: 18 });
    expect(parsed.age).toBe(18);
  });
});

describe('asset safety', () => {
  it('blocks path traversal', () => {
    expect(() => safeUploadsPath('../../etc/passwd')).toThrow(/escapes/);
    expect(() => safeUploadsPath('..\\..\\windows\\system32')).toThrow(/escapes/);
  });

  it('rejects disallowed mime types', () => {
    expect(() =>
      saveUploadedAsset({ buffer: Buffer.from('hello'), originalFilename: 'x.txt', mimeType: 'text/plain', type: 'other' }),
    ).toThrow(/Unsupported/);
  });

  it('stores a safe generated filename for valid uploads', () => {
    const asset = saveUploadedAsset({
      buffer: PNG_BYTES,
      originalFilename: '../../evil.png',
      mimeType: 'image/png',
      type: 'portrait',
    });
    expect(asset.path).not.toContain('..');
    expect(asset.path).toMatch(/\.png$/);
    deleteAsset(asset.id); // clean up the test file
  });
});

describe('minigame rewards are server-authoritative', () => {
  it('clamps impossible client submissions and bounds rewards', async () => {
    const { character } = seedWorldAndCharacter();
    const start = await startMinigame({ minigameId: 'memory_match', characterId: character.id, worldId: null });
    expect(start.runId).toBeTruthy();

    const before = getRelationship(character.id).curiosity;
    const res = finishMinigame({
      runId: start.runId,
      submission: { minigameId: 'memory_match', submission: { pairsMatched: 99999, moves: 0, timeMs: 0 } },
    });
    // No matter what the client claims, rewards are capped.
    expect(res.result.reward.relationship.curiosity ?? 0).toBeLessThanOrEqual(10);
    expect(res.result.score).toBeLessThanOrEqual(100);
    const after = getRelationship(character.id).curiosity;
    expect(after - before).toBeLessThanOrEqual(10);
  });

  it('rejects a submission for a different minigame', async () => {
    const { character } = seedWorldAndCharacter();
    const start = await startMinigame({ minigameId: 'memory_match', characterId: character.id, worldId: null });
    expect(() =>
      finishMinigame({
        runId: start.runId,
        submission: { minigameId: 'timing_meter', submission: { rounds: [{ accuracy: 1 }] } },
      }),
    ).toThrow();
  });

  it('rejects an unknown run id', () => {
    expect(() =>
      finishMinigame({
        runId: 'does-not-exist',
        submission: { minigameId: 'memory_match', submission: { pairsMatched: 1, moves: 1, timeMs: 1 } },
      }),
    ).toThrow();
  });
});

describe('lumberjack — a money-only skill job', () => {
  it('pays coin for a clean shift and never touches a relationship (runs character-less)', async () => {
    const { world, character } = seedWorldAndCharacter();
    const wallet = playerIdForWorld(world.id);
    const beforeMoney = getOrCreatePlayer(wallet).money;
    const beforeComfort = getRelationship(character.id).comfort;
    const beforeStamina = ensureWorldState(world.id).stamina;

    const start = await startMinigame({ minigameId: 'lumberjack', characterId: null, worldId: world.id });
    const config = LumberjackConfigSchema.parse(start.config);
    // A flawless shift: every swing dead on the grain.
    const swings = config.logs.map(() => ({ accuracy: 1 }));
    const res = finishMinigame({ runId: start.runId, submission: { minigameId: 'lumberjack', submission: { swings } } });

    expect(res.result.grade).toBe('S');
    expect(res.result.reward.money).toBeGreaterThan(0);
    expect(res.result.reward.money).toBeLessThanOrEqual(100);
    expect(getOrCreatePlayer(wallet).money).toBe(beforeMoney + res.result.reward.money);
    // No character on a job run — no bond movement, no reaction, but it still costs a daily action.
    expect(res.reaction).toBeNull();
    expect(getRelationship(character.id).comfort).toBe(beforeComfort);
    expect(ensureWorldState(world.id).stamina).toBe(beforeStamina - 1);
  });

  it('a botched shift earns nothing (grade F)', async () => {
    const { world } = seedWorldAndCharacter();
    const start = await startMinigame({ minigameId: 'lumberjack', characterId: null, worldId: world.id });
    const config = LumberjackConfigSchema.parse(start.config);
    const swings = config.logs.map(() => ({ accuracy: 0 }));
    const res = finishMinigame({ runId: start.runId, submission: { minigameId: 'lumberjack', submission: { swings } } });
    expect(res.result.grade).toBe('F');
    expect(res.result.reward.money).toBe(0);
  });

  it('a flop never dents a relationship, even with a partner selected (a job is impersonal)', async () => {
    const { world, character } = seedWorldAndCharacter();
    applyRelationshipChange(character.id, { comfort: 30 }, { source: 'test' });
    const comfortBefore = getRelationship(character.id).comfort;
    const tensionBefore = getRelationship(character.id).tension;
    // Even if the arcade passes a partner, a money-only job must ignore them.
    const start = await startMinigame({ minigameId: 'lumberjack', characterId: character.id, worldId: world.id });
    const config = LumberjackConfigSchema.parse(start.config);
    const swings = config.logs.map(() => ({ accuracy: 0 })); // grade F
    const res = finishMinigame({ runId: start.runId, submission: { minigameId: 'lumberjack', submission: { swings } } });
    expect(res.result.grade).toBe('F');
    expect(res.result.characterId).toBeNull(); // not attributed to the partner
    const rel = getRelationship(character.id);
    expect(rel.comfort).toBe(comfortBefore); // no FLOP_PENALTY
    expect(rel.tension).toBe(tensionBefore);
  });
});

describe('writer (The Copy Desk) — an LLM-copy typing job', () => {
  it('pays for a clean, fast transcription and stays money-only', async () => {
    const { world } = seedWorldAndCharacter();
    const wallet = playerIdForWorld(world.id);
    // A valid generated dispatch so build() takes the LLM path deterministically.
    const dispatch = JSON.stringify({
      headline: 'Quiet Morning on the Pier',
      body: 'The tide came in soft over the harbor stones this morning, and the gulls wheeled low above the empty market stalls as the town slowly stirred to its small and certain routines.',
    });
    setAdapterOverride(new ScriptedAdapter([dispatch]));

    const beforeMoney = getOrCreatePlayer(wallet).money;
    const start = await startMinigame({ minigameId: 'writer', characterId: null, worldId: world.id });
    const config = WriterConfigSchema.parse(start.config);
    expect(config.source).toBe('llm');
    expect(config.passage.length).toBeGreaterThan(0);

    // Transcribe it perfectly and fast.
    const res = finishMinigame({
      runId: start.runId,
      submission: { minigameId: 'writer', submission: { typed: config.passage, elapsedMs: 1000 } },
    });
    expect(res.result.grade).toBe('S');
    expect(res.result.reward.money).toBeGreaterThan(0);
    expect(res.result.reward.money).toBeLessThanOrEqual(100);
    expect(getOrCreatePlayer(wallet).money).toBe(beforeMoney + res.result.reward.money);
    expect(res.reaction).toBeNull();
  });

  it('falls back to deterministic copy when generation fails, and a blank submission earns F', async () => {
    const { world } = seedWorldAndCharacter();
    // Adapter always returns junk, so structured generation fails → fallback copy.
    setAdapterOverride(new ScriptedAdapter(['not json', 'still not json', 'nope', 'no']));
    const start = await startMinigame({ minigameId: 'writer', characterId: null, worldId: world.id });
    const config = WriterConfigSchema.parse(start.config);
    expect(config.source).toBe('fallback');
    expect(config.passage.length).toBeGreaterThan(0);

    const res = finishMinigame({
      runId: start.runId,
      submission: { minigameId: 'writer', submission: { typed: '', elapsedMs: 0 } },
    });
    expect(res.result.grade).toBe('F');
    expect(res.result.reward.money).toBe(0);
  });
});

describe('failed structured evaluation does not mutate state', () => {
  it('leaves relationship + memories untouched when evaluation fails', async () => {
    const { character } = seedWorldAndCharacter();
    const baseline = getRelationship(character.id);
    const session = createSession({ characterId: character.id, mode: 'chat', locationId: null });
    addPlayerMessage(session.id, 'Hello, lovely to meet you!');

    // Adapter always returns invalid output, so the structured eval fails.
    setAdapterOverride(new ScriptedAdapter(['this is not json']));

    const res = await endSession(session.id);
    expect(res.evaluated).toBe(false);
    expect(res.evalError).toBeTruthy();
    expect(res.memoriesWritten).toBe(0);

    const after = getRelationship(character.id);
    expect(after.affection).toBe(baseline.affection);
    expect(after.trust).toBe(baseline.trust);
  });
});
