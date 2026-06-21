import './characters.page.css';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Character } from '@dsim/shared';
import { api } from '../lib/api';
import { useAsync, errorMessage } from '../lib/hooks';
import {
  type DraftEnvelope,
  isNewCharScope,
  keyForEnvelope,
  listDrafts,
  pruneDrafts,
  relativeTime,
  removeDraft,
} from '../lib/drafts';
import { Portrait } from '../components/Portrait';
import { Icon } from '../components/Icon';
import { Banner, Empty, Loader, ConfirmDialog } from '../components/ui';
import { ShareImportButton, ShareExportDialog } from '../components/ShareTools';
import { useAppData } from '../state/app-context';

const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // forget month-old drafts

export function Characters() {
  const nav = useNavigate();
  const { creatorMode, activeWorldId, activeWorld, worlds, worldsLoaded, dayTick } = useAppData();
  const state = useAsync(() => api.listCharacters(), [activeWorldId, dayTick]);
  const memorials = useAsync(() => api.listMemorials(activeWorldId ?? undefined), [activeWorldId, dayTick]);
  const lost = new Set(memorials.data ?? []);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
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
          <span className="kicker">The Almanac · Cast</span>
          <h1>People</h1>
          <p>The hearts you keep close — every face you can call on for a date.</p>
        </div>
        {creatorMode && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {selecting ? (
              <>
                <span className="muted" style={{ alignSelf: 'center' }}>
                  {selected.size} selected
                </span>
                <button
                  className="btn primary"
                  type="button"
                  disabled={selected.size === 0}
                  onClick={openExportSelected}
                >
                  <Icon name="download" size={16} /> Export {selected.size > 0 ? selected.size : ''}…
                </button>
                <button className="btn ghost" type="button" onClick={cancelSelecting}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <ShareImportButton
                  targetWorldId={activeWorldId ?? null}
                  onImported={() => state.reload()}
                  label="Import"
                />
                <button className="btn ghost" type="button" onClick={() => setSelecting(true)}>
                  <Icon name="download" size={16} /> Export…
                </button>
                <Link className="btn primary" to="/characters/new">
                  <Icon name="plus" size={16} /> New
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
            <span className="kicker">Unfinished drafts</span>
          </div>
          <div className="ppl-drafts-list">
            {drafts.map((d) => {
              const isNewChar = isNewCharScope(d.scopeId);
              return (
                <div className="ppl-draft-row" key={d.scopeId}>
                  <div className="ppl-draft-main">
                    <span className="ppl-draft-name">{d.label || 'Untitled character'}</span>
                    <span className="ppl-draft-meta">
                      {isNewChar ? 'New character' : 'Unsaved changes'} · {relativeTime(d.updatedAt)}
                    </span>
                  </div>
                  <div className="ppl-draft-actions">
                    <button className="btn sm primary" onClick={() => resumeDraft(d)}>
                      <Icon name="edit" size={14} /> Resume
                    </button>
                    <button className="btn sm ghost" onClick={() => setPendingDraftDiscard(d)}>
                      <Icon name="trash" size={14} /> Discard
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
            <Empty icon={<Icon name="people" size={34} />} title="No one in your life yet">
              {creatorMode ? (
                <>
                  <p>Bring someone into being to start dating.</p>
                  <Link className="btn primary" to="/characters/new">
                    Create your first character
                  </Link>
                </>
              ) : (
                <p>Switch to Creator mode (Phone → Settings) to add characters.</p>
              )}
            </Empty>
          ) : (
            <>
              <div className="ppl-count">
                <span className="ppl-num">{characters.length}</span>{' '}
                {characters.length === 1 ? 'soul' : 'souls'} in your almanac
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
                          <span className="ppl-inmemoriam">In memoriam</span>
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
                        : 'No description yet.'}
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
                          {selected.has(c.id) ? 'Selected' : 'Select'}
                        </button>
                      ) : (
                        <>
                          {memorial ? (
                            <Link className="btn sm ghost ppl-date" to={`/characters/${c.id}`}>
                              <Icon name="remember" size={15} /> Remember
                            </Link>
                          ) : (
                            <Link className="btn sm primary ppl-date" to={`/chat?character=${c.id}`}>
                              <Icon name="date" size={15} /> Date
                            </Link>
                          )}
                          {creatorMode && (
                            <div className="ppl-creator-row">
                              <Link className="btn sm ghost" to={`/characters/${c.id}/edit`}>
                                <Icon name="edit" size={14} /> Edit
                              </Link>
                              <button className="btn sm ghost" onClick={() => duplicate(c.id)} disabled={actingId !== null}>
                                <Icon name="duplicate" size={14} /> Duplicate
                              </button>
                              <button className="btn sm ghost" onClick={() => setExportChars([c])}>
                                <Icon name="download" size={14} /> Export
                              </button>
                              <button className="btn sm danger" onClick={() => setPendingDelete({ id: c.id, name: c.name })}>
                                <Icon name="trash" size={14} /> Delete
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
                      <span className="kicker">Not in any world</span>
                      <h2>Unassigned characters</h2>
                    </div>
                    <span className="trail" />
                  </div>
                  <p className="muted" style={{ marginTop: -6 }}>
                    These belong to no world, so they don't show in any roster.
                    {activeWorld ? ` Place one into ${activeWorld.name} to start dating them.` : ' Enter a world to place them.'}
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
                            <Icon name="plus" size={15} /> Move to {activeWorld?.name ?? 'world'}
                          </button>
                          <div className="ppl-creator-row">
                            <Link className="btn sm ghost" to={`/characters/${c.id}/edit`}>
                              <Icon name="edit" size={14} /> Edit
                            </Link>
                            <button className="btn sm danger" onClick={() => setPendingDelete({ id: c.id, name: c.name })}>
                              <Icon name="trash" size={14} /> Delete
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
          title={`Delete ${pendingDelete.name}?`}
          body="This removes their memories and your relationship too. This can't be undone."
          confirmLabel="Delete"
          danger
          busy={deleting}
          onConfirm={() => remove(pendingDelete.id)}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingDraftDiscard && (
        <ConfirmDialog
          kicker="Discard draft"
          title={`Discard ${pendingDraftDiscard.label?.trim() || 'this draft'}?`}
          body="This permanently removes the unsaved draft. Anything already saved is untouched."
          confirmLabel="Discard draft"
          danger
          onConfirm={() => discardDraft(pendingDraftDiscard)}
          onCancel={() => setPendingDraftDiscard(null)}
        />
      )}
    </div>
  );
}
