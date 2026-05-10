import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotkeyCapture } from '../../src/renderer/components/HotkeyCapture.js';

describe('HotkeyCapture', () => {
  it('shows the current accelerator when not capturing', () => {
    render(
      <HotkeyCapture value="F4" onCapture={() => {}} onReset={() => {}} />,
    );
    expect(screen.getByText('F4')).toBeInTheDocument();
  });

  it('clicking enters capture mode', async () => {
    render(
      <HotkeyCapture value="F4" onCapture={() => {}} onReset={() => {}} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /edit hotkey/i }));
    expect(screen.getByText(/press a key/i)).toBeInTheDocument();
  });

  it('captures next keypress and calls onCapture', async () => {
    const onCapture = vi.fn();
    render(
      <HotkeyCapture value="F4" onCapture={onCapture} onReset={() => {}} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /edit hotkey/i }));
    await userEvent.keyboard('{F5}');
    expect(onCapture).toHaveBeenCalledWith('F5');
  });

  it('Escape cancels capture mode without calling onCapture', async () => {
    const onCapture = vi.fn();
    render(
      <HotkeyCapture value="F4" onCapture={onCapture} onReset={() => {}} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /edit hotkey/i }));
    await userEvent.keyboard('{Escape}');
    expect(onCapture).not.toHaveBeenCalled();
    expect(screen.getByText('F4')).toBeInTheDocument();
  });

  it('Reset button calls onReset', async () => {
    const onReset = vi.fn();
    render(
      <HotkeyCapture value="F4" onCapture={() => {}} onReset={onReset} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /reset hotkey/i }));
    expect(onReset).toHaveBeenCalled();
  });

  it('renders "(none)" when value is null', () => {
    render(
      <HotkeyCapture value={null} onCapture={() => {}} onReset={() => {}} />,
    );
    expect(screen.getByText(/\(none\)/i)).toBeInTheDocument();
  });
});
