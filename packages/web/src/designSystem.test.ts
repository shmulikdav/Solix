import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The palette, enforced as source rules rather than as a convention.
 *
 * The audit found seven colour tokens defined and essentially ignored: the top
 * bar used six unrelated colours, two different buttons were both amber for
 * unrelated reasons, and "Approve & run" — which dispatches one agent per task
 * and is the largest spend in the product — was the same green as "this is
 * free". Colour carried no information.
 *
 * The rule now: `solix-warn` means "this spends money", `solix-danger` means
 * "this destroys or stops something", `solix-ok` means "free or succeeded",
 * `solix-accent` is the primary non-spending action, and navigation is
 * neutral. These tests keep raw Tailwind palette colours out of the panels so
 * a new button cannot quietly reintroduce a sixth meaning of amber.
 */

const SRC = new URL('.', import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const UI_DIRS = ['panels', 'hud'].map((d) => join(SRC, d));
const files = UI_DIRS.flatMap((d) => walk(d));

/**
 * Pull out every `<button …>` opening tag with its line number. A scan rather
 * than a regex over the whole file, so a colour inside ordinary status text is
 * not mistaken for a control's colour — `awaiting_approval` being amber is
 * meaningful and stays.
 */
function buttonTags(src: string): Array<{ line: number; tag: string }> {
  const out: Array<{ line: number; tag: string }> = [];
  for (let i = src.indexOf('<button'); i !== -1; i = src.indexOf('<button', i + 1)) {
    let depth = 0;
    let end = i;
    for (; end < src.length; end++) {
      const c = src[end];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push({
      line: src.slice(0, i).split('\n').length,
      tag: src.slice(i, end + 1),
    });
  }
  return out;
}

/** Raw Tailwind palette colours that duplicate a semantic token. */
const BANNED: Array<[RegExp, string]> = [
  [/\b(bg|text|border)-amber-\d{3}\b/, 'amber-* on a button duplicates solix-warn'],
  [/\b(bg|text|border)-emerald-\d{3}\b/, 'emerald-* on a button duplicates solix-ok'],
  [/\b(bg|text|border)-red-\d{3}\b/, 'red-* on a button duplicates solix-danger'],
  [/\b(bg|text|border)-cyan-\d{3}\b/, 'cyan-* on a button is a sixth unexplained colour'],
];

describe('design system — colour is semantic', () => {
  it('has UI files to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const [pattern, why] of BANNED) {
    it(`no ${why}`, () => {
      const offenders: string[] = [];
      for (const f of files) {
        for (const { line, tag } of buttonTags(readFileSync(f, 'utf8'))) {
          if (pattern.test(tag)) offenders.push(`${f.replace(SRC, '')}:${line}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  // N3/C7: the bar had six unrelated colours and two different buttons sharing
  // amber for unrelated reasons. Navigation never costs anything, so it is
  // neutral; the one coloured control is the primary action.
  it('keeps top-bar navigation neutral', () => {
    const src = readFileSync(join(SRC, 'hud/TopBar.tsx'), 'utf8');
    const coloured = buttonTags(src)
      .filter(({ tag }) => /(bg|text|border)-solix-(warn|ok|danger)\b/.test(tag))
      .map(({ line }) => line);
    expect(coloured).toEqual([]);
  });

  it('leaves exactly one accented control in the actions cluster', () => {
    const src = readFileSync(join(SRC, 'hud/TopBar.tsx'), 'utf8');
    // Only the persistent nav cluster. The left group's "exit playback" chip
    // is a transient mode indicator and is meant to stand out.
    const actions = src.slice(src.indexOf('data-topbar-actions'));
    const accented = buttonTags(actions).filter(({ tag }) =>
      /bg-solix-accent\//.test(tag),
    );
    // + Task. Opening a panel is never the thing worth highlighting.
    expect(accented).toHaveLength(1);
    expect(accented[0]!.tag).toContain('onNewTask');
  });

  // The specific inversion the audit found: the biggest spend in the product
  // wearing the colour that everywhere else means "free".
  it('does not paint a spend action with the free/ok colour', () => {
    const plan = readFileSync(join(SRC, 'panels/PlanPanel.tsx'), 'utf8');
    const approveBlock = plan.slice(
      plan.indexOf("'Approve & run'") - 600,
      plan.indexOf("'Approve & run'"),
    );
    expect(approveBlock).toContain('solix-warn');
    expect(approveBlock).not.toContain('solix-ok');
  });

  it('states the consequence next to the approve-and-run button', () => {
    const plan = readFileSync(join(SRC, 'panels/PlanPanel.tsx'), 'utf8');
    expect(plan).toContain('one per task. Each run costs money');
  });

  // C3: browser prompts are unstyled, look like the browser rather than the
  // app, and in two of the three cases fed an unvalidated string to parseFloat
  // or straight into a POST body.
  it('uses no window.prompt anywhere in the UI', () => {
    const offenders = files.filter((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .some((line) => {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) {
            return false;
          }
          return /window\.prompt\s*\(/.test(line);
        }),
    );
    expect(offenders).toEqual([]);
  });
});
