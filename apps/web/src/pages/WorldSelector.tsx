import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  PHASE_ICONS,
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
import { phaseLabel, genderLabel, sexualityLabel, weekdayLabel } from '../i18n/labels';
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
  const { t } = useTranslation(['pages', 'common']);
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
        <div className="kicker">{t('pages:worldSelector.kicker')}</div>
        <h1 className="wsel-title">{t('pages:worldSelector.title')}</h1>
        <p className="wsel-sub">{t('pages:worldSelector.sub')}</p>
      </header>

      {error && <Banner kind="error">{error}</Banner>}

      <div className="wsel-share row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 18 }}>
        {!selecting ? (
          <>
            <ShareImportButton
              targetWorldId={activeWorldId ?? null}
              onImported={onImported}
              label={t('pages:worldSelector.importFile')}
            />
            {worlds.length > 0 && (
              <button className="btn ghost" type="button" onClick={() => setSelecting(true)}>
                <Icon name="download" size={16} /> {t('pages:worldSelector.exportWorlds')}
              </button>
            )}
          </>
        ) : (
          <>
            <span className="muted" style={{ alignSelf: 'center' }}>
              {t('pages:worldSelector.nSelected', { count: selected.size })}
            </span>
            <button
              className="btn primary"
              type="button"
              disabled={selected.size === 0}
              onClick={() => setExportOpen(true)}
            >
              <Icon name="download" size={16} />{' '}
              {selected.size > 0
                ? t('pages:worldSelector.exportN', { count: selected.size })
                : t('pages:worldSelector.export')}
            </button>
            <button className="btn ghost" type="button" onClick={cancelSelecting}>
              {t('pages:worldSelector.cancel')}
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
          <span className="wsel-new-title">{t('pages:worldSelector.startNew')}</span>
          <span className="wsel-new-sub">{t('pages:worldSelector.startNewSub')}</span>
        </button>
      </div>

      {worlds.length === 0 && <p className="wsel-empty-note">{t('pages:worldSelector.emptyNote')}</p>}

      {exportOpen && selectedWorlds.length > 0 && (
        <ShareExportDialog worlds={selectedWorlds} characters={[]} onClose={cancelSelecting} />
      )}

      {pendingDelete && (
        <ConfirmDialog
          kicker={t('pages:worldSelector.deleteKicker')}
          title={t('pages:worldSelector.deleteTitle', { name: pendingDelete.name })}
          body={
            <>
              {t('pages:worldSelector.deleteBody')}
              <label
                style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', marginTop: 12 }}
              >
                <input
                  type="checkbox"
                  checked={deleteChars}
                  onChange={(e) => setDeleteChars(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>{t('pages:worldSelector.deleteCharsLabel')}</span>
              </label>
            </>
          }
          confirmLabel={t('pages:worldSelector.deleteConfirm')}
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
  const { t } = useTranslation('pages');
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
      {isActive && <span className="wsel-current">{t('worldSelector.currentlyPlaying')}</span>}
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
                  <span className="wsel-stat-k">{t('worldSelector.day')}</span>
                  <span className="wsel-stat-v">
                    <span className="wsel-phase">{PHASE_ICONS[state.phase]}</span> {state.day}
                  </span>
                  <span className="wsel-stat-sub">
                    {phaseLabel(state.phase)}
                    {cal ? ` · ${weekdayLabel(cal.dayOfWeek)}` : ''}
                  </span>
                </div>
              )}
              <div className="wsel-stat">
                <span className="wsel-stat-k">{t('worldSelector.people')}</span>
                <span className="wsel-stat-v">{cast?.length ?? 0}</span>
                <span className="wsel-stat-sub">{t('worldSelector.inCircle')}</span>
              </div>
              {unread > 0 && (
                <div className="wsel-stat">
                  <span className="wsel-stat-k">{t('worldSelector.phone')}</span>
                  <span className="wsel-stat-v wsel-unread">{unread}</span>
                  <span className="wsel-stat-sub">{t('worldSelector.unread')}</span>
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
            {isSelected ? t('worldSelector.selected') : t('worldSelector.selectToExport')}{' '}
            <Icon name={isSelected ? 'check' : 'plus'} size={16} />
          </button>
        ) : (
          <>
            <button className="btn primary flex-fill" onClick={onEnter}>
              {isActive ? t('worldSelector.continue') : t('worldSelector.enter')}{' '}
              <Icon name="chevronRight" size={16} />
            </button>
            {onDelete && (
              <button
                className="btn danger ghost"
                onClick={onDelete}
                title={t('worldSelector.deleteWorld')}
                aria-label={t('worldSelector.deleteWorld')}
              >
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

const HOW_TO_PLAY: { icon: IconName; key: string }[] = [
  { icon: 'date', key: 'howToPlay.date' },
  { icon: 'people', key: 'howToPlay.people' },
  { icon: 'phone', key: 'howToPlay.phone' },
  { icon: 'shop', key: 'howToPlay.shop' },
  { icon: 'recap', key: 'howToPlay.recap' },
  { icon: 'worlds', key: 'howToPlay.worlds' },
];

const STEP_TITLE_KEYS = ['stepTitles.setScene', 'stepTitles.whoAreYou', 'stepTitles.bringPeople', 'stepTitles.howItWorks'];

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
  const { t } = useTranslation(['pages', 'common']);
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
      label: () => worldForm.name.trim() || t('pages:worldOnboarding.untitledWorld'),
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
      setError(t('pages:worldOnboarding.nameRequired'));
      return;
    }
    if (mode === 'clone' && !sourceWorldId) {
      setError(t('pages:worldOnboarding.chooseSource'));
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
        setError(t('pages:worldOnboarding.genFailed', { error: res.error }));
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
        <div className="kicker">{t('pages:worldOnboarding.stepOf', { step })}</div>
        <h1 className="wsel-title">
          {step === 4
            ? t('pages:worldOnboarding.welcome', {
                name: world?.name ?? t('pages:worldOnboarding.yourWorldFallback'),
              })
            : t(`pages:worldOnboarding.${STEP_TITLE_KEYS[step - 1]}` as 'pages:worldOnboarding.stepTitles.setScene')}
        </h1>
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
          noun={t('pages:worldOnboarding.nounNewWorld')}
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
                  <span className="wonb-mode-title">{t('pages:worldOnboarding.modeFreshTitle')}</span>
                  <span className="wonb-mode-sub">{t('pages:worldOnboarding.modeFreshSub')}</span>
                </button>
                <button
                  className={`wonb-mode-opt${mode === 'clone' ? ' on' : ''}`}
                  onClick={() => setMode('clone')}
                  type="button"
                >
                  <span className="wonb-mode-title">{t('pages:worldOnboarding.modeCloneTitle')}</span>
                  <span className="wonb-mode-sub">{t('pages:worldOnboarding.modeCloneSub')}</span>
                </button>
              </div>
            )}

            {mode === 'clone' && canClone ? (
              <>
                <p className="wonb-flavor">{t('pages:worldOnboarding.cloneFlavor')}</p>
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
                <Field label={t('pages:worldOnboarding.nameNewSave')}>
                  <input
                    value={worldForm.name}
                    placeholder={t('pages:worldOnboarding.nameNewSavePlaceholder')}
                    onChange={(e) => setWorldForm({ ...worldForm, name: e.target.value })}
                  />
                </Field>
              </>
            ) : (
              <>
                <p className="wonb-flavor">{t('pages:worldOnboarding.blankFlavor')}</p>
                <Field label={t('pages:worldOnboarding.worldName')}>
                  <input
                    autoFocus
                    value={worldForm.name}
                    placeholder={t('pages:worldOnboarding.worldNamePlaceholder')}
                    onChange={(e) => setWorldForm({ ...worldForm, name: e.target.value })}
                  />
                </Field>
                <Field
                  label={t('pages:worldOnboarding.summaryLabel')}
                  hint={t('pages:worldOnboarding.summaryHint')}
                >
                  <input
                    value={worldForm.summary}
                    placeholder={t('pages:worldOnboarding.summaryPlaceholder')}
                    onChange={(e) => setWorldForm({ ...worldForm, summary: e.target.value })}
                  />
                </Field>
                <Field label={t('pages:worldOnboarding.toneLabel')} hint={t('pages:worldOnboarding.toneHint')}>
                  <input
                    value={worldForm.tone}
                    placeholder={t('pages:worldOnboarding.tonePlaceholder')}
                    onChange={(e) => setWorldForm({ ...worldForm, tone: e.target.value })}
                  />
                </Field>

                <div className="wonb-gen">
                  <div className="wonb-cast-head">
                    <span className="kicker">{t('pages:worldOnboarding.conjureKicker')}</span>
                    <span className="trail" />
                  </div>
                  <p className="wonb-flavor">{t('pages:worldOnboarding.conjureFlavor')}</p>
                  <Field label={t('pages:worldOnboarding.ideaLabel')} hint={t('pages:worldOnboarding.ideaHint')}>
                    <textarea
                      value={genPrompt}
                      rows={3}
                      placeholder={t('pages:worldOnboarding.ideaPlaceholder')}
                      onChange={(e) => setGenPrompt(e.target.value)}
                    />
                  </Field>
                  <button className="btn" type="button" onClick={generateTheWorld} disabled={generating || busy}>
                    <Icon name="generate" size={14} />
                    {generating
                      ? t('pages:worldOnboarding.generating')
                      : generated
                        ? t('pages:worldOnboarding.regenerate')
                        : t('pages:worldOnboarding.generate')}
                  </button>

                  {generated && (
                    <div className="wonb-gen-preview">
                      <Field label={t('pages:worldOnboarding.loreLabel')} hint={t('pages:worldOnboarding.loreHint')}>
                        <textarea
                          value={generated.lore}
                          rows={5}
                          onChange={(e) => setGenerated((g) => (g ? { ...g, lore: e.target.value } : g))}
                        />
                      </Field>
                      <Field
                        label={t('pages:worldOnboarding.rulesLabel')}
                        hint={t('pages:worldOnboarding.rulesHint')}
                      >
                        <textarea
                          value={generated.rules}
                          rows={3}
                          onChange={(e) => setGenerated((g) => (g ? { ...g, rules: e.target.value } : g))}
                        />
                      </Field>
                      <Field
                        label={t('pages:worldOnboarding.globalNotesLabel')}
                        hint={t('pages:worldOnboarding.globalNotesHint')}
                      >
                        <textarea
                          value={generated.globalNotes}
                          rows={3}
                          onChange={(e) => setGenerated((g) => (g ? { ...g, globalNotes: e.target.value } : g))}
                        />
                      </Field>
                      <div className="wonb-cast-head">
                        <span className="kicker">
                          {t('pages:worldOnboarding.locationsCount', { count: generated.locations.length })}
                        </span>
                        <span className="trail" />
                      </div>
                      {generated.locations.length === 0 ? (
                        <p className="wonb-flavor">{t('pages:worldOnboarding.noLocations')}</p>
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
                                  title={t('pages:worldOnboarding.removeLocation')}
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
                                  {loc.tags.map((tag) => (
                                    <span key={tag} className="wonb-chip">
                                      {tag}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="wonb-cast-head">
                        <span className="kicker">
                          {t('pages:worldOnboarding.worldNotesCount', { count: generated.notes.length })}
                        </span>
                        <span className="trail" />
                      </div>
                      {generated.notes.length === 0 ? (
                        <p className="wonb-flavor">{t('pages:worldOnboarding.noNotes')}</p>
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
                                  title={t('pages:worldOnboarding.removeNote')}
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
                {t('pages:worldOnboarding.back')}
              </button>
              <button className="btn primary" onClick={createTheWorld} disabled={busy}>
                {busy ? t('pages:worldOnboarding.creating') : t('pages:worldOnboarding.continue')}{' '}
                <Icon name="chevronRight" size={16} />
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <p className="wonb-flavor">{t('pages:worldOnboarding.personaFlavor')}</p>
            <Field label={t('pages:worldOnboarding.yourName')}>
              <input
                autoFocus
                value={persona.name}
                placeholder={t('pages:worldOnboarding.yourNamePlaceholder')}
                onChange={(e) => setPersona({ ...persona, name: e.target.value })}
              />
            </Field>
            <Field label={t('pages:worldOnboarding.pronouns')}>
              <select value={persona.pronouns} onChange={(e) => setPersona({ ...persona, pronouns: e.target.value })}>
                {PRONOUN_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
            <div className="inline-fields">
              <Field label={t('pages:worldOnboarding.gender')} hint={t('pages:worldOnboarding.genderHint')}>
                <select value={persona.gender} onChange={(e) => setPersona({ ...persona, gender: e.target.value as Gender })}>
                  {Object.keys(GENDER_LABELS).map((k) => (
                    <option key={k} value={k}>
                      {genderLabel(k)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('pages:worldOnboarding.sexuality')} hint={t('pages:worldOnboarding.sexualityHint')}>
                <select
                  value={persona.sexuality}
                  onChange={(e) => setPersona({ ...persona, sexuality: e.target.value as Sexuality })}
                >
                  {Object.keys(SEXUALITY_LABELS).map((k) => (
                    <option key={k} value={k}>
                      {sexualityLabel(k)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label={t('pages:worldOnboarding.aboutYou')} hint={t('pages:worldOnboarding.aboutYouHint')}>
              <textarea
                value={persona.personaNotes}
                placeholder={t('pages:worldOnboarding.aboutYouPlaceholder')}
                onChange={(e) => setPersona({ ...persona, personaNotes: e.target.value })}
              />
            </Field>
            <div className="row end wonb-actions">
              <button className="btn ghost" onClick={() => setStep(1)} disabled={busy}>
                {t('pages:worldOnboarding.back')}
              </button>
              <button className="btn primary" onClick={savePersona} disabled={busy}>
                {busy ? t('pages:worldOnboarding.saving') : t('pages:worldOnboarding.continue')}{' '}
                <Icon name="chevronRight" size={16} />
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
  const { t } = useTranslation('pages');
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
    id === UNASSIGNED ? t('worldOnboarding.unassigned') : worlds.find((w) => w.id === id)?.name ?? t('worldOnboarding.anotherWorld');

  return (
    <>
      <p className="wonb-flavor">{t('worldOnboarding.importFlavor')}</p>

      {all.loading ? (
        <Spinner />
      ) : others.length === 0 ? (
        <div className="wonb-blank">
          <p>{t('worldOnboarding.noImport')}</p>
        </div>
      ) : (
        <div className="wonb-import">
          {[...byWorld.entries()].map(([wid, chars]) => (
            <div key={wid} className="wonb-import-world">
              <div className="wonb-cast-head">
                <span className="kicker">{t('worldOnboarding.fromWorld', { world: worldName(wid) })}</span>
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
          {t('worldOnboarding.back')}
        </button>
        <button className="btn primary" onClick={onContinue} disabled={busy}>
          {busy
            ? t('worldOnboarding.importing')
            : selected.size > 0
              ? t('worldOnboarding.importN', { count: selected.size })
              : t('worldOnboarding.skip')}{' '}
          <Icon name="chevronRight" size={16} />
        </button>
      </div>
    </>
  );
}

/** The final onboarding beat: how-to-play + a preview of who lives in this world. */
function OnboardWelcome({ world, persona, onEnter }: { world: World; persona: string; onEnter: () => void }) {
  const { t } = useTranslation('pages');
  const { creatorMode } = useAppData();
  const cast = useAsync(() => api.listCharacters(world.id), [world.id]);
  const people = cast.data ?? [];

  return (
    <>
      <p className="wonb-flavor">
        {t('worldOnboarding.welcomeFlavor', {
          persona,
          summary: world.summary || t('worldOnboarding.newChapter'),
        })}
      </p>

      <ul className="wonb-howto">
        {HOW_TO_PLAY.map((h, i) => (
          <li key={i}>
            <span className="wonb-howto-icon">
              <Icon name={h.icon} size={18} />
            </span>
            <span>{t(`worldOnboarding.${h.key}` as 'worldOnboarding.howToPlay.date')}</span>
          </li>
        ))}
      </ul>

      <div className="wonb-cast-head">
        <span className="kicker">{t('worldOnboarding.peopleYouCouldMeet')}</span>
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
            {creatorMode
              ? t('worldOnboarding.blankPageCreator')
              : t('worldOnboarding.blankPagePlayer')}
          </p>
        </div>
      )}

      <div className="row end wonb-actions">
        <button className="btn primary lg" onClick={onEnter}>
          {t('worldOnboarding.enterWorld', { name: world.name })} <Icon name="chevronRight" size={18} />
        </button>
      </div>
    </>
  );
}
