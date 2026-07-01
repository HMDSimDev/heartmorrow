import type { ReactNode } from 'react';
import './result-card.css';

export type ResultTone = 'brass' | 'rose' | 'sage' | 'ember' | 'moon';

/**
 * A shared "keepsake" outcome card — the generalized form of the date-recap card,
 * for anywhere an app resolves a meaningful RESULT (an outing, a work shift, a
 * trade, a purchase). It speaks the Nocturne .date-moment vellum language: a
 * wax-SEAL flourish, a mono uppercase KICKER (optionally paired with a right-aligned
 * pill via `aside`), an optional display-serif TITLE, an italic-serif SUMMARY, and a
 * ruled LEDGER footer. `tone` recolors the seal / kicker / border / glow:
 *   brass = neutral-good · rose = warmth · sage = gain · ember = loss/strain · moon = quiet.
 * Everything but `tone` is optional, so callers compose only the parts they have.
 */
export function ResultCard({
  tone = 'brass',
  seal,
  kicker,
  aside,
  title,
  summary,
  ledger,
  className,
}: {
  tone?: ResultTone;
  seal?: ReactNode;
  kicker?: ReactNode;
  aside?: ReactNode;
  title?: ReactNode;
  summary?: ReactNode;
  ledger?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`result-card tone-${tone}${className ? ` ${className}` : ''}`}>
      {seal != null && (
        <div className="result-card-seal" aria-hidden="true">
          {seal}
        </div>
      )}
      {(kicker || aside) && (
        <div className="result-card-head">
          {kicker && <div className="result-card-kicker">{kicker}</div>}
          {aside}
        </div>
      )}
      {title && <div className="result-card-title">{title}</div>}
      {summary && <p className="result-card-summary">{summary}</p>}
      {ledger && <div className="result-card-ledger">{ledger}</div>}
    </div>
  );
}

/** A right-aligned header pill (a grade, a fit, the stat that moved) — mirrors the
 *  date-recap mood pill; its tint follows the card tone. */
export function ResultPill({ children }: { children: ReactNode }) {
  return <span className="result-pill">{children}</span>;
}
