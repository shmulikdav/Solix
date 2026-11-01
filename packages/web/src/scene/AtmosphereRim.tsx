import { useEffect, useMemo } from 'react';
import { BackSide, Color, ShaderMaterial } from 'three';

/**
 * Fresnel rim glow. Renders a back-faces sphere slightly larger than the
 * planet body — the back-side trick means the rim is visible only at the
 * silhouette, not over the front of the sphere.
 *
 * Cheap (one extra sphere, one shader pass per planet) and high-impact
 * visually: planets pick up a soft halo in their own color without losing
 * the model-color encoding on user-session planets.
 */
export interface AtmosphereRimProps {
  radius: number;
  color: string;
  intensity?: number; // multiplier on the glow (default 1)
  power?: number; // Fresnel exponent — higher = tighter rim (default 3)
}

/**
 * One material, built once.
 *
 * This used to be `useMemo(… , [color, intensity, power])`, and `intensity`
 * is a continuous function of `session.contextUsagePct` (see `Planet.tsx`) —
 * so **every `context_update` event constructed a new `ShaderMaterial`**,
 * which means a new compiled GPU program, and nothing anywhere in
 * `packages/web/src/scene/` ever called `dispose()`. Three.js does not
 * garbage-collect GPU resources: they are released when you release them, or
 * when the context is lost.
 *
 * The leak scaled with event volume rather than fleet size, so it did not
 * need a big galaxy to matter — a 30-planet `solix demo` left running does
 * it. "Would you leave it running?" is one of the four questions the partner
 * brief asks, which makes this the wrong thing to be wrong about.
 *
 * Nothing in the shaders depends on the props; they are uniforms. So the
 * material is built once and written to.
 */
export function createRimMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color('#ffffff') },
      uIntensity: { value: 1 },
      uPower: { value: 3 },
    },
    transparent: true,
    depthWrite: false,
    side: BackSide,
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vViewDir = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uPower;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        // Back-side render: dot(normal, view) is positive at the silhouette.
        float fres = pow(max(0.0, dot(vNormal, vViewDir)), uPower);
        gl_FragColor = vec4(uColor * uIntensity, fres);
      }
    `,
  });
}

/**
 * Point the existing material at new values.
 *
 * `Color.set` writes into the object the uniform already holds rather than
 * replacing it, so the uniform's identity is stable too — three only needs
 * to upload the value, not relink anything.
 */
export function applyRimUniforms(
  material: ShaderMaterial,
  { color, intensity, power }: { color: string; intensity: number; power: number },
): void {
  (material.uniforms.uColor!.value as Color).set(color);
  material.uniforms.uIntensity!.value = intensity;
  material.uniforms.uPower!.value = power;
}

/**
 * One material for the life of the planet, pointed at the current values.
 *
 * Separated from the component so it can be tested: rendering `<mesh>` needs
 * a WebGL context, and this needs none. The first version of this test
 * created a material by hand and asserted it stayed the same object, which
 * it could not help doing — a check that cannot fail, which is the defect
 * the ledger exists to catch, committed inside a test for it.
 */
export function useRimMaterial(
  color: string,
  intensity: number,
  power: number,
): ShaderMaterial {
  const material = useMemo(() => createRimMaterial(), []);
  applyRimUniforms(material, { color, intensity, power });
  // The other half of the leak: even without the per-event churn, a planet
  // that left the galaxy took its material's GPU program with it and never
  // gave it back.
  useEffect(() => () => material.dispose(), [material]);
  return material;
}

export function AtmosphereRim({
  radius,
  color,
  intensity = 1,
  power = 3,
}: AtmosphereRimProps): JSX.Element {
  const material = useRimMaterial(color, intensity, power);

  return (
    <mesh>
      <sphereGeometry args={[radius * 1.18, 32, 32]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}
