import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActivityDef, Character, TogetherResult } from '@dsim/shared';
import { fitLabel, togetherFit } from '@dsim/shared';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/hooks';
import { useAppData } from '../../state/app-context';
import { relationshipStatLabel } from '../../i18n/labels';
import { PhoneAppBar } from './PhoneAppBar';
import { PortraitPicker } from '../PortraitPicker';
import { Banner } from '../ui';
import './phone-life.css';

type TFn = (key: string, opts?: Record<string, unknown>) => string;

/** Player-facing copy + banner tone for how an outing landed. */
function togetherNote(res: TogetherResult, name: string, t: TFn): { kind: 'ok' | 'info' | 'error'; text: string } {
  const stat = relationshipStatLabel(res.stat).toLowerCase();
  const tension = res.tensionDelta > 0 ? t('together.tensionSuffix', { n: res.tensionDelta }) : '';
  switch (res.outcome) {
    case 'spark':
      return { kind: 'ok', text: t('together.note.spark', { name, stat }) };
    case 'warm':
      return {
        kind: 'ok',
        text:
          res.tensionDelta > 0
            ? t('together.note.warmTension', { name, stat, delta: res.statDelta, tension })
            : t('together.note.warm', { name, stat, delta: res.statDelta }),
      };
    case 'flat':
      return { kind: 'info', text: t('together.note.flat', { name }) };
    case 'crowded':
      return { kind: 'info', text: t('together.note.crowded', { name, tension }) };
    case 'misfire':
      return { kind: 'error', text: t('together.note.misfire', { name, tension }) };
  }
}

const FIT_CLS: Record<TogetherResult['fit'], string> = {
  great: 'is-great',
  ok: 'is-ok',
  poor: 'is-poor',
};

export function TogetherApp() {
  const { t } = useTranslation(['phone', 'common']);
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
      setError(t('together.errWorld'));
      return;
    }
    if (onDate) {
      setError(t('together.errOnDate', { name: activeDate!.characterName }));
      return;
    }
    if (!target) {
      setError(t('together.errChoose'));
      return;
    }
    setBusy(true);
    setNote(undefined);
    setError(undefined);
    try {
      const res = await api.performActivity({ activityId: a.id, worldId: activeWorldId, characterId: target });
      await Promise.all([reloadPlayer(), refreshWorldState()]);
      const name = partner?.name.split(' ')[0] ?? t('together.they');
      if (res.together) setNote(togetherNote(res.together, name, t as unknown as TFn));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="phone-app">
      <PhoneAppBar title={t('together.title')} kicker={t('together.kicker')} icon="together" />
      <div className="phone-embed pl-work-embed">
        {(note || error) && (
          <div className="pl-work-banner">
            {note && <Banner kind={note.kind}>{note.text}</Banner>}
            {error && <Banner kind="error">{error}</Banner>}
          </div>
        )}

        <div className="pl-board">
          <p className="pl-board-note">
            {t('together.boardNote')}
          </p>
          {noEnergy && <p className="pl-board-note">{t('together.noEnergy')}</p>}
          {onDate && (
            <p className="pl-board-note">
              {t('together.onDateNote', { name: activeDate!.characterName })}
            </p>
          )}
        </div>

        {partnerOptions.length === 0 ? (
          <p className="pl-board-note">{t('together.noOne')}</p>
        ) : (
          <>
            <div className="pl-partner-pick">
              <div className="pl-partner-label">{t('together.with')}</div>
              <PortraitPicker options={partnerOptions} value={target} onChange={(id) => setTarget(id)} compact />
            </div>

            <div className="pl-eyebrow">{t('together.ways')}</div>
            {together.map((a) => {
              const tier = partner ? fitLabel(togetherFit(a, partner.datingStats)) : null;
              const bold = (a.boldness ?? 0) >= 0.3;
              const statLabel = a.relationshipStat ? relationshipStatLabel(a.relationshipStat) : '';
              return (
                <div className="pl-tile pl-together" key={a.id}>
                  <div className="pl-tile-icon" aria-hidden="true">{a.icon ?? '☕'}</div>
                  <div className="pl-tile-body">
                    <div className="pl-tile-label">{a.label}</div>
                    <div className="pl-tile-desc">{a.description}</div>
                    <div className="pl-meta">
                      {tier && <span className={`pl-fit ${FIT_CLS[tier]}`}>{t(`together.fit.${tier}`)}</span>}
                      {bold && <span className="pl-bold">{t('together.bolder')}</span>}
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
