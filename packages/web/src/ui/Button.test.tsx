// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Button } from './Button.js';

afterEach(cleanup);

describe('Button', () => {
  it('maps each variant to its semantic token', () => {
    const cases: Array<[Parameters<typeof Button>[0]['variant'], string]> = [
      ['warn', 'solix-warn'],
      ['danger', 'solix-danger'],
      ['ok', 'solix-ok'],
      ['primary', 'solix-accent'],
      ['neutral', 'slate-'],
    ];
    for (const [variant, token] of cases) {
      const { container } = render(<Button variant={variant}>Go</Button>);
      expect(container.querySelector('button')!.className).toContain(token);
      cleanup();
    }
  });

  // The pattern this exists to own: a busy button that still looks idle, or
  // still takes clicks, is how a double-dispatch happens.
  it('busy swaps the label, disables, and announces itself', () => {
    const onClick = vi.fn();
    render(
      <Button busy busyLabel="Saving…" onClick={onClick}>
        Save
      </Button>,
    );
    const btn = screen.getByRole('button');
    expect(btn.textContent).toBe('Saving…');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is not marked busy when idle', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button').getAttribute('aria-busy')).toBeNull();
  });

  // Was opacity-40 in most panels and opacity-50 in others.
  it('uses one disabled treatment', () => {
    render(<Button disabled>Save</Button>);
    expect(screen.getByRole('button').className).toContain('disabled:opacity-40');
  });
});
