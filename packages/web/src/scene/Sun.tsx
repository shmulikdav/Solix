import { ErrorBoundary } from '../ErrorBoundary.js';
import { Suspense, useMemo, useRef } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import {
  AdditiveBlending,
  CanvasTexture,
  type Group,
  MathUtils,
  type Mesh,
  type PointLight,
  RepeatWrapping,
  type Sprite,
  TextureLoader,
} from 'three';
import { selectPlanets, useSolixStore } from '../store/index.js';

const SUN_TEXTURE_URL = '/textures/sun.jpg';

// Sprint K.5b: scaled back from 2.3 (felt like the sun was eating the
// screen) to 1.4. The sun should be the gravitational center, not the
// only thing you can see.
const SUN_RADIUS = 1.4;
const SUN_LIGHT_BASE = 18;

/**
 * Live workspace activity, read imperatively so it never triggers a React
 * render. `active` = sessions actually working; `attention` = anything that
 * needs a human (permission / input / plan review / error).
 */
function readSunActivity(): { active: number; attention: number } {
  const planets = selectPlanets(useSolixStore.getState());
  let active = 0;
  let attention = 0;
  for (const s of planets) {
    if (s.status === 'active') active++;
    else if (
      s.status === 'awaiting_permission' ||
      s.status === 'awaiting_input' ||
      s.status === 'plan_review' ||
      s.status === 'error'
    )
      attention++;
  }
  return { active, attention };
}

export function Sun(): JSX.Element {
  const groupRef = useRef<Group>(null);
  const lightRef = useRef<PointLight>(null);

  // The living sun: brighten + grow slightly with active work, lerped so it
  // breathes rather than snaps. Read imperatively in the frame loop (same
  // pattern as SunBody's motion read) — no re-render churn.
  useFrame(() => {
    const { active } = readSunActivity();
    const load = Math.min(active, 8) / 8; // 0..1
    if (lightRef.current) {
      const target = SUN_LIGHT_BASE * (1 + load * 0.7);
      lightRef.current.intensity = MathUtils.lerp(
        lightRef.current.intensity,
        target,
        0.05,
      );
    }
    if (groupRef.current) {
      const target = 1 + load * 0.12;
      const s = MathUtils.lerp(groupRef.current.scale.x, target, 0.05);
      groupRef.current.scale.set(s, s, s);
    }
  });

  return (
    <group ref={groupRef}>
      {/*
        Sun's pointLight: meaningful illumination on inner planets,
        steeper falloff so outer planets keep the cool nebula tint of
        the background. decay=2 is physically correct inverse-square.
        Intensity is animated by the living-sun frame loop above.
      */}
      <pointLight
        ref={lightRef}
        position={[0, 0, 0]}
        intensity={SUN_LIGHT_BASE}
        distance={70}
        decay={2}
        color="#ffd486"
      />
      {/* Boundary outside Suspense: a missing/corrupt sun texture must fall
          back to the procedural sun, not take the scene (and the app) down. */}
      <ErrorBoundary label="sun texture" fallback={<SunFallback />}>
        <Suspense fallback={<SunFallback />}>
          <SunBody />
        </Suspense>
      </ErrorBoundary>
      <SunHaloes />
      <SolarProminences />
      {/*
        Invisible pick sphere. The sun body is a meshBasicMaterial with no
        handler, so this transparent sphere (opacity 0, NOT visible={false} —
        the raycaster skips invisible objects) is the click/hover target that
        opens Mission Control. Sized just past the corona so it's easy to hit.
      */}
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          useSolixStore.getState().openWorkspace();
        }}
        onPointerOver={() => {
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          document.body.style.cursor = '';
        }}
      >
        <sphereGeometry args={[SUN_RADIUS * 1.3, 24, 24]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

/**
 * Textured sun body. Slight axial rotation when motion is on; rotation
 * pauses with the rest of the scene.
 */
function SunBody(): JSX.Element {
  const ref = useRef<Mesh>(null);
  const texture = useLoader(TextureLoader, SUN_TEXTURE_URL);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;

  useFrame((_, delta) => {
    const motion = useSolixStore.getState().motionEnabled;
    if (motion && ref.current) ref.current.rotation.y += delta * 0.05;
  });

  return (
    <mesh ref={ref}>
      <sphereGeometry args={[SUN_RADIUS, 64, 64]} />
      {/*
        meshBasicMaterial — sun is its own light source; we don't want the
        scene's pointLight applying shading on top of the texture. The
        texture color goes straight to the screen, then bloom takes care of
        the glow.
      */}
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}

/** Procedural fallback if the texture isn't available. */
function SunFallback(): JSX.Element {
  return (
    <mesh>
      <sphereGeometry args={[SUN_RADIUS, 48, 48]} />
      <meshBasicMaterial color="#fde68a" />
    </mesh>
  );
}

/**
 * Three stacked translucent shells around the sun — the inner one
 * breathes in/out subtly. With bloom + ACES tonemapping on, this
 * reads as a proper corona with hot edge and faint outer haze.
 */
function SunHaloes(): JSX.Element {
  const haloRef = useRef<Mesh>(null);
  const outerRef = useRef<Mesh>(null);

  useFrame(() => {
    const t = performance.now() * 0.001;
    if (haloRef.current) {
      const s = 1 + Math.sin(t * 1.3) * 0.04;
      haloRef.current.scale.set(s, s, s);
    }
    if (outerRef.current) {
      const s = 1 + Math.sin(t * 0.6 + 1) * 0.025;
      outerRef.current.scale.set(s, s, s);
    }
  });

  return (
    <>
      {/* Hot inner shell — closest to the surface, brightest tone */}
      <mesh ref={haloRef}>
        <sphereGeometry args={[SUN_RADIUS * 1.08, 32, 32]} />
        <meshBasicMaterial
          color="#fff7c2"
          transparent
          opacity={0.22}
          toneMapped={false}
        />
      </mesh>
      {/* Mid corona — pulled in, smaller bleed */}
      <mesh>
        <sphereGeometry args={[SUN_RADIUS * 1.22, 32, 32]} />
        <meshBasicMaterial
          color="#ffae3c"
          transparent
          opacity={0.10}
          toneMapped={false}
        />
      </mesh>
      {/* Outer haze — pulled in to ~1.5x radius (was 2x). The sun
          glows; it doesn't paint the whole scene orange. */}
      <mesh ref={outerRef}>
        <sphereGeometry args={[SUN_RADIUS * 1.5, 32, 32]} />
        <meshBasicMaterial
          color="#f97316"
          transparent
          opacity={0.04}
          toneMapped={false}
        />
      </mesh>
    </>
  );
}

/**
 * Sprint K.5: a handful of flame-shaped sprite billboards attached at
 * random latitudes on the sun's surface. They flicker (sin-driven
 * opacity + scale wobble) so the sun feels alive rather than static.
 */
function makeFlameTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Vertical flame: hot core at bottom, fading to transparent at top.
  const grad = ctx.createLinearGradient(0, size, 0, 0);
  grad.addColorStop(0, 'rgba(255,250,210,1)');
  grad.addColorStop(0.3, 'rgba(255,170,40,0.85)');
  grad.addColorStop(0.7, 'rgba(220,80,20,0.4)');
  grad.addColorStop(1, 'rgba(120,30,0,0)');

  ctx.fillStyle = grad;
  // Pinch the flame: narrower at top, wider at bottom, using triangle path.
  ctx.beginPath();
  ctx.moveTo(size * 0.15, size);
  ctx.quadraticCurveTo(size * 0.5, size * 0.5, size * 0.85, size);
  ctx.lineTo(size * 0.5, 0);
  ctx.closePath();
  ctx.fill();

  return new CanvasTexture(canvas);
}

interface FlameSpec {
  pos: [number, number, number];
  size: number;
  phase: number;
  baseOpacity: number;
}

function SolarProminences(): JSX.Element {
  const flames: FlameSpec[] = useMemo(() => {
    // 8 flames evenly distributed on the surface with random scale + phase.
    return Array.from({ length: 8 }, (_, i) => {
      const theta = (i / 8) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const phi = (Math.random() - 0.5) * 1.0; // mostly equatorial
      const r = SUN_RADIUS * 1.02;
      return {
        pos: [
          r * Math.cos(phi) * Math.cos(theta),
          r * Math.sin(phi),
          r * Math.cos(phi) * Math.sin(theta),
        ],
        size: 0.5 + Math.random() * 0.45,
        phase: Math.random() * Math.PI * 2,
        baseOpacity: 0.45 + Math.random() * 0.3,
      };
    });
  }, []);
  const texture = useMemo(() => makeFlameTexture(), []);
  const refs = useRef<(Sprite | null)[]>([]);

  useFrame(() => {
    const t = performance.now() * 0.001;
    // When any session needs a human, the prominences flick faster, grow,
    // brighten, and tint red — so the sun flares before you click anything.
    const attention = readSunActivity().attention > 0;
    const wobbleFreq = attention ? 3.4 : 1.4;
    const opFreq = attention ? 4.0 : 1.7;
    const scaleBoost = attention ? 1.35 : 1;
    const opBoost = attention ? 1.5 : 1;
    refs.current.forEach((sprite, i) => {
      if (!sprite) return;
      const spec = flames[i]!;
      const wobble = 0.85 + Math.sin(t * wobbleFreq + spec.phase) * 0.25;
      const sz = spec.size * wobble * scaleBoost;
      sprite.scale.set(sz, sz * 1.4, 1);
      const m = sprite.material;
      m.opacity =
        spec.baseOpacity * opBoost * (0.7 + Math.sin(t * opFreq + spec.phase) * 0.3);
      m.color.setHex(attention ? 0xff4444 : 0xffffff);
    });
  });

  if (!texture) return <></>;

  return (
    <>
      {flames.map((spec, i) => (
        <sprite
          key={i}
          ref={(s) => {
            refs.current[i] = s;
          }}
          position={spec.pos}
        >
          <spriteMaterial
            map={texture}
            transparent
            depthWrite={false}
            blending={AdditiveBlending}
            opacity={spec.baseOpacity}
            toneMapped={false}
          />
        </sprite>
      ))}
    </>
  );
}

// Lens flare removed in Sprint K.5b — too aggressive against bloom,
// turned the whole screen orange. The corona shells alone read as a
// star against the new toned-down bloom.
