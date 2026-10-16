import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Rendered instead of the children when they throw. */
  fallback: ReactNode;
  /** Optional label used in the console warning. */
  label?: string;
}

interface State {
  failed: boolean;
}

/**
 * Catches render errors and swaps in a fallback.
 *
 * This exists because `<Suspense>` does NOT cover failures — only the pending
 * state. The scene wrapped its textured planets in Suspense with a procedural
 * fallback, which looks like graceful degradation but isn't: when a texture
 * failed to load, `useLoader` threw, the error sailed past Suspense, and with
 * no boundary anywhere in the app React unmounted the whole tree — the entire
 * UI, HUD included, went blank. Missing textures are an expected state (they
 * are fetched by a separate `prepare-assets` script and deliberately not
 * committed), so this has to be survivable.
 *
 * Pair it OUTSIDE a Suspense boundary: the inner Suspense absorbs the thrown
 * promise while loading, this catches a genuine failure.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Warn, don't rethrow — degrading is the point.
    console.warn(
      `[solix] ${this.props.label ?? 'component'} failed, using fallback:`,
      error.message,
      info.componentStack?.split('\n')[1]?.trim() ?? '',
    );
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
