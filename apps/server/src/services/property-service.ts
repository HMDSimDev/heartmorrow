import {
  PropertySchema,
  PropertyOwnershipSchema,
  PropertyLeaseSchema,
  PropertyCategorySchema,
  RelationshipStatKeySchema,
  RentCadenceSchema,
  PropertyGenerationSchema,
  GeneratePropertiesInputSchema,
  PROPERTY_GEN,
  rentCadenceDays,
  type Property,
  type PropertyCreate,
  type PropertyUpdate,
  type PropertyOwnership,
  type PropertyView,
  type PropertyLease,
  type LeaseResponse,
  type GeneratedProperty,
  type GeneratePropertiesParsed,
  type BuyPropertyResponse,
  type SellPropertyResponse,
  type StructuredResult,
} from '@dsim/shared';
import { getDb } from '../db/index';
import { propertiesRepo, propertyOwnershipRepo, propertyLeasesRepo, landlordNoticesRepo, worldStatesRepo } from '../db/repositories';
import { newId, playerIdForWorld } from '../lib/ids';
import { badRequest, notFound } from '../lib/errors';
import { addMoney, getOrCreatePlayer, spendMoney } from './player-service';
import { featureEnabled } from './world-feature-service';
import { recordEvent } from './event-service';
import { getLlmSettings } from './settings-service';
import { callStructuredLlm } from '../llm/structured';
import { buildPropertyGenMessages } from '../prompt/prompt-builder';

function currentDay(worldId: string): number {
  return worldStatesRepo.get(worldId)?.day ?? 1;
}

// --- authoring CRUD ---------------------------------------------------------

export function listProperties(worldId: string): Property[] {
  return propertiesRepo.listByWorld(worldId);
}

export function getProperty(id: string): Property {
  const p = propertiesRepo.get(id);
  if (!p) throw notFound(`Property ${id} not found.`);
  return p;
}

export function createProperty(input: PropertyCreate): Property {
  const now = Date.now();
  const property = PropertySchema.parse({ ...input, id: newId('prop'), createdAt: now, updatedAt: now });
  return propertiesRepo.insert(property);
}

export function updateProperty(id: string, patch: PropertyUpdate): Property {
  const current = getProperty(id);
  // worldId is immutable once created (ownership rows reference it); ignore a patch attempt.
  const next = PropertySchema.parse({
    ...current,
    ...patch,
    id: current.id,
    worldId: current.worldId,
    updatedAt: Date.now(),
  });
  // Guard the lease economy: you can't zero out the rent of a property someone is
  // actively leasing (that would make it an un-chargeable, un-evictable free venue).
  if (next.rentAmount <= 0 && current.rentAmount > 0 && propertyLeasesRepo.anyForProperty(current.id)) {
    throw badRequest('Cannot set rent to 0 while this property has an active lease. End the lease first.');
  }
  return propertiesRepo.update(next);
}

export function deleteProperty(id: string): void {
  getProperty(id);
  // Leases + ownership cascade via FK; landlord notices carry no FK, so clear them here
  // so an eviction/overdue notice can't outlive the property it references.
  landlordNoticesRepo.deleteByProperty(id);
  propertiesRepo.delete(id);
}

// --- player ownership -------------------------------------------------------

/** A property as the player sees it: ownership, active lease, and affordability. */
export function listPropertyViews(worldId: string): PropertyView[] {
  const playerId = playerIdForWorld(worldId);
  const money = getOrCreatePlayer(playerId).money;
  const owned = new Set(propertyOwnershipRepo.listByPlayer(worldId, playerId).map((o) => o.propertyId));
  const leases = new Map(propertyLeasesRepo.listByPlayer(worldId, playerId).map((l) => [l.propertyId, l]));
  return propertiesRepo.listByWorld(worldId).map((property) => ({
    property,
    owned: owned.has(property.id),
    lease: leases.get(property.id) ?? null,
    affordableBuy: money >= property.buyPrice,
    affordableLease: money >= property.rentAmount,
  }));
}

/** The property definitions the player currently OWNS in a world. */
export function listOwnedProperties(worldId: string): Property[] {
  const playerId = playerIdForWorld(worldId);
  return propertyOwnershipRepo
    .listByPlayer(worldId, playerId)
    .map((o) => propertiesRepo.get(o.propertyId))
    .filter((p): p is Property => p != null);
}

/** Total resale equity of owned property (sell value is flat = buyPrice). */
export function ownedPropertyValue(worldId: string): number {
  return listOwnedProperties(worldId).reduce((sum, p) => sum + p.buyPrice, 0);
}

/** Buy a property outright. Cost is server-authoritative (never client-supplied). */
export function buyProperty(worldId: string, propertyId: string): BuyPropertyResponse {
  const property = getProperty(propertyId);
  if (property.worldId !== worldId) throw notFound(`Property ${propertyId} not found in this world.`);
  const playerId = playerIdForWorld(worldId);
  if (propertyOwnershipRepo.getByPlayerAndProperty(worldId, playerId, propertyId)) {
    throw badRequest('You already own this property.');
  }
  return getDb().transaction<BuyPropertyResponse>(() => {
    const player = spendMoney(property.buyPrice, playerId); // throws on insufficient funds
    // Buying out of a lease ends it — you now own the place outright (no more rent).
    propertyLeasesRepo.delete(worldId, playerId, propertyId);
    const ownership = propertyOwnershipRepo.insert(
      PropertyOwnershipSchema.parse({
        id: newId('powns'),
        worldId,
        playerId,
        propertyId,
        purchasePrice: property.buyPrice,
        acquiredAt: Date.now(),
      }),
    );
    recordEvent('property_purchase', { worldId, playerId, propertyId, name: property.name, price: property.buyPrice });
    return { ownership, money: player.money };
  });
}

// --- leasing (tenancy with recurring rent) ----------------------------------

/** Start a lease: pay the first period's rent up front and arm the rent clock. */
export function leaseProperty(worldId: string, propertyId: string): LeaseResponse {
  const property = getProperty(propertyId);
  if (property.worldId !== worldId) throw notFound(`Property ${propertyId} not found in this world.`);
  if (property.rentAmount <= 0) throw badRequest('This property is not available to lease.');
  const playerId = playerIdForWorld(worldId);
  if (propertyOwnershipRepo.getByPlayerAndProperty(worldId, playerId, propertyId)) {
    throw badRequest('You already own this property.');
  }
  if (propertyLeasesRepo.getByPlayerAndProperty(worldId, playerId, propertyId)) {
    throw badRequest('You already lease this property.');
  }
  const days = rentCadenceDays(property.rentCadence);
  return getDb().transaction<LeaseResponse>(() => {
    const player = spendMoney(property.rentAmount, playerId); // first period up front
    const lease = propertyLeasesRepo.upsert(
      PropertyLeaseSchema.parse({
        id: newId('lease'),
        worldId,
        playerId,
        propertyId,
        nextDueDay: currentDay(worldId) + days,
        status: 'active',
        graceUntilDay: null,
        startedAt: Date.now(),
      }),
    );
    recordEvent('property_leased', { worldId, playerId, propertyId, name: property.name, rent: property.rentAmount });
    return { lease, money: player.money };
  });
}

/** Pay rent now (manual catch-up while overdue, or settle a payment that's come due).
 *  Refuses to charge a lease whose rent isn't owed yet — so paying repeatedly when
 *  you don't need to can't silently drain your wallet. */
export function payRent(worldId: string, propertyId: string): LeaseResponse {
  const property = getProperty(propertyId);
  const playerId = playerIdForWorld(worldId);
  const lease = propertyLeasesRepo.getByPlayerAndProperty(worldId, playerId, propertyId);
  if (!lease) throw badRequest('You do not lease this property.');
  if (property.rentAmount <= 0) throw badRequest('This lease has no rent to pay.');
  const today = currentDay(worldId);
  // Only payable when rent is actually owed: the lease is overdue, or this period has
  // come due. A current, not-yet-due lease has nothing to pay.
  if (lease.status !== 'overdue' && today < lease.nextDueDay) {
    throw badRequest("Rent isn't due yet.");
  }
  const days = rentCadenceDays(property.rentCadence);
  return getDb().transaction<LeaseResponse>(() => {
    const player = spendMoney(property.rentAmount, playerId);
    const next = propertyLeasesRepo.upsert(
      PropertyLeaseSchema.parse({
        ...lease,
        // Advance from the period boundary so a payment never discards the unused
        // remainder of an already-paid period.
        nextDueDay: Math.max(lease.nextDueDay, today) + days,
        status: 'active',
        graceUntilDay: null,
      }),
    );
    recordEvent('rent_paid', { worldId, playerId, propertyId, name: property.name, amount: property.rentAmount, manual: true });
    return { lease: next, money: player.money };
  });
}

/** Voluntarily end a lease (move out). No penalty; you simply can't date there after. */
export function endLease(worldId: string, propertyId: string): { money: number } {
  const playerId = playerIdForWorld(worldId);
  if (!propertyLeasesRepo.getByPlayerAndProperty(worldId, playerId, propertyId)) {
    throw badRequest('You do not lease this property.');
  }
  propertyLeasesRepo.delete(worldId, playerId, propertyId);
  recordEvent('property_lease_ended', { worldId, playerId, propertyId });
  return { money: getOrCreatePlayer(playerId).money };
}

/** Sell an owned property. Flat refund = the price actually PAID (a steady asset
 *  round-trips to what you spent). Refunding the live, author-editable
 *  `property.buyPrice` instead let a creator buy cheap, raise buyPrice, then sell for
 *  a profit — minting money from nothing — so we use the persisted purchasePrice. */
export function sellProperty(worldId: string, propertyId: string): SellPropertyResponse {
  const property = getProperty(propertyId);
  const playerId = playerIdForWorld(worldId);
  const ownership = propertyOwnershipRepo.getByPlayerAndProperty(worldId, playerId, propertyId);
  if (!ownership) {
    throw badRequest('You do not own this property.');
  }
  return getDb().transaction<SellPropertyResponse>(() => {
    const refund = ownership.purchasePrice;
    const player = addMoney(refund, playerId);
    propertyOwnershipRepo.delete(worldId, playerId, propertyId);
    recordEvent('property_sale', { worldId, playerId, propertyId, name: property.name, refund });
    return { money: player.money, refund };
  });
}

/**
 * Resolve a `prop:<id>` date location to its property + whether the player OWNS it.
 * You can date there if you own it (full buff) OR currently lease it (half buff —
 * a lease in its grace period still counts until eviction). The lease rent is the
 * cost; dating itself is free. Returns null if you neither own nor lease it.
 */
export function propertyVenueInfo(
  locationId: string | null,
  worldId: string | null,
): { property: Property; owned: boolean } | null {
  if (!locationId || !locationId.startsWith('prop:') || !worldId) return null;
  // A world that disabled the property feature has no property venues — even for a
  // stale ownership/lease row — so the free venue + date buff stay gated server-side.
  if (!featureEnabled(worldId, 'property')) return null;
  const property = propertiesRepo.get(locationId.slice('prop:'.length));
  if (!property || property.worldId !== worldId) return null;
  const playerId = playerIdForWorld(worldId);
  if (propertyOwnershipRepo.getByPlayerAndProperty(worldId, playerId, property.id)) return { property, owned: true };
  if (propertyLeasesRepo.getByPlayerAndProperty(worldId, playerId, property.id)) return { property, owned: false };
  return null;
}

// --- LLM property generation (creator tool) ---------------------------------

const clampInt = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(Number.isFinite(n) ? n : lo)));

/**
 * SERVER-OWNS-RULES: turn an LLM-proposed property into a safe PropertyCreate.
 * Clamps every economic field, coerces enums, and enforces the rent-payback floor
 * (rent income can never pay back the purchase price faster than MIN_PAYBACK_DAYS),
 * so a generated property can never be a money printer.
 */
export function boundGeneratedProperty(g: GeneratedProperty, worldId: string): PropertyCreate {
  const category = PropertyCategorySchema.catch('residence').parse(g.category);
  const rentCadence = RentCadenceSchema.catch('weekly').parse(g.rentCadence);
  const buffStat = RelationshipStatKeySchema.nullable().catch(null).parse(g.buffStat);
  const rentAmount = clampInt(g.rentAmount, 0, PROPERTY_GEN.MAX_RENT_AMOUNT);
  let buyPrice = clampInt(g.buyPrice, PROPERTY_GEN.MIN_PRICE, PROPERTY_GEN.MAX_PRICE);
  // Anti-cheap-buy: buying must be worth at least MIN_PAYBACK_DAYS of rent (so owning
  // is a real investment over leasing, never trivially cheaper than a few periods).
  const rentPerDay = rentAmount / rentCadenceDays(rentCadence);
  const minBuy = Math.round(rentPerDay * PROPERTY_GEN.MIN_PAYBACK_DAYS);
  if (buyPrice < minBuy) buyPrice = Math.min(PROPERTY_GEN.MAX_PRICE, minBuy);

  return {
    worldId,
    name: g.name.slice(0, PROPERTY_GEN.MAX_NAME),
    description: g.description.slice(0, PROPERTY_GEN.MAX_DESCRIPTION),
    category,
    buyPrice,
    rentAmount,
    rentCadence,
    indoor: g.indoor,
    tags: g.tags.slice(0, PROPERTY_GEN.MAX_TAGS).map((t) => t.slice(0, PROPERTY_GEN.MAX_TAG_LEN)),
    buffStat,
    buffAmount: buffStat ? clampInt(g.buffAmount, 0, PROPERTY_GEN.MAX_BUFF) : 0,
    assetId: null,
  };
}

/**
 * Generate a batch of in-world property DRAFTS via the LLM. Read-only: returns
 * server-bounded drafts for the creator to review/edit before saving (it persists
 * nothing). Fails safe if the model can't comply.
 */
export async function generateProperties(
  input: GeneratePropertiesParsed,
  worldId: string,
): Promise<StructuredResult<PropertyCreate[]>> {
  const data = GeneratePropertiesInputSchema.parse(input);
  const settings = getLlmSettings();
  const result = await callStructuredLlm(PropertyGenerationSchema, buildPropertyGenMessages(data), {
    settings,
    task: 'Generate a batch of in-world properties (name, description, category, prices, rent, optional date buff).',
    schemaName: 'PropertyGeneration',
  });
  if (!result.ok) {
    return { ok: false, error: result.error, attempts: result.attempts, lastRaw: result.lastRaw };
  }
  const drafts = result.data.properties.map((g) => boundGeneratedProperty(g, worldId));
  return { ok: true, data: drafts, attempts: result.attempts };
}

/** Copy a world's authored property DEFINITIONS into another world (world clone). */
export function clonePropertiesToWorld(sourceWorldId: string, destWorldId: string): void {
  for (const p of propertiesRepo.listByWorld(sourceWorldId)) {
    createProperty({
      worldId: destWorldId,
      name: p.name,
      description: p.description,
      category: p.category,
      buyPrice: p.buyPrice,
      rentAmount: p.rentAmount,
      rentCadence: p.rentCadence,
      indoor: p.indoor,
      tags: p.tags,
      buffStat: p.buffStat,
      buffAmount: p.buffAmount,
      assetId: p.assetId,
    });
  }
}
