import { LandlordNoticeSchema, type LandlordNotice, type LandlordNoticeKind, type LandlordInbox } from '@dsim/shared';
import { landlordNoticesRepo } from '../db/repositories';
import { newId } from '../lib/ids';

/**
 * The landlord's urgent text channel — overdue-rent warnings and eviction notices.
 * A landlord is NOT a dateable character, so these live apart from the character-
 * keyed text threads and surface as a pinned, distinctly-styled "Property Management"
 * conversation in the phone Messages app. Bodies are deterministic (never LLM).
 */

function noticeBody(kind: LandlordNoticeKind, propertyName: string, amount: number, graceDay: number): string {
  if (kind === 'eviction') {
    return `NOTICE OF EVICTION — ${propertyName}. Your rent went unpaid past the grace period, so your lease is terminated. You can no longer take dates there. — Property Management`;
  }
  return `OVERDUE RENT — ${propertyName}. Your rent of ◈${amount} is past due. Pay by Day ${graceDay} or you will be evicted and lose access. — Property Management`;
}

export function sendLandlordNotice(args: {
  worldId: string;
  playerId: string;
  propertyId: string;
  propertyName: string;
  kind: LandlordNoticeKind;
  amount: number;
  graceDay: number;
  day: number;
}): LandlordNotice {
  const notice = LandlordNoticeSchema.parse({
    id: newId('lnotice'),
    worldId: args.worldId,
    playerId: args.playerId,
    propertyId: args.propertyId,
    kind: args.kind,
    body: noticeBody(args.kind, args.propertyName, args.amount, args.graceDay),
    dayNumber: args.day,
    read: false,
    createdAt: Date.now(),
  });
  return landlordNoticesRepo.insert(notice);
}

export function getLandlordInbox(worldId: string, playerId: string): LandlordInbox {
  return {
    notices: landlordNoticesRepo.listByPlayer(worldId, playerId),
    unread: landlordNoticesRepo.countUnread(worldId, playerId),
  };
}

export function markLandlordNoticesRead(worldId: string, playerId: string): void {
  landlordNoticesRepo.markAllRead(worldId, playerId);
}
