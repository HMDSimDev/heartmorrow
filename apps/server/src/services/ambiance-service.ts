import {
  HARSH_WEATHER,
  PLEASANT_WEATHER,
  MOODS,
  MOOD_ICONS,
  POSITIVE_MOODS,
  NEGATIVE_MOODS,
  SEASON_WEATHER,
  deriveCalendar,
  resolveWeather,
  type DayWeather,
  type Location,
  type Mood,
  type RelationshipStatKey,
  type WeatherForecastDay,
  type WorldWeather,
} from '@dsim/shared';
import { charactersRepo, worldStatesRepo } from '../db/repositories';
import { hashFloat } from '../lib/seeded-random';

/**
 * Deterministic daily atmosphere. Weather is per (world, day); a character's
 * mood is per (world, day, character) and is biased by how they feel about that
 * day's weather. Derived from a stable hash so it needs no storage and a
 * forecast can be computed for any future day.
 */

export function weatherForDay(worldId: string, day: number): DayWeather {
  const season = deriveCalendar(day).season;
  const pool = SEASON_WEATHER[season];
  const idx = Math.floor(hashFloat(`${worldId}|${day}|weather`) * pool.length);
  return resolveWeather(pool[Math.min(idx, pool.length - 1)]!);
}

export interface CharacterMood {
  mood: Mood;
  icon: string;
}

type WeatherPrefs = { favoriteWeather: string[]; dislikedWeather: string[] };

/** Mood of the day, biased toward positive/negative pools by today's weather. */
export function moodForCharacter(
  worldId: string,
  day: number,
  character: WeatherPrefs & { id: string },
): CharacterMood {
  const weather = weatherForDay(worldId, day);
  const pool = character.favoriteWeather.includes(weather.kind)
    ? POSITIVE_MOODS
    : character.dislikedWeather.includes(weather.kind)
      ? NEGATIVE_MOODS
      : MOODS;
  const idx = Math.floor(hashFloat(`${worldId}|${day}|${character.id}|mood`) * pool.length);
  const mood = pool[Math.min(idx, pool.length - 1)]!;
  return { mood, icon: MOOD_ICONS[mood] };
}

/** A character's reaction to a given day's weather (for the Weather app). */
export function weatherReaction(character: WeatherPrefs, weather: DayWeather): 'loves' | 'dislikes' | null {
  if (character.favoriteWeather.includes(weather.kind)) return 'loves';
  if (character.dislikedWeather.includes(weather.kind)) return 'dislikes';
  return null;
}

/**
 * How today's weather + venue colors a date — a small, clamped relationship
 * nudge (the server applies it; the clamp in stat-service is the authority).
 */
export function weatherDateEffect(
  character: WeatherPrefs,
  location: Location | null,
  weather: DayWeather,
): Partial<Record<RelationshipStatKey, number>> {
  const fav = character.favoriteWeather.includes(weather.kind);
  const dis = character.dislikedWeather.includes(weather.kind);
  const harsh = HARSH_WEATHER.includes(weather.kind);
  const pleasant = PLEASANT_WEATHER.includes(weather.kind);
  const outdoor = location ? !location.indoor : false;

  const delta: Partial<Record<RelationshipStatKey, number>> = {};
  const add = (k: RelationshipStatKey, v: number) => {
    delta[k] = (delta[k] ?? 0) + v;
  };

  // The character's own feelings about the weather color the whole date.
  if (fav) {
    add('comfort', 3);
    add('chemistry', 2);
  } else if (dis) {
    add('comfort', -3);
    add('tension', 2);
  }

  // Venue × weather.
  if (location) {
    if (outdoor && harsh && !fav) add('comfort', -3); // miserable outdoors
    if (outdoor && pleasant) add('chemistry', 2); // a lovely day out together
    if (!outdoor && harsh) add('comfort', 2); // cozy inside while it's rough out
  }

  for (const k of Object.keys(delta) as RelationshipStatKey[]) {
    if (!delta[k]) delete delta[k];
  }
  return delta;
}

/** Deterministic weather forecast for upcoming days (today inclusive). */
export function forecastForWorld(worldId: string, fromDay: number, days = 5): WeatherForecastDay[] {
  const out: WeatherForecastDay[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = fromDay + i;
    const cal = deriveCalendar(day);
    out.push({
      day,
      dayOfWeek: cal.dayOfWeek,
      season: cal.season,
      weather: weatherForDay(worldId, day),
      holiday: cal.holiday?.name ?? null,
    });
  }
  return out;
}

/** Today's weather, a forecast, and how each character in the world feels about today. */
export function getWorldWeather(worldId: string, days = 5): WorldWeather {
  const day = worldStatesRepo.get(worldId)?.day ?? 1;
  const today = weatherForDay(worldId, day);
  const characters = charactersRepo.listByWorld(worldId).map((c) => {
    const m = moodForCharacter(worldId, day, c);
    return { id: c.id, name: c.name, mood: m.mood, moodIcon: m.icon, reaction: weatherReaction(c, today) };
  });
  return { day, today, forecast: forecastForWorld(worldId, day, days), characters };
}
