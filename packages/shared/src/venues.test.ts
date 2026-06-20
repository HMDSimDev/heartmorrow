import { describe, it, expect } from 'vitest';
import { venueCost, venueTierMeta, spendTasteOf, venueDateEffect } from './venues';

describe('venue cost tiers', () => {
  it('maps tiers to money costs', () => {
    expect(venueCost(0)).toBe(0);
    expect(venueCost(1)).toBe(40);
    expect(venueCost(2)).toBe(100);
    expect(venueCost(3)).toBe(200);
  });

  it('clamps out-of-range / nullish tiers to a valid venue', () => {
    expect(venueCost(99)).toBe(200); // clamps to lavish
    expect(venueCost(-5)).toBe(0); // clamps to free
    expect(venueCost(null)).toBe(0);
    expect(venueCost(undefined)).toBe(0);
    expect(venueTierMeta(2).symbol).toBe('$$');
  });
});

describe('spendTasteOf', () => {
  it('reads a gifts love language as luxury-leaning', () => {
    expect(spendTasteOf({ loveLanguage: 'receiving gifts' })).toBe('lavish');
  });

  it('reads luxury likes as luxury-leaning', () => {
    expect(spendTasteOf({ likes: ['fine dining', 'designer labels'] })).toBe('lavish');
  });

  it('reads simple tastes (or disliking flashiness) as grounded', () => {
    expect(spendTasteOf({ likes: ['quiet nights', 'picnics'] })).toBe('grounded');
    expect(spendTasteOf({ dislikes: ['anything too fancy'] })).toBe('grounded');
    expect(spendTasteOf({ loveLanguage: 'quality time', likes: ['camping'] })).toBe('grounded');
  });

  it('defaults to neutral when nothing points either way', () => {
    expect(spendTasteOf({ loveLanguage: 'physical touch', likes: ['live music'] })).toBe('neutral');
    expect(spendTasteOf({})).toBe('neutral');
  });
});

describe('venueDateEffect (the judged spend)', () => {
  it('a neutral character enjoys a treat but is never punished for a cheap night', () => {
    const neutral = { loveLanguage: 'physical touch' };
    expect(venueDateEffect(neutral, 0)).toEqual({}); // free → no nudge
    const lavishOuting = venueDateEffect(neutral, 3);
    expect((lavishOuting.affection ?? 0) + (lavishOuting.chemistry ?? 0)).toBeGreaterThan(0);
  });

  it('a luxury-lover is let down by a stingy date and delighted by a splurge', () => {
    const lavish = { loveLanguage: 'gifts' };
    expect(venueDateEffect(lavish, 0).affection!).toBeLessThan(0); // underwhelmed
    expect(venueDateEffect(lavish, 3).affection!).toBeGreaterThan(0); // spoiled
  });

  it('a down-to-earth character is charmed by simplicity and put off by flash', () => {
    const grounded = { likes: ['simple living', 'picnics'] };
    expect(venueDateEffect(grounded, 0).comfort!).toBeGreaterThan(0); // thoughtful + cheap
    const splurge = venueDateEffect(grounded, 3);
    expect(splurge.comfort!).toBeLessThan(0); // too much
    expect(splurge.tension!).toBeGreaterThan(0);
  });

  it('returns a fresh object (never a shared reference)', () => {
    const a = venueDateEffect({ loveLanguage: 'gifts' }, 3);
    a.affection = 999;
    expect(venueDateEffect({ loveLanguage: 'gifts' }, 3).affection).not.toBe(999);
  });
});
