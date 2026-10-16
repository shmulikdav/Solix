import { describe, it, expect } from 'vitest';
import type { PlanTask, PlanTaskStatus } from '@solix/shared';
import {
  computeNewlyBlocked,
  computePlanOutcome,
  computeReadyTasks,
  decideRetryOrEscalate,
  isBudgetExceeded,
  validatePlanGraph,
  withinParallelLimit,
  type SchedulableTask,
} from './scheduler.js';

// Tiny factory for a schedulable task.
function t(
  id: string,
  status: PlanTaskStatus,
  dependsOn: string[] = [],
  attempts = 0,
  maxAttempts = 3,
): SchedulableTask {
  return { id, status, dependsOn, attempts, maxAttempts };
}

describe('computeReadyTasks', () => {
  it('marks a no-dependency pending task ready', () => {
    expect(computeReadyTasks([t('a', 'pending')])).toEqual(['a']);
  });

  it('is ready only when every dependency is completed', () => {
    const tasks = [
      t('a', 'completed'),
      t('b', 'pending', ['a']),
      t('c', 'pending', ['a', 'd']),
      t('d', 'dispatched'),
    ];
    expect(computeReadyTasks(tasks)).toEqual(['b']); // c waits on d
  });

  it('never re-readies a task that is not pending', () => {
    expect(computeReadyTasks([t('a', 'completed'), t('b', 'ready', ['a'])])).toEqual(
      [],
    );
  });
});

describe('computeNewlyBlocked', () => {
  it('blocks a task whose dependency escalated/blocked/skipped', () => {
    const tasks = [
      t('a', 'escalated'),
      t('b', 'pending', ['a']),
      t('c', 'ready', ['b']),
    ];
    // b blocks on escalated a; c blocks on... b is still pending here, so only b.
    expect(computeNewlyBlocked(tasks)).toEqual(['b']);
  });

  it('does NOT block on a merely failed (retryable) dependency', () => {
    const tasks = [t('a', 'failed'), t('b', 'pending', ['a'])];
    expect(computeNewlyBlocked(tasks)).toEqual([]);
  });

  it('treats a dangling dependency id as unsatisfiable', () => {
    expect(computeNewlyBlocked([t('b', 'pending', ['ghost'])])).toEqual(['b']);
  });
});

describe('decideRetryOrEscalate', () => {
  it('retries while attempts remain', () => {
    expect(decideRetryOrEscalate({ attempts: 1, maxAttempts: 3 })).toBe('retry');
  });
  it('escalates once attempts hit the ceiling', () => {
    expect(decideRetryOrEscalate({ attempts: 3, maxAttempts: 3 })).toBe(
      'escalate',
    );
  });
});

describe('withinParallelLimit', () => {
  it('allows up to the limit and no more', () => {
    expect(withinParallelLimit(3, 4)).toBe(true);
    expect(withinParallelLimit(4, 4)).toBe(false);
  });
});

describe('isBudgetExceeded', () => {
  it('never trips without a budget', () => {
    expect(isBudgetExceeded(9999, undefined)).toBe(false);
  });
  it('trips at or over the cap, not under', () => {
    expect(isBudgetExceeded(0.99, 1)).toBe(false);
    expect(isBudgetExceeded(1, 1)).toBe(true);
    expect(isBudgetExceeded(1.5, 1)).toBe(true);
  });
});

describe('validatePlanGraph', () => {
  it('accepts a valid DAG', () => {
    const r = validatePlanGraph([
      t('a', 'pending'),
      t('b', 'pending', ['a']),
      t('c', 'pending', ['a', 'b']),
    ]);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects an unknown dependency id', () => {
    const r = validatePlanGraph([t('b', 'pending', ['ghost'])]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('unknown task ghost'))).toBe(true);
  });

  it('rejects a self-dependency', () => {
    const r = validatePlanGraph([t('a', 'pending', ['a'])]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('depends on itself'))).toBe(true);
  });

  it('detects a cycle', () => {
    const r = validatePlanGraph([
      t('a', 'pending', ['b']),
      t('b', 'pending', ['a']),
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('cycle'))).toBe(true);
  });
});

describe('computePlanOutcome', () => {
  const s = (status: PlanTaskStatus): Pick<PlanTask, 'status'> => ({ status });

  it('is running while any task is active (incl. transiently failed)', () => {
    expect(computePlanOutcome([s('completed'), s('failed')])).toBe('running');
    expect(computePlanOutcome([s('completed'), s('dispatched')])).toBe('running');
  });

  it('is completed when all tasks succeeded or were skipped', () => {
    expect(computePlanOutcome([s('completed'), s('skipped')])).toBe('completed');
  });

  it('is failed when settled with an escalated/blocked task', () => {
    expect(computePlanOutcome([s('completed'), s('escalated')])).toBe('failed');
    expect(computePlanOutcome([s('completed'), s('blocked')])).toBe('failed');
  });
});
