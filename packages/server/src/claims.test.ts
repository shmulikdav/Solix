import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The ledger is only worth having if it cannot drift from the tests.
 *
 * `docs/CLAIMS.md` lists every public promise and the test that holds it.
 * This checks the binding in both directions:
 *
 *   - a row with no test is a claim nobody is checking — the exact state
 *     that let six overclaims ship;
 *   - a `CLAIM-` id in a test that is not a row is a test whose purpose has
 *     gone undocumented, which is how the website came to describe
 *     `solix run` wrongly while this repo described it correctly.
 *
 * It also checks the row's stated holder really is where the id lives, so a
 * copied row cannot point at the wrong file.
 */
const ROOT = resolve(import.meta.dirname ?? __dirname, '..', '..', '..');
const LEDGER = join(ROOT, 'docs', 'CLAIMS.md');

interface Row {
  id: string;
  claim: string;
  publishedIn: string;
  heldBy: string;
}

/** Rows of the ledger table, which is the only table with a `CLAIM-` id. */
export function parseLedger(markdown: string): Row[] {
  const rows: Row[] = [];
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length !== 4) continue;
    const id = cells[0]!.replace(/`/g, '');
    if (!id.startsWith('CLAIM-')) continue;
    rows.push({
      id,
      claim: cells[1]!,
      publishedIn: cells[2]!,
      heldBy: cells[3]!.replace(/`/g, ''),
    });
  }
  return rows;
}

/** Every test file in the monorepo, so neither side can hide. */
function testFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      testFiles(full, found);
    } else if (/\.test\.(ts|tsx)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

describe('the claims ledger binds to the tests', () => {
  const ledger = parseLedger(readFileSync(LEDGER, 'utf8'));
  const files = testFiles(join(ROOT, 'packages'));
  const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

  it('parses a ledger that is actually populated', () => {
    // Guards against the parser silently matching nothing and every
    // assertion below passing over an empty list.
    expect(ledger.length).toBeGreaterThanOrEqual(10);
    expect(files.length).toBeGreaterThan(50);
  });

  it('every claim has a test that names it', () => {
    const unheld = ledger
      .filter(({ id }) => ![...sources.values()].some((s) => s.includes(id)))
      .map((r) => r.id);
    expect(
      unheld,
      `these claims are published with nothing checking them:\n  ${unheld.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every claim is held by the file the ledger names', () => {
    const misfiled: string[] = [];
    for (const row of ledger) {
      const path = join(ROOT, row.heldBy);
      const source = sources.get(path);
      if (!source || !source.includes(row.id)) {
        misfiled.push(`${row.id} → ${row.heldBy}`);
      }
    }
    expect(
      misfiled,
      `the ledger points at a file that does not contain the id:\n  ${misfiled.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every CLAIM- id used in a test is a row in the ledger', () => {
    const known = new Set(ledger.map((r) => r.id));
    const orphans = new Set<string>();
    for (const [, source] of sources) {
      for (const m of source.matchAll(/CLAIM-[A-Z0-9-]+/g)) {
        if (!known.has(m[0])) orphans.add(m[0]);
      }
    }
    expect(
      [...orphans],
      `these ids are asserted somewhere but documented nowhere:\n  ${[...orphans].join('\n  ')}`,
    ).toEqual([]);
  });

  it('every claim says where it is published, so it can be found and changed', () => {
    const vague = ledger
      .filter((r) => r.publishedIn.length < 4)
      .map((r) => r.id);
    expect(vague).toEqual([]);
  });

  it('no two rows share an id', () => {
    const ids = ledger.map((r) => r.id);
    expect(ids).toHaveLength(new Set(ids).size);
  });
});
