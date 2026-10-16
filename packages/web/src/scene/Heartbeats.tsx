import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { Mesh, MeshBasicMaterial } from 'three';
import type { ScheduledTask } from '@solix/shared';
import { selectEnabledSchedules, useSolixStore } from '../store/index.js';

/**
 * Sprint M — "heartbeats". Each enabled scheduled task renders as a small
 * cyan node pulsing on a faint outer ring, with its cadence + next run on a
 * hover label. When a schedule fires it spawns a normal session planet via
 * the existing launch flow, so these nodes are purely the "upcoming work"
 * indicator.
 */
const RING_RADIUS = 17;

export function Heartbeats(): JSX.Element | null {
  const schedules = useSolixStore(selectEnabledSchedules);
  if (!schedules.length) return null;
  return (
    <group>
      {schedules.map((s, i) => {
        const angle = (i / schedules.length) * Math.PI * 2;
        const x = Math.cos(angle) * RING_RADIUS;
        const z = Math.sin(angle) * RING_RADIUS;
        return <HeartbeatNode key={s.id} schedule={s} position={[x, 0, z]} />;
      })}
    </group>
  );
}

function HeartbeatNode({
  schedule,
  position,
}: {
  schedule: ScheduledTask;
  position: [number, number, number];
}): JSX.Element {
  const meshRef = useRef<Mesh>(null);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    // ~1.4 Hz heartbeat pulse.
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 1.4);
    const mesh = meshRef.current;
    if (mesh) {
      const s = 0.5 + pulse * 0.35;
      mesh.scale.set(s, s, s);
      const mat = mesh.material as MeshBasicMaterial;
      mat.opacity = 0.45 + pulse * 0.45;
    }
  });

  // Interval routines show their cadence + next run; webhook/manual routines
  // fire on demand, so show the trigger kind instead of a bogus "next run".
  const trigger = schedule.trigger ?? 'interval';
  const cadenceLabel =
    trigger === 'interval'
      ? `every ${schedule.cron} · next ${relativeNextRun(schedule.nextRunAt)}`
      : trigger === 'webhook'
        ? 'webhook trigger'
        : 'manual trigger';

  return (
    <group position={position}>
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.35, 16, 16]} />
        <meshBasicMaterial color="#22d3ee" transparent opacity={0.7} />
      </mesh>
      <Html
        center
        zIndexRange={[20, 0]}
        distanceFactor={14}
        style={{ pointerEvents: 'none', userSelect: 'none' }}
        position={[0, 0.7, 0]}
      >
        <div className="px-2 py-1 rounded text-[10px] whitespace-nowrap border bg-black/50 border-cyan-300/40 text-cyan-100">
          <div className="font-semibold flex items-center gap-1">
            <span>{trigger === 'webhook' ? '⚡' : '✷'}</span>
            <span>{schedule.name ?? schedule.prompt.slice(0, 24)}</span>
          </div>
          <div className="opacity-70">
            {cadenceLabel}
            {schedule.owner ? ` · ${schedule.owner}` : ''}
          </div>
        </div>
      </Html>
    </group>
  );
}

function relativeNextRun(ts: number): string {
  const dt = ts - Date.now();
  if (dt <= 0) return 'now';
  const min = Math.round(dt / 60000);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}
