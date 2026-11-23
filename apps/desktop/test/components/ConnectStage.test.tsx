import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectStage, type ConnectPhase } from '../../src/renderer/components/ce/ConnectStage.js';
import type { CePickStep } from '../../src/shared/ipc.js';

const cover = { src: null, onError: () => {} };

function stage(phase: ConnectPhase, over: Partial<Parameters<typeof ConnectStage>[0]> = {}): void {
  render(<ConnectStage title="9 Kings" cover={cover} phase={phase} launched hasTable steps={[]} {...over} />);
}

describe('ConnectStage', () => {
  it('says what is happening and marks where that is in the sequence', () => {
    stage('connecting', { progress: 'Waiting for the game to finish loading…' });
    expect(screen.getByText('Waiting for the game to finish loading…')).toBeInTheDocument();
    const steps = within(screen.getByRole('list', { name: 'Progress' })).getAllByRole('listitem');
    expect(steps.map((s) => s.textContent)).toEqual(['Start game', 'Connect', 'Match a table']);
    expect(steps[1]).toHaveAttribute('aria-current', 'step');
  });

  it('leaves out the launch steps when attaching to a game that was already running', () => {
    stage('connecting', { launched: false });
    const steps = within(screen.getByRole('list', { name: 'Progress' })).getAllByRole('listitem');
    expect(steps.map((s) => s.textContent)).toEqual(['Connect', 'Match a table']);
    expect(steps[0]).toHaveAttribute('aria-current', 'step');
  });

  it('has no sequence to show for a single step', () => {
    stage('connecting', { launched: false, hasTable: false });
    expect(screen.queryByRole('list', { name: 'Progress' })).not.toBeInTheDocument();
  });

  it('shows each table with how it fared', () => {
    const steps: CePickStep[] = [
      { id: 30, filename: 'Game_v3.CT', state: 'broken' },
      { id: 20, filename: 'Game_v2.CT', state: 'checking' },
      { id: 10, filename: 'Game_v1.CT', state: 'waiting' },
    ];
    stage('matching', { steps });
    expect(screen.getByText('Finding a table that matches your game')).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: 'Tables being checked' })).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Game_v3.CT');
    expect(rows[0]).toHaveTextContent('different version');
    expect(rows[1]).toHaveTextContent('checking…');
    expect(rows[2]).toHaveTextContent(/^Game_v1\.CT$/);
  });

  it('prefers the session\'s own progress line while connecting', () => {
    stage('connecting', { progress: 'Downloading the table…' });
    expect(screen.getByText('Downloading the table…')).toBeInTheDocument();
  });

  it('offers Cancel only when there is something to cancel', async () => {
    const onCancel = vi.fn();
    stage('waiting', { onCancel });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
