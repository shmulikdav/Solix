import type { Project } from '@solix/shared';

/**
 * Pick a project, or type a path.
 *
 * There were three of these: a <select> plus a cwd <input> in the plan panel,
 * the same pair in the team installer, and a chip row in the task modal — with
 * near-identical class strings and three different placeholder conventions for
 * the same field. Three implementations of one control is how two of them end
 * up behaving differently without anyone deciding they should.
 *
 * The plan panel distinguishes projects Solix created from ones it merely
 * observed running, so grouping is supported but optional.
 */
export function ProjectPicker({
  projects,
  value,
  onChange,
  groups,
  placeholder = 'Choose an existing project…',
  listId,
}: {
  /** Flat list, used when `groups` is not given. */
  projects?: Project[];
  value: string;
  onChange: (cwd: string) => void;
  /** Labelled groups, rendered as optgroups. Empty groups are skipped. */
  groups?: Array<{ label: string; projects: Project[] }>;
  placeholder?: string;
  /** When set, the text input also offers these paths as a datalist. */
  listId?: string;
}): JSX.Element {
  const resolved = groups ?? (projects?.length ? [{ label: '', projects }] : []);
  const nonEmpty = resolved.filter((g) => g.projects.length > 0);
  const all = nonEmpty.flatMap((g) => g.projects);

  return (
    <>
      {all.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) onChange(e.target.value);
          }}
          aria-label="Choose a project"
          className="w-full text-xs bg-black/40 border border-solix-border rounded p-2 text-slate-200 mb-2 focus:outline-none focus:border-solix-accent"
        >
          <option value="">{placeholder}</option>
          {nonEmpty.map((g) =>
            g.label ? (
              <optgroup key={g.label} label={g.label}>
                {g.projects.map((p) => (
                  <option key={p.id} value={p.cwd}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            ) : (
              g.projects.map((p) => (
                <option key={p.id} value={p.cwd}>
                  {p.name}
                </option>
              ))
            ),
          )}
        </select>
      )}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="/path/to/project"
        aria-label="Project path"
        {...(listId ? { list: listId } : {})}
        className="w-full text-xs font-mono bg-black/40 border border-solix-border rounded p-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
      />
      {listId && (
        <datalist id={listId}>
          {all.map((p) => (
            <option key={p.id} value={p.cwd} />
          ))}
        </datalist>
      )}
    </>
  );
}
