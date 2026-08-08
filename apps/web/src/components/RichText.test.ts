import { describe, expect, it } from 'vitest';
import { parseRichLine } from './RichText';

describe('parseRichLine', () => {
  it('separates Japanese scene prose, an action, and dialogue in a venue opener', () => {
    const text =
      'ゼニス・ガーデンの高層テラスでは、雨上がりの空気が微かに漂っている。\n\n' +
      '*ゆっくりと視線を向け、わずかに首を傾けて*\n\n' +
      'お会いできて嬉しいです。今日は少しだけ……切ないような気分です。';

    expect(parseRichLine(text, { sceneLead: true })).toEqual([
      { kind: 'scene', text: 'ゼニス・ガーデンの高層テラスでは、雨上がりの空気が微かに漂っている。\n\n' },
      { kind: 'action', text: 'ゆっくりと視線を向け、わずかに首を傾けて' },
      { kind: 'text', text: '\n\nお会いできて嬉しいです。今日は少しだけ……切ないような気分です。' },
    ]);
  });

  it('recognizes full-width Japanese IME asterisks as action delimiters', () => {
    expect(parseRichLine('＊ゆっくりと微笑んで＊\n\nこんばんは。')).toEqual([
      { kind: 'action', text: 'ゆっくりと微笑んで' },
      { kind: 'text', text: '\n\nこんばんは。' },
    ]);
  });

  it('parses Arabic and Hebrew actions without disturbing their Unicode text', () => {
    expect(parseRichLine('*تميل رأسها قليلًا* يسعدني لقاؤك.')).toEqual([
      { kind: 'action', text: 'تميل رأسها قليلًا' },
      { kind: 'text', text: ' يسعدني لقاؤك.' },
    ]);
    expect(parseRichLine('*מחייכת בשקט* נעים מאוד.')).toEqual([
      { kind: 'action', text: 'מחייכת בשקט' },
      { kind: 'text', text: ' נעים מאוד.' },
    ]);
  });

  it('keeps a compliant narration-only venue opener as scene prose', () => {
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
