import { describe, it, expect, beforeEach } from 'vitest';
import { POSITIVE_MOODS, NEGATIVE_MOODS, resolveWeather, type Location, type WeatherKind } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { weatherForDay, moodForCharacter, weatherDateEffect, weatherReaction, forecastForWorld } from './ambiance-service';

const W = (kind: WeatherKind) => resolveWeather(kind);
const loc = (indoor: boolean): Location => ({ id: 'l', name: 'Spot', description: '', tags: [], indoor, priceTier: 0, imageAssetId: null });

beforeEach(() => resetDb());

describe('weather engine', () => {
  it('weatherForDay is deterministic per (world, day)', () => {
    const { world } = seedWorldAndCharacter();
    expect(weatherForDay(world.id, 3).kind).toBe(weatherForDay(world.id, 3).kind);
  });

  it('forecast covers consecutive days and agrees with weatherForDay', () => {
    const { world } = seedWorldAndCharacter();
    const fc = forecastForWorld(world.id, 5, 4);
    expect(fc.map((f) => f.day)).toEqual([5, 6, 7, 8]);
    expect(fc[0]!.weather.kind).toBe(weatherForDay(world.id, 5).kind);
  });

  it('mood is biased positive in loved weather and negative in disliked weather', () => {
    const { world } = seedWorldAndCharacter();
    const day = 4;
    const kind = weatherForDay(world.id, day).kind;
    const lover = { id: 'lover', favoriteWeather: [kind], dislikedWeather: [] };
    const hater = { id: 'hater', favoriteWeather: [], dislikedWeather: [kind] };
    expect((POSITIVE_MOODS as readonly string[]).includes(moodForCharacter(world.id, day, lover).mood)).toBe(true);
    expect((NEGATIVE_MOODS as readonly string[]).includes(moodForCharacter(world.id, day, hater).mood)).toBe(true);
  });

  it('weatherDateEffect: outdoor+harsh hurts, indoor+harsh is cozy, favorite lifts', () => {
    const none = { favoriteWeather: [], dislikedWeather: [] };
    expect(weatherDateEffect(none, loc(false), W('rainy')).comfort!).toBeLessThan(0); // miserable outside
    expect(weatherDateEffect(none, loc(true), W('rainy')).comfort!).toBeGreaterThan(0); // cozy inside
    const fan = { favoriteWeather: ['sunny'], dislikedWeather: [] };
    const eff = weatherDateEffect(fan, loc(false), W('sunny'));
    expect((eff.comfort ?? 0) + (eff.chemistry ?? 0)).toBeGreaterThan(0);
    // No location chosen → no venue effect, but a disliked-weather mood hit still applies.
    expect(weatherDateEffect({ favoriteWeather: [], dislikedWeather: ['stormy'] }, null, W('stormy')).comfort!).toBeLessThan(0);
  });

  it('weatherReaction reflects preferences', () => {
    expect(weatherReaction({ favoriteWeather: ['rainy'], dislikedWeather: [] }, W('rainy'))).toBe('loves');
    expect(weatherReaction({ favoriteWeather: [], dislikedWeather: ['rainy'] }, W('rainy'))).toBe('dislikes');
    expect(weatherReaction({ favoriteWeather: [], dislikedWeather: [] }, W('rainy'))).toBeNull();
  });
});
