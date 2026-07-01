import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  DATING_STAT_KEYS,
  DEFAULT_DATING_STATS,
  GUARDEDNESS_DEFAULT,
  MIN_CHARACTER_AGE,
  RELATIONSHIP_STYLE_LABELS,
  CHARACTER_LINK_LABELS,
  GENDER_LABELS,
  SEXUALITY_LABELS,
  EXPRESSIONS,
  DAYS_OF_WEEK,
  WEATHER_KINDS,
  WEATHER_ICONS,
  type Character,
  type CharacterLink,
  type CharacterLinkKind,
  type Employment,
  type CharacterMemory,
  type DatingStats,
  type Gender,
  type Relationship,
  type RelationshipStyle,
  type Sexuality,
  type World,
} from '@dsim/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import {
  genderLabel,
  sexualityLabel,
  relationshipStyleLabel,
  characterLinkLabel,
  weatherLabel,
  datingStatLabel,
  datingStatDesc,
  expressionLabel,
  weekdayAbbr,
  weekdayLabel,
  guardednessDescriptorLabel,
} from '../i18n/labels';
import { Banner, Field, Modal, TagInput } from '../components/ui';
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

const TABS: { id: TabId; labelKey: `characterEditor.tabs.${TabId}` }[] = [
  { id: 'identity',      labelKey: 'characterEditor.tabs.identity' },
  { id: 'personality',   labelKey: 'characterEditor.tabs.personality' },
  { id: 'profile',       labelKey: 'characterEditor.tabs.profile' },
  { id: 'relationships', labelKey: 'characterEditor.tabs.relationships' },
  { id: 'world',         labelKey: 'characterEditor.tabs.world' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CharacterEditor() {
  const { t } = useTranslation(['pages', 'common']);
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
  // Unified "Generate" flow: a modal that drafts a whole character from a portrait,
  // pasted/uploaded reference text, or both.
  const [generating, setGenerating] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [genText, setGenText] = useState('');
  const [genFileName, setGenFileName] = useState<string | null>(null);
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
      label: () => form.name.trim() || t('pages:characterEditor.untitledCharacter'),
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
        setSavedNote(t('pages:characterEditor.saved'));
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
        setSavedNote(t('pages:characterEditor.statsGenerated'));
        draft.dismissFound(); // generated content supersedes any stale restore offer
      } else {
        setError(t('pages:characterEditor.statGenFailed', { error: res.error }));
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
        setSavedNote(t('pages:characterEditor.profileGenerated'));
        draft.dismissFound();
      } else {
        setError(t('pages:characterEditor.profileGenFailed', { error: res.error }));
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGeneratingProfile(false);
    }
  };

  // True when the draft already has enough content that generating would clobber
  // real work — used to warn before overwriting.
  const hasContent = Boolean(
    form.name.trim() || form.shortDescription.trim() || form.personality.trim() || form.appearance.trim(),
  );

  // At least one source must be present for the unified generator to run.
  const canGenerate = Boolean(form.portraitAssetId) || genText.trim().length > 0;

  // Read an uploaded file STRICTLY as UTF-8 text — its bytes are never executed or
  // parsed as anything else (any file type is accepted but treated as plain text).
  const MAX_SOURCE_CHARS = 40000;
  const onPickSourceFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be re-picked later
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      setGenText(text.length > MAX_SOURCE_CHARS ? text.slice(0, MAX_SOURCE_CHARS) : text);
      setGenFileName(file.name);
    };
    reader.onerror = () => setError(t('pages:characterEditor.genFileError'));
    reader.readAsText(file);
  };

  const runGeneration = async () => {
    if (!canGenerate) return;
    setGenerating(true);
    setError(undefined);
    setSavedNote(undefined);
    try {
      const res = await api.generateCharacter({
        assetId: form.portraitAssetId,
        sourceText: genText.trim().slice(0, MAX_SOURCE_CHARS),
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
        setSavedNote(t('pages:characterEditor.characterGenerated'));
        draft.dismissFound();
        setGenOpen(false);
      } else {
        setError(t('pages:characterEditor.characterGenFailed', { error: res.error }));
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGenerating(false);
    }
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
      name: form.name || t('pages:characterEditor.unnamed'),
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
            <span className="kicker">{t('pages:characterEditor.workbench')}</span>
            <span className="creator-tool-tag">
              {isNew ? t('pages:characterEditor.tagNew') : t('pages:characterEditor.tagEditing')}
            </span>
          </div>
          <h1>
            {isNew
              ? t('pages:characterEditor.newTitle')
              : t('pages:characterEditor.editTitle', {
                  name: form.name || t('pages:characterEditor.editFallback'),
                })}
          </h1>
          <p>{t('pages:characterEditor.intro')}</p>
        </div>
        <div className="creator-head-actions">
          {!isNew && (
            <button className="btn ghost" onClick={showPreview}>
              <Icon name="preview" size={14} />
              {t('pages:characterEditor.previewPrompt')}
            </button>
          )}
          <button className="btn ghost" onClick={() => setGenOpen(true)}>
            <Icon name="generate" size={14} />
            {t('pages:characterEditor.generate')}
          </button>
          <UnsavedPill dirty={draft.dirty} failed={draft.persistError} />
          <button className="btn primary" onClick={save} disabled={saving || !form.name.trim()}>
            <Icon name="save" size={14} />
            {saving
              ? t('pages:characterEditor.saving')
              : isNew
                ? t('pages:characterEditor.create')
                : t('pages:characterEditor.save')}
          </button>
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {savedNote && <Banner kind="ok">{savedNote}</Banner>}

      {draft.found && (
        <DraftRestoreBar
          env={draft.found}
          noun={t('pages:characterEditor.noun')}
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
            <div className="ce-portrait-name">{form.name || <span className="ce-portrait-placeholder">{t('pages:characterEditor.unnamed')}</span>}</div>
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
          <nav className="ce-tabs" aria-label={t('pages:characterEditor.editorSectionsAria')}>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`ce-tab ${activeTab === tab.id ? 'ce-tab-active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {t(`pages:${tab.labelKey}`)}
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
                  <h2>{t('pages:characterEditor.secIdentity')}</h2>
                  <span className="trail" />
                </div>
                <Field label={t('pages:characterEditor.name')}>
                  <input value={form.name} onChange={(e) => set('name', e.target.value)} />
                </Field>
                <div className="inline-fields">
                  <Field label={t('pages:characterEditor.age')} hint={t('pages:characterEditor.ageHint', { min: MIN_CHARACTER_AGE })}>
                    <input
                      type="number"
                      min={MIN_CHARACTER_AGE}
                      value={form.age}
                      onChange={(e) => set('age', Number(e.target.value))}
                    />
                  </Field>
                  <Field label={t('pages:characterEditor.pronouns')}>
                    <input value={form.pronouns} onChange={(e) => set('pronouns', e.target.value)} />
                  </Field>
                </div>
                <div className="inline-fields">
                  <Field label={t('pages:characterEditor.gender')} hint={t('pages:characterEditor.genderHint')}>
                    <select value={form.gender} onChange={(e) => set('gender', e.target.value as Gender)}>
                      {Object.keys(GENDER_LABELS).map((k) => (
                        <option key={k} value={k}>
                          {genderLabel(k)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('pages:characterEditor.sexuality')} hint={t('pages:characterEditor.sexualityHint')}>
                    <select value={form.sexuality} onChange={(e) => set('sexuality', e.target.value as Sexuality)}>
                      {Object.keys(SEXUALITY_LABELS).map((k) => (
                        <option key={k} value={k}>
                          {sexualityLabel(k)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label={t('pages:characterEditor.world')} hint={t('pages:characterEditor.worldHint')}>
                  <select value={form.worldId ?? ''} onChange={(e) => set('worldId', e.target.value || null)}>
                    <option value="">{t('pages:characterEditor.noWorld')}</option>
                    {worlds.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={t('pages:characterEditor.relStyle')}
                  hint={t('pages:characterEditor.relStyleHint')}
                >
                  <select
                    value={form.relationshipStyle}
                    onChange={(e) => set('relationshipStyle', e.target.value as RelationshipStyle)}
                  >
                    {(Object.keys(RELATIONSHIP_STYLE_LABELS) as RelationshipStyle[]).map((k) => (
                      <option key={k} value={k}>
                        {relationshipStyleLabel(k)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('pages:characterEditor.shortDesc')}>
                  <textarea value={form.shortDescription} onChange={(e) => set('shortDescription', e.target.value)} />
                </Field>
              </div>

              <div className="card">
                <div className="creator-sec">
                  <span className="creator-index">02</span>
                  <h2>{t('pages:characterEditor.secPortrait')}</h2>
                  <span className="trail" />
                </div>
                <AssetPicker value={form.portraitAssetId} onChange={(v) => set('portraitAssetId', v)} characterName={form.name} />
                <div className="ce-image-gen">
                  <button className="btn sm primary" onClick={() => setGenOpen(true)}>
                    <Icon name="generate" size={13} />
                    {t('pages:characterEditor.generate')}
                  </button>
                  <p className="creator-note">{t('pages:characterEditor.portraitGenNote')}</p>
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
                    {t('pages:characterEditor.expressions')}
                    <span className="badge" style={{ marginLeft: 6 }}>
                      {t('pages:characterEditor.expressionsSet', {
                        count: form.expressionRows.filter((r) => r.assetId).length,
                      })}
                    </span>
                  </h3>
                  <span className="trail" />
                </div>
                {expressionsOpen && (
                  <>
                    <p className="creator-note">{t('pages:characterEditor.expressionsNote')}</p>
                    {form.expressionRows.map((row, i) => (
                  <div key={row.name} className="creator-subcard stack">
                    <div className="row">
                      <strong className="flex-fill">{expressionLabel(row.name)}</strong>
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
                          {t('pages:characterEditor.clear')}
                        </button>
                      )}
                    </div>
                    <AssetPicker
                      value={row.assetId}
                      characterName={form.name}
                      expressionName={row.name}
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
                  <h2>{t('pages:characterEditor.secPersonality')}</h2>
                  <span className="trail" />
                </div>
                <Field label={t('pages:characterEditor.personality')}>
                  <textarea value={form.personality} onChange={(e) => set('personality', e.target.value)} />
                </Field>
                <Field label={t('pages:characterEditor.speechStyle')}>
                  <textarea value={form.speechStyle} onChange={(e) => set('speechStyle', e.target.value)} />
                </Field>
                <Field label={t('pages:characterEditor.relPrefs')}>
                  <textarea
                    value={form.relationshipPreferences}
                    onChange={(e) => set('relationshipPreferences', e.target.value)}
                  />
                </Field>
                <Field label={t('pages:characterEditor.creatorNotes')} hint={t('pages:characterEditor.creatorNotesHint')}>
                  <textarea value={form.creatorNotes} onChange={(e) => set('creatorNotes', e.target.value)} />
                </Field>
              </div>

              <div className="card">
                <div className="creator-sec">
                  <span className="creator-index">04</span>
                  <h2>{t('pages:characterEditor.secTraits')}</h2>
                  <span className="trail" />
                </div>
                <Field label={t('pages:characterEditor.likes')}>
                  <TagInput value={form.likes} onChange={(v) => set('likes', v)} />
                </Field>
                <Field label={t('pages:characterEditor.dislikes')}>
                  <TagInput value={form.dislikes} onChange={(v) => set('dislikes', v)} />
                </Field>
                <Field label={t('pages:characterEditor.goals')}>
                  <TagInput value={form.goals} onChange={(v) => set('goals', v)} />
                </Field>
                <Field label={t('pages:characterEditor.boundaries')}>
                  <TagInput value={form.boundaries} onChange={(v) => set('boundaries', v)} />
                </Field>
                <Field
                  label={t('pages:characterEditor.guardedness', {
                    value: form.guardedness,
                    descriptor: guardednessDescriptorLabel(form.guardedness),
                  })}
                  hint={t('pages:characterEditor.guardednessHint')}
                >
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={form.guardedness}
                    onChange={(e) => set('guardedness', Number(e.target.value))}
                  />
                  <div className="ce-range-ends">
                    <span>{t('pages:characterEditor.openBook')}</span>
                    <span>{t('pages:characterEditor.walledOff')}</span>
                  </div>
                </Field>
              </div>
            </div>

            {/* Weather preferences — fits naturally under personality */}
            <div className="card">
              <div className="creator-sec">
                <span className="creator-index">09</span>
                <h2>{t('pages:characterEditor.secWeather')}</h2>
                <span className="trail" />
              </div>
              <p className="creator-note">{t('pages:characterEditor.weatherNote')}</p>
              <div className="weather-pref-grid">
                {WEATHER_KINDS.map((k) => {
                  const fav = form.favoriteWeather.includes(k);
                  const dis = form.dislikedWeather.includes(k);
                  return (
                    <div className="weather-pref" key={k}>
                      <span className="flex-fill">
                        {WEATHER_ICONS[k]} {weatherLabel(k)}
                      </span>
                      <button
                        className={`btn sm ${fav ? 'primary' : 'ghost'}`}
                        onClick={() => toggleWeather(k, 'fav')}
                        title={t('pages:characterEditor.lovesWeather')}
                      >
                        ♥
                      </button>
                      <button
                        className={`btn sm ${dis ? 'danger' : 'ghost'}`}
                        onClick={() => toggleWeather(k, 'dis')}
                        title={t('pages:characterEditor.dislikesWeather')}
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
                  <h2>{t('pages:characterEditor.secProfile')}</h2>
                  <span className="trail" />
                  <button
                    className="btn sm creator-sec-action"
                    onClick={generateProfile}
                    disabled={generatingProfile || !form.name.trim()}
                  >
                    <Icon name="generate" size={13} />
                    {generatingProfile
                      ? t('pages:characterEditor.generating')
                      : t('pages:characterEditor.genFromDesc')}
                  </button>
                </div>
                <p className="creator-note">
                  {t('pages:characterEditor.profileNote', {
                    name: form.name || t('pages:characterEditor.thisCharacter'),
                  })}
                </p>
                <Field label={t('pages:characterEditor.appearance')}>
                  <textarea value={form.appearance} onChange={(e) => set('appearance', e.target.value)} />
                </Field>
                <Field label={t('pages:characterEditor.textingStyle')} hint={t('pages:characterEditor.textingStyleHint')}>
                  <textarea value={form.textingStyle} onChange={(e) => set('textingStyle', e.target.value)} />
                </Field>
                <Field label={t('pages:characterEditor.onlinePersona')} hint={t('pages:characterEditor.onlinePersonaHint')}>
                  <textarea value={form.onlinePersona} onChange={(e) => set('onlinePersona', e.target.value)} />
                </Field>
                <Field label={t('pages:characterEditor.loveLanguage')}>
                  <input value={form.loveLanguage} onChange={(e) => set('loveLanguage', e.target.value)} />
                </Field>
              </div>

              <div className="card">
                <div className="creator-sec">
                  <span className="creator-index">06</span>
                  <h2>{t('pages:characterEditor.secChemistry')}</h2>
                  <span className="trail" />
                </div>
                <p className="creator-note">{t('pages:characterEditor.chemistryNote')}</p>
                <Field label={t('pages:characterEditor.physicalNeeds')}>
                  <TagInput value={form.physicalNeeds} onChange={(v) => set('physicalNeeds', v)} />
                </Field>
                <Field label={t('pages:characterEditor.physicalDesires')}>
                  <TagInput value={form.physicalDesires} onChange={(v) => set('physicalDesires', v)} />
                </Field>
                <Field label={t('pages:characterEditor.physicalDislikes')}>
                  <TagInput value={form.physicalDislikes} onChange={(v) => set('physicalDislikes', v)} />
                </Field>
                <Field label={t('pages:characterEditor.insecurities')}>
                  <TagInput value={form.insecurities} onChange={(v) => set('insecurities', v)} />
                </Field>
                <Field label={t('pages:characterEditor.quirks')}>
                  <TagInput value={form.quirks} onChange={(v) => set('quirks', v)} />
                </Field>
              </div>
            </div>

            {/* Dating stats also belong in Profile — defines their dating persona */}
            <div className="card">
              <div className="creator-sec">
                <span className="creator-index">10</span>
                <h2>{t('pages:characterEditor.secBaseStats')}</h2>
                <span className="trail" />
                <button
                  className="btn sm creator-sec-action"
                  onClick={generateStats}
                  disabled={generatingStats || !form.name.trim()}
                >
                  <Icon name="generate" size={13} />
                  {generatingStats
                    ? t('pages:characterEditor.generating')
                    : t('pages:characterEditor.genFromDesc')}
                </button>
              </div>
              <p className="creator-note">{t('pages:characterEditor.baseStatsNote')}</p>
              {DATING_STAT_KEYS.map((k) => (
                <Field
                  key={k}
                  label={t('pages:characterEditor.statLabel', {
                    label: datingStatLabel(k),
                    value: form.datingStats[k],
                  })}
                  hint={datingStatDesc(k)}
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
                <h2>{t('pages:characterEditor.secConnections')}</h2>
                <span className="trail" />
              </div>
              <p className="creator-note">
                {t('pages:characterEditor.connectionsNote', {
                  name: form.name || t('pages:characterEditor.thisCharacter'),
                })}
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
                    <option value="">{t('pages:characterEditor.selectCharacter')}</option>
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
                        {characterLinkLabel(k)}
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
                {t('pages:characterEditor.addConnection')}
              </button>
              <label className="ce-excanoize-label">
                <input
                  type="checkbox"
                  checked={form.allowsExCanonization}
                  onChange={(e) => set('allowsExCanonization', e.target.checked)}
                />
                <span className="creator-note ce-excanoize-body">
                  <strong>{t('pages:characterEditor.exCanonStrong')}</strong>
                  {t('pages:characterEditor.exCanonBody', {
                    name: form.name || t('pages:characterEditor.thisCharacter'),
                  })}
                </span>
              </label>
            </div>

            {/* Relationship stats */}
            <div className="card">
              <div className="creator-sec">
                <span className="creator-index">11</span>
                <h2>{t('pages:characterEditor.secRelationship')}</h2>
                <span className="trail" />
              </div>
              {relationship ? (
                <RelationshipBars relationship={relationship} />
              ) : (
                <p className="muted">{t('pages:characterEditor.relStatsLater')}</p>
              )}
            </div>

            {/* Memories */}
            <div className="card">
              <div className="creator-sec">
                <span className="creator-index">12</span>
                <h2>{t('pages:characterEditor.secMemories')}</h2>
                <span className="trail" />
              </div>
              {isNew ? (
                <p className="muted">{t('pages:characterEditor.memoriesSaveFirst')}</p>
              ) : (
                <>
                  <div className="row" style={{ alignItems: 'flex-end' }}>
                    <div className="flex-fill">
                      <Field label={t('pages:characterEditor.addMemory')}>
                        <input
                          value={newMemory.text}
                          placeholder={t('pages:characterEditor.memoryPlaceholder')}
                          onChange={(e) => setNewMemory((m) => ({ ...m, text: e.target.value }))}
                        />
                      </Field>
                    </div>
                    <Field label={t('pages:characterEditor.importance')}>
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
                      {addingMemory ? t('pages:characterEditor.adding') : t('pages:characterEditor.add')}
                    </button>
                  </div>
                  {memories.length === 0 ? (
                    <p className="muted">{t('pages:characterEditor.noMemories')}</p>
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
                          {deletingMemoryId === m.id ? t('pages:characterEditor.deleting') : t('pages:characterEditor.delete')}
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
                <h2>{t('pages:characterEditor.secEmployment')}</h2>
                <span className="trail" />
              </div>
              <p className="creator-note">
                {t('pages:characterEditor.employmentNote', {
                  name: form.name || t('pages:characterEditor.thisCharacter'),
                })}
              </p>
              <label className="ce-employed-toggle">
                <input
                  type="checkbox"
                  checked={form.employment != null}
                  onChange={(e) => set('employment', e.target.checked ? { ...DEFAULT_JOB } : null)}
                />
                <span>{t('pages:characterEditor.employed')}</span>
              </label>
              {form.employment && (
                <>
                  <div className="inline-fields">
                    <Field label={t('pages:characterEditor.jobTitle')}>
                      <input value={form.employment.title} onChange={(e) => patchEmp({ title: e.target.value })} />
                    </Field>
                    <Field label={t('pages:characterEditor.workplace')} hint={t('pages:characterEditor.workplaceHint')}>
                      <input value={form.employment.place} onChange={(e) => patchEmp({ place: e.target.value })} />
                    </Field>
                  </div>
                  <Field label={t('pages:characterEditor.shift')}>
                    <select
                      value={form.employment.shiftPhase}
                      onChange={(e) => patchEmp({ shiftPhase: e.target.value as Employment['shiftPhase'] })}
                    >
                      <option value="morning">{t('pages:characterEditor.shiftMorning')}</option>
                      <option value="afternoon">{t('pages:characterEditor.shiftAfternoon')}</option>
                      <option value="evening">{t('pages:characterEditor.shiftEvening')}</option>
                    </select>
                  </Field>
                  <Field label={t('pages:characterEditor.workdays')}>
                    <div className="ce-workdays">
                      {DAYS_OF_WEEK.map((d, idx) => (
                        <button
                          key={d}
                          type="button"
                          className={`btn sm ${form.employment!.workdays.includes(idx) ? 'primary' : 'ghost'}`}
                          onClick={() => toggleWorkday(idx)}
                          title={weekdayLabel(d)}
                        >
                          {weekdayAbbr(d)}
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
              <span className="kicker">{t('pages:characterEditor.assembledPrompt')}</span>
              <span className="trail" />
              <button
                className="btn sm ghost creator-sec-action"
                onClick={() => setPreviewOpen(false)}
              >
                <Icon name="close" size={13} />
                {t('pages:characterEditor.close')}
              </button>
            </div>
          </summary>
          <pre className="pre ce-prompt-pre">{preview}</pre>
        </details>
      )}

      {genOpen && (
        <Modal onClose={() => !generating && setGenOpen(false)}>
          <div className="kicker">{t('pages:characterEditor.genKicker')}</div>
          <h2 style={{ marginTop: 0 }}>{t('pages:characterEditor.genTitle')}</h2>
          <p className="hint">{t('pages:characterEditor.genIntro')}</p>

          <div className="stack" style={{ gap: 14 }}>
            <Field label={t('pages:characterEditor.genPortrait')} hint={t('pages:characterEditor.genPortraitHint')}>
              <AssetPicker value={form.portraitAssetId} onChange={(v) => set('portraitAssetId', v)} />
            </Field>

            <Field label={t('pages:characterEditor.genText')} hint={t('pages:characterEditor.genTextHint')}>
              <textarea
                value={genText}
                rows={8}
                placeholder={t('pages:characterEditor.genTextPlaceholder')}
                onChange={(e) => {
                  setGenText(e.target.value.slice(0, MAX_SOURCE_CHARS));
                  setGenFileName(null);
                }}
              />
              <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                <label className="btn sm ghost" style={{ cursor: 'pointer', margin: 0 }}>
                  <Icon name="upload" size={13} />
                  {t('pages:characterEditor.genUpload')}
                  <input type="file" style={{ display: 'none' }} onChange={onPickSourceFile} />
                </label>
                {genFileName && <span className="hint">{genFileName}</span>}
                {genText && (
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={() => {
                      setGenText('');
                      setGenFileName(null);
                    }}
                  >
                    {t('pages:characterEditor.genClearText')}
                  </button>
                )}
              </div>
            </Field>

            {hasContent && <Banner kind="info">{t('pages:characterEditor.genOverwriteWarn')}</Banner>}
          </div>

          <div className="row end" style={{ flexWrap: 'wrap', marginTop: 16 }}>
            <button className="btn ghost" onClick={() => setGenOpen(false)} disabled={generating}>
              {t('common:cancel')}
            </button>
            <button className="btn primary" onClick={runGeneration} disabled={generating || !canGenerate} autoFocus>
              <Icon name="generate" size={14} />
              {generating ? t('pages:characterEditor.generating') : t('pages:characterEditor.genRun')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
