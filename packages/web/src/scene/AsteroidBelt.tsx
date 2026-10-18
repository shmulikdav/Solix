import { useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import {
  Color,
  type InstancedMesh,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import type { Skill } from '@solix/shared';
import { selectSkillsArray, useSolixStore } from '../store/index.js';
import { useHoverCursor } from './useHoverCursor.js';

const BELT_RADIUS = 22;
const BELT_THICKNESS = 1.6;
const TILT = 0.2;

function colorForSource(source: Skill['source']): Color {
  switch (source) {
    case 'anthropic':
      return new Color('#94a3b8');
    case 'solix':
      return new Color('#a855f7');
    case 'user':
      return new Color('#06b6d4');
    default:
      return new Color('#cbd5e1');
  }
}

interface AsteroidLayout {
  angle: number;
  radius: number;
  y: number;
  size: number;
  rot: Quaternion;
  color: Color;
  skill: Skill;
}

const TMP_OBJ = new Object3D();

export function AsteroidBelt(): JSX.Element | null {
  const hoverCursor = useHoverCursor();
  const skills = useSolixStore(selectSkillsArray);
  const selectSkill = useSolixStore((s) => s.selectSkill);
  const selectedSkillId = useSolixStore((s) => s.selectedSkillId);
  const meshRef = useRef<InstancedMesh>(null);

  const layout = useMemo<AsteroidLayout[]>(() => {
    return skills.map((skill, i) => {
      const angle = (i / Math.max(1, skills.length)) * Math.PI * 2;
      const jitter = ((skill.id.charCodeAt(0) ?? 0) % 13) / 13 - 0.5;
      const radius = BELT_RADIUS + jitter * BELT_THICKNESS;
      const y =
        Math.sin(angle * 1.7 + (skill.id.charCodeAt(1) ?? 0)) * 0.3 +
        Math.tan(TILT) * Math.sin(angle) * 0.4;
      const size = 0.18 + (skill.id.length % 5) * 0.04;
      const q = new Quaternion();
      q.setFromAxisAngle(new Vector3(1, 0.4, 0.1).normalize(), angle * 1.3);
      return {
        angle,
        radius,
        y,
        size,
        rot: q,
        color: colorForSource(skill.source),
        skill,
      };
    });
  }, [skills]);

  const driftRef = useRef(0);
  const spinRef = useRef(0);

  useFrame((_state, delta) => {
    if (!meshRef.current || !layout.length) return;
    const motionEnabled = useSolixStore.getState().motionEnabled;
    if (motionEnabled) {
      driftRef.current += delta * 0.04;
      spinRef.current += delta * 0.8;
    }
    const drift = driftRef.current;
    const spin = spinRef.current;
    for (let i = 0; i < layout.length; i++) {
      const item = layout[i]!;
      const angle = item.angle + drift;
      TMP_OBJ.position.set(
        Math.cos(angle) * item.radius,
        item.y,
        Math.sin(angle) * item.radius,
      );
      TMP_OBJ.quaternion.copy(item.rot);
      TMP_OBJ.rotateY(spin + i);
      const isSelected = selectedSkillId === item.skill.id;
      const scale = isSelected ? item.size * 1.6 : item.size;
      TMP_OBJ.scale.set(scale, scale, scale);
      TMP_OBJ.updateMatrix();
      meshRef.current.setMatrixAt(i, TMP_OBJ.matrix);
      meshRef.current.setColorAt(i, item.color);
    }
    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) {
      meshRef.current.instanceColor.needsUpdate = true;
    }
  });

  if (!layout.length) return null;

  const onClick = (e: ThreeEvent<MouseEvent>): void => {
    e.stopPropagation();
    const idx = e.instanceId;
    if (typeof idx !== 'number') return;
    const item = layout[idx];
    if (!item) return;
    selectSkill(item.skill.id);
  };

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, layout.length]}
      onClick={onClick}
      {...hoverCursor}
    >
      <icosahedronGeometry args={[1, 0]} />
      <meshStandardMaterial roughness={0.85} metalness={0.05} />
    </instancedMesh>
  );
}
