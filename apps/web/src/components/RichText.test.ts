import { describe, expect, it } from 'vitest';
import { parseRichLine } from './RichText';

describe('parseRichLine', () => {
  it('separates a venue scene lead from actions and dialogue', () => {
    expect(parseRichLine(
      'Rain taps against the glass.\n\n*She looks up.*\n\nYou made it.',
      { sceneLead: true },
    )).toEqual([
      { kind: 'scene', text: 'Rain taps against the glass.\n\n' },
      { kind: 'action', text: 'She looks up.' },
      { kind: 'text', text: '\n\nYou made it.' },
    ]);
  });

  it('keeps a pure venue description as scene prose', () => {
    expect(parseRichLine('Rain taps against the glass.', { sceneLead: true })).toEqual([
      { kind: 'scene', text: 'Rain taps against the glass.' },
    ]);
  });

  it('keeps ordinary character dialogue behavior unchanged', () => {
    expect(parseRichLine('*She smiles.* Hello.')).toEqual([
      { kind: 'action', text: 'She smiles.' },
      { kind: 'text', text: ' Hello.' },
    ]);
  });
});
