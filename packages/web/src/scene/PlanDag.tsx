import { useMemo } from 'react';
import { Line } from '@react-three/drei';
import type { Session } from '@solix/shared';
import { selectPlansArray, useSolixStore } from '../store/index.js';
import { planetOrbitRadius, planetPhase } from './orbits.js';

/**
 * v2 Maestro — the conductor's dispatch overlay. For each running plan, draws a
 * beam from the sun (the conductor) to every live worker/verifier planet, plus
 * fainter dashed edges between dependent task planets. Positions mirror
 * Planet.tsx's initial-phase layout (same as ConstellationLines), so the lines
 * land on the planets even with motion paused. Purely additive — renders nothing
 * unless a plan is actively dispatching.
 */
const MAESTRO_COLOR = '#fde047';

function planetPosition(s: Session): [number, number, number] {
  const angle = planetPhase(s.orbitSlot, s.id, s.projectId);
  const r = planetOrbitRadius(s.orbitSlot);
  return [Math.cos(angle) * r, Math.sin(angle * 0.5) * 0.4, Math.sin(angle) * r];
}

export function PlanDag(): JSX.Element | null {
  const plans = useSolixStore(selectPlansArray);
  const planTasks = useSolixStore((s) => s.planTasks);
  const sessions = useSolixStore((s) => s.sessions);

  const { beams, edges } = useMemo(() => {
    const beams: Array<{ id: string; points: [number, number, number][] }> = [];
    const edges: Array<{ id: string; points: [number, number, number][] }> = [];
    const origin: [number, number, number] = [0, 0, 0];

    for (const plan of plans) {
      if (plan.status !== 'running') continue;
      const tasks = Object.values(planTasks).filter((t) => t.planId === plan.id);
      const posByTask = new Map<string, [number, number, number]>();

      // A dispatched task with a live planet gets a beam from the sun.
      for (const t of tasks) {
        const sess = t.sessionId ? sessions[t.sessionId] : undefined;
        if (!sess || sess.status !== 'active') continue;
        const pos = planetPosition(sess);
        posByTask.set(t.id, pos);
        beams.push({ id: `beam-${t.id}`, points: [origin, pos] });
      }

      // Dependency edges between tasks that are both currently on-screen.
      for (const t of tasks) {
        const to = posByTask.get(t.id);
        if (!to) continue;
        for (const dep of t.dependsOn) {
          const from = posByTask.get(dep);
          if (from) edges.push({ id: `edge-${dep}-${t.id}`, points: [from, to] });
        }
      }
    }
    return { beams, edges };
  }, [plans, planTasks, sessions]);

  if (!beams.length && !edges.length) return null;

  return (
    <group>
      {beams.map((b) => (
        <Line
          key={b.id}
          points={b.points}
          color={MAESTRO_COLOR}
          lineWidth={1.5}
          transparent
          opacity={0.5}
        />
      ))}
      {edges.map((e) => (
        <Line
          key={e.id}
          points={e.points}
          color={MAESTRO_COLOR}
          lineWidth={1}
          transparent
          opacity={0.25}
          dashed
        />
      ))}
    </group>
  );
}
