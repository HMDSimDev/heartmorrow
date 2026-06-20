/**
 * Reasoning-token filter for DIALOGUE text.
 *
 * Many local "reasoning" models (DeepSeek-R1, Qwen, etc.) emit their chain of
 * thought wrapped in `<think>…</think>` before the actual reply. We strip those
 * blocks from the natural-language dialogue that is shown to and stored for the
 * player. The model still streams tokens — we just suppress everything inside a
 * think block, so the UI can show a "typing…" indicator until the real answer
 * begins.
 *
 * This is plain-text cleanup for the dialogue path ONLY. It is NOT used on the
 * structured-output path (which must remain strict JSON parse + Zod + retry).
 *
 * The streaming variant (`ThinkStripper`) handles tags that are split across
 * token boundaries (e.g. "<thi" then "nk>") without ever emitting a partial tag.
 */

const OPEN = '<think>';
const CLOSE = '</think>';

function indexOfCI(haystack: string, lowerNeedle: string): number {
  return haystack.toLowerCase().indexOf(lowerNeedle);
}

/** Longest suffix of `s` that is a proper prefix of `tag` (case-insensitive). */
function partialSuffixLen(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let k = max; k > 0; k -= 1) {
    if (s.slice(s.length - k).toLowerCase() === tag.slice(0, k).toLowerCase()) return k;
  }
  return 0;
}

export class ThinkStripper {
  private pending = ''; // unresolved raw text (may hold a partial tag)
  private inThink = false;
  private out = '';
  private suppressed = ''; // reasoning buffered while inside an as-yet-unclosed <think>

  /** Feed a raw token chunk; returns the newly-visible (cleaned) text, if any. */
  push(chunk: string): string {
    this.pending += chunk;
    let emitted = '';

    for (;;) {
      if (!this.inThink) {
        const idx = indexOfCI(this.pending, OPEN);
        if (idx !== -1) {
          emitted += this.pending.slice(0, idx);
          this.pending = this.pending.slice(idx + OPEN.length);
          this.inThink = true;
          continue;
        }
        // No complete open tag; emit everything except a possible partial tag.
        const hold = partialSuffixLen(this.pending, OPEN);
        emitted += this.pending.slice(0, this.pending.length - hold);
        this.pending = this.pending.slice(this.pending.length - hold);
        break;
      } else {
        const idx = indexOfCI(this.pending, CLOSE);
        if (idx !== -1) {
          // Properly delimited reasoning — discard it.
          this.suppressed = '';
          this.pending = this.pending.slice(idx + CLOSE.length);
          this.inThink = false;
          continue;
        }
        // Still inside a think block; buffer the reasoning (in case it never
        // closes) but hold back a possible partial close tag.
        const hold = partialSuffixLen(this.pending, CLOSE);
        this.suppressed += this.pending.slice(0, this.pending.length - hold);
        this.pending = this.pending.slice(this.pending.length - hold);
        break;
      }
    }

    this.out += emitted;
    return emitted;
  }

  /** Flush at end of stream; returns any final visible text. */
  end(): string {
    let emitted = '';
    if (this.inThink) {
      // A <think> block that never closed: the model never delimited its answer
      // (some local fine-tunes emit an opening tag but no closing one). Surface
      // the buffered text rather than returning nothing — an empty reply is worse
      // than an undelimited one.
      emitted = this.suppressed + this.pending;
    } else if (this.pending) {
      // A held-back partial-open tag that never completed is just real text.
      emitted = this.pending;
    }
    if (emitted) this.out += emitted;
    this.pending = '';
    this.suppressed = '';
    return emitted;
  }

  get visible(): string {
    return this.out;
  }
}

/** One-shot strip of `<think>…</think>` blocks for non-streamed dialogue. */
export function stripThink(text: string): string {
  const stripper = new ThinkStripper();
  stripper.push(text);
  stripper.end();
  return stripper.visible;
}
