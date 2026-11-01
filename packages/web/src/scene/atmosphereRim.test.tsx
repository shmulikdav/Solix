// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { Color } from 'three';
import {
  applyRimUniforms,
  createRimMaterial,
  useRimMaterial,
} from './AtmosphereRim.js';

/**
 * CLAIM-RENDERER-RELEASES-GPU · the galaxy does not leak while you watch it.
 *
 * `AtmosphereRim` memoised its `ShaderMaterial` on `[color, intensity,
 * power]`, and `intensity` is a continuous function of
 * `session.contextUsagePct` (`Planet.tsx`). So every `context_update` built
 * a new material — a new compiled GPU program — and
 * `grep -rn dispose packages/web/src/scene/` returned nothing. Three.js
 * releases GPU resources when you release them and not before.
 *
 * The leak scaled with **event volume, not fleet size**: a 30-planet
 * `solix demo` left running does it, which is exactly the setup a design
 * partner is asked to leave running.
 *
 * Nothing in the shaders depends on the props — they are uniforms — so the
 * fix is to build once and write. These are the two halves of that, tested
 * without a renderer because constructing and mutating a material needs no
 * WebGL context.
 */
describe('CLAIM-RENDERER-RELEASES-GPU · the rim material', () => {
  it('is built once and reused, however the glow changes', () => {
    // The real assertion, through the hook the component uses. Written by
    // hand first — one material, 21 `applyRimUniforms` calls, assert there
    // is one material — which is true by construction and could not fail.
    //
    // `intensity` here walks the exact range `Planet.tsx` derives from
    // `contextUsagePct`, which is what every `context_update` moved.
    const rim = (pct: number): [string, number, number] => [
      '#8899ff',
      0.4 + (1 - pct / 100) * 0.8,
      3,
    ];
    const { result, rerender } = renderHook(
      ([c, i, p]: [string, number, number]) => useRimMaterial(c, i, p),
      { initialProps: rim(0) },
    );
    const first = result.current;

    for (let pct = 5; pct <= 100; pct += 5) rerender(rim(pct));

    expect(result.current, 'one material across 21 context updates').toBe(first);
  });

  it('releases the material when the planet leaves the galaxy', () => {
    const { result, unmount } = renderHook(() =>
      useRimMaterial('#8899ff', 1, 3),
    );
    let disposed = 0;
    result.current.addEventListener('dispose', () => {
      disposed += 1;
    });

    unmount();

    expect(disposed, 'three.js frees GPU resources only when told to').toBe(1);
  });

  it('keeps drawing the current values across a rerender', () => {
    const { result, rerender } = renderHook(
      ([c, i]: [string, number]) => useRimMaterial(c, i, 3),
      { initialProps: ['#ff0000', 0.5] as [string, number] },
    );
    rerender(['#00ff00', 1.2]);
    expect((result.current.uniforms.uColor!.value as Color).getHexString()).toBe(
      '00ff00',
    );
    expect(result.current.uniforms.uIntensity!.value).toBe(1.2);
  });

  it('actually changes what it draws', () => {
    // Reuse is only correct if the uniforms carry the change — otherwise
    // this "fix" would be a planet whose glow stopped responding.
    const m = createRimMaterial();
    applyRimUniforms(m, { color: '#ff0000', intensity: 0.5, power: 2 });
    expect((m.uniforms.uColor!.value as Color).getHexString()).toBe('ff0000');
    expect(m.uniforms.uIntensity!.value).toBe(0.5);
    expect(m.uniforms.uPower!.value).toBe(2);

    applyRimUniforms(m, { color: '#00ff00', intensity: 1.2, power: 4 });
    expect((m.uniforms.uColor!.value as Color).getHexString()).toBe('00ff00');
    expect(m.uniforms.uIntensity!.value).toBe(1.2);
    expect(m.uniforms.uPower!.value).toBe(4);
  });

  it('writes into the Color it already holds rather than replacing it', () => {
    // Keeps the uniform's identity stable, so three uploads a value instead
    // of treating it as a new binding.
    const m = createRimMaterial();
    const before = m.uniforms.uColor!.value as Color;
    applyRimUniforms(m, { color: '#123456', intensity: 1, power: 3 });
    expect(m.uniforms.uColor!.value).toBe(before);
  });

  it('can be disposed, and says so', () => {
    const m = createRimMaterial();
    let disposed = 0;
    m.addEventListener('dispose', () => {
      disposed += 1;
    });
    m.dispose();
    expect(disposed).toBe(1);
  });

  it('carries the shaders the rim needs', () => {
    // Guards the extraction: moving the shader source into a factory must
    // not quietly drop the back-side Fresnel that makes this a rim at all.
    const m = createRimMaterial();
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.fragmentShader).toContain('dot(vNormal, vViewDir)');
    expect(m.vertexShader).toContain('normalMatrix');
  });
});
