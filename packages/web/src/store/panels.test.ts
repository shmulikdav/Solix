import { describe, expect, it, beforeEach } from 'vitest';
import { selectDockOffsetPx, useSolixStore } from './index.js';
import { RIGHT_DOCK_WIDTH_PX } from '../panels/dock.js';

/**
 * The right dock used to be two uncoordinated systems: local useState in
 * App.tsx for Galaxy/Connections, and the store for the rest. Three panels
 * ended up with identical position AND z-index, so they stacked silently and
 * which one won was decided by DOM order.
 *
 * Worse, the Decision Queue is positioned purely by a width offset, shares
 * z-30 with the dock panels and renders before them — so when the offset
 * disagreed with the panel actually on screen, a pending permission request
 * could end up behind an opaque panel. Permission requests are what unblock
 * stuck agents, which is why this is tested rather than eyeballed.
 */
const s = () => useSolixStore.getState();

describe('right dock exclusivity', () => {
  beforeEach(() => {
    useSolixStore.setState({
      activePanel: null,
      activePanelTab: null,
      selectedSessionId: null,
      selectedAdvisorId: null,
      selectedSkillId: null,
    });
  });

  it('opening any panel closes every other', () => {
    s().openPanel('plan');
    expect(s().activePanel).toBe('plan');

    s().selectSession('sess-1');
    expect(s().activePanel).toBe('session');
    expect(s().selectedSessionId).toBe('sess-1');

    s().openPanel('galaxy');
    expect(s().activePanel).toBe('galaxy');
    // The selection must be cleared, not merely covered.
    expect(s().selectedSessionId).toBeNull();

    s().selectAdvisor('adv-1');
    expect(s().activePanel).toBe('advisor');
    expect(s().selectedAdvisorId).toBe('adv-1');

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
      () => s().openPanel('workspace'),
      () => s().openPanel('connections'),
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
    // Preserves the original behaviour: selectSession(null) deliberately did
    // NOT close the workspace or plan panel. Widening that would close panels
    // the user never asked to close.
    s().openPanel('plan');
    s().selectSession(null);
    expect(s().activePanel).toBe('plan');

    s().selectAdvisor(null);
    s().selectSkill(null);
    expect(s().activePanel).toBe('plan');
  });

  it('clearing the selection that IS on screen closes the dock', () => {
    s().selectSession('sess-1');
    s().selectSession(null);
    expect(s().activePanel).toBeNull();
    expect(s().selectedSessionId).toBeNull();
  });

  it('closePanel closes whatever is open', () => {
    for (const p of ['plan', 'galaxy', 'connections', 'workspace'] as const) {
      s().openPanel(p);
      s().closePanel();
      expect(s().activePanel).toBeNull();
    }
  });

  it('remembers a tab so reopening returns you where you were', () => {
    s().openPanel('connections', 'notifications');
    expect(s().activePanelTab).toBe('notifications');
    s().closePanel();
    expect(s().activePanelTab).toBeNull();
  });

  it('offset is the dock width iff a panel is open — B6 regression', () => {
    expect(selectDockOffsetPx(s())).toBe(0);
    // Every panel reports the SAME width. The old if-chain returned 460 for a
    // session and 420 for an advisor while the panel covering them was 480,
    // which is how the Decision Queue ended up mispositioned.
    for (const open of [
      () => s().selectSession('a'),
      () => s().selectAdvisor('b'),
      () => s().selectSkill('c'),
      () => s().openPanel('plan'),
      () => s().openPanel('galaxy'),
      () => s().openPanel('connections'),
      () => s().openPanel('workspace'),
    ]) {
      open();
      expect(selectDockOffsetPx(s())).toBe(RIGHT_DOCK_WIDTH_PX);
    }
    s().closePanel();
    expect(selectDockOffsetPx(s())).toBe(0);
  });
});
