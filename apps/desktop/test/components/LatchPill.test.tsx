import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LatchPill } from '../../src/renderer/components/LatchPill.js';

describe('LatchPill', () => {
  it('renders the "Waiting" label when state is waiting', () => {
    render(<LatchPill state="waiting" />);
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for game');
  });

  it('renders Connected when state is latched', () => {
    render(<LatchPill state="latched" />);
    expect(screen.getByRole('status')).toHaveTextContent('Connected');
  });

  it('uses the green palette when latched', () => {
    render(<LatchPill state="latched" />);
    const pill = screen.getByRole('status');
    expect(pill.className).toMatch(/bg-neon-green/);
    expect(pill.className).toMatch(/text-neon-green/);
  });

  it('stays neutral while waiting — waiting is not an error', () => {
    render(<LatchPill state="waiting" />);
    const pill = screen.getByRole('status');
    expect(pill.className).toMatch(/text-muted/);
    expect(pill.className).not.toMatch(/neon-pink/);
  });
});
