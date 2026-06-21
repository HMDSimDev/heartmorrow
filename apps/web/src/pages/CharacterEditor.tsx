import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  DATING_STAT_KEYS,
  DATING_STAT_LABELS,
  DATING_STAT_DESCRIPTIONS,
  DEFAULT_DATING_STATS,
  GUARDEDNESS_DEFAULT,
  guardednessDescriptor,
  MIN_CHARACTER_AGE,
  RELATIONSHIP_STYLE_LABELS,
  CHARACTER_LINK_LABELS,
  GENDER_LABELS,
  SEXUALITY_LABELS,
  EXPRESSIONS,
  EXPRESSION_LABELS,
  DAYS_OF_WEEK,
  WEATHER_KINDS,
  WEATHER_LABELS,
  WEATHER_ICONS,
  type Character,
  type CharacterLink,
  type CharacterLinkKind,
  type Employment,
  type CharacterMemory,
  type DatingStats,
  type Expression,
  type Gender,
  type Relationship,
  type RelationshipStyle,
  type Sexuality,
  type World,
} from '@dsim/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import { Banner, ConfirmDialog, Field, TagInput } from '../components/ui';
import { DraftRestoreBar, UnsavedPill } from '../components/DraftBar';
import { useDraft } from '../lib/useDraft';
import { draftKey, NEW_CHAR_SCOPE } from '../lib/drafts';
import { AssetPicker } from '../components/AssetPicker';
import { RelationshipBars } from '../components/StatBars';
import { Portrait } from '../components/Portrait';
import { Icon } from '../components/Icon';
import './creator.page.css';

// ---------------------------------------------------------------------------
// Form type
// ---------------------------------------------------------------------------

interface Form {
  name: string;
  age: number;
  pronouns: string;
  gender: Gender;
  sexuality: Sexuality;
  worldId: string | null;
  shortDescription: string;
  personality: string;
  speechStyle: string;
  creatorNotes: string;
  relationshipPreferences: string;
  relationshipStyle: RelationshipStyle;
  guardedness: number;
  likes: string[];
  dislikes: string[];
  boundaries: string[];
  goals: string[];
  links: CharacterLink[];
  employment: Employment | null;
  allowsExCanonization: boolean;
  favoriteWeather: string[];
  dislikedWeather: string[];
  datingStats: DatingStats;
  appearance: string;
  textingStyle: string;
  onlinePersona: string;
  loveLanguage: string;
  physicalNeeds: string[];
  physicalDesires: string[];
  physicalDislikes: string[];
  insecurities: string[];
  quirks: string[];
  portraitAssetId: string | null;
  expressionRows: Array<{ name: string; assetId: string | null }>;
}

const emptyForm: Form = {
  name: '',
  age: MIN_CHARACTER_AGE,
  pronouns: 'they/them',
  gender: 'unspecified',
  sexuality: 'unspecified',
  worldId: null,
  shortDescription: '',
  personality: '',
  speechStyle: '',
  creatorNotes: '',
  relationshipPreferences: '',
  relationshipStyle: 'monogamous',
  guardedness: GUARDEDNESS_DEFAULT,
  likes: [],
  dislikes: [],
  boundaries: [],
  goals: [],
  links: [],
  employment: null,
  allowsExCanonization: false,
  favoriteWeather: [],
  dislikedWeather: [],
  datingStats: { ...DEFAULT_DATING_STATS },
  appearance: '',
  textingStyle: '',
  onlinePersona: '',
  loveLanguage: '',
  physicalNeeds: [],
  physicalDesires: [],
  physicalDislikes: [],
  insecurities: [],
  quirks: [],
  portraitAssetId: null,
  expressionRows: EXPRESSIONS.map((name) => ({ name, assetId: null })),
};

// ---------------------------------------------------------------------------
// Tab definitions — sections are grouped into 5 logical steps
// ---------------------------------------------------------------------------

type TabId = 'identity' | 'personality' | 'profile' | 'relationships' | 'world';

const TABS: { id: TabId; label: string }[] = [
  { id: 'identity',      label: 'Identity' },
  { id: 'personality',   label: 'Personality' },
  { id: 'profile',       label: 'Profile' },
  { id: 'relationships', label: 'Relationships' },
  { id: 'world',         label: 'World' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CharacterEditor() {
  const { id } = useParams();
  const isNew = !id;
  const nav = useNavigate();
  const location = useLocation();
  const { reloadAssets, activeWorldId } = useAppData();

  const [form, setForm] = useState<Form>(emptyForm);
  // The saved/initial snapshot the live form is diffed against for draft
  // persistence — set once the record (or empty new form) is loaded.
  const [baseline, setBaseline] = useState<Form | null>(null);
  // The id whose record is currently loaded into form/baseline. Gates draft
  // persistence so a mid-flight id change (back/forward between two edit URLs)
  // can't write the old record's data under the new id's key.
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [worlds, setWorlds] = useState<World[]>([]);
  const [allChars, setAllChars] = useState<Character[]>([]);
  const [memories, setMemories] = useState<CharacterMemory[]>([]);
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string>();
  const [preview, setPreview] = useState<string>();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [expressionsOpen, setExpressionsOpen] = useState(false);
  const [newMemory, setNewMemory] = useState({ text: '', importance: 3 });
  const [addingMemory, setAddingMemory] = useState(false);
  const [deletingMemoryId, setDeletingMemoryId] = useState<string | null>(null);
  const [generatingStats, setGeneratingStats] = useState(false);
  const [generatingProfile, setGeneratingProfile] = useState(false);
  const [generatingFromImage, setGeneratingFromImage] = useState(false);
  const [imageConfirmOpen, setImageConfirmOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('identity');

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const DEFAULT_JOB: Employment = { title: '', place: '', workdays: [0, 1, 2, 3, 4], shiftPhase: 'morning' };
  const patchEmp = (patch: Partial<Employment>) =>
    setForm((f) => ({ ...f, employment: { ...(f.employment ?? DEFAULT_JOB), ...patch } }));
  const toggleWorkday = (idx: number) =>
    setForm((f) => {
      const cur = f.employment ?? DEFAULT_JOB;
      const workdays = cur.workdays.includes(idx)
        ? cur.workdays.filter((d) => d !== idx)
        : [...cur.workdays, idx].sort((a, b) => a - b);
      return { ...f, employment: { ...cur, workdays } };
    });

  const toggleWeather = (kind: string, pref: 'fav' | 'dis') =>
    setForm((f) => {
      const inFav = f.favoriteWeather.includes(kind);
      const inDis = f.dislikedWeather.includes(kind);
      const fav = f.favoriteWeather.filter((k) => k !== kind);
      const dis = f.dislikedWeather.filter((k) => k !== kind);
      if (pref === 'fav' && !inFav) fav.push(kind);
      if (pref === 'dis' && !inDis) dis.push(kind);
      return { ...f, favoriteWeather: fav, dislikedWeather: dis };
    });

  useEffect(() => {
    void api.listWorlds().then(setWorlds).catch(() => undefined);
    void api.listCharacters().then(setAllChars).catch(() => undefined);
    void reloadAssets();
    if (!id) {
      // A brand-new character defaults to the world you're playing, so it never
      // gets orphaned (a world-less character shows up in no world's roster).
      const initial = { ...emptyForm, worldId: activeWorldId };
      setForm(initial);
      setBaseline(initial); // a fresh form is its own clean baseline
      setLoadedId(null);
      return;
    }
    void (async () => {
      try {
        const bundle = await api.getCharacterBundle(id);
        const c = bundle.character;
        const loaded: Form = {
          name: c.name,
          age: c.age,
          pronouns: c.pronouns,
          gender: c.gender,
          sexuality: c.sexuality,
          worldId: c.worldId,
          shortDescription: c.shortDescription,
          personality: c.personality,
          speechStyle: c.speechStyle,
          creatorNotes: c.creatorNotes,
          relationshipPreferences: c.relationshipPreferences,
          relationshipStyle: c.relationshipStyle,
          guardedness: c.guardedness,
          likes: c.likes,
          dislikes: c.dislikes,
          boundaries: c.boundaries,
          goals: c.goals,
          links: c.links,
          employment: c.employment,
          allowsExCanonization: c.allowsExCanonization,
          favoriteWeather: c.favoriteWeather,
          dislikedWeather: c.dislikedWeather,
          datingStats: c.datingStats,
          appearance: c.appearance,
          textingStyle: c.textingStyle,
          onlinePersona: c.onlinePersona,
          loveLanguage: c.loveLanguage,
          physicalNeeds: c.physicalNeeds,
          physicalDesires: c.physicalDesires,
          physicalDislikes: c.physicalDislikes,
          insecurities: c.insecurities,
          quirks: c.quirks,
          portraitAssetId: c.portraitAssetId,
          expressionRows: EXPRESSIONS.map((name) => ({ name, assetId: c.expressionAssets[name] ?? null })),
        };
        setForm(loaded);
        setBaseline(loaded); // the saved record is the clean baseline for edits
        setLoadedId(id); // enable draft persistence now that this id's record is in
        setMemories(bundle.memories);
        setRelationship(bundle.relationship);
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reloadAssets]);

  const payload = useMemo(
    () => ({
      name: form.name,
      age: form.age,
      pronouns: form.pronouns,
      gender: form.gender,
      sexuality: form.sexuality,
      worldId: form.worldId,
      shortDescription: form.shortDescription,
      personality: form.personality,
      speechStyle: form.speechStyle,
      creatorNotes: form.creatorNotes,
      relationshipPreferences: form.relationshipPreferences,
      relationshipStyle: form.relationshipStyle,
      guardedness: form.guardedness,
      likes: form.likes,
      dislikes: form.dislikes,
      boundaries: form.boundaries,
      goals: form.goals,
      links: form.links.filter((l) => l.targetId),
      // A half-filled job (no title/place) is treated as unemployed, like empty links are dropped.
      employment:
        form.employment && form.employment.title.trim() && form.employment.place.trim()
          ? { ...form.employment, title: form.employment.title.trim(), place: form.employment.place.trim() }
          : null,
      allowsExCanonization: form.allowsExCanonization,
      favoriteWeather: form.favoriteWeather,
      dislikedWeather: form.dislikedWeather,
      datingStats: form.datingStats,
      appearance: form.appearance,
      textingStyle: form.textingStyle,
      onlinePersona: form.onlinePersona,
      loveLanguage: form.loveLanguage,
      physicalNeeds: form.physicalNeeds,
      physicalDesires: form.physicalDesires,
      physicalDislikes: form.physicalDislikes,
      insecurities: form.insecurities,
      quirks: form.quirks,
      portraitAssetId: form.portraitAssetId,
      expressionAssets: Object.fromEntries(
        form.expressionRows.filter((r) => r.name.trim() && r.assetId).map((r) => [r.name.trim(), r.assetId as string]),
      ),
    }),
    [form],
  );

  // Auto-keep unsaved work as a draft. A new character is keyed by the world
  // it'll belong to (one in-flight new character per world); an edit is keyed by
  // the character id. The draft is cleared the moment Save succeeds.
  const draftScopeId = isNew ? NEW_CHAR_SCOPE(activeWorldId) : id!;
  const draft = useDraft<Form>({
    key: draftKey.character(draftScopeId),
    value: form,
    baseline,
    // A new form has no async load; an edit is enabled only once ITS record is in
    // (so re-keying to another id can't persist the prior record under the new key).
    enabled: isNew || loadedId === id,
    meta: {
      kind: 'character',
      scopeId: draftScopeId,
      // Tag edits by the SAVED world, so an unsaved World-dropdown change doesn't
      // re-file the draft under a world the character doesn't live in yet.
      worldId: isNew ? activeWorldId : baseline?.worldId ?? form.worldId,
      isNew,
      label: () => form.name.trim() || 'Untitled character',
    },
  });

  // Arriving via "Resume" from the People drafts strip means the choice to
  // continue is already made — apply the draft immediately (before paint, so the
  // restore bar never flashes) instead of offering it again. One-shot: consume
  // the nav flag so a later manual revisit still shows the normal offer.
  const resumedRef = useRef(false);
  useLayoutEffect(() => {
    if (resumedRef.current) return;
    if ((location.state as { resumeDraft?: boolean } | null)?.resumeDraft !== true) return;
    if (!draft.found) return;
    resumedRef.current = true;
    const d = draft.restore();
    if (d) setForm({ ...emptyForm, ...d });
    nav(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.found]);

  const save = async () => {
    setSaving(true);
    setError(undefined);
    setSavedNote(undefined);
    try {
      if (isNew) {
        const created = await api.createCharacter(payload);
        // The current form is now the saved truth; clear the new-character draft
        // BEFORE the key re-keys to /edit so it doesn't orphan under new__<world>.
        setBaseline(form);
        draft.clear();
        nav(`/characters/${created.id}/edit`);
      } else {
        await api.updateCharacter(id!, payload);
        setBaseline(form); // saved → the form is clean again
        draft.clear();
        setSavedNote('Saved!');
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const addMemory = async () => {
    if (!id || !newMemory.text.trim() || addingMemory) return;
    setAddingMemory(true);
    try {
      await api.addMemory(id, { text: newMemory.text.trim(), importance: newMemory.importance, tags: [] });
      setMemories(await api.listMemories(id));
      setNewMemory({ text: '', importance: 3 });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setAddingMemory(false);
    }
  };

  const generateStats = async () => {
    setGeneratingStats(true);
    setError(undefined);
    try {
      const res = await api.generateStats({
        name: form.name,
        age: form.age,
        shortDescription: form.shortDescription,
        personality: form.personality,
        speechStyle: form.speechStyle,
        likes: form.likes,
        dislikes: form.dislikes,
        goals: form.goals,
        relationshipPreferences: form.relationshipPreferences,
      });
      if (res.ok) {
        set('datingStats', res.data);
        setSavedNote('Stats generated — review and Save.');
        draft.dismissFound(); // generated content supersedes any stale restore offer
      } else {
        setError(`Stat generation failed: ${res.error}`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGeneratingStats(false);
    }
  };

  const generateProfile = async () => {
    setGeneratingProfile(true);
    setError(undefined);
    try {
      const res = await api.generateProfile({
        name: form.name,
        age: form.age,
        shortDescription: form.shortDescription,
        personality: form.personality,
        speechStyle: form.speechStyle,
        likes: form.likes,
        dislikes: form.dislikes,
        goals: form.goals,
        relationshipPreferences: form.relationshipPreferences,
        appearance: form.appearance,
      });
      if (res.ok) {
        setForm((f) => ({
          ...f,
          appearance: res.data.appearance,
          textingStyle: res.data.textingStyle,
          onlinePersona: res.data.onlinePersona,
          loveLanguage: res.data.loveLanguage,
          physicalNeeds: res.data.physicalNeeds,
          physicalDesires: res.data.physicalDesires,
          physicalDislikes: res.data.physicalDislikes,
          insecurities: res.data.insecurities,
          quirks: res.data.quirks,
        }));
        setSavedNote('Profile generated — review and Save.');
        draft.dismissFound();
      } else {
        setError(`Profile generation failed: ${res.error}`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGeneratingProfile(false);
    }
  };

  // True when the draft already has enough content that regenerating from a photo
  // would clobber real work — used to gate the overwrite confirmation.
  const hasContent = Boolean(
    form.name.trim() || form.shortDescription.trim() || form.personality.trim() || form.appearance.trim(),
  );

  const runImageGeneration = async () => {
    if (!form.portraitAssetId) return;
    setGeneratingFromImage(true);
    setError(undefined);
    setSavedNote(undefined);
    try {
      const res = await api.generateCharacterFromImage({
        assetId: form.portraitAssetId,
        worldId: form.worldId,
      });
      if (res.ok) {
        const d = res.data;
        // Fill the generated fields; PRESERVE the chosen portrait, expressions,
        // world, and the creator-only fields the model never sees.
        setForm((f) => ({
          ...f,
          name: d.name,
          age: d.age,
          pronouns: d.pronouns,
          gender: d.gender,
          sexuality: d.sexuality,
          shortDescription: d.shortDescription,
          personality: d.personality,
          speechStyle: d.speechStyle,
          relationshipPreferences: d.relationshipPreferences,
          relationshipStyle: d.relationshipStyle,
          guardedness: d.guardedness,
          likes: d.likes,
          dislikes: d.dislikes,
          goals: d.goals,
          boundaries: d.boundaries,
          appearance: d.appearance,
          textingStyle: d.textingStyle,
          onlinePersona: d.onlinePersona,
          loveLanguage: d.loveLanguage,
          physicalNeeds: d.physicalNeeds,
          physicalDesires: d.physicalDesires,
          physicalDislikes: d.physicalDislikes,
          insecurities: d.insecurities,
          quirks: d.quirks,
          datingStats: d.datingStats,
        }));
        setActiveTab('identity');
        setSavedNote('Character generated from portrait — review every tab and Save.');
        draft.dismissFound();
      } else {
        setError(`Generation from image failed: ${res.error}`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGeneratingFromImage(false);
    }
  };

  // Confirm before overwriting an already-filled draft; otherwise generate now.
  const generateFromImage = () => {
    if (!form.portraitAssetId) return;
    if (hasContent) setImageConfirmOpen(true);
    else void runImageGeneration();
  };

  const showPreview = async () => {
    if (!id) return;
    try {
      const p = await api.promptPreview(id);
      setPreview(`~${p.approxChars} chars\n\n${p.system}`);
      setPreviewOpen(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // Synthetic character object fed to <Portrait> — mirrors the API shape without
  // needing an actual saved character record.
  const previewCharacter = useMemo(
    () => ({
      name: form.name || 'Unnamed',
      portraitAssetId: form.portraitAssetId,
      expressionAssets: Object.fromEntries(
        form.expressionRows.filter((r) => r.name.trim() && r.assetId).map((r) => [r.name.trim(), r.assetId as string]),
      ),
    }),
    [form.name, form.portraitAssetId, form.expressionRows],
  );

  return (
    <div className="ce-layout">
      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                             */}
      {/* ------------------------------------------------------------------ */}
      <div className="framed creator-head ce-head">
        <div className="creator-head-titles">
          <div className="creator-meta">
            <span className="kicker">Character workbench</span>
            <span className="creator-tool-tag">{isNew ? 'new' : 'editing'}</span>
          </div>
          <h1>{isNew ? 'New character' : `Edit ${form.name || 'character'}`}</h1>
          <p>All notes here are treated as character <b>data</b> in prompts - never as instructions to the model. You should fill this out with a lot of detail so the LLM can breathe as much life into your characters as possible. Data from this profile is surfaced in quite a few areas, and it will only be as good as what you put in. Putting slop in will give slop out. The only thing you should be cognizant of is that the more data you put here, the longer the prompts will be. You can press preview prompt in the top right to see how long a full prompt would be.</p>
        </div>
        <div className="creator-head-actions">
          {!isNew && (
            <button className="btn ghost" onClick={showPreview}>
              <Icon name="preview" size={14} />
              Preview prompt
            </button>
          )}
          <UnsavedPill dirty={draft.dirty} failed={draft.persistError} />
          <button className="btn primary" onClick={save} disabled={saving || !form.name.trim()}>
            <Icon name="save" size={14} />
            {saving ? 'Saving…' : isNew ? 'Create' : 'Save'}
          </button>
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {savedNote && <Banner kind="ok">{savedNote}</Banner>}

      {draft.found && (
        <DraftRestoreBar
          env={draft.found}
          noun="character"
          onRestore={() => {
            const d = draft.restore();
            if (d) setForm({ ...emptyForm, ...d }); // spread over defaults = forward-tolerant
          }}
          onDiscard={() => draft.discard()}
          onDismiss={() => draft.dismissFound()}
        />
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Two-column canvas: side rail (portrait preview) + main form         */}
      {/* ------------------------------------------------------------------ */}
      <div className="ce-canvas">

        {/* Sticky portrait rail */}
        <aside className="ce-rail">
          <div className="ce-portrait-plate framed">
            <Portrait character={previewCharacter} className="ce-portrait-img" />
            <div className="ce-portrait-name">{form.name || <span className="ce-portrait-placeholder">Unnamed</span>}</div>
            {form.age >= MIN_CHARACTER_AGE && (
              <div className="ce-portrait-meta">{form.age} · {form.pronouns || '—'}</div>
            )}
            {relationship && (
              <div className="ce-portrait-bars">
                <RelationshipBars relationship={relationship} />
              </div>
            )}
          </div>
        </aside>

        {/* Form column */}
        <div className="ce-main stack">

          {/* Tab nav */}
          <nav className="ce-tabs" aria-label="Editor sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`ce-tab ${activeTab === t.id ? 'ce-tab-active' : ''}`}
                onClick={() => setActiveTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          {/* ------------------------------------------------------------ */}
          {/* Tab: Identity — sections 01 Portrait + 02 Identity basics     */}
          {/* ------------------------------------------------------------ */}
          <div className={`ce-panel stack ${activeTab === 'identity' ? '' : 'ce-panel-hidden'}`}>
            <div className="grid cols-2">
              <div className="card">
                <div className="creator-sec">
                  <span className="creator-index">01</span>
                  <h2>Identity</h2>
                  <span className="trail" />
                </div>
                <Field label="Name">
                  <input value={form.name} onChange={(e) => set('name', e.target.value)} />
                </Field>
                <div className="inline-fields">
                  <Field label="Age" hint={`Must be ${MIN_CHARACTER_AGE}+`}>
                    <input
                      type="number"
                      min={MIN_CHARACTER_AGE}
                      value={form.age}
                      onChange={(e) => set('age', Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Pronouns">
                    <input value={form.pronouns} onChange={(e) => set('pronouns', e.target.value)} />
                  </Field>
                </div>
                <div className="inline-fields">
                  <Field label="Gender" hint="Separate from pronouns.">
                    <select value={form.gender} onChange={(e) => set('gender', e.target.value as Gender)}>
                      {Object.entries(GENDER_LABELS).map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Sexuality" hint="Gates who romance can deepen with. Players discover it through play.">
                    <select value={form.sexuality} onChange={(e) => set('sexuality', e.target.value as Sexuality)}>
                      {Object.entries(SEXUALITY_LABELS).map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label="World" hint="A character with no world is unassigned and won't appear in any world until you place them (recover them under People → Unassigned).">
                  <select value={form.worldId ?? ''} onChange={(e) => set('worldId', e.target.value || null)}>
                    <option value="">— No world (unassigned) —</option>
                    {worlds.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Relationship style"
                  hint="Monogamous characters may get jealous if they learn you're dating others."
                >
                  <select
                    value={form.relationshipStyle}
                    onChange={(e) => set('relationshipStyle', e.target.value as RelationshipStyle)}
                  >
                    {(Object.keys(RELATIONSHIP_STYLE_LABELS) as RelationshipStyle[]).map((k) => (
                      <option key={k} value={k}>
                        {RELATIONSHIP_STYLE_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Short description">
                  <textarea value={form.shortDescription} onChange={(e) => set('shortDescription', e.target.value)} />
                </Field>
              </div>

              <div className="card">
                <div className="creator-sec">
                  <span className="creator-index">02</span>
                  <h2>Portrait</h2>
                  <span className="trail" />
                </div>
                <AssetPicker value={form.portraitAssetId} onChange={(v) => set('portraitAssetId', v)} />
                <div className="ce-image-gen">
                  <button
                    className="btn sm primary"
                    onClick={generateFromImage}
                    disabled={generatingFromImage || !form.portraitAssetId}
                  >
                    <Icon name="generate" size={13} />
                    {generatingFromImage ? 'Reading the portrait…' : 'Generate character from portrait'}
                  </button>
                  <p className="creator-note">
                    {form.portraitAssetId
                      ? 'Uses a vision model to draft a whole character from this image, fitted to the selected world. Fills every tab for you to review before saving. Set a vision model in Settings (it falls back to your main model).'
                      : 'Upload or pick a portrait above first, then a vision model can draft a full character from it.'}
                  </p>
                </div>
                <div className="divider" />
                <div
                  className="creator-sec"
                  style={{ cursor: 'pointer' }}
                  role="button"
                  tabIndex={0}
                  aria-expanded={expressionsOpen}
                  onClick={() => setExpressionsOpen((o) => !o)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setExpressionsOpen((o) => !o);
                    }
                  }}
                >
                  <h3 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Icon name={expressionsOpen ? 'chevronDown' : 'chevronRight'} size={16} />
                    Expressions
                    <span className="badge" style={{ marginLeft: 6 }}>
                      {form.expressionRows.filter((r) => r.assetId).length} set
                    </span>
                  </h3>
                  <span className="trail" />
                </div>
                {expressionsOpen && (
                  <>
                    <p className="creator-note">
                      These are the fixed expressions the date evaluator can pick. Assign an image to any you want
                      shown; leave the rest blank to use the default portrait.
                    </p>
                    {form.expressionRows.map((row, i) => (
                  <div key={row.name} className="creator-subcard stack">
                    <div className="row">
                      <strong className="flex-fill">{EXPRESSION_LABELS[row.name as Expression] ?? row.name}</strong>
                      {row.assetId && (
                        <button
                          className="btn sm danger"
                          onClick={() => {
                            const rows = [...form.expressionRows];
                            rows[i] = { ...rows[i]!, assetId: null };
                            set('expressionRows', rows);
                          }}
                        >
                          <Icon name="trash" size={13} />
                          Clear
                        </button>
                      )}
                    </div>
                    <AssetPicker
                      value={row.assetId}
                      uploadType="expression"
                      onChange={(v) => {
                        const rows = [...form.expressionRows];
                        rows[i] = { ...rows[i]!, assetId: v };
                        set('expressionRows', rows);
                      }}
                    />
                  </div>
                    ))}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* ------------------------------------------------------------ */}
          {/* Tab: Personality — sections 03 + 04                           */}
          {/* ------------------------------------------------------------ */}
          <div className={`ce-panel stack ${activeTab === 'personality' ? '' : 'ce-panel-hidden'}`}>
            <div className="grid cols-2">
              <div className="card">
                <div className="creator-sec">
                  <span className="creator-index">03</span>
                  <h2>Personality & voice</h2>
                  <span className="trail" />
                </div>
                <Field label="Personality">
                  <textarea value={form.personality} onChange={(e) => set('personality', e.target.value)} />
                </Field>
                <Field label="Speech style">
                  <textarea value={form.speechStyle} onChange={(e) => set('speechStyle', e.target.value)} />
                </Field>
                <Field label="Relationship preferences">
                  <textarea
                    value={form.relationshipPreferences}
                    onChange={(e) => set('relationshipPreferences', e.target.value)}
                  />
                </Field>
                <Field label="Private creator notes" hint="Whatever extra guidance you want to give to the model; never shown verbatim to players.">
                  <textarea value={form.creatorNotes} onChange={(e) => set('creatorNotes', e.target.value)} />
                </Field>
              </div>

              <div className="card">
                <div className="creator-sec">
                  <span className="creator-index">04</span>
                  <h2>Traits & boundaries</h2>
                  <span className="trail" />
                </div>
                <Field label="Likes">
                  <TagInput value={form.likes} onChange={(v) => set('likes', v)} />
                </Field>
                <Field label="Dislikes">
                  <TagInput value={form.dislikes} onChange={(v) => set('dislikes', v)} />
                </Field>
                <Field label="Goals">
                  <TagInput value={form.goals} onChange={(v) => set('goals', v)} />
                </Field>
                <Field label="Boundaries">
                  <TagInput value={form.boundaries} onChange={(v) => set('boundaries', v)} />
                </Field>
                <Field
                  label={`Guardedness: ${form.guardedness} — ${guardednessDescriptor(form.guardedness)}`}
                  hint="How slow they are to warm up on a date. Higher = they open up, trust, and flirt only once it's earned, and a date with them starts cooler. Doesn't change how fast a bad date sours."
                >
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={form.guardedness}
                    onChange={(e) => set('guardedness', Number(e.target.value))}
                  />
                  <div className="ce-range-ends">
                    <span>open book</span>
                    <span>walled off</span>
                  </div>
                </Field>
              </div>
            </div>

            {/* Weather preferences — fits naturally under personality */}
            <div className="card">
              <div className="creator-sec">
                <span className="creator-index">09</span>
                <h2>Weather preferences</h2>
                <span className="trail" />
              </div>
              <p className="creator-note">
                Sets their mood on those days and nudges outdoor dates. ♥ = loves it, ✕ = can't stand it.
              </p>
              <div className="weather-pref-grid">
                {WEATHER_KINDS.map((k) => {
                  const fav = form.favoriteWeather.includes(k);
                  const dis = form.dislikedWeather.includes(k);
                  return (
                    <div className="weather-pref" key={k}>
                      <span className="flex-fill">
                        {WEATHER_ICONS[k]} {WEATHER_LABELS[k]}
                      </span>
                      <button
                        className={`btn sm ${fav ? 'primary' : 'ghost'}`}
                        onClick={() => toggleWeather(k, 'fav')}
                        title="loves this weather"
                      >
                        ♥
                      </button>
                      <button
                        className={`btn sm ${dis ? 'danger' : 'ghost'}`}
                        onClick={() => toggleWeather(k, 'dis')}
                        title="dislikes this weather"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ------------------------------------------------------------ */}
          {/* Tab: Profile — sections 05 + 06                               */}
          {/* ------------------------------------------------------------ */}
          <div className={`ce-panel stack ${activeTab === 'profile' ? '' : 'ce-panel-hidden'}`}>
            <div className="grid cols-2">
              <div className="card">
                <div className="creator-sec">
                  <span className="creator-index">05</span>
                  <h2>Profile & presence</h2>
                  <span className="trail" />
                  <button
                    className="btn sm creator-sec-action"
                    onClick={generateProfile}
                    disabled={generatingProfile || !form.name.trim()}
                  >
                    <Icon name="generate" size={13} />
                    {generatingProfile ? 'Generating…' : 'Generate from description'}
                  </button>
                </div>
                <p className="creator-note">
                  Flavor that makes {form.name || 'this character'} feel alive — how they look, text, and show up online.
                  Used by the in-world phone feed.
                </p>
                <Field label="Appearance">
                  <textarea value={form.appearance} onChange={(e) => set('appearance', e.target.value)} />
                </Field>
                <Field label="Texting style" hint="How they write texts & posts — distinct from how they speak aloud.">
                  <textarea value={form.textingStyle} onChange={(e) => set('textingStyle', e.target.value)} />
                </Field>
                <Field label="Online persona" hint="How they behave on a social feed.">
                  <textarea value={form.onlinePersona} onChange={(e) => set('onlinePersona', e.target.value)} />
                </Field>
                <Field label="Love language">
                  <input value={form.loveLanguage} onChange={(e) => set('loveLanguage', e.target.value)} />
                </Field>
              </div>

              <div className="card">
                <div className="creator-sec">
                  <span className="creator-index">06</span>
                  <h2>Chemistry & quirks</h2>
                  <span className="trail" />
                </div>
                <p className="creator-note">Tasteful physical/sensory notes plus the little human details.</p>
                <Field label="Physical needs">
                  <TagInput value={form.physicalNeeds} onChange={(v) => set('physicalNeeds', v)} />
                </Field>
                <Field label="Physical desires">
                  <TagInput value={form.physicalDesires} onChange={(v) => set('physicalDesires', v)} />
                </Field>
                <Field label="Physical dislikes">
                  <TagInput value={form.physicalDislikes} onChange={(v) => set('physicalDislikes', v)} />
                </Field>
                <Field label="Insecurities">
                  <TagInput value={form.insecurities} onChange={(v) => set('insecurities', v)} />
                </Field>
                <Field label="Quirks">
                  <TagInput value={form.quirks} onChange={(v) => set('quirks', v)} />
                </Field>
              </div>
            </div>

            {/* Dating stats also belong in Profile — defines their dating persona */}
            <div className="card">
              <div className="creator-sec">
                <span className="creator-index">10</span>
                <h2>Base dating stats</h2>
                <span className="trail" />
                <button
                  className="btn sm creator-sec-action"
                  onClick={generateStats}
                  disabled={generatingStats || !form.name.trim()}
                >
                  <Icon name="generate" size={13} />
                  {generatingStats ? 'Generating…' : 'Generate from description'}
                </button>
              </div>
              <p className="creator-note">
                These six traits define the character's dating persona. They shape how much relationship progress
                Together activities yield (each activity favors certain stats), pick the character's favorite minigame
                (their highest stat), and color how they talk on dates. They may also drive additional systems in the
                future.
              </p>
              {DATING_STAT_KEYS.map((k) => (
                <Field
                  key={k}
                  label={`${DATING_STAT_LABELS[k]}: ${form.datingStats[k]}`}
                  hint={DATING_STAT_DESCRIPTIONS[k]}
                >
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={form.datingStats[k]}
                    onChange={(e) => set('datingStats', { ...form.datingStats, [k]: Number(e.target.value) })}
                  />
                </Field>
              ))}
            </div>
          </div>

          {/* ------------------------------------------------------------ */}
          {/* Tab: Relationships — sections 07 + 11 + 12                    */}
          {/* ------------------------------------------------------------ */}
          <div className={`ce-panel stack ${activeTab === 'relationships' ? '' : 'ce-panel-hidden'}`}>
            <div className="card">
              <div className="creator-sec">
                <span className="creator-index">07</span>
                <h2>Connections</h2>
                <span className="trail" />
              </div>
              <p className="creator-note">
                How {form.name || 'this character'} relates to others in the world — drives gossip and edge-aware jealousy.
              </p>
              {form.links.map((link, i) => (
                <div className="ce-link-row" key={i}>
                  <select
                    className="flex-fill"
                    value={link.targetId}
                    onChange={(e) => {
                      const links = [...form.links];
                      links[i] = { ...links[i]!, targetId: e.target.value };
                      set('links', links);
                    }}
                  >
                    <option value="">— Character —</option>
                    {allChars
                      // Only this character's OWN world — connections never cross worlds.
                      .filter((c) => c.id !== id && c.worldId === form.worldId)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                  <select
                    value={link.kind}
                    onChange={(e) => {
                      const links = [...form.links];
                      links[i] = { ...links[i]!, kind: e.target.value as CharacterLinkKind };
                      set('links', links);
                    }}
                  >
                    {(Object.keys(CHARACTER_LINK_LABELS) as CharacterLinkKind[]).map((k) => (
                      <option key={k} value={k}>
                        {CHARACTER_LINK_LABELS[k]}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn sm danger"
                    onClick={() => set('links', form.links.filter((_, j) => j !== i))}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              ))}
              <button
                className="btn sm"
                onClick={() => set('links', [...form.links, { targetId: '', kind: 'friend' }])}
              >
                <Icon name="plus" size={13} />
                Add connection
              </button>
              <label className="ce-excanoize-label">
                <input
                  type="checkbox"
                  checked={form.allowsExCanonization}
                  onChange={(e) => set('allowsExCanonization', e.target.checked)}
                />
                <span className="creator-note ce-excanoize-body">
                  <strong>Allow ex-canonization.</strong> Let other characters establish facts about{' '}
                  {form.name || 'this character'} by revealing them as their ex on a date (e.g. a date mentions their ex used
                  to smoke → it becomes true here, and they react if you bring it up). Off by default — their truth stays
                  immutable. Reversible anytime.
                </span>
              </label>
            </div>

            {/* Relationship stats */}
            <div className="card">
              <div className="creator-sec">
                <span className="creator-index">11</span>
                <h2>Relationship</h2>
                <span className="trail" />
              </div>
              {relationship ? (
                <RelationshipBars relationship={relationship} />
              ) : (
                <p className="muted">Relationship stats appear after the character is created.</p>
              )}
            </div>

            {/* Memories */}
            <div className="card">
              <div className="creator-sec">
                <span className="creator-index">12</span>
                <h2>Memories</h2>
                <span className="trail" />
              </div>
              {isNew ? (
                <p className="muted">Save the character first to add manual memories.</p>
              ) : (
                <>
                  <div className="row" style={{ alignItems: 'flex-end' }}>
                    <div className="flex-fill">
                      <Field label="Add a memory">
                        <input
                          value={newMemory.text}
                          placeholder="e.g. The player loves rainy days too."
                          onChange={(e) => setNewMemory((m) => ({ ...m, text: e.target.value }))}
                        />
                      </Field>
                    </div>
                    <Field label="Importance">
                      <select
                        value={newMemory.importance}
                        onChange={(e) => setNewMemory((m) => ({ ...m, importance: Number(e.target.value) }))}
                      >
                        {[1, 2, 3, 4, 5].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <button className="btn" onClick={addMemory} disabled={addingMemory || !newMemory.text.trim()}>
                      {addingMemory ? 'Adding…' : 'Add'}
                    </button>
                  </div>
                  {memories.length === 0 ? (
                    <p className="muted">No memories yet.</p>
                  ) : (
                    memories.map((m) => (
                      <div className="list-item" key={m.id}>
                        <span className="badge accent">{m.importance}</span>
                        <span className="flex-fill">{m.text}</span>
                        <button
                          className="btn sm danger"
                          disabled={deletingMemoryId !== null}
                          onClick={async () => {
                            if (deletingMemoryId) return;
                            setDeletingMemoryId(m.id);
                            try {
                              await api.deleteMemory(m.id);
                              if (id) setMemories(await api.listMemories(id));
                            } catch (e) {
                              setError(errorMessage(e));
                            } finally {
                              setDeletingMemoryId(null);
                            }
                          }}
                        >
                          {deletingMemoryId === m.id ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    ))
                  )}
                </>
              )}
            </div>
          </div>

          {/* ------------------------------------------------------------ */}
          {/* Tab: World — sections 08 Employment                           */}
          {/* ------------------------------------------------------------ */}
          <div className={`ce-panel stack ${activeTab === 'world' ? '' : 'ce-panel-hidden'}`}>
            <div className="card">
              <div className="creator-sec">
                <span className="creator-index">08</span>
                <h2>Employment</h2>
                <span className="trail" />
              </div>
              <p className="creator-note">
                What {form.name || 'this character'} does for work. Coworkers (anyone sharing the same workplace) tend to run
                into each other — this feeds the world simulation. Leave unemployed if they don't work.
              </p>
              <label className="ce-employed-toggle">
                <input
                  type="checkbox"
                  checked={form.employment != null}
                  onChange={(e) => set('employment', e.target.checked ? { ...DEFAULT_JOB } : null)}
                />
                <span>Employed</span>
              </label>
              {form.employment && (
                <>
                  <div className="inline-fields">
                    <Field label="Job title">
                      <input value={form.employment.title} onChange={(e) => patchEmp({ title: e.target.value })} />
                    </Field>
                    <Field label="Workplace" hint="Characters who share a workplace are coworkers.">
                      <input value={form.employment.place} onChange={(e) => patchEmp({ place: e.target.value })} />
                    </Field>
                  </div>
                  <Field label="Shift">
                    <select
                      value={form.employment.shiftPhase}
                      onChange={(e) => patchEmp({ shiftPhase: e.target.value as Employment['shiftPhase'] })}
                    >
                      <option value="morning">Morning</option>
                      <option value="afternoon">Afternoon</option>
                      <option value="evening">Evening</option>
                    </select>
                  </Field>
                  <Field label="Workdays">
                    <div className="ce-workdays">
                      {DAYS_OF_WEEK.map((d, idx) => (
                        <button
                          key={d}
                          type="button"
                          className={`btn sm ${form.employment!.workdays.includes(idx) ? 'primary' : 'ghost'}`}
                          onClick={() => toggleWorkday(idx)}
                          title={d}
                        >
                          {d.slice(0, 3)}
                        </button>
                      ))}
                    </div>
                  </Field>
                </>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Prompt preview — collapsible dev panel, not always visible          */}
      {/* ------------------------------------------------------------------ */}
      {previewOpen && preview !== undefined && (
        <details className="card ce-prompt-details" open>
          <summary className="ce-prompt-summary">
            <div className="creator-sec" style={{ margin: 0, flex: 1 }}>
              <span className="kicker">Assembled system prompt</span>
              <span className="trail" />
              <button
                className="btn sm ghost creator-sec-action"
                onClick={() => setPreviewOpen(false)}
              >
                <Icon name="close" size={13} />
                Close
              </button>
            </div>
          </summary>
          <pre className="pre ce-prompt-pre">{preview}</pre>
        </details>
      )}

      {imageConfirmOpen && (
        <ConfirmDialog
          title="Overwrite this draft from the portrait?"
          kicker="Generate from image"
          confirmLabel={generatingFromImage ? 'Generating…' : 'Overwrite & generate'}
          danger
          busy={generatingFromImage}
          body={
            <>
              This will replace the name, identity, personality, traits, profile, and dating stats with a fresh draft
              generated from the portrait. Your portrait, expressions, connections, and employment are kept. This can't
              be undone (but nothing is saved until you press Save).
            </>
          }
          onCancel={() => setImageConfirmOpen(false)}
          onConfirm={async () => {
            await runImageGeneration();
            setImageConfirmOpen(false);
          }}
        />
      )}
    </div>
  );
}
