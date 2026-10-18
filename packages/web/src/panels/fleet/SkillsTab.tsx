import { useState } from 'react';
import { useSolixStore } from '../../store/index.js';
import { Button } from '../../ui/Button.js';

/**
 * Skills — the authoring half.
 *
 * The skill *detail* view stays contextual: it opens by clicking an asteroid in
 * the 3D belt, which is how you look at a skill in passing. What moves here is
 * authoring, which is configuration and was previously reached through a
 * '__new__' sentinel written into `selectedSkillId`.
 *
 * That sentinel is gone. It was a fake id in the same field that holds real
 * skill ids, so every reader had to special-case it, and a stale one left an
 * empty dock panel with its width still reserved and no way out but Escape.
 */
export function SkillsTab(): JSX.Element {
  const skills = useSolixStore((s) => s.skills);
  const selectSkill = useSolixStore((s) => s.selectSkill);

  const all = Object.values(skills);
  const userSkills = all.filter((s) => s.source === 'user');
  const builtIn = all.filter((s) => s.source !== 'user');

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">
          Your skills · {userSkills.length}
        </div>
        {userSkills.length === 0 ? (
          <div className="text-xs text-slate-500">
            None yet. Write one below.
          </div>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {userSkills.map((s) => (
              <button
                key={s.id}
                onClick={() => selectSkill(s.id)}
                className="w-full text-left rounded border border-solix-border bg-black/20 px-3 py-2 hover:bg-solix-border/20"
              >
                <div className="text-sm text-slate-100">{s.name}</div>
                <div className="text-[11px] text-slate-500 break-all">
                  {s.id}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {builtIn.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">
            Built in · {builtIn.length}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {builtIn.map((s) => (
              <button
                key={s.id}
                onClick={() => selectSkill(s.id)}
                className="px-2 py-1 rounded border border-solix-border text-[11px] text-slate-300 hover:bg-solix-border/30"
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-solix-border pt-4">
        <NewSkillForm />
      </div>
    </div>
  );
}

function NewSkillForm(): JSX.Element {
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
    const res = await createSkill({
      name: name.trim(),
      description: description.trim(),
      body,
    });
    setBusy(false);
    if (res.ok && res.id) {
      setName('');
      setDescription('');
      setBody('');
      // Opening the new skill's detail view closes Fleet, which is the right
      // outcome: you just made a thing and now you are looking at it.
      select(res.id);
    } else {
      setError(res.error ?? 'Could not create the skill.');
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">
        Author a skill
      </div>
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
        rows={10}
        className="w-full text-xs font-mono bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent resize-none"
      />
      {error && <div className="text-[11px] text-solix-danger">{error}</div>}
      <Button
        variant="primary"
        onClick={() => void onCreate()}
        disabled={!name.trim() || !body.trim()}
        busy={busy}
        busyLabel="Creating…"
      >
        Create skill
      </Button>
    </div>
  );
}
