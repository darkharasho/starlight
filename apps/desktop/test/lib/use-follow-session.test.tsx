import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { useFollowSession } from '../../src/renderer/lib/use-follow-session.js';

function Harness(): JSX.Element {
  const [id, setId] = useState<string | null>(null);
  useFollowSession(id);
  const navigate = useNavigate();
  const loc = useLocation();
  return (
    <div>
      <span data-testid="path">{loc.pathname}</span>
      <button onClick={() => setId('s1')}>start</button>
      <button onClick={() => setId('s2')}>start2</button>
      <button onClick={() => { navigate('/active'); setId('s3'); }}>open</button>
      <button onClick={() => navigate('/library')}>leave</button>
      <button onClick={() => navigate(-1)}>back</button>
    </div>
  );
}

describe('useFollowSession', () => {
  it('opens the game screen when a session starts', () => {
    render(<MemoryRouter initialEntries={['/']}><Harness /></MemoryRouter>);
    fireEvent.click(screen.getByText('start'));
    expect(screen.getByTestId('path')).toHaveTextContent('/active');
  });

  it('lets you leave the game screen while the session is still open', () => {
    render(<MemoryRouter initialEntries={['/']}><Harness /></MemoryRouter>);
    fireEvent.click(screen.getByText('start'));
    fireEvent.click(screen.getByText('leave'));
    expect(screen.getByTestId('path')).toHaveTextContent('/library');
    fireEvent.click(screen.getByText('back'));
    fireEvent.click(screen.getByText('back'));
    expect(screen.getByTestId('path')).toHaveTextContent('/');
  });

  it('follows a new session even after you left the previous one', () => {
    render(<MemoryRouter initialEntries={['/']}><Harness /></MemoryRouter>);
    fireEvent.click(screen.getByText('start'));
    fireEvent.click(screen.getByText('leave'));
    fireEvent.click(screen.getByText('start2'));
    expect(screen.getByTestId('path')).toHaveTextContent('/active');
  });

  it('does not stack a second game-screen entry when you opened the game yourself', () => {
    render(<MemoryRouter initialEntries={['/']}><Harness /></MemoryRouter>);
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByTestId('path')).toHaveTextContent('/active');
    fireEvent.click(screen.getByText('back'));
    expect(screen.getByTestId('path')).toHaveTextContent(/^\/$/);
  });
});
