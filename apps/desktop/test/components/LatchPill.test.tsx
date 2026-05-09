import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LatchPill } from '../../src/renderer/components/LatchPill.js';

describe('LatchPill', () => {
  it('renders the "Waiting" label when state is waiting', () => {
    render(<LatchPill state="waiting" />);
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for game');
  });

  it('renders LATCHED when state is latched', () => {
    render(<LatchPill state="latched" />);
    expect(screen.getByRole('status')).toHaveTextContent('LATCHED');
  });

  it('uses the green palette when latched', () => {
    render(<LatchPill state="latched" />);
    const pill = screen.getByRole('status');
    expect(pill.className).toMatch(/border-neon-green/);
    expect(pill.className).toMatch(/text-neon-green/);
  });

  it('uses the pink palette when waiting', () => {
    render(<LatchPill state="waiting" />);
    const pill = screen.getByRole('status');
    expect(pill.className).toMatch(/border-neon-pink/);
  });
});
