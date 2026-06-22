import './characters.page.css';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import type { Character } from '@dsim/shared';
import { api } from '../lib/api';
import { useAsync, errorMessage } from '../lib/hooks';
import {
  type DraftEnvelope,
  isNewCharScope,
  keyForEnvelope,
  listDrafts,
  pruneDrafts,
  removeDraft,
} from '../lib/drafts';
import { relativeTime } from '../i18n/labels';
import { Portrait } from '../components/Portrait';
import { Icon } from '../components/Icon';
import { Banner, Empty, Loader, ConfirmDialog } from '../components/ui';
import { ShareImportButton, ShareExportDialog } from '../components/ShareTools';
import { useAppData } from '../state/app-context';

const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // forget month-old drafts

export function Characters() {
  const { t } = useTranslation(['pages', 'common']);
  const nav = useNavigate();
  const { creatorMode, activeWorldId, activeWorld, worlds, worldsLoaded, dayTick } = useAppData();
  const state = useAsync(() => api.listCharacters(), [activeWorldId, dayTick]);
  const memorials = useAsync(() => api.listMemorials(activeWorldId ?? undefined), [activeWorldId, dayTick]);
  const lost = new Set(memorials.data ?? []);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [pendingDuplicate, setPendingDuplicate] = useState<{ id: string; name: string } | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Bulk-share selection: pick people, then preview + tweak before export.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The people queued for the export dialog (a single Export click, or the selection).
  const [exportChars, setExportChars] = useState<Character[] | null>(null);

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const cancelSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const openExportSelected = () => {
    const picked = (state.data ?? []).filter((c) => selected.has(c.id));
    if (picked.length > 0) setExportChars(picked);
  };

  // Unfinished character drafts (auto-kept but never saved) for THIS world, so an
  // abandoned new character / unsaved edit is findable here, not just behind the
  // editor route. Pruned of drafts whose world or character no longer exists.
  const [drafts, setDrafts] = useState<DraftEnvelope[]>([]);
  const [pendingDraftDiscard, setPendingDraftDiscard] = useState<DraftEnvelope | null>(null);
  const allChars = state.data;
  useEffect(() => {
    if (!creatorMode || !activeWorldId) {
      setDrafts([]);
      return;
    }
    // Only prune against the world/character lists once they're actually loaded —
    // pruning against an empty set would wrongly delete everything.
    pruneDrafts({
      maxAgeMs: DRAFT_MAX_AGE_MS,
      liveWorldIds: worldsLoaded ? new Set(worlds.map((w) => w.id)) : undefined,
      liveCharacterIds: allChars ? new Set(allChars.map((c) => c.id)) : undefined,
    });
    setDrafts(listDrafts({ kind: 'character', worldId: activeWorldId }));
  }, [creatorMode, activeWorldId, worlds, worldsLoaded, allChars, dayTick]);

  const discardDraft = (env: DraftEnvelope) => {
    removeDraft(keyForEnvelope(env));
    setDrafts((ds) => ds.filter((d) => d.scopeId !== env.scopeId));
    setPendingDraftDiscard(null);
  };

  const resumeDraft = (env: DraftEnvelope) =>
    // The user already chose to continue this draft — tell the editor to apply it
    // straight away rather than offer its own restore bar a second time.
    nav(isNewCharScope(env.scopeId) ? '/characters/new' : `/characters/${env.scopeId}/edit`, {
      state: { resumeDraft: true },
    });

  const duplicate = async (id: string) => {
    if (actingId) return;
    setActingId(id);
    try {
      const copy = await api.duplicateCharacter(id);
      nav(`/characters/${copy.id}/edit`); // navigates away
    } catch (e) {
      setActingId(null);
      alert(errorMessage(e));
    }
  };

  const remove = async (id: string) => {
    if (deleting) return;
    setDeleting(true);
    try {
      await api.deleteCharacter(id);
      state.reload();
    } catch (e) {
      alert(errorMessage(e));
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  // Recover a world-less ("unassigned") character by placing it into the active world.
  const moveToWorld = async (id: string) => {
    if (!activeWorldId || actingId) return;
    setActingId(id);
    try {
      await api.updateCharacter(id, { worldId: activeWorldId });
      state.reload();
    } catch (e) {
      alert(errorMessage(e));
    } finally {
      setActingId(null);
    }
  };

  return (
    <div className="stack">
      <div className="page-head ppl-head">
        <div className="ppl-titles">
          <span className="kicker">{t('characters.kicker')}</span>
          <h1>{t('characters.title')}</h1>
          <p>{t('characters.blurb')}</p>
        </div>
        {creatorMode && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {selecting ? (
              <>
                <span className="muted" style={{ alignSelf: 'center' }}>
                  {t('characters.selected', { count: selected.size })}
                </span>
                <button
                  className="btn primary"
                  type="button"
                  disabled={selected.size === 0}
                  onClick={openExportSelected}
                >
                  <Icon name="download" size={16} /> {t('characters.exportCount', { count: selected.size })}
                </button>
                <button className="btn ghost" type="button" onClick={cancelSelecting}>
                  {t('characters.cancel')}
                </button>
              </>
            ) : (
              <>
                <ShareImportButton
                  targetWorldId={activeWorldId ?? null}
                  onImported={() => state.reload()}
                  label={t('characters.import')}
                />
                <button className="btn ghost" type="button" onClick={() => setSelecting(true)}>
                  <Icon name="download" size={16} /> {t('characters.export')}
                </button>
                <Link className="btn primary" to="/characters/new">
                  <Icon name="plus" size={16} /> {t('characters.new')}
                </Link>
              </>
            )}
          </div>
        )}
      </div>

      {exportChars && exportChars.length > 0 && (
        <ShareExportDialog worlds={[]} characters={exportChars} onClose={() => setExportChars(null)} />
      )}

      {creatorMode && drafts.length > 0 && (
        <section className="ppl-drafts">
          <div className="ppl-drafts-head">
            <span className="ppl-draft-mark"><Icon name="recap" size={15} /></span>
            <span className="kicker">{t('characters.unfinishedDrafts')}</span>
          </div>
          <div className="ppl-drafts-list">
            {drafts.map((d) => {
              const isNewChar = isNewCharScope(d.scopeId);
              return (
                <div className="ppl-draft-row" key={d.scopeId}>
                  <div className="ppl-draft-main">
                    <span className="ppl-draft-name">{d.label || t('characters.untitled')}</span>
                    <span className="ppl-draft-meta">
                      {isNewChar ? t('characters.newCharacter') : t('characters.unsavedChanges')} · {relativeTime(d.updatedAt)}
                    </span>
                  </div>
                  <div className="ppl-draft-actions">
                    <button className="btn sm primary" onClick={() => resumeDraft(d)}>
                      <Icon name="edit" size={14} /> {t('characters.resume')}
                    </button>
                    <button className="btn sm ghost" onClick={() => setPendingDraftDiscard(d)}>
                      <Icon name="trash" size={14} /> {t('characters.discard')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <Loader state={state}>
        {(allCharacters) => {
          // Only people from the active world appear in this world.
          const characters = allCharacters.filter((c) => !activeWorldId || c.worldId === activeWorldId);
          // World-less ("unassigned") characters belong to no world's roster — surface
          // them (creator mode) so they can be recovered instead of lost forever.
          const unassigned = creatorMode ? allCharacters.filter((c) => !c.worldId) : [];
          return (
            <>
              {characters.length === 0 ? (
            <Empty icon={<Icon name="people" size={34} />} title={t('characters.emptyTitle')}>
              {creatorMode ? (
                <>
                  <p>{t('characters.emptyCreatorBody')}</p>
                  <Link className="btn primary" to="/characters/new">
                    {t('characters.createFirst')}
                  </Link>
                </>
              ) : (
                <p>{t('characters.emptyPlayerBody')}</p>
              )}
            </Empty>
          ) : (
            <>
              <div className="ppl-count">
                <Trans i18nKey="characters.soulCount" ns="pages" count={characters.length} components={[<span className="ppl-num" />]} />
              </div>
              <div className="ppl-gallery">
                {characters.map((c) => {
                  const memorial = lost.has(c.id);
                  return (
                  <article
                    className={`ppl-plate${memorial ? ' ppl-memorial' : ''}${selecting && selected.has(c.id) ? ' is-selected' : ''}`}
                    key={c.id}
                    style={selecting && selected.has(c.id) ? { outline: '2px solid var(--accent, #c9a36a)', outlineOffset: 3 } : undefined}
                  >
                    <div className="ppl-frame">
                      <Link className="ppl-portrait-link" to={`/characters/${c.id}`}>
                        <Portrait character={c} memorial={memorial} />
                      </Link>
                    </div>

                    <div className="ppl-nameplate">
                      <h3 className="ppl-name">
                        <Link to={`/characters/${c.id}`}>{c.name}</Link>
                      </h3>
                      <div className="ppl-meta">
                        {memorial ? (
                          <span className="ppl-inmemoriam">{t('characters.inMemoriam')}</span>
                        ) : (
                          <>
                            {c.age}
                            <span className="ppl-dot">·</span>
                            {c.pronouns}
                          </>
                        )}
                      </div>
                    </div>

                    <p
                      className={`ppl-desc${c.shortDescription ? '' : ' ppl-empty-desc'}`}
                    >
                      {c.shortDescription
                        ? c.shortDescription.length > 90
                          ? `${c.shortDescription.slice(0, 90).trimEnd()}…`
                          : c.shortDescription
                        : t('characters.noDescription')}
                    </p>

                    <div className="ppl-actions">
                      {selecting ? (
                        <button
                          className={`btn sm ${selected.has(c.id) ? 'primary' : 'ghost'} ppl-date`}
                          type="button"
                          onClick={() => toggleSelect(c.id)}
                          aria-pressed={selected.has(c.id)}
                        >
                          <Icon name={selected.has(c.id) ? 'check' : 'plus'} size={15} />{' '}
                          {selected.has(c.id) ? t('characters.selectedBtn') : t('characters.select')}
                        </button>
                      ) : (
                        <>
                          {memorial ? (
                            <Link className="btn sm ghost ppl-date" to={`/characters/${c.id}`}>
                              <Icon name="remember" size={15} /> {t('characters.remember')}
                            </Link>
                          ) : (
                            <Link className="btn sm primary ppl-date" to={`/chat?character=${c.id}`}>
                              <Icon name="date" size={15} /> {t('characters.date')}
                            </Link>
                          )}
                          {creatorMode && (
                            <div className="ppl-creator-row">
                              <Link className="btn sm ghost" to={`/characters/${c.id}/edit`}>
                                <Icon name="edit" size={14} /> {t('characters.edit')}
                              </Link>
                              <button
                                className="btn sm ghost"
                                onClick={() => setPendingDuplicate({ id: c.id, name: c.name })}
                                disabled={actingId !== null}
                              >
                                <Icon name="duplicate" size={14} /> {t('characters.duplicate')}
                              </button>
                              <button className="btn sm ghost" onClick={() => setExportChars([c])}>
                                <Icon name="download" size={14} /> {t('characters.export')}
                              </button>
                              <button className="btn sm danger" onClick={() => setPendingDelete({ id: c.id, name: c.name })}>
                                <Icon name="trash" size={14} /> {t('characters.delete')}
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </article>
                  );
                })}
              </div>
            </>
          )}

              {unassigned.length > 0 && (
                <section className="stack" style={{ marginTop: 24 }}>
                  <div className="section-head">
                    <div className="titles">
                      <span className="kicker">{t('characters.notInWorld')}</span>
                      <h2>{t('characters.unassignedTitle')}</h2>
                    </div>
                    <span className="trail" />
                  </div>
                  <p className="muted" style={{ marginTop: -6 }}>
                    {t('characters.unassignedBody')}
                    {activeWorld ? t('characters.placeInWorld', { world: activeWorld.name }) : t('characters.enterWorld')}
                  </p>
                  <div className="ppl-gallery">
                    {unassigned.map((c) => (
                      <article className="ppl-plate" key={c.id}>
                        <div className="ppl-frame">
                          <Link className="ppl-portrait-link" to={`/characters/${c.id}`}>
                            <Portrait character={c} />
                          </Link>
                        </div>
                        <div className="ppl-nameplate">
                          <h3 className="ppl-name">
                            <Link to={`/characters/${c.id}`}>{c.name}</Link>
                          </h3>
                          <div className="ppl-meta">
                            {c.age}
                            <span className="ppl-dot">·</span>
                            {c.pronouns}
                          </div>
                        </div>
                        <div className="ppl-actions">
                          <button
                            className="btn sm primary ppl-date"
                            disabled={!activeWorldId || actingId !== null}
                            onClick={() => moveToWorld(c.id)}
                          >
                            <Icon name="plus" size={15} /> {t('characters.moveTo', { world: activeWorld?.name ?? t('characters.world') })}
                          </button>
                          <div className="ppl-creator-row">
                            <Link className="btn sm ghost" to={`/characters/${c.id}/edit`}>
                              <Icon name="edit" size={14} /> {t('characters.edit')}
                            </Link>
                            <button className="btn sm danger" onClick={() => setPendingDelete({ id: c.id, name: c.name })}>
                              <Icon name="trash" size={14} /> {t('characters.delete')}
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}
            </>
          );
        }}
      </Loader>
      {state.error && <Banner kind="error">{state.error}</Banner>}

      {pendingDelete && (
        <ConfirmDialog
          title={t('characters.confirmDeleteTitle', { name: pendingDelete.name })}
          body={t('characters.confirmDeleteBody')}
          confirmLabel={t('characters.delete')}
          danger
          busy={deleting}
          onConfirm={() => remove(pendingDelete.id)}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingDuplicate && (
        <ConfirmDialog
          kicker={t('characters.duplicateKicker')}
          title={t('characters.confirmDuplicateTitle', { name: pendingDuplicate.name })}
          body={t('characters.confirmDuplicateBody', { name: pendingDuplicate.name })}
          confirmLabel={t('characters.duplicate')}
          busy={actingId !== null}
          onConfirm={() => {
            const id = pendingDuplicate.id;
            setPendingDuplicate(null);
            void duplicate(id);
          }}
          onCancel={() => setPendingDuplicate(null)}
        />
      )}

      {pendingDraftDiscard && (
        <ConfirmDialog
          kicker={t('characters.discardKicker')}
          title={t('characters.confirmDiscardTitle', { label: pendingDraftDiscard.label?.trim() || t('characters.thisDraft') })}
          body={t('characters.confirmDiscardBody')}
          confirmLabel={t('characters.discardDraft')}
          danger
          onConfirm={() => discardDraft(pendingDraftDiscard)}
          onCancel={() => setPendingDraftDiscard(null)}
        />
      )}
    </div>
  );
}
