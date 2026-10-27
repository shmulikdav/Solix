import { useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { Color, Group, Mesh, MathUtils, MeshStandardMaterial } from 'three';
import type { Session } from '@solix/shared';
import { useSolixStore, selectMoons } from '../store/index.js';
import { costColor, modelColor, statusEmissive, statusLabel } from './colors.js';
import {
  moonOrbitRadius,
  moonOrbitSpeed,
  planetOrbitRadius,
  planetOrbitSpeed,
  planetPhase,
} from './orbits.js';
import { Moon } from './Moon.js';
import { AtmosphereRim } from './AtmosphereRim.js';
import { suggestForSession } from '../suggestions.js';
import { GLOSSARY } from '../glossary.js';
import { useHoverCursor } from './useHoverCursor.js';

interface PlanetProps {
  session: Session;
}

export function Planet({ session }: PlanetProps): JSX.Element {
  const hoverCursor = useHoverCursor();
  const groupRef = useRef<Group>(null);
  const planetRef = useRef<Mesh>(null);
  const flareRef = useRef<Mesh>(null);
  const ringRef = useRef<Mesh>(null);
  const materialRef = useRef<MeshStandardMaterial>(null);
  const phase = useMemo(
    () => planetPhase(session.orbitSlot, session.id, session.projectId),
    [session.orbitSlot, session.id],
  );
  const radius = useMemo(
    () => planetOrbitRadius(session.orbitSlot),
    [session.orbitSlot],
  );

  const moons = useSolixStore((s) => selectMoons(s, session.id));
  const selectSession = useSolixStore((s) => s.selectSession);
  const selectAdvisor = useSolixStore((s) => s.selectAdvisor);
  const advisorForRole = useSolixStore((s) => {
    if (!session.advisorRole) return null;
    return (
      Object.values(s.advisors).find((a) => a.id === session.advisorRole) ?? null
    );
  });
  const selectedSessionId = useSolixStore((s) => s.selectedSessionId);
  const isSelected = selectedSessionId === session.id;
  const isAdvisor = session.kind === 'advisor';
  // Context headroom drives the atmosphere rim — a planet dims as it fills
  // up. Mission + pending count are still read from the store, for the label
  // that says what (if anything) this agent needs.
  const currentMission = useSolixStore((s) =>
    session.currentMissionId
      ? s.missions[session.currentMissionId]
      : undefined,
  );
  const pendingForSession = useSolixStore(
    (s) =>
      Object.values(s.pendingPermissions).filter(
        (p) => p.sessionId === session.id,
      ).length,
  );
  const attention = useMemo(
    () => suggestForSession(session, currentMission, pendingForSession),
    [session, currentMission, pendingForSession],
  );
  /**
   * The glow used to be driven by a 0–100 health score. Context pressure was
   * 40 of those 100 points and the term that actually moved, so driving it
   * from context headroom directly keeps the same visual meaning — a planet
   * dims as it fills up — with one honest input instead of a composite.
   */
  const rimIntensity =
    0.4 + (1 - Math.min(100, Math.max(0, session.contextUsagePct ?? 0)) / 100) * 0.8;

  const baseColor = useMemo(
    () =>
      new Color(
        isAdvisor && advisorForRole
          ? advisorForRole.color
          : modelColor(session.model),
      ),
    [isAdvisor, advisorForRole, session.model],
  );

  const angleRef = useRef(phase);
  // Lerped focus-dim factor: 1.0 = full bright, 0.25 = dimmed because some
  // OTHER planet is selected. Cached on the group via scale-channel-z so we
  // don't re-allocate every frame.
  const dimRef = useRef(1.0);

  useFrame((state, delta) => {
    const storeState = useSolixStore.getState();
    const motionEnabled = storeState.motionEnabled;
    const focusActive = Boolean(
      storeState.selectedSessionId ||
        storeState.selectedAdvisorId ||
        storeState.selectedSkillId,
    );
    const isThisFocused =
      storeState.selectedSessionId === session.id ||
      (isAdvisor &&
        storeState.selectedAdvisorId === session.advisorRole);
    const dimTarget = focusActive && !isThisFocused ? 0.25 : 1.0;
    dimRef.current = MathUtils.lerp(dimRef.current, dimTarget, 0.08);
    const dim = dimRef.current;

    const speed = planetOrbitSpeed(session.status === 'active', session.orbitSlot);
    if (motionEnabled) {
      angleRef.current += delta * speed * 0.3;
    }
    const angle = angleRef.current;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const tilt = Math.sin(angle * 0.5) * 0.4;
    if (groupRef.current) {
      groupRef.current.position.set(x, tilt, z);
    }

    // Status-feedback timing — keeps pulsing regardless of motion mode so
    // attention-grabbing flares (permission, context) still animate.
    const t = state.clock.getElapsedTime();

    if (planetRef.current) {
      if (motionEnabled) {
        planetRef.current.rotation.y += delta * 0.4;
      }
      const targetScale = 0.55 + (session.contextUsagePct / 100) * 0.5;
      const cur = planetRef.current.scale.x;
      const next = MathUtils.lerp(cur, targetScale, 0.04);
      planetRef.current.scale.set(next, next, next);
    }

    if (materialRef.current) {
      const target = statusEmissive(session.status);
      const targetColor = new Color(target.color);
      materialRef.current.emissive.lerp(targetColor, 0.08);
      // Multiply emissive by dim so unfocused planets visibly recede
      // without changing the base color (still readable for glance scanning).
      materialRef.current.emissiveIntensity = MathUtils.lerp(
        materialRef.current.emissiveIntensity,
        target.intensity * dim,
        0.06,
      );
      materialRef.current.opacity = dim;
      materialRef.current.transparent = dim < 0.99;
    }

    if (flareRef.current) {
      const ctxCritical = session.contextUsagePct >= 90;
      const ctxWarn = session.contextUsagePct >= 80 && !ctxCritical;
      const showFlare =
        session.status === 'awaiting_permission' ||
        session.status === 'awaiting_input' ||
        ctxCritical ||
        ctxWarn;
      if (showFlare) {
        let freq = 0.8;
        let color = '#f59e0b';
        if (session.status === 'awaiting_permission') {
          freq = 1.5;
          color = '#ef4444';
        } else if (session.status === 'awaiting_input') {
          freq = 0.8;
          color = '#f59e0b';
        } else if (ctxCritical) {
          freq = 1.2;
          color = '#dc2626';
        } else if (ctxWarn) {
          freq = 0.6;
          color = '#fb923c';
        }
        const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * freq);
        const mat = flareRef.current.material as MeshStandardMaterial;
        mat.color.set(color);
        mat.opacity = (0.25 + pulse * 0.5) * dim;
        flareRef.current.visible = true;
        const s = 1.4 + pulse * 0.5;
        flareRef.current.scale.set(s, s, s);
      } else {
        flareRef.current.visible = false;
      }
    }

    if (ringRef.current) {
      ringRef.current.visible = session.status === 'plan_review';
      ringRef.current.rotation.z += delta * 0.3;
    }
  });

  const onClick = (e: ThreeEvent<MouseEvent>): void => {
    e.stopPropagation();
    selectSession(session.id);
    if (isAdvisor && advisorForRole) {
      selectAdvisor(advisorForRole.id);
    }
  };

  const planetSize = 0.55;
  // Sprint K: each user planet gets a small deterministic axial tilt,
  // derived from session.id. Visual variety without breaking the
  // metaphor — we never want two planets to look identical.
  const axialTiltX = useMemo(() => hashTiltDeg(session.id, 18) * (Math.PI / 180), [session.id]);
  const axialTiltZ = useMemo(() => hashTiltDeg(session.id + '-z', 12) * (Math.PI / 180), [session.id]);

  // Sprint M — budget ring. A faint full "track" with a colored arc that
  // fills as spend approaches the cap. Only present when a budget is set.
  const hasBudget = session.budgetUsd != null && session.budgetUsd > 0;
  const budgetPct = hasBudget
    ? Math.min(100, (session.costUsd / (session.budgetUsd as number)) * 100)
    : 0;
  // Quantize so we only rebuild the arc geometry on whole-percent changes.
  const budgetStep = Math.round(budgetPct);
  const budgetArc = useMemo(
    () => Math.max(0.0001, budgetStep / 100) * Math.PI * 2,
    [budgetStep],
  );

  return (
    <group ref={groupRef}>
      <group rotation={[axialTiltX, 0, axialTiltZ]}>
        <mesh ref={planetRef} onClick={onClick} {...hoverCursor} castShadow>
          <sphereGeometry args={[planetSize, 32, 32]} />
          {/*
            roughness/metalness tuned so the steeper sun-falloff lighting
            from Sprint K reads as proper day/night on the sphere.
            emissiveIntensity stays low (0.06) — just enough to keep the
            night side from going jet black, but not so much that the
            shape disappears.
          */}
          <meshStandardMaterial
            ref={materialRef}
            color={baseColor}
            emissive={baseColor}
            emissiveIntensity={0.06}
            roughness={0.78}
            metalness={0.12}
          />
        </mesh>
      </group>

      {/*
        Atmosphere rim — Fresnel glow at the silhouette in the planet's
        own color. Cheap (one extra back-side sphere), preserves the
        model-color encoding on user planets, adds depth without breaking
        anything when motion is paused.
      */}
      <AtmosphereRim
        radius={planetSize}
        color={
          isAdvisor && advisorForRole
            ? advisorForRole.color
            : modelColor(session.model)
        }
        intensity={rimIntensity * (session.status === 'active' ? 1.2 : 0.9)}
      />

      <mesh ref={flareRef} visible={false}>
        <sphereGeometry args={[planetSize * 1.4, 24, 24]} />
        <meshBasicMaterial color="#ef4444" transparent opacity={0.4} />
      </mesh>

      <mesh ref={ringRef} visible={false} rotation={[Math.PI / 2.4, 0, 0]}>
        <ringGeometry args={[planetSize * 1.4, planetSize * 2.0, 64]} />
        <meshBasicMaterial color="#a78bfa" transparent opacity={0.5} side={2} />
      </mesh>

      {isAdvisor && (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[planetSize * 1.25, planetSize * 1.35, 64]} />
          <meshBasicMaterial color="#fbbf24" transparent opacity={0.7} side={2} />
        </mesh>
      )}

      {hasBudget && (
        <group rotation={[Math.PI / 2, 0, 0]}>
          {/* faint full track */}
          <mesh>
            <ringGeometry args={[planetSize * 2.05, planetSize * 2.3, 64]} />
            <meshBasicMaterial color="#1e293b" transparent opacity={0.35} side={2} />
          </mesh>
          {/* colored fill arc, starting at top, growing clockwise */}
          <mesh>
            <ringGeometry
              args={[planetSize * 2.05, planetSize * 2.3, 64, 1, Math.PI / 2, budgetArc]}
            />
            <meshBasicMaterial
              color={costColor(budgetPct)}
              transparent
              opacity={0.9}
              side={2}
            />
          </mesh>
        </group>
      )}

      {moons.map((moon, i) => (
        <Moon key={moon.id} session={moon} index={i} speed={moonOrbitSpeed()} />
      ))}

      <Html
        center
        zIndexRange={[20, 0]}
        distanceFactor={10}
        style={{ pointerEvents: 'none', userSelect: 'none' }}
        position={[0, planetSize + 0.4, 0]}
      >
        <div
          className={`px-2 py-1 rounded text-[10px] whitespace-nowrap border ${
            isSelected
              ? 'bg-solix-accent/20 border-solix-accent text-white'
              : isAdvisor
                ? 'bg-amber-500/10 border-amber-300/50 text-amber-100'
                : 'bg-black/50 border-white/10 text-slate-200'
          }`}
        >
          <div className="font-semibold flex items-center gap-1">
            {isAdvisor && advisorForRole && (
              <span style={{ color: advisorForRole.color }}>
                {advisorForRole.glyph}
              </span>
            )}
            <span>
              {session.name ??
                (isAdvisor && advisorForRole
                  ? `${advisorForRole.codename} (pinned)`
                  : session.id.slice(0, 8))}
            </span>
          </div>
          <div
            className="opacity-70"
            title={GLOSSARY[session.status] ?? undefined}
          >
            {String(session.model)} · {statusLabel(session.status)}
            {session.origin === 'agentview' && (
              <span
                className="ml-1.5 text-[9px] uppercase tracking-wide text-cyan-300"
                title="Background session managed by Anthropic's Agent View"
              >
                · agent
              </span>
            )}
            {session.wrapperSocketPath && (
              <span
                className="ml-1.5 text-[9px] uppercase tracking-wide text-solix-accent"
                title="Wrapped by `solix run` — UI prompts route to this terminal"
              >
                · wrapped
              </span>
            )}
          </div>
          {session.agentViewSummary && (
            <div className="opacity-80 italic text-[10px] max-w-[200px] truncate" title={session.agentViewSummary}>
              {session.agentViewSummary}
            </div>
          )}
          {attention && (
            <div
              className={
                attention.severity === 'danger'
                  ? 'text-solix-danger'
                  : attention.severity === 'warn'
                    ? 'text-solix-warn'
                    : 'opacity-70'
              }
              title={attention.text}
            >
              {attention.text}
            </div>
          )}
        </div>
      </Html>
    </group>
  );
}

/**
 * Deterministic small tilt in degrees from a string key. Same id always
 * produces the same tilt so a planet doesn't jump every render. Range
 * is centered on 0, half on each side, so most planets stay close to
 * upright with occasional notably-tilted ones.
 */
function hashTiltDeg(key: string, range: number): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  // Map to [-range/2, +range/2].
  const t = ((h >>> 0) % 1000) / 1000; // [0, 1)
  return (t - 0.5) * range;
}

export function PlanetOrbitRing({
  orbitSlot,
}: {
  orbitSlot: number;
}): JSX.Element {
  const radius = planetOrbitRadius(orbitSlot);
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]}>
      <ringGeometry args={[radius - 0.02, radius + 0.02, 128]} />
      <meshBasicMaterial color="#1e293b" transparent opacity={0.35} side={2} />
    </mesh>
  );
}
