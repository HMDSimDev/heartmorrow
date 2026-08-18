import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RelationshipCheckRecovery } from '@dsim/shared';
import { streamRelationshipChecks } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('relationship-check recovery stream', () => {
  it('delivers the persisted cursor state to the client handler', async () => {
    const expected: RelationshipCheckRecovery = { version: 1, next: null, failedCheck: null, failureCode: null, attempts: 1, skipped: false };
    const body = `event: relationship_checks\ndata: ${JSON.stringify({ messageId: 'msg_1', state: expected })}\n\n`;
    const fetchMock = vi.fn(async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    let receivedMessageId = '';
    let receivedState: RelationshipCheckRecovery | null = null;
    await streamRelationshipChecks('session_1', 'msg_1', { onRelationshipChecks: (messageId, state) => { receivedMessageId = messageId; receivedState = state; } });
    expect(receivedMessageId).toBe('msg_1');
    expect(receivedState).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('surfaces a non-streaming HTTP failure through the same error handler', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'That turn is no longer retryable.' }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    let receivedError = '';
    await streamRelationshipChecks('session_1', 'msg_1', { onError: (message) => { receivedError = message; } });
    expect(receivedError).toBe('That turn is no longer retryable.');
  });
});
