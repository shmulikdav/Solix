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

  // N3/C7: the old bar had six unrelated colours and two different buttons
  // sharing amber for unrelated reasons. Navigation never costs anything, so
  // it carries no semantic colour — the rule followed the destinations from
  // the top bar into the rail.
  it('keeps navigation neutral', () => {
    const src = readFileSync(join(SRC, 'shell/NavRail.tsx'), 'utf8');
    // A destination may never be coloured for WHAT IT IS — "Fleet" is not a
    // warning. It may be coloured for live state: "three agents are blocked
    // on you" has to shout, and with Decisions behind a click the rail row is
    // the only in-app signal left. So warn is legal here only behind a count
    // check, exactly as accent is legal only behind an active check.
    const offenders = buttonTags(src)
      .filter(({ tag }) => /(bg|text|border)-solix-(warn|danger)\b/.test(tag))
      .filter(({ tag }) => !/(pending|attention)\s*>\s*0/.test(tag))
      .map(({ line }) => line);
    expect(offenders).toEqual([]);
  });

  // Accent in the rail means "this is where you are", not "this is the
  // important one" — so it may only appear behind an active check.
  it('uses accent in the rail only for the active destination', () => {
    const src = readFileSync(join(SRC, 'shell/NavRail.tsx'), 'utf8');
    for (const { line, tag } of buttonTags(src)) {
      if (!/solix-accent/.test(tag)) continue;
      const guarded =
        /active\s*\?/.test(tag) || /childActive\s*\?/.test(tag);
      expect(guarded, `NavRail.tsx:${line} uses accent unconditionally`).toBe(
        true,
      );
    }
  });

  // The strip that is left carries context and status, not destinations.
  it('keeps the top bar free of navigation buttons', () => {
    const src = readFileSync(join(SRC, 'hud/TopBar.tsx'), 'utf8');
    const openers = buttonTags(src).filter(({ tag }) =>
      /onOpen|openPanel|setViewMode/.test(tag),
    );
    expect(openers).toEqual([]);
  });

  // The specific inversion the audit found: the biggest spend in the product
  // wearing the colour that everywhere else means "free". Asserted on the
  // variant rather than a class string, because the whole point of Button is
  // that call sites no longer carry colours.
  it('does not paint a spend action with the free/ok colour', () => {
    const plan = readFileSync(join(SRC, 'panels/PlanPanel.tsx'), 'utf8');
    const at = plan.indexOf('Approve & run');
    expect(at).toBeGreaterThan(-1);
    const approveBlock = plan.slice(at - 400, at);
    expect(approveBlock).toContain('variant="warn"');
    expect(approveBlock).not.toContain('variant="ok"');
    expect(approveBlock).not.toContain('solix-ok');
  });

  it('states the consequence next to the approve-and-run button', () => {
    const plan = readFileSync(join(SRC, 'panels/PlanPanel.tsx'), 'utf8');
    expect(plan).toContain('one per task. Each run costs money');
  });

  // C1/C2: there were three project pickers and three cwd inputs with
  // near-identical class strings. Three implementations of one control is how
  // two of them end up behaving differently without anyone deciding they
  // should.
  it('has one project/cwd input, not three', () => {
    const offenders = files.filter(
      (f) =>
        !f.endsWith('ProjectPicker.tsx') &&
        /placeholder="\/path\/to\/project"/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => f.replace(SRC, ''))).toEqual([]);
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
