import { describe, expect, it, beforeEach } from 'vitest';
import { selectDockOffsetPx, useSolixStore } from './index.js';
import { RIGHT_DOCK_WIDTH_PX } from '../panels/dock.js';

/**
 * There are now two independent things on screen, and keeping them separate
 * is the point of this file.
 *
 * A **surface** is somewhere you work — Mission Control, Maestro, Share,
 * Fleet — and takes the whole main area. A **dock** is a panel about
 * something you clicked in the scene, plus the decision queue, and floats
 * beside it. They used to share one mutually-exclusive `activePanel`, which
 * meant opening Fleet closed the agent you were reading, and Fleet's six
 * sections had to fit in 480px.
 *
 * The Decision Queue is positioned from a width offset, so a wrong offset
 * can leave a pending permission underneath something. Permission requests
 * are what unblock stuck agents, which is why that is tested rather than
 * eyeballed.
 */
const s = () => useSolixStore.getState();

beforeEach(() => {
  useSolixStore.setState({
    activePanel: null,
    workspaceSurface: null,
    selectedSessionId: null,
    selectedAdvisorId: null,
    selectedSkillId: null,
  });
});

describe('right dock exclusivity', () => {
  it('opening any dock panel closes every other', () => {
    s().openPanel('decisions');
    expect(s().activePanel).toBe('decisions');

    s().selectSession('sess-1');
    expect(s().activePanel).toBe('session');
    expect(s().selectedSessionId).toBe('sess-1');

    s().selectAdvisor('adv-1');
    expect(s().activePanel).toBe('advisor');
    // The selection must be cleared, not merely covered.
    expect(s().selectedSessionId).toBeNull();

    s().selectSkill('skill-1');
    expect(s().activePanel).toBe('skill');
    expect(s().selectedAdvisorId).toBeNull();
    expect(s().selectedSkillId).toBe('skill-1');
  });

  it('never leaves two selections set at once', () => {
    for (const open of [
      () => s().selectSession('a'),
      () => s().selectAdvisor('b'),
      () => s().selectSkill('c'),
      () => s().openPanel('decisions'),
    ]) {
      open();
      const set = [
        s().selectedSessionId,
        s().selectedAdvisorId,
        s().selectedSkillId,
      ].filter(Boolean);
      expect(set.length).toBeLessThanOrEqual(1);
    }
  });

  it('clearing a selection that is not on screen is a no-op', () => {
    s().openPanel('decisions');
    s().selectSession(null);
    expect(s().activePanel).toBe('decisions');
    s().selectAdvisor(null);
    s().selectSkill(null);
    expect(s().activePanel).toBe('decisions');
  });

  it('clearing the selection that IS on screen closes the dock', () => {
    s().selectSession('sess-1');
    s().selectSession(null);
    expect(s().activePanel).toBeNull();
    expect(s().selectedSessionId).toBeNull();
  });
});

describe('workspace surfaces', () => {
  it('are mutually exclusive with each other', () => {
    s().openSurface({ kind: 'plan' });
    expect(s().workspaceSurface).toEqual({ kind: 'plan' });
    s().openSurface({ kind: 'fleet', tab: 'routines' });
    expect(s().workspaceSurface).toEqual({ kind: 'fleet', tab: 'routines' });
    s().closeSurface();
    expect(s().workspaceSurface).toBeNull();
  });

  it('switching Fleet sections keeps you in Fleet', () => {
    s().openSurface({ kind: 'fleet', tab: 'crew' });
    s().openSurface({ kind: 'fleet', tab: 'orgs' });
    expect(s().workspaceSurface).toEqual({ kind: 'fleet', tab: 'orgs' });
  });

  /**
   * The whole reason surfaces exist. Under the old single `activePanel`,
   * opening Fleet closed the agent transcript you were reading, because one
   * field could only hold one thing. A dock is *about* something in the
   * scene; a surface is what the main area shows. They must coexist.
   */
  it('a dock panel stays open over a surface, and vice versa', () => {
    s().openSurface({ kind: 'fleet', tab: 'crew' });
    s().selectSession('sess-1');

    expect(s().workspaceSurface).toEqual({ kind: 'fleet', tab: 'crew' });
    expect(s().activePanel).toBe('session');
    expect(s().selectedSessionId).toBe('sess-1');

    // Closing one leaves the other exactly where it was.
    s().closePanel();
    expect(s().activePanel).toBeNull();
    expect(s().workspaceSurface).toEqual({ kind: 'fleet', tab: 'crew' });

    s().selectAdvisor('adv-1');
    s().closeSurface();
    expect(s().workspaceSurface).toBeNull();
    expect(s().activePanel).toBe('advisor');
  });

  it('the sun click and the P shortcut open surfaces, not docks', () => {
    s().openWorkspace();
    expect(s().workspaceSurface).toEqual({ kind: 'overview' });
    expect(s().activePanel).toBeNull();

    s().openPlanPanel();
    expect(s().workspaceSurface).toEqual({ kind: 'plan' });
  });

  it('closeWorkspace only closes Mission Control', () => {
    s().openSurface({ kind: 'fleet', tab: 'crew' });
    s().closeWorkspace();
    // Not Mission Control, so nothing happens — closing a surface the user
    // did not ask about would throw away their place.
    expect(s().workspaceSurface).toEqual({ kind: 'fleet', tab: 'crew' });

    s().openWorkspace();
    s().closeWorkspace();
    expect(s().workspaceSurface).toBeNull();
  });
});

describe('decision queue offset — B6 regression', () => {
  it('is the dock width iff a dock panel is open', () => {
    expect(selectDockOffsetPx(s())).toBe(0);
    // Every dock reports the SAME width. The old if-chain returned 460 for a
    // session and 420 for an advisor while the panel covering them was 480,
    // which is how the queue ended up mispositioned over a pending request.
    for (const open of [
      () => s().selectSession('a'),
      () => s().selectAdvisor('b'),
      () => s().selectSkill('c'),
      () => s().openPanel('decisions'),
    ]) {
      open();
      expect(selectDockOffsetPx(s())).toBe(RIGHT_DOCK_WIDTH_PX);
    }
    s().closePanel();
    expect(selectDockOffsetPx(s())).toBe(0);
  });

  // A surface fills the main area rather than sitting beside it, so it must
  // NOT shift anything that is positioned from the dock edge.
  it('a surface does not move the dock offset', () => {
    s().openSurface({ kind: 'fleet', tab: 'crew' });
    expect(selectDockOffsetPx(s())).toBe(0);
    s().selectSession('a');
    expect(selectDockOffsetPx(s())).toBe(RIGHT_DOCK_WIDTH_PX);
  });
});
