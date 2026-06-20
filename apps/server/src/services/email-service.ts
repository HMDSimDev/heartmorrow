import { EmailBatchSchema, EmailSchema, DEFAULT_PLAYER_ID, EMAIL_DAY_CHANCE, EMAILS_MAX_PER_DAY, type Email } from '@dsim/shared';
import { charactersRepo, emailsRepo, worldsRepo } from '../db/repositories';
import { getLlmSettings } from './settings-service';
import { getOrCreatePlayer } from './player-service';
import { callStructuredLlm } from '../llm/structured';
import { buildEmailBatchMessages } from '../prompt/prompt-builder';
import { newId, playerIdForWorldOrDefault } from '../lib/ids';
import { notFound } from '../lib/errors';
import { hashFloat, type SeededRandom } from '../lib/seeded-random';
import { recordEvent } from './event-service';

/** Generate the day's in-world emails (companies/strangers — never characters). */
export async function generateDailyEmails(
  worldId: string,
  day: number,
  playerId: string = DEFAULT_PLAYER_ID,
  rng: SeededRandom = hashFloat,
): Promise<void> {
  // CADENCE GATE: most days bring no email at all. Deterministic per (world, day)
  // so it stays idempotent/replay-safe. Gate here (not just in the hook) so the
  // dev/generate route path is rate-limited too.
  if (rng(`email|${worldId}|${day}`) >= EMAIL_DAY_CHANCE) {
    recordEvent('daily_emails_skipped', { day });
    return;
  }
  // Idempotency: never generate a second batch for a day that already has emails
  // in THIS world (e.g. the dev route firing on a day the hook already processed).
  // Scoped per-world so a second world isn't starved when worlds share a day number.
  if (emailsRepo.countByPlayerWorldAndDay(playerId, worldId, day) > 0) {
    recordEvent('daily_emails_skipped', { day, reason: 'already_generated' });
    return;
  }
  const settings = getLlmSettings();
  const world = worldsRepo.get(worldId) ?? null;
  const result = await callStructuredLlm(
    EmailBatchSchema,
    buildEmailBatchMessages({ world, playerName: getOrCreatePlayer(playerIdForWorldOrDefault(worldId)).name }),
    {
      settings,
      task: 'Write a few short in-world emails.',
      schemaName: 'EmailBatch',
      // A batch is up to a couple emails at ~1200 chars each; floor the budget so a
      // user-lowered default doesn't truncate the JSON and drop the whole day's mail.
      maxTokens: Math.max(settings.maxTokens, 2500),
    },
  );
  if (!result.ok) {
    recordEvent('daily_emails_failed', { day, error: result.error });
    return;
  }

  // Hard guard: an email must NEVER appear to come from a love interest — check
  // both the display name and the handle's local-part against character names.
  const names = charactersRepo.list().map((c) => c.name.toLowerCase());
  const fullNames = new Set(names);
  const firstNames = new Set(names.map((n) => n.split(/\s+/)[0]).filter(Boolean));
  const looksLikeCharacter = (senderName: string, senderHandle: string): boolean => {
    const sName = senderName.trim().toLowerCase();
    const handleLocal = (senderHandle.split('@')[0] ?? '').trim().toLowerCase();
    return fullNames.has(sName) || firstNames.has(sName) || firstNames.has(handleLocal);
  };
  const now = Date.now();
  let count = 0;
  for (const e of result.data.emails) {
    if (count >= EMAILS_MAX_PER_DAY) break; // hard cap regardless of model output
    if (looksLikeCharacter(e.senderName, e.senderHandle)) continue;
    emailsRepo.insert(
      EmailSchema.parse({
        id: newId('email'),
        playerId,
        worldId,
        senderName: e.senderName,
        senderHandle: e.senderHandle,
        subject: e.subject,
        body: e.body,
        status: 'delivered',
        read: false,
        dayNumber: day,
        scheduledPhase: null,
        deliveredAt: now,
        createdAt: now,
      }),
    );
    count += 1;
  }
  recordEvent('daily_emails_generated', { day, count });
}

export function listEmails(worldId?: string, playerId: string = DEFAULT_PLAYER_ID): Email[] {
  return worldId
    ? emailsRepo.listDeliveredByPlayerAndWorld(playerId, worldId)
    : emailsRepo.listDeliveredByPlayer(playerId);
}

export function markEmailRead(id: string): Email {
  const email = emailsRepo.get(id);
  if (!email) throw notFound('Email not found.');
  if (email.read) return email;
  const updated = emailsRepo.update({ ...email, read: true });
  recordEvent('email_read', { id });
  return updated;
}

export function unreadEmailCount(worldId?: string, playerId: string = DEFAULT_PLAYER_ID): number {
  return worldId ? emailsRepo.countUnreadByWorld(playerId, worldId) : emailsRepo.countUnread(playerId);
}
