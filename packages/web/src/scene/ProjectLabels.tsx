import { useMemo } from 'react';
import { Html } from '@react-three/drei';
import {
  selectAdvisorPlanets,
  selectScenePlanets,
  useSolixStore,
} from '../store/index.js';
import { planetOrbitRadius, planetPhase } from './orbits.js';

/**
 * Floating project name labels at each project's orbital cluster.
 *
 * planetPhase() now hashes the projectId so all of a project's planets
 * cluster around one base angle. This component drops a single label
 * near that anchor — one per project — so multi-project setups read as
 * separate neighborhoods.
 */
export function ProjectLabels(): JSX.Element {
  const projects = useSolixStore((s) => s.projects);
  const planets = useSolixStore(selectScenePlanets);
  const advisorPlanets = useSolixStore(selectAdvisorPlanets);

  const groups = useMemo(() => {
    const all = [...planets, ...advisorPlanets];
    const map = new Map<
      string,
      { project: (typeof projects)[string]; sessions: typeof all }
    >();
    for (const s of all) {
      const project = projects[s.projectId];
      if (!project) continue;
      const existing = map.get(project.id);
      if (existing) existing.sessions.push(s);
      else map.set(project.id, { project, sessions: [s] });
    }
    return [...map.values()];
  }, [planets, advisorPlanets, projects]);

  if (groups.length < 2) return <></>;

  return (
    <>
      {groups.map(({ project, sessions }) => {
        // Anchor the label at the project's hashed base angle, on the
        // outermost orbit slot used by this project.
        const repSlot = sessions.reduce(
          (m, s) => Math.max(m, s.orbitSlot),
          0,
        );
        const angle = planetPhase(repSlot, sessions[0]!.id, project.id);
        const radius = planetOrbitRadius(repSlot) + 1.2;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        return (
          <Html
            key={project.id}
            position={[x, 1.6, z]}
            center
            zIndexRange={[20, 0]}
            distanceFactor={14}
            style={{ pointerEvents: 'none', userSelect: 'none' }}
          >
            <div className="px-2 py-1 rounded text-[9px] uppercase tracking-widest border border-solix-accent/30 bg-black/50 text-solix-accent/80 whitespace-nowrap">
              {project.name}
              <span className="ml-1.5 text-slate-500">
                · {sessions.length}
              </span>
            </div>
          </Html>
        );
      })}
    </>
  );
}
