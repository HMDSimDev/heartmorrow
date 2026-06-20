import { type Season } from './time';

/**
 * Daily atmosphere: a deterministic weather-of-the-day (per world) and a
 * mood-of-the-day per character. The server derives the concrete value from a
 * hash; these tables are the shared vocabulary (kinds, labels, icons) used by the
 * weather system, the prompt, the Morning Briefing, the Weather app, and the UI.
 */

export const MOODS = ['cheerful', 'playful', 'pensive', 'tired', 'restless', 'content', 'wistful', 'affectionate'] as const;
export type Mood = (typeof MOODS)[number];

export const MOOD_ICONS: Record<Mood, string> = {
  cheerful: '😊',
  playful: '😄',
  pensive: '🤔',
  tired: '😴',
  restless: '😬',
  content: '🙂',
  wistful: '🥹',
  affectionate: '🥰',
};

/** Moods a character drifts toward in weather they love / can't stand. */
export const POSITIVE_MOODS: readonly Mood[] = ['cheerful', 'playful', 'content', 'affectionate'];
export const NEGATIVE_MOODS: readonly Mood[] = ['pensive', 'tired', 'restless', 'wistful'];

/**
 * Canonical, season-independent weather kinds. Character preferences reference
 * these (so "loves rain" works year-round); each season draws from its own subset.
 */
export const WEATHER_KINDS = ['sunny', 'clear', 'cloudy', 'rainy', 'windy', 'foggy', 'snowy', 'stormy'] as const;
export type WeatherKind = (typeof WEATHER_KINDS)[number];

export const WEATHER_LABELS: Record<WeatherKind, string> = {
  sunny: 'sunny',
  clear: 'clear and mild',
  cloudy: 'overcast',
  rainy: 'rainy',
  windy: 'breezy',
  foggy: 'foggy',
  snowy: 'snowing',
  stormy: 'stormy',
};

export const WEATHER_ICONS: Record<WeatherKind, string> = {
  sunny: '☀️',
  clear: '🌤️',
  cloudy: '☁️',
  rainy: '🌧️',
  windy: '🍃',
  foggy: '🌫️',
  snowy: '❄️',
  stormy: '⛈️',
};

/** Unpleasant to be outdoors in — an outdoor date in these takes a hit. */
export const HARSH_WEATHER: readonly WeatherKind[] = ['rainy', 'snowy', 'stormy', 'foggy'];
/** Lovely outdoors — an outdoor date in these gets a lift. */
export const PLEASANT_WEATHER: readonly WeatherKind[] = ['sunny', 'clear', 'windy'];

/** Which weather kinds can occur in each season (the day's weather is drawn from these). */
export const SEASON_WEATHER: Record<Season, WeatherKind[]> = {
  Spring: ['clear', 'rainy', 'windy', 'cloudy', 'sunny'],
  Summer: ['sunny', 'clear', 'stormy', 'cloudy'],
  Autumn: ['rainy', 'cloudy', 'foggy', 'windy'],
  Winter: ['snowy', 'cloudy', 'foggy', 'clear'],
};

export interface DayWeather {
  kind: WeatherKind;
  label: string;
  icon: string;
}

/** Resolve a weather kind to its display form. */
export function resolveWeather(kind: WeatherKind): DayWeather {
  return { kind, label: WEATHER_LABELS[kind], icon: WEATHER_ICONS[kind] };
}

// --- Weather app / forecast response shapes (server-computed) ---------------

export interface WeatherForecastDay {
  day: number;
  dayOfWeek: string;
  season: string;
  weather: DayWeather;
  holiday: string | null;
}

export interface CharacterWeatherReaction {
  id: string;
  name: string;
  mood: string;
  moodIcon: string;
  reaction: 'loves' | 'dislikes' | null;
}

export interface WorldWeather {
  day: number;
  today: DayWeather;
  forecast: WeatherForecastDay[];
  characters: CharacterWeatherReaction[];
}
