import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  type Quest,
  type QuestGraph,
  type QuestNode,
  type NodeAffordance,
  type Effect,
  type StatePredicate,
  type QuestGoal,
  type OutcomeGrade,
  type Character,
  type QuestCreate,
  type QuestUpdate,
} from '@dsim/shared';
import { api } from '../../lib/api';
import { useAsync, errorMessage } from '../../lib/hooks';
import { Banner, Empty, Field, Loader, ConfirmDialog, Modal } from '../ui';
import { Icon } from '../Icon';

/**
 * The creator-mode quest authoring surface (the "Author" view of the Wayfarer tab).
 * A list of a world's authored quests + a full node-graph editor. The server
 * re-sanitises every saved graph through boundQuestGraph, so this UI is a
 * convenience over the schema, not the safety boundary.
 */

const GRADES: OutcomeGrade[] = ['success', 'partial', 'fail', 'complication'];
const STAT_OPTIONS = [...DATING_STAT_KEYS, 'grit', 'wits'] as const;
const PREDICATE_KINDS = ['flag', 'entityFaction', 'entityHp', 'entityDisposition', 'hasItem', 'atNode', 'turnGte', 'always'] as const;

interface Draft {
  id: string | null; // null = a brand-new quest
  name: string;
  blurb: string;
  partnerId: string | null;
  minWarmthBand: number;
  graph: QuestGraph;
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
  return (
    <article className="card wf-author-row">
      <div>
        <h3>{quest.name}</h3>
        <p className="hint">
          {quest.graph.nodes.length} scene{quest.graph.nodes.length === 1 ? '' : 's'} ·{' '}
          {quest.graph.goals.length} goal{quest.graph.goals.length === 1 ? '' : 's'}
          {quest.partnerId ? ' · partner-anchored' : ''}
        </p>
      </div>
      <div className="row">
        <button className="btn ghost sm" onClick={onEdit}>
          <Icon name="edit" size={14} /> Edit
        </button>
        <button className="btn danger sm" onClick={() => setConfirm(true)}>
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
        onDrafted({ id: null, name: res.data.name, blurb: res.data.blurb, partnerId: res.data.partnerId, minWarmthBand: res.data.minWarmthBand, graph: res.data.graph });
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
      <Field label="Your idea" hint="A scene, a goal, a problem to talk/fight/sneak your way through.">
        <textarea
          value={prompt}
          rows={3}
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

function QuestEditor({ worldId, draft: initial, onClose, onSaved }: { worldId: string; draft: Draft; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  void t;
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const chars = useAsync(() => api.listCharacters(worldId), [worldId]);
  const characters: Character[] = chars.data ?? [];

  /** Ergonomic nested-immutable update: clone, mutate, set. Graphs are small. */
  const edit = (fn: (d: Draft) => void) => setDraft((prev) => { const c = structuredClone(prev); fn(c); return c; });
  const editGraph = (fn: (g: QuestGraph) => void) => edit((d) => fn(d.graph));

  // Every entity across the graph (for goal/edge predicates that span scenes).
  const allEntities = useMemo(
    () => draft.graph.nodes.flatMap((n) => n.entities.map((e) => ({ id: e.id, label: `${e.name || e.id} (${n.id})` }))),
    [draft.graph],
  );
  const nodeIds = draft.graph.nodes.map((n) => n.id);

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

  return (
    <div className="wf-editor">
      <div className="wf-editor-head">
        <button className="btn ghost sm" onClick={onClose}>
          <Icon name="chevronRight" size={14} /> Back
        </button>
        <strong>{draft.id ? 'Edit adventure' : 'New adventure'}</strong>
        <button className="btn primary sm" onClick={save} disabled={saving || !draft.name.trim()}>
          <Icon name="save" size={14} /> {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

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
          <Field label="On timeout">
            <select value={draft.graph.timeoutOutcome} onChange={(e) => editGraph((g) => (g.timeoutOutcome = e.target.value as QuestGraph['timeoutOutcome']))}>
              {QUEST_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        </div>
      </section>

      {/* --- scenes (nodes) --- */}
      <h3 className="wf-ed-h">Scenes</h3>
      {draft.graph.nodes.map((node, ni) => (
        <NodeCard
          key={ni}
          node={node}
          nodeIds={nodeIds}
          allEntities={allEntities}
          characters={characters}
          canRemove={draft.graph.nodes.length > 1}
          onChange={(fn) => editGraph((g) => fn(g.nodes[ni]!))}
          onRemove={() => editGraph((g) => { g.nodes.splice(ni, 1); })}
        />
      ))}
      <button className="btn ghost sm" onClick={() => editGraph((g) => { g.nodes.push(blankNode(`scene${g.nodes.length + 1}`)); })}>
        <Icon name="plus" size={14} /> Add scene
      </button>

      {/* --- goals --- */}
      <h3 className="wf-ed-h">Goals <span className="hint">(need at least one “win”)</span></h3>
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
      <button className="btn ghost sm" onClick={() => editGraph((g) => { g.goals.push(blankGoal()); })}>
        <Icon name="plus" size={14} /> Add goal
      </button>
    </div>
  );
}

// --- node ------------------------------------------------------------------

function NodeCard({
  node, nodeIds, allEntities, characters, canRemove, onChange, onRemove,
}: {
  node: QuestNode;
  nodeIds: string[];
  allEntities: { id: string; label: string }[];
  characters: Character[];
  canRemove: boolean;
  onChange: (fn: (n: QuestNode) => void) => void;
  onRemove: () => void;
}) {
  return (
    <section className="card wf-ed-card wf-ed-node">
      <div className="wf-ed-rowhead">
        <Field label="Scene id">
          <input value={node.id} onChange={(e) => onChange((n) => (n.id = e.target.value))} />
        </Field>
        <Field label="Kind">
          <input value={node.kind} onChange={(e) => onChange((n) => (n.kind = e.target.value))} />
        </Field>
        <label className="wf-ed-check">
          <input type="checkbox" checked={node.isTerminal} onChange={(e) => onChange((n) => (n.isTerminal = e.target.checked))} /> Terminal
        </label>
        {canRemove && <button className="btn danger sm" onClick={onRemove}><Icon name="trash" size={13} /></button>}
      </div>
      <Field label="Setup" hint="The scene text shown to the player (display-only).">
        <textarea value={node.setup} rows={2} onChange={(e) => onChange((n) => (n.setup = e.target.value))} />
      </Field>

      {/* entities */}
      <div className="wf-ed-sub">
        <div className="wf-ed-subhead">Entities <span className="hint">the mutable “nouns” of the scene</span></div>
        {node.entities.map((ent, ei) => (
          <div key={ei} className="wf-ed-line">
            <input className="wf-ed-id" placeholder="id" value={ent.id} onChange={(e) => onChange((n) => (n.entities[ei]!.id = e.target.value))} />
            <input placeholder="name" value={ent.name} onChange={(e) => onChange((n) => (n.entities[ei]!.name = e.target.value))} />
            <select value={ent.faction} onChange={(e) => onChange((n) => (n.entities[ei]!.faction = e.target.value as QuestNode['entities'][number]['faction']))}>
              {QUEST_FACTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <input className="wf-ed-num" type="number" title="disposition" value={ent.disposition} onChange={(e) => onChange((n) => (n.entities[ei]!.disposition = clampNum(e.target.value, -100, 100)))} />
            <input className="wf-ed-num" type="number" title="hp (blank = none)" value={ent.hp ?? ''} placeholder="hp" onChange={(e) => onChange((n) => (n.entities[ei]!.hp = e.target.value === '' ? undefined : clampNum(e.target.value, 0, QUEST.MAX_HP)))} />
            <button className="btn danger sm" onClick={() => onChange((n) => { n.entities.splice(ei, 1); })}><Icon name="trash" size={12} /></button>
          </div>
        ))}
        <button className="btn ghost sm" onClick={() => onChange((n) => { n.entities.push({ id: `e${n.entities.length + 1}`, name: '', faction: 'neutral', disposition: 0 }); })}>
          <Icon name="plus" size={12} /> Add entity
        </button>
      </div>

      {/* affordances */}
      <div className="wf-ed-sub">
        <div className="wf-ed-subhead">Affordances <span className="hint">what's possible here, and what each outcome does</span></div>
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
        <button className="btn ghost sm" onClick={() => onChange((n) => { n.affordances.push(blankAffordance()); })}>
          <Icon name="plus" size={12} /> Add affordance
        </button>
      </div>

      {/* edges */}
      <div className="wf-ed-sub">
        <div className="wf-ed-subhead">Routing <span className="hint">move to another scene when a condition holds</span></div>
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
        <button className="btn ghost sm" onClick={() => onChange((n) => { n.edges.push({ when: { kind: 'flag', flag: '' }, to: nodeIds[0]! }); })}>
          <Icon name="plus" size={12} /> Add route
        </button>
      </div>
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
  return (
    <div className="card wf-ed-aff">
      <div className="wf-ed-line">
        <select value={aff.verb} onChange={(e) => onChange((a) => (a.verb = e.target.value as NodeAffordance['verb']))}>
          {QUEST_VERBS.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select title="tested stat" value={aff.stat} onChange={(e) => onChange((a) => (a.stat = e.target.value))}>
          {STAT_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select title="difficulty" value={aff.difficulty} onChange={(e) => onChange((a) => (a.difficulty = e.target.value as NodeAffordance['difficulty']))}>
          {DIFFICULTY_BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <button className="btn danger sm" onClick={onRemove}><Icon name="trash" size={12} /></button>
      </div>
      <input className="wf-ed-hint" placeholder="hint — “what you might try”" value={aff.hint} onChange={(e) => onChange((a) => (a.hint = e.target.value))} />
      {GRADES.map((grade) => (
        <div key={grade} className="wf-ed-grade-block">
          <div className={`wf-ed-grade-tag wf-grade-${grade}`}>{grade}</div>
          {aff.effects[grade].map((eff, fi) => (
            <EffectRow
              key={fi}
              effect={eff}
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
      ))}
    </div>
  );
}

// --- one effect row --------------------------------------------------------

function EffectRow({
  effect, entities, nodeIds, characters, onChange, onRemove,
}: {
  effect: Effect;
  entities: QuestNode['entities'];
  nodeIds: string[];
  characters: Character[];
  onChange: (fn: (e: Effect) => void) => void;
  onRemove: () => void;
}) {
  const num = (v: string) => (v === '' ? 0 : Number(v));
  return (
    <div className="wf-ed-line wf-ed-eff">
      <select value={effect.op} onChange={(e) => onChange((x) => (x.op = e.target.value as Effect['op']))}>
        {EFFECT_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
      </select>

      {(effect.op === 'setFlag' || effect.op === 'clearFlag') && (
        <input placeholder="flag" value={effect.flag ?? ''} onChange={(e) => onChange((x) => (x.flag = e.target.value))} />
      )}

      {effect.op === 'moveEntityToFaction' && (
        <>
          <EntitySelect entities={entities} value={effect.entityId} onChange={(v) => onChange((x) => (x.entityId = v))} />
          <select value={effect.faction ?? 'neutral'} onChange={(e) => onChange((x) => (x.faction = e.target.value as Effect['faction']))}>
            {QUEST_FACTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </>
      )}

      {effect.op === 'adjustWarmth' && (
        <>
          <select title="character" value={effect.characterId ?? ''} onChange={(e) => onChange((x) => (x.characterId = e.target.value))}>
            <option value="">— character —</option>
            {characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input className="wf-ed-num" type="number" title="delta" value={effect.delta ?? 0} onChange={(e) => onChange((x) => (x.delta = num(e.target.value)))} />
        </>
      )}

      {effect.op === 'adjustStat' && (
        <>
          <select title="target" value={effect.entityId ?? ''} onChange={(e) => onChange((x) => (x.entityId = e.target.value || undefined))}>
            <option value="">(player)</option>
            {entities.map((en) => <option key={en.id} value={en.id}>{en.name || en.id}</option>)}
          </select>
          <input className="wf-ed-key" placeholder={effect.entityId ? 'hp / disposition' : 'stat'} value={effect.key ?? ''} onChange={(e) => onChange((x) => (x.key = e.target.value))} />
          <input className="wf-ed-num" type="number" title="delta" value={effect.delta ?? 0} onChange={(e) => onChange((x) => (x.delta = num(e.target.value)))} />
        </>
      )}

      {(effect.op === 'grantItem' || effect.op === 'removeItem') && (
        <>
          <input placeholder="itemId" value={effect.itemId ?? ''} onChange={(e) => onChange((x) => (x.itemId = e.target.value))} />
          <input className="wf-ed-num" type="number" title="qty" value={effect.qty ?? 1} onChange={(e) => onChange((x) => (x.qty = clampNum(e.target.value, 1, 5)))} />
        </>
      )}

      {effect.op === 'addMoney' && (
        <input className="wf-ed-num" type="number" title="amount" value={effect.amount ?? 0} onChange={(e) => onChange((x) => (x.amount = clampNum(e.target.value, 0, QUEST.MONEY_DELTA_MAX)))} />
      )}

      {effect.op === 'moveToNode' && (
        <select value={effect.nodeId ?? ''} onChange={(e) => onChange((x) => (x.nodeId = e.target.value))}>
          <option value="">— scene —</option>
          {nodeIds.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      )}

      {effect.op === 'endScene' && (
        <select value={effect.status ?? 'resolved'} onChange={(e) => onChange((x) => (x.status = e.target.value as Effect['status']))}>
          {QUEST_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      )}

      <button className="btn danger sm" onClick={onRemove}><Icon name="trash" size={11} /></button>
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
    <section className="card wf-ed-card wf-ed-goal">
      <div className="wf-ed-line">
        <select title="kind" value={goal.kind} onChange={(e) => onChange((g) => (g.kind = e.target.value as QuestGoal['kind']))}>
          {GOAL_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select title="outcome" value={goal.outcome} onChange={(e) => onChange((g) => (g.outcome = e.target.value as QuestGoal['outcome']))}>
          {GOAL_OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <input placeholder="label (shown to player)" value={goal.label} onChange={(e) => onChange((g) => (g.label = e.target.value))} />
        <button className="btn danger sm" onClick={onRemove}><Icon name="trash" size={12} /></button>
      </div>
      <div className="wf-ed-line">
        <span className="wf-ed-when">when</span>
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
        {PREDICATE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>

      {predicate.kind === 'flag' && (
        <>
          <input placeholder="flag" value={predicate.flag ?? ''} onChange={(e) => onChange((p) => (p.flag = e.target.value))} />
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
            {QUEST_FACTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
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
