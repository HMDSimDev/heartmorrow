import { useEffect, useMemo, useState } from 'react';
import type { ActivityDef, Character, TogetherResult } from '@dsim/shared';
import { RELATIONSHIP_STAT_LABELS, fitLabel, togetherFit } from '@dsim/shared';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/hooks';
import { useAppData } from '../../state/app-context';
import { PhoneAppBar } from './PhoneAppBar';
import { PortraitPicker } from '../PortraitPicker';
import { Banner } from '../ui';
import './phone-life.css';

/** Player-facing copy + banner tone for how an outing landed. */
function togetherNote(res: TogetherResult, name: string): { kind: 'ok' | 'info' | 'error'; text: string } {
  const label = (RELATIONSHIP_STAT_LABELS[res.stat] ?? res.stat).toLowerCase();
  const tension = res.tensionDelta > 0 ? ` (tension +${res.tensionDelta})` : '';
  switch (res.outcome) {
    case 'spark':
      return { kind: 'ok', text: `A spark — ${name} lit up. Your ${label} grew, and the afternoon stuck with them.` };
    case 'warm':
      return {
        kind: 'ok',
        text:
          res.tensionDelta > 0
            ? `A good afternoon with ${name} — ${label} grew (+${res.statDelta}), though it got a touch much by the end${tension}.`
            : `A good afternoon together. Your ${label} with ${name} grew (+${res.statDelta}).`,
      };
    case 'flat':
      return {
        kind: 'info',
        text: `You're as close as easy afternoons can take you. To grow nearer now, ${name} needs a real date.`,
      };
    case 'crowded':
      return { kind: 'info', text: `That's a lot of ${name} for one day — they could use a little room${tension}.` };
    case 'misfire':
      return {
        kind: 'error',
        text: `You reached for something deep too soon and it landed wrong — ${name} pulled back a little${tension}.`,
      };
  }
}

const FIT_HINT: Record<TogetherResult['fit'], { label: string; cls: string }> = {
  great: { label: 'Right up their alley', cls: 'is-great' },
  ok: { label: 'Could be nice', cls: 'is-ok' },
  poor: { label: 'Not really their thing', cls: 'is-poor' },
};

export function TogetherApp() {
  const { activeWorldId, reloadPlayer, refreshWorldState, worldState, dayTick, activeDate } = useAppData();
  const [activities, setActivities] = useState<ActivityDef[]>([]);
  const [allCharacters, setAllCharacters] = useState<Character[]>([]);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'info' | 'error'; text: string }>();
  const [error, setError] = useState<string>();

  const noEnergy = (worldState?.stamina ?? 0) <= 0;
  const onDate = !!activeDate;

  useEffect(() => {
    api.listActivities().then(setActivities).catch(() => undefined);
    api.listCharacters().then(setAllCharacters).catch(() => undefined);
  }, [dayTick]);

  // Time together happens in the active world, so only offer its characters.
  const characters = useMemo(
    () => allCharacters.filter((c) => c.worldId === activeWorldId),
    [allCharacters, activeWorldId],
  );
  useEffect(() => {
    if (characters.length && (target === null || !characters.some((c) => c.id === target))) {
      setTarget(characters[0]!.id);
    }
  }, [characters, target]);

  const partner = characters.find((c) => c.id === target) ?? null;
  const together = activities.filter((a) => a.kind === 'together');
  const partnerOptions = characters.map((c) => ({ id: c.id, character: c }));

  const perform = async (a: ActivityDef) => {
    if (!activeWorldId) {
      setError('Pick an active world first.');
      return;
    }
    if (onDate) {
      setError(`You're on a date with ${activeDate!.characterName} — wrap it up on the Date tab first.`);
      return;
    }
    if (!target) {
      setError('Choose someone to spend time with.');
      return;
    }
    setBusy(true);
    setNote(undefined);
    setError(undefined);
    try {
      const res = await api.performActivity({ activityId: a.id, worldId: activeWorldId, characterId: target });
      await Promise.all([reloadPlayer(), refreshWorldState()]);
      const name = partner?.name.split(' ')[0] ?? 'They';
      if (res.together) setNote(togetherNote(res.together, name));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="phone-app">
      <PhoneAppBar title="Together" kicker="time, shared" icon="together" />
      <div className="phone-embed pl-work-embed">
        {(note || error) && (
          <div className="pl-work-banner">
            {note && <Banner kind={note.kind}>{note.text}</Banner>}
            {error && <Banner kind="error">{error}</Banner>}
          </div>
        )}

        <div className="pl-board">
          <p className="pl-board-note">
            An afternoon is yours to give. Some moods suit some people — and pushing too hard, too soon, or too often
            can cool things. The deepest closeness still only comes from a real date.
          </p>
          {noEnergy && <p className="pl-board-note">You're out of energy for today — end the day to rest.</p>}
          {onDate && (
            <p className="pl-board-note">
              You're with {activeDate!.characterName} right now — finish it on the Date tab first.
            </p>
          )}
        </div>

        {partnerOptions.length === 0 ? (
          <p className="pl-board-note">No one to spend time with in this world yet.</p>
        ) : (
          <>
            <div className="pl-partner-pick">
              <div className="pl-partner-label">With</div>
              <PortraitPicker options={partnerOptions} value={target} onChange={(id) => setTarget(id)} compact />
            </div>

            <div className="pl-eyebrow">Ways to spend the time</div>
            {together.map((a) => {
              const tier = partner ? fitLabel(togetherFit(a, partner.datingStats)) : null;
              const hint = tier ? FIT_HINT[tier] : null;
              const bold = (a.boldness ?? 0) >= 0.3;
              const statLabel = a.relationshipStat ? RELATIONSHIP_STAT_LABELS[a.relationshipStat] : '';
              return (
                <div className="pl-tile pl-together" key={a.id}>
                  <div className="pl-tile-icon" aria-hidden="true">{a.icon ?? '☕'}</div>
                  <div className="pl-tile-body">
                    <div className="pl-tile-label">{a.label}</div>
                    <div className="pl-tile-desc">{a.description}</div>
                    <div className="pl-meta">
                      {hint && <span className={`pl-fit ${hint.cls}`}>{hint.label}</span>}
                      {bold && <span className="pl-bold">a bolder move</span>}
                      {!!a.cost && <span className="pl-cost">◈ {a.cost}</span>}
                    </div>
                  </div>
                  <div className="pl-tile-action">
                    <button
                      className="btn sm"
                      onClick={() => perform(a)}
                      disabled={busy || !target || noEnergy || onDate}
                    >
                      <span className="pl-coin">{statLabel} ↗</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
