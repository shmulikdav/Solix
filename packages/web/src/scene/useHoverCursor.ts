import { useEffect, useRef } from 'react';

/**
 * Pointer-cursor affordance for a clickable 3D object.
 *
 * Planets, advisors and skill-asteroids were all clickable but gave no hover
 * feedback — only the sun did — so in a scene where everything else is
 * decorative there was nothing to tell you three of the four object types were
 * interactive.
 *
 * Returns handlers to spread onto a `<mesh>`. Resets the cursor on unmount,
 * which is load-bearing here: scene objects disappear when a session
 * terminates, and an object unmounting under the pointer would otherwise leave
 * the cursor stuck as a pointer over empty space.
 */
export function useHoverCursor(): {
  onPointerOver: () => void;
  onPointerOut: () => void;
} {
  const hovering = useRef(false);

  useEffect(
    () => () => {
      if (hovering.current) document.body.style.cursor = '';
    },
    [],
  );

  return {
    onPointerOver: () => {
      hovering.current = true;
      document.body.style.cursor = 'pointer';
    },
    onPointerOut: () => {
      hovering.current = false;
      document.body.style.cursor = '';
    },
  };
}
