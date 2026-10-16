import { useEffect, useState } from 'react';
import { useSolixStore } from '../store/index.js';

interface SkillDetail {
  id: string;
  name: string;
  description: string;
  source: 'anthropic' | 'solix' | 'user';
  manifestPath: string;
  installedInProjects: string[];
  manifest: string;
}

interface SkillVersion {
  id: string;
  ordinal: number;
  name: string;
  createdAt: number;
}

/** Sentinel selectedSkillId that opens the "new skill" authoring form. */
export const NEW_SKILL_ID = '__new__';

/** Strip YAML frontmatter → the editable skill body. */
function bodyOf(manifest: string): string {
  const m = manifest.match(/^---\n[\s\S]*?\n---\n?/);
  return (m ? manifest.slice(m[0].length) : manifest).trim();
}

export function SkillPanel(): JSX.Element | null {
  const skillId = useSolixStore((s) => s.selectedSkillId);
  const skillSummary = useSolixStore((s) =>
    skillId && skillId !== NEW_SKILL_ID ? s.skills[skillId] : null,
  );
  const select = useSolixStore((s) => s.selectSkill);
  const advisors = useSolixStore((s) => s.advisors);

  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!skillId || skillId === NEW_SKILL_ID) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/skills/${encodeURIComponent(skillId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SkillDetail | null) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skillId]);

  if (skillId === NEW_SKILL_ID) {
    return <NewSkillForm onClose={() => select(null)} />;
  }
  if (!skillSummary) return null;

  const requiredBy = Object.values(advisors).filter((a) =>
    a.requiredSkills.some((rs) => skillSummary.id.endsWith(`:${rs}`) || skillSummary.id === rs),
  );
  const isUser = skillSummary.source === 'user';

  return (
    <div className="absolute top-16 right-0 bottom-0 w-[480px] bg-solix-panel border-l border-solix-border backdrop-blur-md flex flex-col z-20">
      <div className="px-4 py-3 border-b border-solix-border flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-cyan-300/70">
            Skill · {skillSummary.source}
          </div>
          <div className="text-lg font-semibold">{skillSummary.name}</div>
          <div className="text-xs text-slate-400 mt-0.5 break-all">
            {skillSummary.id}
          </div>
        </div>
        <button
          onClick={() => select(null)}
          className="text-slate-400 hover:text-slate-100"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {requiredBy.length > 0 && (
        <div className="px-4 py-2 border-b border-solix-border">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
            required by
          </div>
          <div className="flex flex-wrap gap-1.5">
            {requiredBy.map((a) => (
              <span
                key={a.id}
                className="text-[10px] px-1.5 py-0.5 rounded border border-amber-300/40 text-amber-200"
              >
                <span className="mr-1">{a.glyph}</span>
                {a.codename}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="px-4 py-3 border-b border-solix-border text-sm text-slate-300 leading-relaxed">
        {skillSummary.description}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading && <div className="text-sm text-slate-500 italic">Loading…</div>}
        {detail && isUser ? (
          <UserSkillEditor
            key={detail.id}
            id={detail.id}
            initialName={detail.name}
            initialDescription={detail.description}
            initialBody={bodyOf(detail.manifest)}
            onDeleted={() => select(null)}
          />
        ) : (
          detail && (
            <>
              <div className="text-[10px] uppercase tracking-wide text-slate-500">
                manifest
              </div>
              <pre className="text-[11px] text-slate-300 whitespace-pre-wrap break-words bg-black/40 p-3 rounded border border-solix-border">
                {detail.manifest}
              </pre>
            </>
          )
        )}
      </div>

      <div className="px-4 py-3 border-t border-solix-border text-xs text-slate-500">
        {skillSummary.installedInProjects.length === 0
          ? 'Not installed in any project yet.'
          : `Installed in ${skillSummary.installedInProjects.length} project(s).`}
      </div>
    </div>
  );
}

function NewSkillForm({ onClose }: { onClose: () => void }): JSX.Element {
  const createSkill = useSolixStore((s) => s.createSkill);
  const select = useSolixStore((s) => s.selectSkill);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onCreate = async (): Promise<void> => {
    if (!name.trim() || !body.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await createSkill({ name: name.trim(), description: description.trim(), body });
    setBusy(false);
    if (res.ok && res.id) select(res.id);
    else setError(res.error ?? 'Could not create the skill.');
  };

  return (
    <div className="absolute top-16 right-0 bottom-0 w-[480px] bg-solix-panel border-l border-solix-border backdrop-blur-md flex flex-col z-20">
      <div className="px-4 py-3 border-b border-solix-border flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-cyan-300/70">
            New skill
          </div>
          <div className="text-lg font-semibold">Author a skill</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100" aria-label="Close">
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Skill name"
          className="w-full text-sm bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One-line description"
          className="w-full text-xs bg-black/40 border border-solix-border rounded p-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Skill instructions (markdown)…"
          rows={12}
          className="w-full text-xs font-mono bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent resize-none"
        />
        {error && <div className="text-[11px] text-solix-danger">{error}</div>}
      </div>
      <div className="px-4 py-3 border-t border-solix-border">
        <button
          onClick={() => void onCreate()}
          disabled={busy || !name.trim() || !body.trim()}
          className="w-full py-2 rounded bg-amber-500/20 border border-amber-400/60 text-amber-100 text-sm hover:bg-amber-500/30 disabled:opacity-40"
        >
          {busy ? 'Creating…' : 'Create skill'}
        </button>
      </div>
    </div>
  );
}

function UserSkillEditor({
  id,
  initialName,
  initialDescription,
  initialBody,
  onDeleted,
}: {
  id: string;
  initialName: string;
  initialDescription: string;
  initialBody: string;
  onDeleted: () => void;
}): JSX.Element {
  const updateSkill = useSolixStore((s) => s.updateSkill);
  const deleteSkill = useSolixStore((s) => s.deleteSkill);
  const restoreSkillVersion = useSolixStore((s) => s.restoreSkillVersion);

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [body, setBody] = useState(initialBody);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [testInput, setTestInput] = useState('');
  const [composed, setComposed] = useState<string | null>(null);

  const loadVersions = (): void => {
    void fetch(`/api/skills/${encodeURIComponent(id)}/versions`)
      .then((r) => r.json())
      .then((v: SkillVersion[]) => setVersions(v))
      .catch(() => {});
  };
  useEffect(loadVersions, [id]);

  const onSave = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    const res = await updateSkill(id, { name, description, body });
    setBusy(false);
    setNote(res.ok ? 'Saved — a version was snapshotted.' : res.error ?? 'Save failed.');
    if (res.ok) loadVersions();
  };

  const onRestore = async (versionId: string): Promise<void> => {
    const res = await restoreSkillVersion(id, versionId);
    if (res.ok) {
      setNote('Restored. Reopen the skill to see the restored content.');
      loadVersions();
    }
  };

  const onCompose = async (): Promise<void> => {
    const res = await fetch(`/api/skills/${encodeURIComponent(id)}/compose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: testInput }),
    });
    const data = (await res.json().catch(() => ({}))) as { prompt?: string };
    setComposed(data.prompt ?? '');
  };

  const onDelete = async (): Promise<void> => {
    if (!window.confirm('Delete this skill and its version history?')) return;
    const res = await deleteSkill(id);
    if (res.ok) onDeleted();
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">Edit</div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full text-sm bg-black/40 border border-solix-border rounded p-2 text-slate-100 focus:outline-none focus:border-solix-accent"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full text-xs bg-black/40 border border-solix-border rounded p-2 text-slate-200 focus:outline-none focus:border-solix-accent"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          className="w-full text-xs font-mono bg-black/40 border border-solix-border rounded p-2 text-slate-100 focus:outline-none focus:border-solix-accent resize-none"
        />
        <div className="flex gap-2">
          <button
            onClick={() => void onSave()}
            disabled={busy}
            className="flex-1 py-1.5 rounded bg-amber-500/20 border border-amber-400/60 text-amber-100 text-xs hover:bg-amber-500/30 disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={() => void onDelete()}
            className="px-3 py-1.5 rounded bg-solix-danger/15 border border-solix-danger/60 text-solix-danger text-xs hover:bg-solix-danger/25"
          >
            Delete
          </button>
        </div>
        {note && <div className="text-[11px] text-slate-400">{note}</div>}
      </div>

      {versions.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">
            Versions
          </div>
          {versions.map((v) => (
            <div key={v.id} className="flex items-center gap-2 text-[11px]">
              <span className="text-slate-500">v{v.ordinal}</span>
              <span className="text-slate-400 flex-1 truncate">
                {new Date(v.createdAt).toLocaleString()}
              </span>
              <button
                onClick={() => void onRestore(v.id)}
                className="text-amber-300 hover:text-amber-200"
              >
                Restore
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">
          Test (dry run)
        </div>
        <div className="flex gap-2">
          <input
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
            placeholder="Sample input…"
            className="flex-1 text-xs bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
          />
          <button
            onClick={() => void onCompose()}
            className="px-3 rounded bg-black/30 border border-solix-border text-slate-300 text-xs hover:bg-black/50"
          >
            Compose
          </button>
        </div>
        {composed != null && (
          <pre className="text-[10px] text-slate-300 whitespace-pre-wrap break-words bg-black/40 p-2 rounded border border-solix-border max-h-48 overflow-auto">
            {composed}
          </pre>
        )}
      </div>
    </div>
  );
}
