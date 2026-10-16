import { describe, it, expect } from 'vitest';
import {
  MAX_DELEGATION_DEPTH,
  MAX_SUBTASKS_PER_DELEGATION,
  delegationPromptNote,
  parseSubtaskProposal,
} from './delegation.js';

function block(json: string): string {
  return `some worker output\n<<<SOLIX_SUBTASKS\n${json}\nSOLIX_SUBTASKS>>>\ntrailing`;
}

describe('parseSubtaskProposal (P2 #8)', () => {
  it('returns nothing when there is no block', () => {
    expect(parseSubtaskProposal('just did the work').subtasks).toHaveLength(0);
  });

  it('parses a valid proposal and defaults acceptance criteria', () => {
    const { subtasks } = parseSubtaskProposal(
      block('[{"title":"A","prompt":"do a"},{"title":"B","prompt":"do b","acceptanceCriteria":"b done"}]'),
    );
    expect(subtasks).toHaveLength(2);
    expect(subtasks[0]).toMatchObject({ title: 'A', prompt: 'do a' });
    expect(subtasks[0]!.acceptanceCriteria).toBeTruthy(); // defaulted
    expect(subtasks[1]!.acceptanceCriteria).toBe('b done');
  });

  it('skips entries missing title/prompt but keeps valid ones', () => {
    const { subtasks, warnings } = parseSubtaskProposal(
      block('[{"title":"ok","prompt":"p"},{"title":"no prompt"},{"prompt":"no title"}]'),
    );
    expect(subtasks).toHaveLength(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('caps the number of subtasks', () => {
    const many = JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, prompt: 'p' })),
    );
    const { subtasks, warnings } = parseSubtaskProposal(block(many));
    expect(subtasks).toHaveLength(MAX_SUBTASKS_PER_DELEGATION);
    expect(warnings.some((w) => w.includes('capped'))).toBe(true);
  });

  it('ignores malformed JSON without throwing', () => {
    const { subtasks, warnings } = parseSubtaskProposal(block('{not json'));
    expect(subtasks).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('delegationPromptNote is present under the cap and empty at it', () => {
    expect(delegationPromptNote(0)).toContain('SOLIX_SUBTASKS');
    expect(delegationPromptNote(MAX_DELEGATION_DEPTH)).toBe('');
  });
});
