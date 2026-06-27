import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  QUEST_VERBS,
  DIFFICULTY_BANDS,
  EFFECT_OPS,
  QUEST_FACTIONS,
  QUEST_STATUSES,
  GOAL_KINDS,
  GOAL_OUTCOMES,
  DATING_STAT_KEYS,
  QUEST,
  effectTier,
  tierUnlockedBy,
  lintQuestGraph,
  type Quest,
  type QuestGraph,
  type QuestNode,
  type NodeAffordance,
  type Effect,
  type StatePredicate,
  type QuestGoal,
  type GoalKind,
  type OutcomeGrade,
  type DifficultyBand,
  type Character,
  type QuestCreate,
  type QuestUpdate,
} from '@dsim/shared';
import { api } from '../../lib/api';
import { useAsync, errorMessage } from '../../lib/hooks';
import { Banner, Empty, Field, Loader, ConfirmDialog, Modal } from '../ui';
import { Icon } from '../Icon';
import { SceneGraph } from './SceneGraph';

// --- Friendly labels (this creator surface is intentionally English chrome) ---------

const VERB_LABEL: Record<string, string> = {
  talk: 'Talk / ask', persuade: 'Persuade', charm: 'Charm', deceive: 'Deceive (bluff)',
  intimidate: 'Intimidate', inspect: 'Inspect', sneak: 'Sneak', move: 'Move',
  use_item: 'Use item', aid: 'Aid / help', force: 'Force', attack: 'Attack', wait: 'Wait',
};
const DIFFICULTY_LABEL: Record<string, string> = {
  trivial: 'Trivial · ~90%', normal: 'Normal · ~65%', hard: 'Hard · ~40%', desperate: 'Desperate · ~20%',
};
const FACTION_LABEL: Record<string, string> = {
  party: 'In your party', ally: 'Ally', neutral: 'Neutral', hostile: 'Hostile',
};
const STATUS_LABEL: Record<string, string> = {
  resolved: 'Resolved · soft end', abandoned: 'Abandoned', active: 'Active',
};
const EFFECT_OP_LABEL: Record<string, string> = {
  setFlag: 'Set a flag', clearFlag: 'Clear a flag',
  moveEntityToFaction: 'Change a character’s side', adjustWarmth: 'Change closeness with a date',
  adjustStat: 'Change a stat (health / feeling)', grantItem: 'Give a scene item', removeItem: 'Take a scene item',
  addMoney: 'Give money', moveToNode: 'Go to another scene', endScene: 'End the scene',
};
const EFFECT_OP_HINT: Record<string, string> = {
  setFlag: 'Marks something true (e.g. door_open) — a goal or route can then check it.',
  clearFlag: 'Unmarks a flag.',
  moveEntityToFaction: 'Switches a character to your side (ally/party) or against you (hostile).',
  adjustWarmth: 'Nudges your real relationship with a dated character (capped per day).',
  adjustStat: 'Changes a character’s health/feeling, or a player stat. Blank target = the player.',
  grantItem: 'Adds a scene item (used by “has item” goals — not your real inventory).',
  removeItem: 'Removes a scene item.',
  addMoney: 'Pays the player money (capped per quest).',
  moveToNode: 'Moves play to another scene. Needs a Desperate approach to fire.',
  endScene: 'Ends the quest. Needs a Desperate approach to fire.',
};
const PREDICATE_LABEL: Record<string, string> = {
  flag: 'A flag is set', entityFaction: 'A character is on a side', entityHp: 'A character’s health',
  entityDisposition: 'A character’s feeling', hasItem: 'Player has an item', atNode: 'Player is at a scene',
  turnGte: 'On / after a turn', always: 'Always (true immediately)',
};
const GOAL_KIND_LABEL: Record<string, string> = {
  defeat: 'Defeat · drop a character to 0 health', persuade: 'Persuade · win a character over',
  acquire: 'Acquire · get an item', reach: 'Reach · get to a scene/beat',
  survive: 'Survive · hold out N turns', flag: 'Flag · a custom condition',
};
const TIER_LABEL: Record<string, string> = {
  cosmetic: 'cosmetic', material: 'material', heavy: 'heavy', spine: 'spine',
};
// Plain-language framing for the four outcome grades (the rules engine's terms read
// as jargon; authors think "what happens if they nail it / fumble it").
const GRADE_LABEL: Record<OutcomeGrade, string> = {
  success: 'Success', partial: 'Partial', fail: 'Fail', complication: 'Complication',
};
const GRADE_GLOSS: Record<OutcomeGrade, string> = {
  success: 'they nail it', partial: 'partly works', fail: 'no luck', complication: 'it backfires',
};

/**
 * The creator-mode quest authoring surface (the "Author" view of the Wayfarer tab).
 * A list of a world's authored quests + a full node-graph editor. The server
 * re-sanitises every saved graph through boundQuestGraph, so this UI is a
 * convenience over the schema, not the safety boundary.
 */

const GRADES: OutcomeGrade[] = ['success', 'partial', 'fail', 'complication'];
const STAT_OPTIONS = [...DATING_STAT_KEYS, 'grit', 'wits'] as const;
const PREDICATE_KINDS = ['flag', 'entityFaction', 'entityHp', 'entityDisposition', 'hasItem', 'atNode', 'turnGte', 'always'] as const;

// --- Flag wiring -----------------------------------------------------------
// The hardest thing to see in the editor is which effect SETS a flag and which
// route/goal CHECKS it. We index those relationships once, then (a) draw a trace
// line under each approach and (b) cross-highlight a flag's twins when one is focused.

interface FlagWiring {
  setters: Map<string, string[]>; // flag -> human labels of effects that set/clear it
  checkers: Map<string, string[]>; // flag -> human labels of routes/goals that check it
}

function computeWiring(graph: QuestGraph): FlagWiring {
  const setters = new Map<string, string[]>();
  const checkers = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, flag: string | undefined, label: string) => {
    const f = flag?.trim();
    if (!f) return;
    (m.get(f) ?? m.set(f, []).get(f)!).push(label);
  };
  for (const n of graph.nodes) {
    for (const a of n.affordances)
      for (const grade of GRADES)
        for (const e of a.effects[grade]) {
          if (e.op === 'setFlag') add(setters, e.flag, `${VERB_LABEL[a.verb] ?? a.verb} · ${grade} (${n.id})`);
          if (e.op === 'clearFlag') add(setters, e.flag, `cleared · ${VERB_LABEL[a.verb] ?? a.verb} (${n.id})`);
        }
    for (const edge of n.edges)
      if (edge.when.kind === 'flag') add(checkers, edge.when.flag, `route ${n.id}→${edge.to}${edge.when.negate ? ' (not)' : ''}`);
  }
  for (const g of graph.goals)
    if (g.predicate.kind === 'flag')
      add(checkers, g.predicate.flag, `${g.outcome === 'win' ? 'Win' : 'Lose'} goal${g.label ? ` “${g.label}”` : ''}${g.predicate.negate ? ' (not)' : ''}`);
  return { setters, checkers };
}

interface WiringCtx extends FlagWiring {
  active: string | null;
  setActive: (flag: string | null) => void;
}
const WiringContext = createContext<WiringCtx>({ setters: new Map(), checkers: new Map(), active: null, setActive: () => {} });

/** A flag-name input that cross-highlights its twins on focus and explains, in its
 *  tooltip, where the flag is set and checked. Used by effects + route/goal predicates. */
function FlagInput({ value, onChange, placeholder = 'flag' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const { setters, checkers, active, setActive } = useContext(WiringContext);
  const flag = value.trim();
  const hot = !!flag && active === flag;
  const set = setters.get(flag) ?? [];
  const checked = checkers.get(flag) ?? [];
  const title = flag
    ? `${set.length ? `Set by: ${set.join('; ')}` : 'Not set by anything yet'}\n${checked.length ? `Checked by: ${checked.join('; ')}` : 'Not checked by any route or goal'}`
    : undefined;
  return (
    <input
      list="wf-flags"
      className={`wf-ed-flag${hot ? ' wf-flag-hot' : ''}`}
      placeholder={placeholder}
      title={title}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => setActive(flag || null)}
      onBlur={() => setActive(null)}
    />
  );
}

interface Draft {
  id: string | null; // null = a brand-new quest
  name: string;
  blurb: string;
  partnerId: string | null;
  minWarmthBand: number;
  graph: QuestGraph;
  /** One-time notes from the generator (incl. fiction-coherence judge findings that the
   *  live linter can't see). Shown as an info banner on a freshly-drafted quest only. */
  genNotes?: string[];
}

function blankGraph(): QuestGraph {
  return {
    entryNodeId: 'scene1',
    maxTurns: QUEST.DEFAULT_MAX_TURNS,
    timeoutOutcome: 'resolved',
    nodes: [
      {
        id: 'scene1',
        kind: 'scene',
        setup: '',
        entities: [],
        affordances: [
          {
            verb: 'persuade',
            stat: 'charm',
            difficulty: 'normal',
            hint: '',
            effects: { success: [{ op: 'setFlag', flag: 'done' }], partial: [], fail: [], complication: [] },
          },
        ],
        edges: [],
        isTerminal: false,
      },
    ],
    goals: [{ id: 'win', kind: 'flag', outcome: 'win', label: 'Complete the quest', predicate: { kind: 'flag', flag: 'done' } }],
  };
}

function draftFromQuest(q: Quest): Draft {
  return { id: q.id, name: q.name, blurb: q.blurb, partnerId: q.partnerId, minWarmthBand: q.minWarmthBand, graph: structuredClone(q.graph) };
}

export function QuestAuthor({ worldId }: { worldId: string }) {
  const list = useAsync(() => api.authoredQuests(worldId), [worldId]);
  const chars = useAsync(() => api.listCharacters(worldId), [worldId]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [genOpen, setGenOpen] = useState(false);

  if (editing) {
    return (
      <QuestEditor
        worldId={worldId}
        draft={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          list.reload();
        }}
      />
    );
  }

  return (
    <div className="wf-author">
      <div className="wf-author-bar">
        <div className="wf-author-bar-title">
          <span className="kicker">Authoring</span>
          <p className="hint">Craft adventures players can step into — generate a draft, or build one by hand.</p>
        </div>
        <div className="row wf-author-bar-actions">
          <button className="btn ghost sm" onClick={() => setGenOpen(true)}>
            <Icon name="generate" size={14} /> Generate
          </button>
          <button
            className="btn primary sm"
            onClick={() => setEditing({ id: null, name: '', blurb: '', partnerId: null, minWarmthBand: 0, graph: blankGraph() })}
          >
            <Icon name="plus" size={14} /> New adventure
          </button>
        </div>
      </div>
      {genOpen && (
        <GenerateModal
          worldId={worldId}
          characters={chars.data ?? []}
          onClose={() => setGenOpen(false)}
          onDrafted={(d) => {
            setGenOpen(false);
            setEditing(d);
          }}
        />
      )}
      <Loader state={list}>
        {(data) =>
          data.quests.length === 0 ? (
            <Empty icon={<Icon name="quest" size={28} />} title="No adventures authored yet">
              <p className="hint">Create one — give it a scene, a few things the player can try, and a goal.</p>
            </Empty>
          ) : (
            <div className="wf-author-list">
              {data.quests.map((q) => (
                <QuestRow key={q.id} quest={q} onEdit={() => setEditing(draftFromQuest(q))} onDeleted={() => list.reload()} />
              ))}
            </div>
          )
        }
      </Loader>
    </div>
  );
}

function QuestRow({ quest, onEdit, onDeleted }: { quest: Quest; onEdit: () => void; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const sceneN = quest.graph.nodes.length;
  const goalN = quest.graph.goals.length;
  return (
    <article className={`card wf-author-row${quest.partnerId ? ' romance' : ''}`}>
      <span className="wf-author-medal" aria-hidden>
        <Icon name={quest.partnerId ? 'affection' : 'quest'} size={18} />
      </span>
      <div className="wf-author-row-main">
        <h3>{quest.name || 'Untitled adventure'}</h3>
        <div className="wf-author-chips">
          <span className="wf-chip"><Icon name="location" size={11} /> {sceneN} scene{sceneN === 1 ? '' : 's'}</span>
          <span className="wf-chip"><Icon name="end" size={11} /> {goalN} goal{goalN === 1 ? '' : 's'}</span>
          {quest.partnerId && <span className="wf-chip romance"><Icon name="affection" size={11} /> Partner-anchored</span>}
        </div>
      </div>
      <div className="row wf-author-row-actions">
        <button className="btn ghost sm" onClick={onEdit}>
          <Icon name="edit" size={14} /> Edit
        </button>
        <button className="btn danger sm" onClick={() => setConfirm(true)} title="Delete adventure">
          <Icon name="trash" size={14} />
        </button>
      </div>
      {confirm && (
        <ConfirmDialog
          title={`Delete “${quest.name}”?`}
          body="This removes the quest and any in-progress run of it. This can't be undone."
          danger
          busy={busy}
          confirmLabel="Delete"
          onConfirm={async () => {
            setBusy(true);
            try {
              await api.deleteQuest(quest.id);
              onDeleted();
            } finally {
              setBusy(false);
              setConfirm(false);
            }
          }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </article>
  );
}

// --- Generate (✨) ----------------------------------------------------------

function GenerateModal({
  worldId, characters, onClose, onDrafted,
}: {
  worldId: string;
  characters: Character[];
  onClose: () => void;
  onDrafted: (d: Draft) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.generateQuest(worldId, prompt.trim(), partnerId || null);
      if (res.ok) {
        onDrafted({ id: null, name: res.data.name, blurb: res.data.blurb, partnerId: res.data.partnerId, minWarmthBand: res.data.minWarmthBand, graph: res.data.graph, genNotes: res.data.warnings });
      } else {
        setError(res.error || 'The model couldn’t draft a usable quest. Try a clearer idea, or a more capable model.');
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <div className="kicker">Generate a quest</div>
      <h2 style={{ marginTop: 0 }}>Describe the adventure</h2>
      {error && <Banner kind="error">{error}</Banner>}
      <Field label="Your idea" hint="A scene, a goal, a problem to talk/fight/sneak your way through. Go into as much detail as you like.">
        <textarea
          value={prompt}
          rows={8}
          autoFocus
          placeholder="e.g. A midnight standoff at the harbor warehouse — win over the suspicious night watchman before the smugglers arrive."
          onChange={(e) => setPrompt(e.target.value)}
        />
      </Field>
      <Field label="Anchor to a character" hint="Optional — makes it a romance quest with that person.">
        <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
          <option value="">— none —</option>
          {characters.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </Field>
      <div className="row end" style={{ marginTop: 10 }}>
        <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={go} disabled={busy || !prompt.trim()}>
          {busy ? 'Drafting…' : <><Icon name="generate" size={14} /> Draft it</>}
        </button>
      </div>
      <p className="hint" style={{ marginTop: 8 }}>The model drafts it; you can edit everything before saving. Nothing is saved until you do.</p>
    </Modal>
  );
}

// --- The editor -------------------------------------------------------------

export function QuestEditor({ worldId, draft: initial, onClose, onSaved }: { worldId: string; draft: Draft; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmBack, setConfirmBack] = useState(false);
  const [notesDismissed, setNotesDismissed] = useState(false);
  // The scene focused in the graph below; the detail form edits this one. Tracked by
  // index (not id) so renaming a scene's id doesn't drop the selection.
  const [selectedIdx, setSelectedIdx] = useState(() => {
    const i = initial.graph.nodes.findIndex((n) => n.id === initial.graph.entryNodeId);
    return i >= 0 ? i : 0;
  });
  const chars = useAsync(() => api.listCharacters(worldId), [worldId]);
  const characters: Character[] = chars.data ?? [];

  /** Ergonomic nested-immutable update: clone, mutate, set. Graphs are small. */
  const edit = (fn: (d: Draft) => void) => setDraft((prev) => { const c = structuredClone(prev); fn(c); return c; });
  const editGraph = (fn: (g: QuestGraph) => void) => edit((d) => fn(d.graph));

  // Keep the selection in range as scenes come and go.
  useEffect(() => {
    setSelectedIdx((sel) => Math.min(sel, Math.max(0, draft.graph.nodes.length - 1)));
  }, [draft.graph.nodes.length]);

  const addScene = () => {
    setSelectedIdx(draft.graph.nodes.length); // the about-to-be-pushed node's index
    editGraph((g) => { g.nodes.push(blankNode(`scene${g.nodes.length + 1}`)); });
  };
  const removeScene = (i: number) => {
    setSelectedIdx((sel) => (sel > i ? sel - 1 : sel === i ? Math.max(0, i - 1) : sel));
    editGraph((g) => { g.nodes.splice(i, 1); });
  };
  const selectById = (id: string) => {
    const i = draft.graph.nodes.findIndex((n) => n.id === id);
    if (i >= 0) setSelectedIdx(i);
  };
  const selectedNode = draft.graph.nodes[selectedIdx];

  // Every entity across the graph (for goal/edge predicates that span scenes).
  const allEntities = useMemo(
    () => draft.graph.nodes.flatMap((n) => n.entities.map((e) => ({ id: e.id, label: `${e.name || e.id} (${n.id})` }))),
    [draft.graph],
  );
  const nodeIds = draft.graph.nodes.map((n) => n.id);
  const allFlags = useMemo(() => flagsSetIn(draft.graph), [draft.graph]);
  const problems = useMemo(() => validateDraft(draft), [draft]);
  const blocking = problems.some((p) => p.blocking);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);
  const close = () => (dirty ? setConfirmBack(true) : onClose());

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (draft.id) {
        const patch: QuestUpdate = {
          name: draft.name,
          blurb: draft.blurb,
          partnerId: draft.partnerId,
          minWarmthBand: draft.minWarmthBand,
          graph: draft.graph,
        };
        await api.updateQuest(draft.id, patch);
      } else {
        const input: QuestCreate = {
          worldId,
          name: draft.name,
          blurb: draft.blurb,
          partnerId: draft.partnerId,
          minWarmthBand: draft.minWarmthBand,
          graph: draft.graph,
        };
        await api.createQuest(input);
      }
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const wiring = useMemo(() => computeWiring(draft.graph), [draft.graph]);
  const [activeFlag, setActiveFlag] = useState<string | null>(null);

  return (
    <WiringContext.Provider value={{ ...wiring, active: activeFlag, setActive: setActiveFlag }}>
    <div className="wf-editor">
      {/* shared flag suggestions so authors reuse flag names instead of retyping them */}
      <datalist id="wf-flags">
        {allFlags.map((f) => <option key={f} value={f} />)}
      </datalist>

      <div className="wf-editor-head">
        <button className="btn ghost sm" onClick={close}>
          <Icon name="recap" size={14} /> Back
        </button>
        <div className="wf-editor-head-title">
          <span className="kicker">{draft.id ? 'Editing' : 'New adventure'}</span>
          <strong>{draft.name.trim() || 'Untitled adventure'}</strong>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {dirty && <span className="wf-ed-dirty"><span className="wf-ed-dirty-dot" />Unsaved changes</span>}
          <button className="btn primary sm" onClick={save} disabled={saving || blocking} title={blocking ? 'Fix the highlighted problems first' : undefined}>
            <Icon name="save" size={14} /> {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {(() => {
        // Show only the generation notes the LIVE linter doesn't already report (so the
        // deterministic ones surface in the problems list below — and drop off once fixed —
        // while the coherence-judge notes, which can't be rechecked, persist here).
        const live = new Set(problems.map((p) => p.text));
        const banner = (draft.genNotes ?? []).filter((n) => !live.has(n));
        if (banner.length === 0 || notesDismissed) return null;
        return (
          <Banner kind="info">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <strong>Generated draft — a few things worth a look before saving:</strong>
              <button className="btn ghost sm" onClick={() => setNotesDismissed(true)}>Dismiss</button>
            </div>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {banner.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </Banner>
        );
      })()}

      <details className="wf-ed-help">
        <summary>How authoring works</summary>
        <p>
          A quest is one or more <strong>scenes</strong>. Each scene has <strong>entities</strong> (the
          characters/things you can affect), <strong>approaches</strong> (what the player can try — a verb, the
          stat it tests, a difficulty, and what each outcome does), optional <strong>routes</strong> to other
          scenes, and <strong>goals</strong> that decide when the quest is won or lost.
        </p>
        <p>
          A <strong>flag</strong> is a named marker (e.g. <code>door_open</code>). An effect can set it and a goal or
          route can check it — that’s how you connect “what happened” to “the quest is won”. Bigger effects (a side
          switch, money, ending the scene) only fire on <strong>harder</strong> approaches.
        </p>
      </details>

      {problems.length > 0 && (
        <div className="wf-ed-validate">
          {problems.map((p, i) => (
            <div key={i} className={`wf-ed-prob ${p.blocking ? 'block' : 'warn'}`}>
              <Icon name={p.blocking ? 'warn' : 'info'} size={13} /> {p.text}
            </div>
          ))}
        </div>
      )}

      {confirmBack && (
        <ConfirmDialog
          title="Discard changes?"
          body="Your unsaved edits to this adventure will be lost."
          danger
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          onConfirm={() => { setConfirmBack(false); onClose(); }}
          onCancel={() => setConfirmBack(false)}
        />
      )}

      {/* --- quest meta --- */}
      <section className="card wf-ed-card">
        <div className="wf-ed-grid">
          <Field label="Name">
            <input value={draft.name} onChange={(e) => edit((d) => (d.name = e.target.value))} maxLength={120} />
          </Field>
          <Field label="Partner anchor" hint="A dated character this quest is about (optional).">
            <select value={draft.partnerId ?? ''} onChange={(e) => edit((d) => (d.partnerId = e.target.value || null))}>
              <option value="">— none —</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          {draft.partnerId && (
            <Field label="Min warmth band" hint="0–5; how close before this unlocks.">
              <input type="number" min={0} max={5} value={draft.minWarmthBand} onChange={(e) => edit((d) => (d.minWarmthBand = clampNum(e.target.value, 0, 5)))} />
            </Field>
          )}
        </div>
        <Field label="Blurb" hint="One line shown on the lobby card.">
          <input value={draft.blurb} onChange={(e) => edit((d) => (d.blurb = e.target.value))} maxLength={400} />
        </Field>
        <div className="wf-ed-grid">
          <Field label="Entry scene">
            <select value={draft.graph.entryNodeId} onChange={(e) => editGraph((g) => (g.entryNodeId = e.target.value))}>
              {nodeIds.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </Field>
          <Field label="Max turns" hint={`Hard cap (1–${QUEST.MAX_TURNS_CEILING}).`}>
            <input type="number" min={1} max={QUEST.MAX_TURNS_CEILING} value={draft.graph.maxTurns} onChange={(e) => editGraph((g) => (g.maxTurns = clampNum(e.target.value, 1, QUEST.MAX_TURNS_CEILING)))} />
          </Field>
          <Field label="On timeout" hint="What hitting the turn cap with no goal met resolves to.">
            <select value={draft.graph.timeoutOutcome} onChange={(e) => editGraph((g) => (g.timeoutOutcome = e.target.value as QuestGraph['timeoutOutcome']))}>
              {QUEST_STATUSES.filter((s) => s !== 'active').map((s) => <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>)}
            </select>
          </Field>
        </div>
      </section>

      {/* --- scenes: the node graph (overview + navigation) + a focused editor for the selected scene --- */}
      <h3 className="wf-ed-h"><Icon name="location" size={15} /> Scenes <span className="wf-ed-h-count">{draft.graph.nodes.length}</span></h3>
      <SceneGraph
        graph={draft.graph}
        selectedId={selectedNode?.id ?? null}
        onSelect={selectById}
        onAddScene={addScene}
        onSetEntry={(id) => editGraph((g) => (g.entryNodeId = id))}
      />
      {selectedNode && (
        <NodeCard
          key={selectedIdx}
          node={selectedNode}
          index={selectedIdx}
          isEntry={selectedNode.id === draft.graph.entryNodeId}
          nodeIds={nodeIds}
          allEntities={allEntities}
          characters={characters}
          canRemove={draft.graph.nodes.length > 1}
          onChange={(fn) => editGraph((g) => fn(g.nodes[selectedIdx]!))}
          onRemove={() => removeScene(selectedIdx)}
        />
      )}

      {/* --- goals --- */}
      <h3 className="wf-ed-h"><Icon name="end" size={15} /> Goals <span className="hint">need at least one “win”</span></h3>
      {draft.graph.goals.map((goal, gi) => (
        <GoalCard
          key={gi}
          goal={goal}
          nodeIds={nodeIds}
          allEntities={allEntities}
          onChange={(fn) => editGraph((g) => fn(g.goals[gi]!))}
          onRemove={() => editGraph((g) => { g.goals.splice(gi, 1); })}
        />
      ))}
      <button className="btn ghost sm wf-ed-add" onClick={() => editGraph((g) => { g.goals.push(blankGoal()); })}>
        <Icon name="plus" size={14} /> Add goal
      </button>
    </div>
    </WiringContext.Provider>
  );
}

// --- node ------------------------------------------------------------------

function NodeCard({
  node, index, isEntry, nodeIds, allEntities, characters, canRemove, onChange, onRemove,
}: {
  node: QuestNode;
  index: number;
  isEntry: boolean;
  nodeIds: string[];
  allEntities: { id: string; label: string }[];
  characters: Character[];
  canRemove: boolean;
  onChange: (fn: (n: QuestNode) => void) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(true);
  const ents = node.entities.length;
  const affs = node.affordances.length;
  const routes = node.edges.length;
  const summary = `${ents} entit${ents === 1 ? 'y' : 'ies'} · ${affs} approach${affs === 1 ? '' : 'es'} · ${routes} route${routes === 1 ? '' : 's'}${node.isTerminal ? ' · ending scene' : ''}`;
  return (
    <section className={`card wf-ed-card wf-ed-node${isEntry ? ' wf-ed-node-entry' : ''}`}>
      <div className="wf-ed-rowhead">
        <button type="button" className="btn ghost sm wf-ed-collapse" onClick={() => setOpen((o) => !o)} title={open ? 'Collapse scene' : 'Expand scene'}>
          <span className="wf-ed-chev" style={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none' }}><Icon name="chevronRight" size={14} /></span>
        </button>
        <span className="wf-ed-scene-no" title={`Scene ${index + 1}`}>{index + 1}</span>
        <Field label="Scene id">
          <input title="A short identifier for this scene — routes and goals refer to it by this name." value={node.id} onChange={(e) => onChange((n) => (n.id = e.target.value))} />
        </Field>
        <Field label="Kind">
          <input title="A flavour tag for the narrator (e.g. scene, combat, social). Doesn't change the rules." value={node.kind} onChange={(e) => onChange((n) => (n.kind = e.target.value))} />
        </Field>
        {isEntry && <span className="wf-ed-entry" title="Play starts here">Entry</span>}
        <label className="wf-ed-check" title="Reaching this scene ends the quest (resolved) the moment the player routes into it — use it for an exit or ending scene. Most scenes are not endings.">
          <input type="checkbox" checked={node.isTerminal} onChange={(e) => onChange((n) => (n.isTerminal = e.target.checked))} /> Ending scene
        </label>
        {canRemove && <button className="btn danger sm" onClick={onRemove}><Icon name="trash" size={13} /></button>}
      </div>
      {!open && <div className="wf-ed-node-sum hint">{summary}</div>}
      {open && (<>
      <Field label="Setup" hint="The scene text shown to the player (display-only).">
        <textarea value={node.setup} rows={2} onChange={(e) => onChange((n) => (n.setup = e.target.value))} />
      </Field>

      {/* entities */}
      <div className="wf-ed-sub wf-ed-sub-cast">
        <div className="wf-ed-subhead"><Icon name="people" size={13} /> Cast <span className="hint">characters &amp; objects in this scene the player can affect</span></div>
        {node.entities.length > 0 && (
          <div className="wf-ed-castrow wf-ed-colhead">
            <span>id</span>
            <span>name</span>
            <span>side</span>
            <span title="how the character feels about the player">feeling</span>
            <span title="health (leave blank if not a combatant)">health</span>
            <span />
          </div>
        )}
        {node.entities.map((ent, ei) => (
          <div key={ei} className="wf-ed-ent">
            <div className="wf-ed-castrow">
              <input className="wf-ed-id" placeholder="id" value={ent.id} onChange={(e) => onChange((n) => (n.entities[ei]!.id = e.target.value))} />
              <input placeholder="name" value={ent.name} onChange={(e) => onChange((n) => (n.entities[ei]!.name = e.target.value))} />
              <select title="Whose side this character starts on. 'persuade' goals want them ally/party; 'defeat' goals target hostiles." value={ent.faction} onChange={(e) => onChange((n) => (n.entities[ei]!.faction = e.target.value as QuestNode['entities'][number]['faction']))}>
                {QUEST_FACTIONS.map((f) => <option key={f} value={f}>{FACTION_LABEL[f] ?? f}</option>)}
              </select>
              <input className="wf-ed-num" type="number" title="feeling toward the player (−100…100)" value={ent.disposition} onChange={(e) => onChange((n) => (n.entities[ei]!.disposition = clampNum(e.target.value, -100, 100)))} />
              <input className="wf-ed-num" type="number" title="health 0…100 (blank = none)" value={ent.hp ?? ''} placeholder="—" onChange={(e) => onChange((n) => (n.entities[ei]!.hp = e.target.value === '' ? undefined : clampNum(e.target.value, 0, QUEST.MAX_HP)))} />
              <button className="btn danger sm" onClick={() => onChange((n) => { n.entities.splice(ei, 1); })}><Icon name="trash" size={12} /></button>
            </div>
            <input
              className="wf-ed-ent-desc"
              placeholder="what this is — e.g. “young barista, neurotic and high-strung” or “a battered strongbox, rusted shut” (for the narrator)"
              title="A short description the narrator uses to portray this character or object. Not shown to the player verbatim — it just colours how it’s written."
              maxLength={500}
              value={ent.description ?? ''}
              onChange={(e) => onChange((n) => (n.entities[ei]!.description = e.target.value))}
            />
          </div>
        ))}
        <button className="btn ghost sm wf-ed-add" onClick={() => onChange((n) => { n.entities.push({ id: `e${n.entities.length + 1}`, name: '', description: '', faction: 'neutral', disposition: 0 }); })}>
          <Icon name="plus" size={12} /> Add to cast
        </button>
      </div>

      {/* affordances */}
      <div className="wf-ed-sub wf-ed-sub-app">
        <div className="wf-ed-subhead"><Icon name="quest" size={13} /> Approaches <span className="hint">what the player can try here — and what each result does</span></div>
        <p className="wf-ed-explain">
          When the player tries an approach, the game rolls their <strong>stat</strong> against its <strong>difficulty</strong> — a higher stat or easier difficulty means better odds. The roll lands on one of the four outcomes (success → complication), and that outcome’s effects fire.
        </p>
        {node.affordances.map((aff, ai) => (
          <AffordanceCard
            key={ai}
            aff={aff}
            entities={node.entities}
            nodeIds={nodeIds}
            characters={characters}
            onChange={(fn) => onChange((n) => fn(n.affordances[ai]!))}
            onRemove={() => onChange((n) => { n.affordances.splice(ai, 1); })}
          />
        ))}
        <button className="btn ghost sm wf-ed-add" onClick={() => onChange((n) => { n.affordances.push(blankAffordance()); })}>
          <Icon name="plus" size={12} /> Add approach
        </button>
      </div>

      {/* edges */}
      <div className="wf-ed-sub wf-ed-sub-routes">
        <div className="wf-ed-subhead"><Icon name="send" size={13} /> Routes <span className="hint">jump to another scene when a condition holds</span></div>
        {node.edges.map((edge, gi) => (
          <div key={gi} className="wf-ed-line wf-ed-edge">
            <span className="wf-ed-when">when</span>
            <PredicateRow predicate={edge.when} nodeIds={nodeIds} allEntities={allEntities} onChange={(fn) => onChange((n) => fn(n.edges[gi]!.when))} />
            <span className="wf-ed-when">→</span>
            <select value={edge.to} onChange={(e) => onChange((n) => (n.edges[gi]!.to = e.target.value))}>
              {nodeIds.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
            <button className="btn danger sm" onClick={() => onChange((n) => { n.edges.splice(gi, 1); })}><Icon name="trash" size={12} /></button>
          </div>
        ))}
        <button className="btn ghost sm wf-ed-add" onClick={() => onChange((n) => { n.edges.push({ when: { kind: 'flag', flag: '' }, to: nodeIds[0]! }); })}>
          <Icon name="plus" size={12} /> Add route
        </button>
      </div>
      </>)}
    </section>
  );
}

// --- affordance ------------------------------------------------------------

function AffordanceCard({
  aff, entities, nodeIds, characters, onChange, onRemove,
}: {
  aff: NodeAffordance;
  entities: QuestNode['entities'];
  nodeIds: string[];
  characters: Character[];
  onChange: (fn: (a: NodeAffordance) => void) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(true);
  const noSuccess = aff.effects.success.length === 0;
  const { checkers } = useContext(WiringContext);
  // Flags this approach SETS — the trace line shows what reads each of them.
  const setFlags = useMemo(() => {
    const out = new Set<string>();
    for (const g of GRADES) for (const e of aff.effects[g]) if (e.op === 'setFlag' && e.flag?.trim()) out.add(e.flag.trim());
    return [...out];
  }, [aff]);
  return (
    <div className="card wf-ed-aff">
      {/* Header reads as a sentence: “[verb] tests [stat] · [difficulty]”, with a row
          of dots showing which outcomes actually do something. */}
      <div className="wf-ed-aff-head">
        <button type="button" className="btn ghost sm wf-ed-collapse" onClick={() => setOpen((o) => !o)} title={open ? 'Collapse approach' : 'Expand approach'}>
          <span className="wf-ed-chev" style={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none' }}><Icon name="chevronRight" size={13} /></span>
        </button>
        <select className="wf-ed-aff-verb" title="What kind of action this is (talk, sneak, fight…). Mostly flavour for the narrator — the stat and difficulty set the actual odds." value={aff.verb} onChange={(e) => onChange((a) => (a.verb = e.target.value as NodeAffordance['verb']))}>
          {QUEST_VERBS.filter((v) => v !== 'noop').map((v) => <option key={v} value={v}>{VERB_LABEL[v] ?? v}</option>)}
        </select>
        <span className="wf-ed-aff-sep" title="the check rolls this player stat against the difficulty">tests</span>
        <select title="The player's own character stat this check rolls against (charm, empathy, grit, wits…). Higher = better odds." value={aff.stat} onChange={(e) => onChange((a) => (a.stat = e.target.value))}>
          {STAT_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="wf-ed-aff-sep">·</span>
        <select title="Base success chance before the stat shifts it ±25%: Trivial ~90%, Normal ~65%, Hard ~40%, Desperate ~20%. Harder approaches also unlock bigger effects (side-switch, money, ending)." value={aff.difficulty} onChange={(e) => onChange((a) => (a.difficulty = e.target.value as NodeAffordance['difficulty']))}>
          {DIFFICULTY_BANDS.map((b) => <option key={b} value={b}>{DIFFICULTY_LABEL[b] ?? b}</option>)}
        </select>
        <span className="wf-ed-aff-dots" title="which outcomes do something">
          {GRADES.map((g) => (
            <span key={g} className={`wf-ed-dot wf-grade-${g}${aff.effects[g].length ? ' on' : ''}`} title={`${GRADE_LABEL[g]}: ${aff.effects[g].length || 'nothing'}`} />
          ))}
        </span>
        <button className="btn danger sm" onClick={onRemove}><Icon name="trash" size={12} /></button>
      </div>
      {open && (<>
        <input className="wf-ed-hint" placeholder="hint — what the player might try (shown to them)" value={aff.hint} onChange={(e) => onChange((a) => (a.hint = e.target.value))} />
        {noSuccess && (
          <div className="wf-ed-prob warn"><Icon name="info" size={12} /> Nothing happens on success — the player can’t make progress this way.</div>
        )}
        <div className="wf-ed-outcomes">
          {GRADES.map((grade) => (
            <div key={grade} className={`wf-ed-grade-block wf-gl-${grade}`}>
              <div className={`wf-ed-grade-tag wf-grade-${grade}`}>
                <strong>{GRADE_LABEL[grade]}</strong>
                <em>{GRADE_GLOSS[grade]}</em>
              </div>
              <div className="wf-ed-grade-effects">
                {aff.effects[grade].length === 0 && <span className="wf-ed-grade-none">— nothing —</span>}
                {aff.effects[grade].map((eff, fi) => (
                  <EffectRow
                    key={fi}
                    effect={eff}
                    band={aff.difficulty}
                    entities={entities}
                    nodeIds={nodeIds}
                    characters={characters}
                    onChange={(fn) => onChange((a) => fn(a.effects[grade][fi]!))}
                    onRemove={() => onChange((a) => { a.effects[grade].splice(fi, 1); })}
                  />
                ))}
                <button className="btn ghost sm wf-ed-addeff" onClick={() => onChange((a) => { a.effects[grade].push({ op: 'setFlag', flag: '' }); })}>
                  <Icon name="plus" size={11} /> effect
                </button>
              </div>
            </div>
          ))}
        </div>
        {setFlags.length > 0 && (
          <div className="wf-ed-trace">
            <Icon name="info" size={11} />
            <span className="wf-ed-trace-lead">sets</span>
            {setFlags.map((f) => {
              const reads = checkers.get(f) ?? [];
              return (
                <span
                  key={f}
                  className={`wf-ed-trace-item${reads.length ? '' : ' dangling'}`}
                  title={reads.length ? `Checked by: ${reads.join('; ')}` : 'No route or goal checks this flag yet'}
                >
                  <code>{f}</code> {reads.length ? `→ ${reads.join(', ')}` : '→ unused'}
                </span>
              );
            })}
          </div>
        )}
      </>)}
    </div>
  );
}

// --- one effect row --------------------------------------------------------

function EffectRow({
  effect, band, entities, nodeIds, characters, onChange, onRemove,
}: {
  effect: Effect;
  band: DifficultyBand;
  entities: QuestNode['entities'];
  nodeIds: string[];
  characters: Character[];
  onChange: (fn: (e: Effect) => void) => void;
  onRemove: () => void;
}) {
  const num = (v: string) => (v === '' ? 0 : Number(v));
  const tier = effectTier(effect);
  const fires = tierUnlockedBy(band).has(tier);
  const incomplete = effectIncomplete(effect);
  return (
    <div className={`wf-ed-eff-wrap${incomplete ? ' bad' : !fires ? ' off' : ''}`}>
      <div className="wf-ed-line wf-ed-eff">
        <select value={effect.op} onChange={(e) => onChange((x) => (x.op = e.target.value as Effect['op']))}>
          {EFFECT_OPS.map((op) => <option key={op} value={op}>{EFFECT_OP_LABEL[op] ?? op}</option>)}
        </select>

        {(effect.op === 'setFlag' || effect.op === 'clearFlag') && (
          <FlagInput value={effect.flag ?? ''} onChange={(v) => onChange((x) => (x.flag = v))} />
        )}

        {effect.op === 'moveEntityToFaction' && (
          <>
            <EntitySelect entities={entities} value={effect.entityId} onChange={(v) => onChange((x) => (x.entityId = v))} />
            <select value={effect.faction ?? 'neutral'} onChange={(e) => onChange((x) => (x.faction = e.target.value as Effect['faction']))}>
              {QUEST_FACTIONS.map((f) => <option key={f} value={f}>{FACTION_LABEL[f] ?? f}</option>)}
            </select>
          </>
        )}

        {effect.op === 'adjustWarmth' && (
          <>
            <select title="dated character this closeness routes to" value={effect.characterId ?? ''} onChange={(e) => onChange((x) => (x.characterId = e.target.value))}>
              <option value="">— character —</option>
              {characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input className="wf-ed-num" type="number" title="amount (+ closer / − strained)" value={effect.delta ?? 0} onChange={(e) => onChange((x) => (x.delta = num(e.target.value)))} />
          </>
        )}

        {effect.op === 'adjustStat' && (
          <>
            <select title="who it changes" value={effect.entityId ?? ''} onChange={(e) => onChange((x) => (x.entityId = e.target.value || undefined))}>
              <option value="">(player)</option>
              {entities.map((en) => <option key={en.id} value={en.id}>{en.name || en.id}</option>)}
            </select>
            <input className="wf-ed-key" placeholder={effect.entityId ? 'hp / disposition' : 'stat'} value={effect.key ?? ''} onChange={(e) => onChange((x) => (x.key = e.target.value))} />
            <input className="wf-ed-num" type="number" title="amount (+/−)" value={effect.delta ?? 0} onChange={(e) => onChange((x) => (x.delta = num(e.target.value)))} />
          </>
        )}

        {(effect.op === 'grantItem' || effect.op === 'removeItem') && (
          <>
            <input placeholder="item id" value={effect.itemId ?? ''} onChange={(e) => onChange((x) => (x.itemId = e.target.value))} />
            <input className="wf-ed-num" type="number" title="quantity" value={effect.qty ?? 1} onChange={(e) => onChange((x) => (x.qty = clampNum(e.target.value, 1, 5)))} />
          </>
        )}

        {effect.op === 'addMoney' && (
          <input className="wf-ed-num" type="number" title={`amount (≤ ${QUEST.MONEY_DELTA_MAX})`} value={effect.amount ?? 0} onChange={(e) => onChange((x) => (x.amount = clampNum(e.target.value, 0, QUEST.MONEY_DELTA_MAX)))} />
        )}

        {effect.op === 'moveToNode' && (
          <select value={effect.nodeId ?? ''} onChange={(e) => onChange((x) => (x.nodeId = e.target.value))}>
            <option value="">— scene —</option>
            {nodeIds.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        )}

        {effect.op === 'endScene' && (
          <select value={effect.status ?? 'resolved'} onChange={(e) => onChange((x) => (x.status = e.target.value as Effect['status']))}>
            {QUEST_STATUSES.filter((s) => s !== 'active').map((s) => <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>)}
          </select>
        )}

        {!fires && (
          <span className="wf-ed-eff-warn" title={`Too big to fire on a “${DIFFICULTY_LABEL[band] ?? band}” approach (${TIER_LABEL[tier]} effect) — raise the difficulty or use a smaller effect`}>
            <Icon name="warn" size={10} /> won’t fire
          </span>
        )}
        <button className="btn danger sm" onClick={onRemove}><Icon name="trash" size={11} /></button>
      </div>
      <div className="wf-ed-eff-hint hint">{EFFECT_OP_HINT[effect.op]}</div>
    </div>
  );
}

function EntitySelect({ entities, value, onChange }: { entities: QuestNode['entities']; value?: string; onChange: (v: string) => void }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">— entity —</option>
      {entities.map((en) => <option key={en.id} value={en.id}>{en.name || en.id}</option>)}
    </select>
  );
}

// --- goal ------------------------------------------------------------------

function GoalCard({
  goal, nodeIds, allEntities, onChange, onRemove,
}: {
  goal: QuestGoal;
  nodeIds: string[];
  allEntities: { id: string; label: string }[];
  onChange: (fn: (g: QuestGoal) => void) => void;
  onRemove: () => void;
}) {
  return (
    <section className={`card wf-ed-card wf-ed-goal wf-goal-${goal.outcome}`}>
      <div className="wf-ed-line">
        <select
          title="the kind of ending — pre-fills a matching condition you can then tweak"
          value={goal.kind}
          onChange={(e) => onChange((g) => {
            g.kind = e.target.value as QuestGoal['kind'];
            g.predicate = predicateForKind(g.kind);
          })}
        >
          {GOAL_KINDS.map((k) => <option key={k} value={k}>{GOAL_KIND_LABEL[k] ?? k}</option>)}
        </select>
        <select title="does meeting this win or lose the quest?" value={goal.outcome} onChange={(e) => onChange((g) => (g.outcome = e.target.value as QuestGoal['outcome']))}>
          {GOAL_OUTCOMES.map((o) => <option key={o} value={o}>{o === 'win' ? 'Win' : 'Lose'}</option>)}
        </select>
        <input placeholder="label (shown to the player)" value={goal.label} onChange={(e) => onChange((g) => (g.label = e.target.value))} />
        <button className="btn danger sm" onClick={onRemove}><Icon name="trash" size={12} /></button>
      </div>
      <div className="wf-ed-line">
        <span className="wf-ed-when">met when</span>
        <PredicateRow predicate={goal.predicate} nodeIds={nodeIds} allEntities={allEntities} onChange={(fn) => onChange((g) => fn(g.predicate))} />
      </div>
    </section>
  );
}

// --- predicate -------------------------------------------------------------

function PredicateRow({
  predicate, nodeIds, allEntities, onChange,
}: {
  predicate: StatePredicate;
  nodeIds: string[];
  allEntities: { id: string; label: string }[];
  onChange: (fn: (p: StatePredicate) => void) => void;
}) {
  const num = (v: string) => (v === '' ? 0 : Number(v));
  return (
    <span className="wf-ed-pred">
      <select value={predicate.kind} onChange={(e) => onChange((p) => (p.kind = e.target.value as StatePredicate['kind']))}>
        {PREDICATE_KINDS.map((k) => <option key={k} value={k}>{PREDICATE_LABEL[k] ?? k}</option>)}
      </select>

      {predicate.kind === 'flag' && (
        <>
          <FlagInput value={predicate.flag ?? ''} onChange={(v) => onChange((p) => (p.flag = v))} />
          <label className="wf-ed-check"><input type="checkbox" checked={!!predicate.negate} onChange={(e) => onChange((p) => (p.negate = e.target.checked))} /> not</label>
        </>
      )}
      {predicate.kind === 'atNode' && (
        <select value={predicate.nodeId ?? ''} onChange={(e) => onChange((p) => (p.nodeId = e.target.value))}>
          <option value="">— scene —</option>
          {nodeIds.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      )}
      {predicate.kind === 'turnGte' && (
        <input className="wf-ed-num" type="number" placeholder="turn" value={predicate.value ?? 0} onChange={(e) => onChange((p) => (p.value = num(e.target.value)))} />
      )}
      {predicate.kind === 'hasItem' && (
        <>
          <input placeholder="itemId" value={predicate.itemId ?? ''} onChange={(e) => onChange((p) => (p.itemId = e.target.value))} />
          <input className="wf-ed-num" type="number" title="qty" value={predicate.value ?? 1} onChange={(e) => onChange((p) => (p.value = num(e.target.value)))} />
        </>
      )}
      {predicate.kind === 'entityFaction' && (
        <>
          <PredEntity allEntities={allEntities} value={predicate.entityId} onChange={(v) => onChange((p) => (p.entityId = v))} />
          <select value={predicate.faction ?? 'ally'} onChange={(e) => onChange((p) => (p.faction = e.target.value as StatePredicate['faction']))}>
            {QUEST_FACTIONS.map((f) => <option key={f} value={f}>{FACTION_LABEL[f] ?? f}</option>)}
          </select>
        </>
      )}
      {(predicate.kind === 'entityHp' || predicate.kind === 'entityDisposition') && (
        <>
          <PredEntity allEntities={allEntities} value={predicate.entityId} onChange={(v) => onChange((p) => (p.entityId = v))} />
          <select value={predicate.op ?? 'gte'} onChange={(e) => onChange((p) => (p.op = e.target.value as StatePredicate['op']))}>
            <option value="gte">≥</option>
            <option value="lte">≤</option>
          </select>
          <input className="wf-ed-num" type="number" value={predicate.value ?? 0} onChange={(e) => onChange((p) => (p.value = num(e.target.value)))} />
        </>
      )}
    </span>
  );
}

function PredEntity({ allEntities, value, onChange }: { allEntities: { id: string; label: string }[]; value?: string; onChange: (v: string) => void }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">— entity —</option>
      {allEntities.map((en) => <option key={en.id} value={en.id}>{en.label}</option>)}
    </select>
  );
}

// --- blanks + helpers ------------------------------------------------------

/** Mirror clampEffect's null-cases: does this effect lack a required operand (so the
 *  referee would silently DROP it)? Drives the red "incomplete" outline in the editor. */
function effectIncomplete(e: Effect): boolean {
  switch (e.op) {
    case 'setFlag':
    case 'clearFlag': return !e.flag;
    case 'moveEntityToFaction': return !e.entityId || !e.faction;
    case 'adjustWarmth': return !e.characterId || !e.delta;
    case 'adjustStat': return !e.key || !e.delta;
    case 'grantItem':
    case 'removeItem': return !e.itemId;
    case 'addMoney': return !e.amount;
    case 'moveToNode': return !e.nodeId;
    default: return false; // endScene is always complete
  }
}

/** The predicate shape a goal KIND implies, so picking a kind pre-fills a matching,
 *  still-editable predicate instead of leaving two unrelated fields (plan §5.4.1). */
function predicateForKind(kind: GoalKind): StatePredicate {
  switch (kind) {
    case 'defeat': return { kind: 'entityHp', op: 'lte', value: 0 };
    case 'persuade': return { kind: 'entityFaction', faction: 'ally' };
    case 'acquire': return { kind: 'hasItem', value: 1 };
    case 'reach': return { kind: 'atNode' };
    case 'survive': return { kind: 'turnGte', value: 3 };
    default: return { kind: 'flag', flag: '' };
  }
}

/** Every flag a success/partial/fail/complication effect SETS — for the flag picker
 *  and the "a goal checks a flag nothing sets" warning. */
function flagsSetIn(graph: QuestGraph): string[] {
  const out = new Set<string>();
  for (const n of graph.nodes)
    for (const a of n.affordances)
      for (const grade of GRADES)
        for (const e of a.effects[grade]) if (e.op === 'setFlag' && e.flag) out.add(e.flag);
  return [...out];
}

interface Problem {
  text: string;
  blocking: boolean;
}

/** Pre-save validation surfaced inline. Delegates the graph coherence checks to the
 *  SHARED {@link lintQuestGraph} (the same one the generator's repair loop uses), so the
 *  editor, the generation pipeline, and the referee's notion of "winnable" never drift.
 *  The server's safeGraph + boundQuestGraph still own the real boundary; this turns the
 *  eventual problem into live guidance. Only the quest NAME (not part of the graph) is
 *  checked here. */
function validateDraft(draft: Draft): Problem[] {
  const problems: Problem[] = [];
  if (!draft.name.trim()) problems.push({ text: 'Give the adventure a name.', blocking: true });
  for (const p of lintQuestGraph(draft.graph, { partnerId: draft.partnerId }))
    problems.push({ text: p.message, blocking: p.severity === 'blocking' });
  return problems;
}

function blankNode(id: string): QuestNode {
  return { id, kind: 'scene', setup: '', entities: [], affordances: [blankAffordance()], edges: [], isTerminal: false };
}
function blankAffordance(): NodeAffordance {
  return { verb: 'persuade', stat: 'charm', difficulty: 'normal', hint: '', effects: { success: [], partial: [], fail: [], complication: [] } };
}
function blankGoal(): QuestGoal {
  return { id: `g${Math.floor(Math.random() * 1e6)}`, kind: 'flag', outcome: 'win', label: '', predicate: { kind: 'flag', flag: '' } };
}
function clampNum(v: string, lo: number, hi: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
