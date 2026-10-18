import { Suspense, useMemo, useRef } from 'react';
import { useFrame, useLoader, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import {
  Color,
  DoubleSide,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  TextureLoader,
} from 'three';
import type { Advisor } from '@solix/shared';
import {
  selectEnabledAdvisors,
  selectOptInAdvisors,
  useSolixStore,
} from '../store/index.js';
import { AtmosphereRim } from './AtmosphereRim.js';
import { ErrorBoundary } from '../ErrorBoundary.js';
import { useHoverCursor } from './useHoverCursor.js';

const RING_RADIUS = 3.3;
const GHOST_RING_RADIUS = 4.3;
const PLANET_SIZE = 0.34; // slightly bigger so textures read at this orbit

interface TexturePackSpec {
  body: string;
  ring?: string;
  cloud?: string;
  ringInner?: number; // multiples of PLANET_SIZE
  ringOuter?: number;
  axialTilt?: number; // radians
}

const TEXTURE_PACKS: Record<string, TexturePackSpec> = {
  saturn: {
    body: '/textures/saturn.jpg',
    ring: '/textures/saturn_ring.png',
    ringInner: 1.5,
    ringOuter: 2.4,
    axialTilt: 0.45,
  },
  mars: {
    body: '/textures/mars.jpg',
    axialTilt: 0.4,
  },
  earth: {
    body: '/textures/earth.jpg',
    cloud: '/textures/earth_clouds.png',
    axialTilt: 0.41,
  },
  jupiter: {
    body: '/textures/jupiter.jpg',
    axialTilt: 0.05,
  },
  moon: {
    body: '/textures/moon.jpg',
    axialTilt: 0.1,
  },
};

interface AdvisorPlanetProps {
  advisor: Advisor;
  index: number;
  total: number;
}

function AdvisorPlanet({
  advisor,
  index,
  total,
}: AdvisorPlanetProps): JSX.Element {
  const groupRef = useRef<Group>(null);
  const phase = useMemo(
    () => (index / Math.max(1, total)) * Math.PI * 2,
    [index, total],
  );
  const select = useSolixStore((s) => s.selectAdvisor);
  const isSelected = useSolixStore(
    (s) => s.selectedAdvisorId === advisor.id,
  );

  const angleRef = useRef(phase);

  useFrame((_state, delta) => {
    if (useSolixStore.getState().motionEnabled) {
      angleRef.current += delta * 0.18;
    }
    const angle = angleRef.current;
    if (groupRef.current) {
      groupRef.current.position.set(
        Math.cos(angle) * RING_RADIUS,
        0,
        Math.sin(angle) * RING_RADIUS,
      );
    }
  });

  // Lerped per-advisor dim factor — read by both Procedural and Textured
  // body via a closure so each material can apply it without a parent ref.
  const dimRef = useRef(1.0);
  useFrame(() => {
    const storeState = useSolixStore.getState();
    const focusActive = Boolean(
      storeState.selectedSessionId ||
        storeState.selectedAdvisorId ||
        storeState.selectedSkillId,
    );
    const isThisFocused =
      storeState.selectedAdvisorId === advisor.id ||
      (advisor.pinnedSessionId &&
        storeState.selectedSessionId === advisor.pinnedSessionId);
    const target = focusActive && !isThisFocused ? 0.25 : 1.0;
    dimRef.current = MathUtils.lerp(dimRef.current, target, 0.08);
  });

  const onClick = (e: ThreeEvent<MouseEvent>): void => {
    e.stopPropagation();
    select(advisor.id);
  };

  const pack = advisor.texturePack
    ? TEXTURE_PACKS[advisor.texturePack]
    : undefined;

  return (
    <group ref={groupRef}>
      {pack ? (
        // ErrorBoundary OUTSIDE Suspense: Suspense absorbs the thrown promise
        // while the texture loads, the boundary catches an actual load failure
        // (missing/404/corrupt file) and falls back to the procedural look —
        // which is what the scene always claimed to do.
        <ErrorBoundary
          label={`advisor texture (${advisor.texturePack ?? 'unknown'})`}
          fallback={<ProceduralBody advisor={advisor} onClick={onClick} dimRef={dimRef} />}
        >
          <Suspense fallback={<ProceduralBody advisor={advisor} onClick={onClick} dimRef={dimRef} />}>
            <TexturedBody advisor={advisor} pack={pack} onClick={onClick} dimRef={dimRef} />
          </Suspense>
        </ErrorBoundary>
      ) : (
        <ProceduralBody advisor={advisor} onClick={onClick} dimRef={dimRef} />
      )}

      <AtmosphereRim
        radius={PLANET_SIZE}
        color={advisor.color}
        intensity={advisor.pinned ? 1.4 : 0.7}
        power={3.5}
      />

      <Html
        center
        zIndexRange={[20, 0]}
        distanceFactor={9}
        style={{ pointerEvents: 'none', userSelect: 'none' }}
        position={[0, PLANET_SIZE + 0.32, 0]}
      >
        <div
          className={`px-1.5 py-0.5 rounded text-[9px] whitespace-nowrap border ${
            isSelected
              ? 'bg-amber-400/20 border-amber-300 text-amber-100'
              : 'bg-black/60 border-white/10 text-amber-100/80'
          }`}
        >
          <span className="mr-1">{advisor.glyph}</span>
          {advisor.codename}
          {advisor.pinned && (
            <span className="ml-1 text-amber-300">●</span>
          )}
        </div>
      </Html>
    </group>
  );
}

interface TexturedBodyProps {
  advisor: Advisor;
  pack: TexturePackSpec;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
  dimRef: React.MutableRefObject<number>;
}

function TexturedBody({
  advisor,
  pack,
  onClick,
  dimRef,
}: TexturedBodyProps): JSX.Element {
  const hoverCursor = useHoverCursor();
  const bodyRef = useRef<Mesh>(null);
  const cloudRef = useRef<Mesh>(null);
  const ringRef = useRef<Mesh>(null);
  const bodyMatRef = useRef<MeshStandardMaterial>(null);
  const cloudMatRef = useRef<MeshStandardMaterial>(null);
  const ringMatRef = useRef<MeshStandardMaterial>(null);

  const bodyTex = useLoader(TextureLoader, pack.body);
  const cloudTex = useLoader(
    TextureLoader,
    pack.cloud ?? '/textures/sun.jpg', // any present file; we just gate render below
  );
  const ringTex = useLoader(
    TextureLoader,
    pack.ring ?? '/textures/sun.jpg',
  );

  bodyTex.wrapS = RepeatWrapping;
  bodyTex.wrapT = RepeatWrapping;

  useFrame((_, delta) => {
    const motion = useSolixStore.getState().motionEnabled;
    if (motion) {
      if (bodyRef.current) bodyRef.current.rotation.y += delta * 0.18;
      if (cloudRef.current) cloudRef.current.rotation.y += delta * 0.25;
      if (ringRef.current) ringRef.current.rotation.z += delta * 0.05;
    }
    const dim = dimRef.current;
    if (bodyMatRef.current) {
      bodyMatRef.current.opacity = dim;
      bodyMatRef.current.transparent = dim < 0.99;
    }
    if (cloudMatRef.current) {
      cloudMatRef.current.opacity = 0.55 * dim;
    }
    if (ringMatRef.current) {
      ringMatRef.current.opacity = 0.85 * dim;
    }
  });

  const tilt = pack.axialTilt ?? 0;
  const ringInner = (pack.ringInner ?? 1.5) * PLANET_SIZE;
  const ringOuter = (pack.ringOuter ?? 2.4) * PLANET_SIZE;

  return (
    <group rotation={[tilt, 0, 0]}>
      <mesh ref={bodyRef} onClick={onClick} {...hoverCursor}>
        <sphereGeometry args={[PLANET_SIZE, 48, 48]} />
        <meshStandardMaterial
          ref={bodyMatRef}
          map={bodyTex}
          roughness={0.85}
          metalness={0.05}
          emissive={new Color(advisor.color)}
          emissiveIntensity={advisor.pinned ? 0.25 : 0.1}
          transparent
          opacity={1}
        />
      </mesh>

      {pack.cloud && (
        <mesh ref={cloudRef}>
          <sphereGeometry args={[PLANET_SIZE * 1.02, 48, 48]} />
          <meshStandardMaterial
            ref={cloudMatRef}
            map={cloudTex}
            transparent
            opacity={0.55}
            depthWrite={false}
            roughness={1}
          />
        </mesh>
      )}

      {pack.ring && (
        <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[ringInner, ringOuter, 96]} />
          <meshStandardMaterial
            ref={ringMatRef}
            map={ringTex}
            transparent
            opacity={0.85}
            side={DoubleSide}
            depthWrite={false}
            roughness={1}
          />
        </mesh>
      )}
    </group>
  );
}

interface ProceduralBodyProps {
  advisor: Advisor;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
  dimRef: React.MutableRefObject<number>;
}

/** Fallback / opt-out body — solid color sphere with a subtle emissive lerp. */
function ProceduralBody({
  advisor,
  onClick,
  dimRef,
}: ProceduralBodyProps): JSX.Element {
  const hoverCursor = useHoverCursor();
  const meshRef = useRef<Mesh>(null);
  const matRef = useRef<MeshStandardMaterial>(null);
  const baseColor = useMemo(() => new Color(advisor.color), [advisor.color]);

  useFrame((_, delta) => {
    const motion = useSolixStore.getState().motionEnabled;
    if (motion && meshRef.current) meshRef.current.rotation.y += delta * 0.4;
    if (matRef.current) {
      const dim = dimRef.current;
      const target = advisor.pinned ? 0.6 : 0.22;
      matRef.current.emissiveIntensity = MathUtils.lerp(
        matRef.current.emissiveIntensity,
        target * dim,
        0.05,
      );
      matRef.current.opacity = dim;
      matRef.current.transparent = dim < 0.99;
    }
  });

  return (
    <mesh ref={meshRef} onClick={onClick} {...hoverCursor}>
      <sphereGeometry args={[PLANET_SIZE, 24, 24]} />
      <meshStandardMaterial
        ref={matRef}
        color={baseColor}
        emissive={baseColor}
        emissiveIntensity={0.22}
        roughness={0.55}
        metalness={0.4}
        transparent
        opacity={1}
      />
    </mesh>
  );
}

/**
 * Sprint N — "ghost" planet for an opt-in (disabled) advisor. Dim, untextured,
 * slowly drifting on a faint outer ring. Clicking it opens the AdvisorPanel
 * (which offers an Enable button), so the opt-in crew is discoverable in the
 * galaxy instead of hidden.
 */
function GhostAdvisorPlanet({
  advisor,
  index,
  total,
}: AdvisorPlanetProps): JSX.Element {
  const hoverCursor = useHoverCursor();
  const groupRef = useRef<Group>(null);
  const matRef = useRef<MeshStandardMaterial>(null);
  const phase = useMemo(
    () => (index / Math.max(1, total)) * Math.PI * 2,
    [index, total],
  );
  const angleRef = useRef(phase);
  const select = useSolixStore((s) => s.selectAdvisor);
  const isSelected = useSolixStore((s) => s.selectedAdvisorId === advisor.id);
  const baseColor = useMemo(() => new Color(advisor.color), [advisor.color]);

  useFrame((state, delta) => {
    if (useSolixStore.getState().motionEnabled) {
      angleRef.current += delta * 0.1;
    }
    const angle = angleRef.current;
    if (groupRef.current) {
      groupRef.current.position.set(
        Math.cos(angle) * GHOST_RING_RADIUS,
        0,
        Math.sin(angle) * GHOST_RING_RADIUS,
      );
    }
    if (matRef.current) {
      // gentle breathing so ghosts read as "available, dormant"
      const t = state.clock.getElapsedTime();
      const pulse = 0.5 + 0.5 * Math.sin(t * 1.1 + phase);
      matRef.current.opacity = (isSelected ? 0.6 : 0.28) + pulse * 0.12;
    }
  });

  const onClick = (e: ThreeEvent<MouseEvent>): void => {
    e.stopPropagation();
    select(advisor.id);
  };

  return (
    <group ref={groupRef}>
      <mesh onClick={onClick} {...hoverCursor}>
        <sphereGeometry args={[PLANET_SIZE * 0.8, 20, 20]} />
        <meshStandardMaterial
          ref={matRef}
          color={baseColor}
          emissive={baseColor}
          emissiveIntensity={0.15}
          roughness={0.7}
          metalness={0.2}
          transparent
          opacity={0.3}
          wireframe
        />
      </mesh>
      <Html
        center
        zIndexRange={[20, 0]}
        distanceFactor={9}
        style={{ pointerEvents: 'none', userSelect: 'none' }}
        position={[0, PLANET_SIZE + 0.28, 0]}
      >
        <div
          className={`px-1.5 py-0.5 rounded text-[9px] whitespace-nowrap border ${
            isSelected
              ? 'bg-cyan-400/20 border-cyan-300 text-cyan-100'
              : 'bg-black/40 border-white/10 text-slate-400'
          }`}
        >
          <span className="mr-1">{advisor.glyph}</span>
          {advisor.codename}
          <span className="ml-1 opacity-60">· opt-in</span>
        </div>
      </Html>
    </group>
  );
}

export function AdvisorRing(): JSX.Element | null {
  const enabled = useSolixStore(selectEnabledAdvisors);
  const optIn = useSolixStore(selectOptInAdvisors);
  if (!enabled.length && !optIn.length) return null;

  return (
    <group>
      {enabled.length > 0 && (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry
            args={[RING_RADIUS - 0.03, RING_RADIUS + 0.03, 128]}
          />
          <meshBasicMaterial
            color="#fbbf24"
            transparent
            opacity={0.12}
            side={DoubleSide}
          />
        </mesh>
      )}
      {optIn.length > 0 && (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry
            args={[GHOST_RING_RADIUS - 0.02, GHOST_RING_RADIUS + 0.02, 128]}
          />
          <meshBasicMaterial
            color="#475569"
            transparent
            opacity={0.1}
            side={DoubleSide}
          />
        </mesh>
      )}
      {enabled.map((advisor, i) => (
        <AdvisorPlanet
          key={advisor.id}
          advisor={advisor}
          index={i}
          total={enabled.length}
        />
      ))}
      {optIn.map((advisor, i) => (
        <GhostAdvisorPlanet
          key={advisor.id}
          advisor={advisor}
          index={i}
          total={optIn.length}
        />
      ))}
    </group>
  );
}
