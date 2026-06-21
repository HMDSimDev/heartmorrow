import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  PHASE_ICONS,
  PHASE_LABELS,
  GENDER_LABELS,
  SEXUALITY_LABELS,
  deriveCalendar,
  type Character,
  type Gender,
  type Location,
  type PhoneInbox,
  type Sexuality,
  type World,
  type WorldNoteCreate,
  type WorldState,
} from '@dsim/shared';
import { api } from '../lib/api';
import { useAsync, errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import { Portrait } from '../components/Portrait';
import { Icon, type IconName } from '../components/Icon';
import { Banner, ConfirmDialog, Field, Spinner } from '../components/ui';
import { ShareImportButton, ShareExportDialog } from '../components/ShareTools';
import { DraftRestoreBar, UnsavedPill } from '../components/DraftBar';
import { useDraft } from '../lib/useDraft';
import { draftKey } from '../lib/drafts';
import './worldselect.page.css';

/** The deliberate "which world am I playing?" landing page. Reachable at any time
 *  via the "Switch world" link, and the app's entry point when no world is active. */
export function WorldSelector() {
  const { worlds, worldsLoaded, activeWorldId, setActiveWorld, reloadWorlds, creatorMode } = useAppData();
  const navigate = useNavigate();
  const [pendingDelete, setPendingDelete] = useState<World | null>(null);
  const [deleteChars, setDeleteChars] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();
  // Bulk-share selection: pick one or more worlds, then preview + tweak before export.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exportOpen, setExportOpen] = useState(false);

  const enter = (id: string) => {
    setActiveWorld(id);
    navigate('/');
  };

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
    setExportOpen(false);
  };

  const selectedWorlds = worlds.filter((w) => selected.has(w.id));

  const onImported = async () => {
    await reloadWorlds();
  };

  const doDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setError(undefined);
    try {
      await api.deleteWorld(pendingDelete.id, deleteChars);
      await reloadWorlds();
      setPendingDelete(null);
      setDeleteChars(false);
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

      <div className="wsel-share row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 18 }}>
        {!selecting ? (
          <>
            <ShareImportButton
              targetWorldId={activeWorldId ?? null}
              onImported={onImported}
              label="Import a share file"
            />
            {worlds.length > 0 && (
              <button className="btn ghost" type="button" onClick={() => setSelecting(true)}>
                <Icon name="download" size={16} /> Export worlds…
              </button>
            )}
          </>
        ) : (
          <>
            <span className="muted" style={{ alignSelf: 'center' }}>
              {selected.size} selected
            </span>
            <button
              className="btn primary"
              type="button"
              disabled={selected.size === 0}
              onClick={() => setExportOpen(true)}
            >
              <Icon name="download" size={16} /> Export {selected.size > 0 ? selected.size : ''}…
            </button>
            <button className="btn ghost" type="button" onClick={cancelSelecting}>
              Cancel
            </button>
          </>
        )}
      </div>

      <div className="wsel-grid">
        {worlds.map((w) => (
          <WorldCard
            key={w.id}
            world={w}
            isActive={w.id === activeWorldId}
            onEnter={() => enter(w.id)}
            onDelete={creatorMode ? () => setPendingDelete(w) : undefined}
            selecting={selecting}
            isSelected={selected.has(w.id)}
            onToggleSelect={() => toggleSelect(w.id)}
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

      {exportOpen && selectedWorlds.length > 0 && (
        <ShareExportDialog worlds={selectedWorlds} characters={[]} onClose={cancelSelecting} />
      )}

      {pendingDelete && (
        <ConfirmDialog
          kicker="Delete world"
          title={`Delete ${pendingDelete.name}?`}
          body={
            <>
              This permanently removes the world and your progress in it — relationships, money, messages, and
              history. This cannot be undone.
              <label
                style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', marginTop: 12 }}
              >
                <input
                  type="checkbox"
                  checked={deleteChars}
                  onChange={(e) => setDeleteChars(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  Also delete this world's characters. Leave unchecked to keep them — they'll move to Unassigned
                  (People → Unassigned) so you can place them in another world.
                </span>
              </label>
            </>
          }
          confirmLabel="Delete forever"
          danger
          busy={deleting}
          onConfirm={doDelete}
          onCancel={() => {
            setPendingDelete(null);
            setDeleteChars(false);
          }}
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
  selecting = false,
  isSelected = false,
  onToggleSelect,
}: {
  world: World;
  isActive: boolean;
  onEnter: () => void;
  onDelete?: () => void;
  selecting?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
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
    <div
      className={`wsel-card framed bracketed${isActive ? ' is-active' : ''}`}
      style={isSelected ? { outline: '2px solid var(--accent, #c9a36a)', outlineOffset: 3 } : undefined}
    >
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
        {selecting ? (
          <button className="btn ghost flex-fill" type="button" onClick={onToggleSelect} aria-pressed={isSelected}>
            {isSelected ? 'Selected' : 'Select to export'} <Icon name={isSelected ? 'check' : 'plus'} size={16} />
          </button>
        ) : (
          <>
            <button className="btn primary flex-fill" onClick={onEnter}>
              {isActive ? 'Continue' : 'Enter'} <Icon name="chevronRight" size={16} />
            </button>
            {onDelete && (
              <button className="btn danger ghost" onClick={onDelete} title="Delete world" aria-label="Delete world">
                <Icon name="trash" size={16} />
              </button>
            )}
          </>
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

/** Only step 1's pre-commit choices are a true unsaved draft — past step 1 the
 *  world is created server-side and lives in the world list. */
interface OnboardingDraft {
  mode: 'blank' | 'clone';
  sourceWorldId: string;
  worldForm: { name: string; summary: string; tone: string };
}
const ONBOARDING_EMPTY: OnboardingDraft = {
  mode: 'blank',
  sourceWorldId: '',
  worldForm: { name: '', summary: '', tone: '' },
};

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
  // AI "generate the whole world" (blank mode only): a free-form idea + the
  // generated draft (lore/rules/locations) the player can edit before creating.
  const [genPrompt, setGenPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<{
    lore: string;
    rules: string;
    globalNotes: string;
    locations: Location[];
    notes: WorldNoteCreate[];
  } | null>(null);

  const canClone = worlds.length > 0;

  // Auto-keep the step-1 setup as a draft so a half-filled new world survives a
  // refresh / nav back to the selector. Only step 1 is draftable — once the
  // world is created (step 2+) it's a real, persisted record.
  const step1Value = useMemo<OnboardingDraft>(
    () => ({ mode, sourceWorldId, worldForm }),
    [mode, sourceWorldId, worldForm],
  );
  const draft = useDraft<OnboardingDraft>({
    // Disabled once the world is created (step 2+, world != null) so going Back to
    // step 1 can't re-persist a draft for a world that already exists.
    key: step === 1 && world == null ? draftKey.worldOnboarding() : null,
    value: step1Value,
    baseline: ONBOARDING_EMPTY,
    enabled: step === 1 && world == null,
    meta: {
      kind: 'worldOnboarding',
      scopeId: 'singleton',
      worldId: null,
      isNew: true,
      label: () => worldForm.name.trim() || 'Untitled world',
    },
  });

  const pickSource = (id: string) => {
    setSourceWorldId(id);
    const src = worlds.find((w) => w.id === id);
    if (src && !worldForm.name.trim()) setWorldForm((f) => ({ ...f, name: `${src.name} (new save)` }));
  };

  const createTheWorld = async () => {
    // Already created this session (user went Back from step 2) — just continue,
    // never mint a duplicate world.
    if (world) {
      setStep(2);
      return;
    }
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
              // Carry the generated setting + locations + notes through when present.
              // The server persists the notes atomically with the world.
              ...(generated
                ? {
                    lore: generated.lore,
                    rules: generated.rules,
                    globalNotes: generated.globalNotes,
                    locations: generated.locations,
                    notes: generated.notes,
                  }
                : {}),
            });
      setWorld(w);
      draft.clear(); // committed to the server → the step-1 draft is done
      await reloadWorlds();
      setStep(2);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const generateTheWorld = async () => {
    setGenerating(true);
    setError(undefined);
    try {
      const res = await api.generateWorld({
        name: worldForm.name.trim(),
        summary: worldForm.summary.trim(),
        tone: worldForm.tone.trim(),
        prompt: genPrompt.trim(),
      });
      if (res.ok) {
        // Fill the seeds from the draft (keep a name the player already typed),
        // then stash the rest for the editable preview.
        setWorldForm((f) => ({
          name: f.name.trim() || res.data.name,
          summary: res.data.summary,
          tone: res.data.tone,
        }));
        setGenerated({
          lore: res.data.lore,
          rules: res.data.rules,
          globalNotes: res.data.globalNotes,
          locations: res.data.locations,
          notes: res.data.notes,
        });
      } else {
        setError(`World generation failed: ${res.error}`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGenerating(false);
    }
  };

  const updateGenLocation = (i: number, patch: Partial<Location>) =>
    setGenerated((g) =>
      g ? { ...g, locations: g.locations.map((l, j) => (j === i ? { ...l, ...patch } : l)) } : g,
    );
  const removeGenLocation = (i: number) =>
    setGenerated((g) => (g ? { ...g, locations: g.locations.filter((_, j) => j !== i) } : g));

  const updateGenNote = (i: number, patch: Partial<WorldNoteCreate>) =>
    setGenerated((g) => (g ? { ...g, notes: g.notes.map((n, j) => (j === i ? { ...n, ...patch } : n)) } : g));
  const removeGenNote = (i: number) =>
    setGenerated((g) => (g ? { ...g, notes: g.notes.filter((_, j) => j !== i) } : g));

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

      {step === 1 && draft.found && (
        <DraftRestoreBar
          env={draft.found}
          noun="new world"
          onRestore={() => {
            const d = draft.restore();
            if (d) {
              setMode(d.mode);
              setSourceWorldId(d.sourceWorldId);
              setWorldForm({ ...ONBOARDING_EMPTY.worldForm, ...d.worldForm });
            }
          }}
          onDiscard={() => draft.discard()}
          onDismiss={() => draft.dismissFound()}
        />
      )}

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

                <div className="wonb-gen">
                  <div className="wonb-cast-head">
                    <span className="kicker">Or conjure it with AI</span>
                    <span className="trail" />
                  </div>
                  <p className="wonb-flavor">
                    Give a spark — a vibe, a place, a premise — and generate a whole setting, lore, and locations to
                    start from. No people are created; you'll bring those in later. Edit anything before you continue.
                  </p>
                  <Field label="Your idea" hint="Optional — the more you give, the more it has to work with.">
                    <textarea
                      value={genPrompt}
                      rows={3}
                      placeholder="e.g. A storm-battered lighthouse town where everyone keeps a secret — autumn, slow-burn, a little melancholy."
                      onChange={(e) => setGenPrompt(e.target.value)}
                    />
                  </Field>
                  <button className="btn" type="button" onClick={generateTheWorld} disabled={generating || busy}>
                    <Icon name="generate" size={14} />
                    {generating ? 'Generating…' : generated ? 'Regenerate world' : 'Generate world'}
                  </button>

                  {generated && (
                    <div className="wonb-gen-preview">
                      <Field label="Lore" hint="The setting's backstory — edit freely.">
                        <textarea
                          value={generated.lore}
                          rows={5}
                          onChange={(e) => setGenerated((g) => (g ? { ...g, lore: e.target.value } : g))}
                        />
                      </Field>
                      <Field label="World rules" hint="How this world works — may be blank for an ordinary setting.">
                        <textarea
                          value={generated.rules}
                          rows={3}
                          onChange={(e) => setGenerated((g) => (g ? { ...g, rules: e.target.value } : g))}
                        />
                      </Field>
                      <Field
                        label="Global notes"
                        hint="The always-in-mind briefing the narrator keeps for every scene."
                      >
                        <textarea
                          value={generated.globalNotes}
                          rows={3}
                          onChange={(e) => setGenerated((g) => (g ? { ...g, globalNotes: e.target.value } : g))}
                        />
                      </Field>
                      <div className="wonb-cast-head">
                        <span className="kicker">Locations · {generated.locations.length}</span>
                        <span className="trail" />
                      </div>
                      {generated.locations.length === 0 ? (
                        <p className="wonb-flavor">No locations — regenerate to get some.</p>
                      ) : (
                        <div className="wonb-gen-locs">
                          {generated.locations.map((loc, i) => (
                            <div key={loc.id} className="wonb-gen-loc">
                              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                                <input
                                  className="wonb-gen-loc-name"
                                  value={loc.name}
                                  onChange={(e) => updateGenLocation(i, { name: e.target.value })}
                                />
                                <button
                                  className="btn ghost sm"
                                  type="button"
                                  title="Remove location"
                                  onClick={() => removeGenLocation(i)}
                                >
                                  <Icon name="trash" size={13} />
                                </button>
                              </div>
                              <textarea
                                value={loc.description}
                                rows={2}
                                onChange={(e) => updateGenLocation(i, { description: e.target.value })}
                              />
                              {loc.tags.length > 0 && (
                                <div className="wonb-gen-loc-tags">
                                  {loc.tags.map((t) => (
                                    <span key={t} className="wonb-chip">
                                      {t}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="wonb-cast-head">
                        <span className="kicker">World notes · {generated.notes.length}</span>
                        <span className="trail" />
                      </div>
                      {generated.notes.length === 0 ? (
                        <p className="wonb-flavor">No notes — regenerate to get some.</p>
                      ) : (
                        <div className="wonb-gen-locs">
                          {generated.notes.map((note, i) => (
                            <div key={i} className="wonb-gen-loc">
                              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                                <input
                                  className="wonb-gen-loc-name"
                                  value={note.title}
                                  onChange={(e) => updateGenNote(i, { title: e.target.value })}
                                />
                                {note.scope && <span className="wonb-chip">{note.scope}</span>}
                                <button
                                  className="btn ghost sm"
                                  type="button"
                                  title="Remove note"
                                  onClick={() => removeGenNote(i)}
                                >
                                  <Icon name="trash" size={13} />
                                </button>
                              </div>
                              <textarea
                                value={note.body ?? ''}
                                rows={3}
                                onChange={(e) => updateGenNote(i, { body: e.target.value })}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}

            <div className="row end wonb-actions">
              <UnsavedPill dirty={draft.dirty} failed={draft.persistError} />
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
  // Anyone not already in the new world is importable — including unassigned
  // (world-less) people, who'd otherwise be invisible here. '' groups them.
  const UNASSIGNED = '';
  const others = (all.data ?? []).filter((c) => (c.worldId ?? UNASSIGNED) !== newWorldId);

  const byWorld = new Map<string, Character[]>();
  for (const c of others) {
    const key = c.worldId ?? UNASSIGNED;
    const arr = byWorld.get(key) ?? [];
    arr.push(c);
    byWorld.set(key, arr);
  }
  const worldName = (id: string) =>
    id === UNASSIGNED ? 'Unassigned' : worlds.find((w) => w.id === id)?.name ?? 'Another world';

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
          <p>You don't have anyone to import yet. Skip ahead — you can always create people once you're in.</p>
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
