import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToggleCheatCard } from '../../src/renderer/components/cheat-cards/ToggleCheatCard.js';
import { ValueCheatCard } from '../../src/renderer/components/cheat-cards/ValueCheatCard.js';
import { UnsupportedCheatCard } from '../../src/renderer/components/cheat-cards/UnsupportedCheatCard.js';

describe('ToggleCheatCard', () => {
  it('shows the cheat name and description', () => {
    render(<ToggleCheatCard id="x" name="Infinite HP" description="Freezes HP." active={false} hotkey="F1" onToggle={() => {}} onRebindHotkey={() => {}} onResetHotkey={() => {}} />);
    expect(screen.getByText('Infinite HP')).toBeInTheDocument();
    expect(screen.getByText('Freezes HP.')).toBeInTheDocument();
  });

  it('shows the hotkey badge', () => {
    render(<ToggleCheatCard id="x" name="X" active={false} hotkey="F1" onToggle={() => {}} onRebindHotkey={() => {}} onResetHotkey={() => {}} />);
    expect(screen.getByText('F1')).toBeInTheDocument();
  });

  it('calls onToggle when the toggle is clicked', async () => {
    const handler = vi.fn();
    render(<ToggleCheatCard id="x" name="X" active={false} hotkey="F1" onToggle={handler} onRebindHotkey={() => {}} onResetHotkey={() => {}} />);
    await userEvent.click(screen.getByRole('switch'));
    expect(handler).toHaveBeenCalledWith('x', true);
  });

  it('renders as active when active=true', () => {
    render(<ToggleCheatCard id="x" name="X" active hotkey="F1" onToggle={() => {}} onRebindHotkey={() => {}} onResetHotkey={() => {}} />);
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });
});

describe('ValueCheatCard', () => {
  const props = {
    id: 'speed', name: 'Speed', description: '1.0 = normal',
    active: false, value: 1.5, step: 0.1, min: 0.1, max: 10,
    hotkeys: { toggle: 'F4', inc: 'PageUp', dec: 'PageDown' },
  };

  it('renders the current value', () => {
    render(<ValueCheatCard {...props} onToggle={() => {}} onValueChange={() => {}} onRebindHotkey={() => {}} onResetHotkey={() => {}} />);
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('1.5');
  });

  it('clamps when the user clicks +', async () => {
    const handler = vi.fn();
    render(<ValueCheatCard {...{ ...props, value: 9.95 }} onToggle={() => {}} onValueChange={handler} onRebindHotkey={() => {}} onResetHotkey={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: '+' }));
    expect(handler).toHaveBeenCalledWith('speed', 10);
  });

  it('renders all three hotkeys', () => {
    render(<ValueCheatCard {...props} onToggle={() => {}} onValueChange={() => {}} onRebindHotkey={() => {}} onResetHotkey={() => {}} />);
    expect(screen.getByText('F4')).toBeInTheDocument();
    expect(screen.getByText('PageUp')).toBeInTheDocument();
    expect(screen.getByText('PageDown')).toBeInTheDocument();
  });
});

describe('UnsupportedCheatCard', () => {
  it('shows the UNSUPPORTED badge and reason', () => {
    render(<UnsupportedCheatCard id="x" name="Auto-Block" reason="Uses Cheat Engine Lua API." />);
    expect(screen.getByText(/UNSUPPORTED/)).toBeInTheDocument();
    expect(screen.getByText(/Lua/i)).toBeInTheDocument();
  });
});
