import './characters.page.css';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAsync, errorMessage } from '../lib/hooks';
import { Portrait } from '../components/Portrait';
import { Icon } from '../components/Icon';
import { Banner, Empty, Loader, ConfirmDialog } from '../components/ui';
import { useAppData } from '../state/app-context';

export function Characters() {
  const nav = useNavigate();
  const { creatorMode, activeWorldId, activeWorld, dayTick } = useAppData();
  const state = useAsync(() => api.listCharacters(), [activeWorldId, dayTick]);
  const memorials = useAsync(() => api.listMemorials(activeWorldId ?? undefined), [activeWorldId, dayTick]);
  const lost = new Set(memorials.data ?? []);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

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
          <Link className="btn primary" to="/characters/new">
            <Icon name="plus" size={16} /> New
          </Link>
        )}
      </div>

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
                  <article className={`ppl-plate${memorial ? ' ppl-memorial' : ''}`} key={c.id}>
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
                          <button className="btn sm danger" onClick={() => setPendingDelete({ id: c.id, name: c.name })}>
                            <Icon name="trash" size={14} /> Delete
                          </button>
                        </div>
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
    </div>
  );
}
