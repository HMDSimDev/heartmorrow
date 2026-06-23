import { z } from 'zod';

/**
 * Wire shapes for the local Prompt Editor — the power-user feature that lets a
 * player override (installation-locally) every system prompt / guardrail the game
 * sends to the model. These schemas describe ONLY the over-the-wire contract; the
 * canonical prompt text and the registry of editable prompts live server-side
 * (apps/server/src/prompt/registry.ts). Overrides are stored in a global
 * `prompt_overrides` table and are NEVER bundled into world/character share files.
 */

/** The functional grouping a prompt belongs to (drives the editor's left-hand list). */
export const PromptCategorySchema = z.enum([
  'roleplay', // the live date / dialogue system prompt + its directive fragments
  'judge', // the impartial scorers (rapport, text judge, evaluator, DTR, walkout, gift…)
  'phone', // texting surfaces (replies, daily texts, relationship beats) + their helpers
  'social', // the "Faces" feed (posts, comments) + their helpers
  'memory', // summaries, recaps, chronicle, fact extraction
  'creator', // creator-mode generators (world / character / items / locations / market…)
  'safety', // safety-critical rails (core guardrails + the opt-in crisis prompts)
]);
export type PromptCategory = z.infer<typeof PromptCategorySchema>;

/**
 * One editable prompt as shown to the client. `id` is the stable registry key
 * (also the override-store primary key). `defaultText` is the shipped template
 * (with any `{{TOKEN}}` placeholders left literal so the editor can show + validate
 * them); `currentText` is the active text (the override when present, else the
 * default). `requiredTokens` lists the `{{TOKEN}}`s the override MUST keep so the
 * game can still interpolate runtime data — deleting one is blocked on save.
 */
export const PromptCatalogEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  category: PromptCategorySchema,
  /** One-line description of when this prompt is used. */
  purpose: z.string(),
  /** The shipped default template (placeholders left as literal `{{TOKEN}}`). */
  defaultText: z.string(),
  /** The active text: the override if one is saved, otherwise `defaultText`. */
  currentText: z.string(),
  /** True when a local override is currently saved for this prompt. */
  isOverridden: z.boolean(),
  /** `{{TOKEN}}` names the override must retain (runtime interpolation slots). */
  requiredTokens: z.array(z.string()).default([]),
  /** When true, the editor shows a "this is a safety rail" warning before editing. */
  safety: z.boolean().default(false),
});
export type PromptCatalogEntry = z.infer<typeof PromptCatalogEntrySchema>;

/** Full catalog returned by `GET /settings/prompts`. */
export const PromptCatalogSchema = z.object({
  entries: z.array(PromptCatalogEntrySchema),
});
export type PromptCatalog = z.infer<typeof PromptCatalogSchema>;

/** Body for `PUT /settings/prompts/:id` — save (or replace) one override. */
export const PromptOverridePatchSchema = z.object({
  /** The custom prompt text. Bounded to keep a runaway paste from bloating prefill. */
  text: z.string().min(1).max(20_000),
});
export type PromptOverridePatch = z.infer<typeof PromptOverridePatchSchema>;

/**
 * An ephemeral override map the Bench preview sends so the player can test edits
 * BEFORE committing them as installation defaults. Applied only for the duration
 * of one bench case run (snapshot + restore), never persisted. Keyed by prompt id.
 */
export const PromptOverrideMapSchema = z.record(z.string(), z.string().max(20_000));
export type PromptOverrideMap = z.infer<typeof PromptOverrideMapSchema>;
