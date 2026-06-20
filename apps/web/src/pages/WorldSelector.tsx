import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  PHASE_ICONS,
  PHASE_LABELS,
  GENDER_LABELS,
  SEXUALITY_LABELS,
  deriveCalendar,
  type Character,
  type Gender,
  type PhoneInbox,
  type Sexuality,
  type World,
  type WorldState,
} from '@dsim/shared';
import { api } from '../lib/api';
import { useAsync, errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import { Portrait } from '../components/Portrait';
import { Icon, type IconName } from '../components/Icon';
import { Banner, ConfirmDialog, Field, Spinner } from '../components/ui';
import './worldselect.page.css';

/** The deliberate "which world am I playing?" landing page. Reachable at any time
 *  via the "Switch world" link, and the app's entry point when no world is active. */
export function WorldSelector() {
  const { worlds, worldsLoaded, activeWorldId, setActiveWorld, reloadWorlds, creatorMode } = useAppData();
  const navigate = useNavigate();
  const [pendingDelete, setPendingDelete] = useState<World | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();

  const enter = (id: string) => {
    setActiveWorld(id);
    navigate('/');
  };

  const doDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setError(undefined);
    try {
      await api.deleteWorld(pendingDelete.id);
      await reloadWorlds();
      setPendingDelete(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeleting(false);
    }
  };

  if (!worldsLoaded) {
    return (
      <div className="wsel">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="wsel">
      <div className="wsel-atmosphere" aria-hidden="true" />
      <header className="wsel-head">
        <div className="kicker">A lamplit almanac of the heart</div>
        <h1 className="wsel-title">Choose a world</h1>
        <p className="wsel-sub">
          Each world is its own story — its own people, its own calendar, its own you. Step into one to begin, and
          come back here any time to switch.
        </p>
      </header>

      {error && <Banner kind="error">{error}</Banner>}

      <div className="wsel-grid">
        {worlds.map((w) => (
          <WorldCard
            key={w.id}
            world={w}
            isActive={w.id === activeWorldId}
            onEnter={() => enter(w.id)}
            onDelete={creatorMode ? () => setPendingDelete(w) : undefined}
          />
        ))}
        <button className="wsel-new" onClick={() => navigate('/worlds/new')}>
          <span className="wsel-new-mark">
            <Icon name="plus" size={30} />
          </span>
          <span className="wsel-new-title">Start a new world</span>
          <span className="wsel-new-sub">Set up a fresh story and persona</span>
        </button>
      </div>

      {worlds.length === 0 && (
        <p className="wsel-empty-note">Your almanac is empty. Start your first world above to begin.</p>
      )}

      {pendingDelete && (
        <ConfirmDialog
          kicker="Delete world"
          title={`Delete ${pendingDelete.name}?`}
          body="This permanently removes the world and everything in it — its people, your relationships, money, messages, and history. This cannot be undone."
          confirmLabel="Delete forever"
          danger
          busy={deleting}
          onConfirm={doDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function WorldCard({
  world,
  isActive,
  onEnter,
  onDelete,
}: {
  world: World;
  isActive: boolean;
  onEnter: () => void;
  onDelete?: () => void;
}) {
  const data = useAsync(
    () =>
      Promise.all([api.getWorldState(world.id), api.listCharacters(world.id), api.phoneInbox(world.id)]) as Promise<
        [WorldState, Character[], PhoneInbox]
      >,
    [world.id],
  );

  const [state, cast, inbox] = data.data ?? [];
  const cal = state ? deriveCalendar(state.day) : null;
  const unread = inbox ? inbox.unreadTexts + inbox.unreadEmails + inbox.feedUnread : 0;

  return (
    <div className={`wsel-card framed bracketed${isActive ? ' is-active' : ''}`}>
      {isActive && <span className="wsel-current">Currently playing</span>}
      <div className="wsel-card-body">
        <div className="wsel-card-head">
          <h2 className="wsel-card-name">{world.name}</h2>
          {world.tone && <div className="wsel-card-tone">{world.tone}</div>}
        </div>
        {world.summary && <p className="wsel-card-summary">{world.summary}</p>}

        {data.loading && !state ? (
          <div className="wsel-card-loading">
            <Spinner />
          </div>
        ) : (
          <>
            <div className="wsel-stats">
              {state && (
                <div className="wsel-stat">
                  <span className="wsel-stat-k">Day</span>
                  <span className="wsel-stat-v">
                    <span className="wsel-phase">{PHASE_ICONS[state.phase]}</span> {state.day}
                  </span>
                  <span className="wsel-stat-sub">
                    {PHASE_LABELS[state.phase]}
                    {cal ? ` · ${cal.dayOfWeek}` : ''}
                  </span>
                </div>
              )}
              <div className="wsel-stat">
                <span className="wsel-stat-k">People</span>
                <span className="wsel-stat-v">{cast?.length ?? 0}</span>
                <span className="wsel-stat-sub">in your circle</span>
              </div>
              {unread > 0 && (
                <div className="wsel-stat">
                  <span className="wsel-stat-k">Phone</span>
                  <span className="wsel-stat-v wsel-unread">{unread}</span>
                  <span className="wsel-stat-sub">unread</span>
                </div>
              )}
            </div>

            {cast && cast.length > 0 && (
              <div className="wsel-cast">
                {cast.slice(0, 7).map((c) => (
                  <span className="wsel-cast-plate" key={c.id} title={c.name}>
                    <Portrait character={c} />
                  </span>
                ))}
                {cast.length > 7 && <span className="wsel-cast-more">+{cast.length - 7}</span>}
              </div>
            )}
          </>
        )}
      </div>

      <div className="wsel-card-actions">
        <button className="btn primary flex-fill" onClick={onEnter}>
          {isActive ? 'Continue' : 'Enter'} <Icon name="chevronRight" size={16} />
        </button>
        {onDelete && (
          <button className="btn danger ghost" onClick={onDelete} title="Delete world" aria-label="Delete world">
            <Icon name="trash" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

// --- New-world onboarding ---------------------------------------------------

const PRONOUN_OPTIONS = ['she/her', 'he/him', 'they/them'];

const HOW_TO_PLAY: { icon: IconName; text: string }[] = [
  { icon: 'date', text: 'Spend your days meeting people — dates and shared activities each cost a little energy.' },
  { icon: 'people', text: 'Talk, and they remember. Relationships warm or cool over time, and drift if you neglect them.' },
  { icon: 'phone', text: 'Your phone holds texts, mail, and a living social feed that keeps moving as the days pass.' },
  { icon: 'shop', text: 'Buy gifts and keepsakes from the shop — your money and bag are yours alone in this world.' },
  { icon: 'recap', text: 'When your energy is spent, end the day to rest, advance time, and see what happened around town.' },
  { icon: 'worlds', text: 'Switch worlds any time from the selector — each one is a completely separate story and save.' },
];

const STEP_TITLES = ['Set the scene', 'Who are you here?', 'Bring people in', 'How it works'];

/** A guided first-run for a new world: set the scene (blank or cloned from a save),
 *  set up your persona, import people from other worlds, then a how-to-play welcome. */
export function WorldOnboarding() {
  const { worlds, reloadWorlds, setActiveWorld, reloadPlayer } = useAppData();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState<'blank' | 'clone'>('blank');
  const [sourceWorldId, setSourceWorldId] = useState<string>('');
  const [worldForm, setWorldForm] = useState({ name: '', summary: '', tone: '' });
  const [persona, setPersona] = useState<{
    name: string;
    pronouns: string;
    gender: Gender;
    sexuality: Sexuality;
    personaNotes: string;
  }>({ name: '', pronouns: 'they/them', gender: 'unspecified', sexuality: 'unspecified', personaNotes: '' });
  const [world, setWorld] = useState<World | null>(null);
  const [importIds, setImportIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const canClone = worlds.length > 0;

  const pickSource = (id: string) => {
    setSourceWorldId(id);
    const src = worlds.find((w) => w.id === id);
    if (src && !worldForm.name.trim()) setWorldForm((f) => ({ ...f, name: `${src.name} (new save)` }));
  };

  const createTheWorld = async () => {
    if (!worldForm.name.trim()) {
      setError('Give your world a name to continue.');
      return;
    }
    if (mode === 'clone' && !sourceWorldId) {
      setError('Choose a world to start from.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const w =
        mode === 'clone'
          ? await api.cloneWorld(sourceWorldId, worldForm.name.trim())
          : await api.createWorld({
              name: worldForm.name.trim(),
              summary: worldForm.summary.trim(),
              tone: worldForm.tone.trim(),
            });
      setWorld(w);
      await reloadWorlds();
      setStep(2);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const savePersona = async () => {
    if (!world) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.updatePlayer(
        {
          name: persona.name.trim() || 'You',
          pronouns: persona.pronouns,
          gender: persona.gender,
          sexuality: persona.sexuality,
          personaNotes: persona.personaNotes.trim(),
        },
        world.id,
      );
      setStep(3);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const importThenContinue = async () => {
    if (!world) return;
    setBusy(true);
    setError(undefined);
    try {
      if (importIds.size > 0) await api.importCharacters(world.id, [...importIds]);
      setStep(4);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleImport = (id: string) =>
    setImportIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const finish = () => {
    if (!world) return;
    setActiveWorld(world.id);
    void reloadPlayer();
    navigate('/');
  };

  return (
    <div className="wsel wonb">
      <div className="wsel-atmosphere" aria-hidden="true" />
      <header className="wsel-head">
        <div className="kicker">New world · step {step} of 4</div>
        <h1 className="wsel-title">{step === 4 ? `Welcome to ${world?.name ?? 'your world'}` : STEP_TITLES[step - 1]}</h1>
      </header>

      <div className="wonb-steps" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={`wonb-pip${n <= step ? ' on' : ''}`} />
        ))}
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      <div className="framed wonb-panel">
        {step === 1 && (
          <>
            {canClone && (
              <div className="wonb-mode">
                <button
                  className={`wonb-mode-opt${mode === 'blank' ? ' on' : ''}`}
                  onClick={() => setMode('blank')}
                  type="button"
                >
                  <span className="wonb-mode-title">A fresh world</span>
                  <span className="wonb-mode-sub">Start from a blank page</span>
                </button>
                <button
                  className={`wonb-mode-opt${mode === 'clone' ? ' on' : ''}`}
                  onClick={() => setMode('clone')}
                  type="button"
                >
                  <span className="wonb-mode-title">Start from a save</span>
                  <span className="wonb-mode-sub">Copy an existing world &amp; its cast</span>
                </button>
              </div>
            )}

            {mode === 'clone' && canClone ? (
              <>
                <p className="wonb-flavor">
                  Pick a world to copy. Its setting, lore, and the people in it are duplicated into a brand-new save —
                  your money, relationships, and history start fresh.
                </p>
                <div className="wonb-sources">
                  {worlds.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      className={`wonb-source${sourceWorldId === w.id ? ' on' : ''}`}
                      onClick={() => pickSource(w.id)}
                    >
                      <span className="wonb-source-name">{w.name}</span>
                      {w.summary && <span className="wonb-source-sum truncate">{w.summary}</span>}
                    </button>
                  ))}
                </div>
                <Field label="Name your new save">
                  <input
                    value={worldForm.name}
                    placeholder="e.g. The Lumen Quarter — take two"
                    onChange={(e) => setWorldForm({ ...worldForm, name: e.target.value })}
                  />
                </Field>
              </>
            ) : (
              <>
                <p className="wonb-flavor">
                  A world is the stage your story plays out on — a town, a season, a mood. You can flesh out its lore,
                  locations, and people later; for now, just give it a name and a feeling.
                </p>
                <Field label="World name">
                  <input
                    autoFocus
                    value={worldForm.name}
                    placeholder="e.g. The Lumen Quarter"
                    onChange={(e) => setWorldForm({ ...worldForm, name: e.target.value })}
                  />
                </Field>
                <Field label="A one-line summary" hint="Optional — what kind of place is this?">
                  <input
                    value={worldForm.summary}
                    placeholder="A cozy arts district where neighbors become something more."
                    onChange={(e) => setWorldForm({ ...worldForm, summary: e.target.value })}
                  />
                </Field>
                <Field label="Tone" hint="Optional — the emotional key of the story.">
                  <input
                    value={worldForm.tone}
                    placeholder="Warm, hopeful, character-driven romance."
                    onChange={(e) => setWorldForm({ ...worldForm, tone: e.target.value })}
                  />
                </Field>
              </>
            )}

            <div className="row end wonb-actions">
              <button className="btn ghost" onClick={() => navigate('/worlds')} disabled={busy}>
                Back
              </button>
              <button className="btn primary" onClick={createTheWorld} disabled={busy}>
                {busy ? 'Creating…' : 'Continue'} <Icon name="chevronRight" size={16} />
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <p className="wonb-flavor">
              This is a fresh start — a separate you, with your own money, keepsakes, and history in this world. Tell
              us who you are here.
            </p>
            <Field label="Your name">
              <input
                autoFocus
                value={persona.name}
                placeholder="What should people call you?"
                onChange={(e) => setPersona({ ...persona, name: e.target.value })}
              />
            </Field>
            <Field label="Pronouns">
              <select value={persona.pronouns} onChange={(e) => setPersona({ ...persona, pronouns: e.target.value })}>
                {PRONOUN_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
            <div className="inline-fields">
              <Field label="Gender" hint="Separate from pronouns.">
                <select value={persona.gender} onChange={(e) => setPersona({ ...persona, gender: e.target.value as Gender })}>
                  {Object.entries(GENDER_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Sexuality" hint="Decides which characters a romance can deepen with. Leave unspecified to date freely.">
                <select
                  value={persona.sexuality}
                  onChange={(e) => setPersona({ ...persona, sexuality: e.target.value as Sexuality })}
                >
                  {Object.entries(SEXUALITY_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="A little about you" hint="Optional — a sentence or two the people you date will sense about you.">
              <textarea
                value={persona.personaNotes}
                placeholder="A sound engineer who just moved to town. A good listener; bad at sitting still."
                onChange={(e) => setPersona({ ...persona, personaNotes: e.target.value })}
              />
            </Field>
            <div className="row end wonb-actions">
              <button className="btn ghost" onClick={() => setStep(1)} disabled={busy}>
                Back
              </button>
              <button className="btn primary" onClick={savePersona} disabled={busy}>
                {busy ? 'Saving…' : 'Continue'} <Icon name="chevronRight" size={16} />
              </button>
            </div>
          </>
        )}

        {step === 3 && world && (
          <ImportPeopleStep
            newWorldId={world.id}
            selected={importIds}
            onToggle={toggleImport}
            busy={busy}
            onBack={() => setStep(2)}
            onContinue={importThenContinue}
          />
        )}

        {step === 4 && world && <OnboardWelcome world={world} persona={persona.name.trim() || 'You'} onEnter={finish} />}
      </div>
    </div>
  );
}

/** Step 3 — copy people from your OTHER worlds into the new one (optional). */
function ImportPeopleStep({
  newWorldId,
  selected,
  onToggle,
  busy,
  onBack,
  onContinue,
}: {
  newWorldId: string;
  selected: Set<string>;
  onToggle: (id: string) => void;
  busy: boolean;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { worlds } = useAppData();
  const all = useAsync(() => api.listCharacters(), []);
  const others = (all.data ?? []).filter((c) => c.worldId && c.worldId !== newWorldId);

  const byWorld = new Map<string, Character[]>();
  for (const c of others) {
    const arr = byWorld.get(c.worldId!) ?? [];
    arr.push(c);
    byWorld.set(c.worldId!, arr);
  }
  const worldName = (id: string) => worlds.find((w) => w.id === id)?.name ?? 'Another world';

  return (
    <>
      <p className="wonb-flavor">
        Know someone from another world you'd like to meet again? Copy them in as a fresh face — a new beginning, no
        history carried over. Skip this and your world stays as it is.
      </p>

      {all.loading ? (
        <Spinner />
      ) : others.length === 0 ? (
        <div className="wonb-blank">
          <p>You don't have anyone in other worlds to import yet. Skip ahead — you can always create people once you're in.</p>
        </div>
      ) : (
        <div className="wonb-import">
          {[...byWorld.entries()].map(([wid, chars]) => (
            <div key={wid} className="wonb-import-world">
              <div className="wonb-cast-head">
                <span className="kicker">From {worldName(wid)}</span>
                <span className="trail" />
              </div>
              <div className="wonb-import-grid">
                {chars.map((c) => {
                  const on = selected.has(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`wonb-import-plate${on ? ' on' : ''}`}
                      onClick={() => onToggle(c.id)}
                      title={c.shortDescription || c.name}
                    >
                      <Portrait character={c} />
                      <span className="wonb-cast-name truncate">{c.name}</span>
                      {on && (
                        <span className="wonb-import-check">
                          <Icon name="check" size={14} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="row end wonb-actions">
        <button className="btn ghost" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button className="btn primary" onClick={onContinue} disabled={busy}>
          {busy ? 'Importing…' : selected.size > 0 ? `Import ${selected.size} & continue` : 'Skip'}{' '}
          <Icon name="chevronRight" size={16} />
        </button>
      </div>
    </>
  );
}

/** The final onboarding beat: how-to-play + a preview of who lives in this world. */
function OnboardWelcome({ world, persona, onEnter }: { world: World; persona: string; onEnter: () => void }) {
  const { creatorMode } = useAppData();
  const cast = useAsync(() => api.listCharacters(world.id), [world.id]);
  const people = cast.data ?? [];

  return (
    <>
      <p className="wonb-flavor">
        The lamps are lit, {persona}. {world.summary || 'A new chapter is yours to write.'} Here's the shape of a day
        before you step in:
      </p>

      <ul className="wonb-howto">
        {HOW_TO_PLAY.map((h, i) => (
          <li key={i}>
            <span className="wonb-howto-icon">
              <Icon name={h.icon} size={18} />
            </span>
            <span>{h.text}</span>
          </li>
        ))}
      </ul>

      <div className="wonb-cast-head">
        <span className="kicker">The people you could meet</span>
        <span className="trail" />
      </div>

      {cast.loading ? (
        <Spinner />
      ) : people.length > 0 ? (
        <div className="wonb-cast">
          {people.slice(0, 12).map((c) => (
            <div className="wonb-cast-card" key={c.id}>
              <Portrait character={c} />
              <span className="wonb-cast-name truncate">{c.name}</span>
              {c.shortDescription && <span className="wonb-cast-desc">{c.shortDescription}</span>}
            </div>
          ))}
        </div>
      ) : (
        <div className="wonb-blank">
          <p>
            This world is a blank page — no one lives here yet.{' '}
            {creatorMode
              ? 'Once you step inside, head to People to create the characters who call it home.'
              : 'Turn on Creator mode in the phone’s Settings to populate it with people to meet.'}
          </p>
        </div>
      )}

      <div className="row end wonb-actions">
        <button className="btn primary lg" onClick={onEnter}>
          Enter {world.name} <Icon name="chevronRight" size={18} />
        </button>
      </div>
    </>
  );
}
