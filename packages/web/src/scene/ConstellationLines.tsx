import { useMemo } from 'react';
import { Line } from '@react-three/drei';
import type { Session } from '@solix/shared';
import {
  selectAdvisorPlanets,
  selectGoalsArray,
  selectScenePlanets,
  useSolixStore,
} from '../store/index.js';
import { planetOrbitRadius, planetPhase } from './orbits.js';

/**
 * Sprint M — "goal constellations". Draws faint lines linking the planets
 * whose current mission rolls up to the same goal, tinted with the goal
 * color. Positions mirror Planet.tsx's initial-phase layout (good enough
 * since motion is paused by default; the lines convey grouping, not a
 * physics-accurate overlay).
 */
function planetPosition(s: Session): [number, number, number] {
  const angle = planetPhase(s.orbitSlot, s.id, s.projectId);
  const r = planetOrbitRadius(s.orbitSlot);
  return [Math.cos(angle) * r, Math.sin(angle * 0.5) * 0.4, Math.sin(angle) * r];
}

export function ConstellationLines(): JSX.Element | null {
  const planets = useSolixStore(selectScenePlanets);
  const advisorPlanets = useSolixStore(selectAdvisorPlanets);
  const goals = useSolixStore(selectGoalsArray);

  const lines = useMemo(() => {
    if (!goals.length) return [];
    const all = [...planets, ...advisorPlanets];
    return goals
      .map((g) => {
        const pts = all
          .filter((s) => s.currentGoalId === g.id)
          .map(planetPosition);
        return { id: g.id, color: g.color, points: pts };
      })
      .filter((l) => l.points.length >= 2);
  }, [planets, advisorPlanets, goals]);

  if (!lines.length) return null;

  return (
    <group>
      {lines.map((l) => (
        <Line
          key={l.id}
          points={l.points}
          color={l.color}
          lineWidth={1}
          transparent
          opacity={0.35}
          dashed={false}
        />
      ))}
    </group>
  );
}
