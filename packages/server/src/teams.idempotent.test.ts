import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests, type DB } from './db.js';
import { installTeamTemplate, TEAM_TEMPLATES } from './state/teams.js';
import { listSchedules } from './state/schedules.js';

/**
 * A team's routines are recurring spend: each one starts a real agent
 * session on a cadence and bills on every run.
 *
 * installTeamTemplate called createSchedule unconditionally for every
 * routine in the template, with no idempotency check and an identical
 * success toast both times — so a second click, which nothing discouraged
 * because nothing said the first had happened, left two enabled interval
 * routines running the same prompt forever at twice the cost.
 *
 * createSchedule already stamps `owner: template.id`, so recognising our own
 * work needed no new state.
 */
const WITH_ROUTINES = TEAM_TEMPLATES.find((t) => t.routines.length > 0);

describe('CLAIM-TEAMS-IDEMPOTENT · installing a team twice', () => {
  let db: DB;
  const cwd = '/tmp/team-project';

  beforeEach(() => {
    db = resetDbForTests();
  });

  it('has a template with routines to test against', () => {
    expect(WITH_ROUTINES).toBeTruthy();
  });

  it('creates its routines the first time', () => {
    const res = installTeamTemplate(db, WITH_ROUTINES!.id, { cwd });
    expect(res.ok).toBe(true);
    expect(res.routinesCreated.length).toBe(WITH_ROUTINES!.routines.length);
    expect(res.routinesAlreadyPresent).toHaveLength(0);
  });

  /** The bug, in one assertion: the row count must not double. */
  it('does not create them again', () => {
    installTeamTemplate(db, WITH_ROUTINES!.id, { cwd });
    const firstCount = listSchedules(db).length;

    const second = installTeamTemplate(db, WITH_ROUTINES!.id, { cwd });

    expect(listSchedules(db).length).toBe(firstCount);
    expect(second.routinesCreated).toHaveLength(0);
    expect(second.routinesAlreadyPresent.length).toBe(
      WITH_ROUTINES!.routines.length,
    );
  });

  it('says so, rather than reporting a silent success', () => {
    installTeamTemplate(db, WITH_ROUTINES!.id, { cwd });
    const second = installTeamTemplate(db, WITH_ROUTINES!.id, { cwd });
    expect(second.warnings.join(' ')).toMatch(/already installed/i);
  });

  /** A different project is a different install, and should get its own. */
  it('still installs into a second project', () => {
    installTeamTemplate(db, WITH_ROUTINES!.id, { cwd });
    const other = installTeamTemplate(db, WITH_ROUTINES!.id, {
      cwd: '/tmp/another-project',
    });
    expect(other.routinesCreated.length).toBe(WITH_ROUTINES!.routines.length);
  });

  it('still honours declining the routines', () => {
    const res = installTeamTemplate(db, WITH_ROUTINES!.id, {
      cwd,
      includeRoutines: false,
    });
    expect(res.routinesCreated).toHaveLength(0);
    expect(listSchedules(db)).toHaveLength(0);
  });
});
