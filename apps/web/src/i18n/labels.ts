// Localized labels for the enum-valued display strings in @dsim/shared
// (phases, seasons, weekdays). The underlying enum VALUES stay canonical English
// — they key the catalogs here and also feed the LLM prompts and icon maps, so
// they must never be translated in place. These helpers map a canonical value to
// its localized label; the catalogs live in `common.json` keyed by that value.
//
// They resolve against the global i18n instance rather than a passed-in `t`: the
// keys are built dynamically from enum values (which the typed-key TFunction
// can't validate), and every component that renders a label also subscribes via
// useTranslation(), so it re-renders — and re-reads these — on a language change.
import type {
  CareerSkill,
  CasinoGame,
  CharacterLinkKind,
  DatingStatKey,
  Gender,
  Intent,
  ItemCategory,
  ItemRarity,
  Phase,
  RelationshipStatus,
  RelationshipStyle,
  PropertyCategory,
  RelationshipStatKey,
  RentCadence,
  Season,
  Sexuality,
  StockSector,
  VideoPokerRank,
  WeatherKind,
} from '@dsim/shared';
import i18n from './index';

// `i18n.t` is typed against the literal key catalog; these keys are dynamic, so
// go through a string-typed view of it.
const t = i18n.t as unknown as (key: string, opts?: Record<string, unknown>) => string;

export const phaseLabel = (phase: Phase | string): string => t(`common:phase.${phase}`);
export const seasonLabel = (season: Season | string): string => t(`common:season.${season}`);
export const seasonAbbr = (season: Season | string): string => t(`common:seasonAbbr.${season}`);
export const weekdayLabel = (day: string): string => t(`common:weekday.${day}`);
export const weekdayAbbr = (day: string): string => t(`common:weekdayAbbr.${day}`);
export const weekday2 = (day: string): string => t(`common:weekday2.${day}`);
export const genderLabel = (gender: Gender | string): string => t(`common:gender.${gender}`);
export const sexualityLabel = (sexuality: Sexuality | string): string => t(`common:sexuality.${sexuality}`);
export const propertyCategoryLabel = (cat: PropertyCategory | string): string => t(`common:propertyCategory.${cat}`);
export const rentCadenceLabel = (c: RentCadence | string): string => t(`common:rentCadence.${c}`);
export const rentCadencePer = (c: RentCadence | string): string => t(`common:rentCadencePer.${c}`);
export const relationshipStatLabel = (k: RelationshipStatKey | string): string => t(`common:relationshipStat.${k}`);
export const datingStatLabel = (k: DatingStatKey | string): string => t(`common:datingStat.${k}`);
export const stockSectorLabel = (s: StockSector | string): string => t(`common:stockSector.${s}`);
export const weatherLabel = (kind: WeatherKind | string): string => t(`common:weather.${kind}`);
export const videoPokerRankLabel = (r: VideoPokerRank | string): string => t(`common:videoPokerRank.${r}`);
export const casinoGameLabel = (g: CasinoGame | string): string => t(`common:casinoGame.${g}`);
export const careerSkillLabel = (s: CareerSkill | string): string => t(`common:careerSkill.${s}`);
export const characterLinkLabel = (k: CharacterLinkKind | string): string => t(`common:characterLink.${k}`);
export const relationshipStatusLabel = (s: RelationshipStatus | string): string => t(`common:relationshipStatus.${s}`);
export const relationshipStyleLabel = (s: RelationshipStyle | string): string => t(`common:relationshipStyle.${s}`);
export const intentLabel = (i: Intent | string): string => t(`common:intent.${i}`);
export const itemRarityLabel = (r: ItemRarity | string): string => t(`common:itemRarity.${r}`);
export const itemCategoryLabel = (c: ItemCategory | string): string => t(`common:itemCategory.${c}`);
export const casinoGameBlurb = (g: CasinoGame | string): string => t(`common:casinoBlurb.${g}`);
export const expressionLabel = (e: string): string => t(`common:expression.${e}`);
export const venueTierLabel = (tier: number): string => t(`common:venueTier.${tier}`);
export const worldNoteScopeLabel = (s: string): string => t(`common:worldNoteScope.${s}`);
export const datingStatDesc = (k: DatingStatKey | string): string => t(`common:datingStatDesc.${k}`);

/** Localized counterpart of shared `guardednessDescriptor` (display only — the
 *  shared English version still feeds prompts). Mirrors its bucket thresholds. */
export function guardednessDescriptorLabel(guardedness = 0): string {
  const g = Math.max(0, Math.min(100, guardedness));
  if (g >= 70) return t('common:guardedness.veryGuarded');
  if (g >= 50) return t('common:guardedness.guarded');
  if (g >= 30) return t('common:guardedness.reserved');
  if (g >= 12) return t('common:guardedness.fairlyOpen');
  return t('common:guardedness.openBook');
}

/** Compact, localized "Nm ago / Nh ago / Nd ago" — consolidates the per-file
 *  `ago()` helpers. App-runtime only (uses Date.now), so safe outside workflows. */
export function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return t('common:relTime.justNow');
  const m = Math.floor(s / 60);
  if (m < 60) return t('common:relTime.minutes', { m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('common:relTime.hours', { h });
  return t('common:relTime.days', { d: Math.floor(h / 24) });
}
