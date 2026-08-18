import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_REQUEST_HEADER, startingRapport, turnRapportDelta } from '@dsim/shared';
import { buildApp } from '../app';
import { messagesRepo } from '../db/repositories';
import { setAdapterOverride } from '../llm/provider';
import type { ChatAdapter, ChatRequest, ChatResult, LlmModelInfo } from '../llm/types';
import { ScriptedAdapter, resetDb, seedWorldAndCharacter } from '../test/helpers';
import { getRapport } from './rapport-service';
import { updateLlmSettings } from './settings-service';
import { addPlayerMessage, advanceRelationshipCheck, attemptPlayerFarewell, beginRelationshipChecks, createSession, endSession, failRelationshipCheck, getRelationshipCheckRecovery, judgeTurn, skipRelationshipChecks } from './conversation-service';

class RecoveringTurnAdapter implements ChatAdapter {
  readonly name = 'recovering-turn';
  failTurnRead = true;
  judgeCalls = 0;
  replyCalls = 0;

  async chat(_request: ChatRequest): Promise<ChatResult> {
    this.judgeCalls += 1;
    if (this.failTurnRead) throw new Error('Model server returned 500.');
    return { content: JSON.stringify({ engagement: 2, expression: 'smiling', note: 'The question showed sincere interest.' }) };
  }

  async streamChat(_request: ChatRequest, onDelta: (text: string) => void): Promise<ChatResult> {
    this.replyCalls += 1;
    const content = 'It was busy, but I am glad you asked.';
    onDelta(content);
    return { content };
  }

  async listModels(): Promise<LlmModelInfo[]> {
    return [];
  }
}

function startRecoverableDate(text = 'Tell me about your week.') {
  const { character } = seedWorldAndCharacter();
  const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
  const message = beginRelationshipChecks(addPlayerMessage(session.id, text).id);
  return { character, session, message };
}

function advanceToRapport(messageId: string): void {
  advanceRelationshipCheck(messageId, 'walkout');
  advanceRelationshipCheck(messageId, 'breakup');
  advanceRelationshipCheck(messageId, 'farewell');
}

beforeEach(() => {
  resetDb();
  updateLlmSettings({ maxRetries: 0 });
});

afterEach(() => setAdapterOverride(null));

describe('durable relationship-check recovery', () => {
  it('blocks later turns and ending until the player retries or explicitly skips', async () => {
    const { session, message } = startRecoverableDate();
    advanceToRapport(message.id);
    const failed = failRelationshipCheck(message.id, 'rapport', 'rapport_read_failed');
    expect(failed.failedCheck).toBe('rapport');
    expect(() => addPlayerMessage(session.id, 'A second turn should wait.')).toThrow(/retry the interrupted relationship read/i);
    await expect(endSession(session.id)).rejects.toThrow(/retry the interrupted relationship read/i);
    const skipped = skipRelationshipChecks(session.id, message.id);
    expect(skipped.next).toBeNull();
    expect(skipped.skipped).toBe(true);
    expect(() => addPlayerMessage(session.id, 'Now the date can continue.')).not.toThrow();
  });

  it('surfaces a failed judge, retries only the unfinished checks, and never applies rapport twice', async () => {
    const app = await buildApp({ logger: false });
    try {
      const { character } = seedWorldAndCharacter();
      const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
      const adapter = new RecoveringTurnAdapter();
      setAdapterOverride(adapter);
      const first = await app.inject({ method: 'POST', url: `/api/conversations/${session.id}/stream`, payload: { text: 'Tell me about your week.' }, headers: { [APP_REQUEST_HEADER]: '1' } });
      expect(first.statusCode).toBe(200);
      expect(first.body).toContain('event: relationship_checks');
      expect(first.body).toContain('"failedCheck":"rapport"');
      expect(first.body).toContain('event: done');
      const playerMessage = messagesRepo.listBySession(session.id).find((message) => message.role === 'player');
      expect(playerMessage).toBeDefined();
      expect(getRelationshipCheckRecovery(playerMessage!)?.next).toBe('rapport');
      adapter.failTurnRead = false;
      const retried = await app.inject({ method: 'POST', url: `/api/conversations/${session.id}/relationship-checks/retry`, payload: { messageId: playerMessage!.id }, headers: { [APP_REQUEST_HEADER]: '1' } });
      expect(retried.statusCode).toBe(200);
      expect(retried.body).toContain('"next":null');
      const refreshed = messagesRepo.get(playerMessage!.id);
      expect(refreshed?.metadata.engagement).toBe(2);
      expect(getRelationshipCheckRecovery(refreshed!)?.next).toBeNull();
      const rapportAfterRetry = getRapport(session.id);
      expect(rapportAfterRetry).toBe(startingRapport(character.guardedness) + turnRapportDelta(2, { guardedness: character.guardedness }));
      const duplicate = await app.inject({ method: 'POST', url: `/api/conversations/${session.id}/relationship-checks/retry`, payload: { messageId: playerMessage!.id }, headers: { [APP_REQUEST_HEADER]: '1' } });
      expect(duplicate.body).toContain('event: error');
      expect(getRapport(session.id)).toBe(rapportAfterRetry);
      expect(adapter.judgeCalls).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('does not repeat rapport if the effect committed before its cursor advanced', async () => {
    const app = await buildApp({ logger: false });
    try {
      const { session, message } = startRecoverableDate();
      advanceToRapport(message.id);
      const adapter = new ScriptedAdapter([JSON.stringify({ engagement: 3, expression: 'happy', note: 'It landed.' })]);
      setAdapterOverride(adapter);
      const read = await judgeTurn(session.id, undefined, undefined, message.id);
      expect(read).not.toBeNull();
      const committedRapport = getRapport(session.id);
      expect(getRelationshipCheckRecovery(messagesRepo.get(message.id)!)?.next).toBe('rapport');
      const retried = await app.inject({ method: 'POST', url: `/api/conversations/${session.id}/relationship-checks/retry`, payload: { messageId: message.id }, headers: { [APP_REQUEST_HEADER]: '1' } });
      expect(retried.body).toContain('"next":null');
      expect(getRapport(session.id)).toBe(committedRapport);
      expect(adapter.calls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('re-emits a committed farewell instead of generating or inserting it twice', async () => {
    const app = await buildApp({ logger: false });
    try {
      const { session, message } = startRecoverableDate('I should get going.');
      advanceRelationshipCheck(message.id, 'walkout');
      advanceRelationshipCheck(message.id, 'breakup');
      const adapter = new ScriptedAdapter([JSON.stringify({ ending: true, expression: 'soft smile', farewellLine: 'Goodnight. I had a lovely time.' })]);
      setAdapterOverride(adapter);
      const farewell = await attemptPlayerFarewell(session.id, message.text, undefined, undefined, message.id);
      expect(farewell).not.toBeNull();
      const messageCount = messagesRepo.listBySession(session.id).length;
      expect(getRelationshipCheckRecovery(messagesRepo.get(message.id)!)?.next).toBe('farewell');
      const retried = await app.inject({ method: 'POST', url: `/api/conversations/${session.id}/relationship-checks/retry`, payload: { messageId: message.id }, headers: { [APP_REQUEST_HEADER]: '1' } });
      expect(retried.body).toContain('event: farewell');
      expect(retried.body).toContain(farewell!.message.id);
      expect(messagesRepo.listBySession(session.id)).toHaveLength(messageCount);
      expect(adapter.calls).toBe(1);
    } finally {
      await app.close();
    }
  });
});
