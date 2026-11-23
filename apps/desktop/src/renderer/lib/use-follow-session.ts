import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Opens the game screen when a new session starts — once per session.
 * `navigate` changes identity on every location change in react-router v6,
 * so it must not be an effect dependency: that re-ran the redirect whenever
 * you left the game screen and bounced you straight back.
 * Skips the push when you're already on the game screen (the game tile
 * navigates there itself), so Back doesn't need two clicks.
 */
export function useFollowSession(sessionId: string | null): void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const navRef = useRef(navigate);
  const pathRef = useRef(pathname);
  navRef.current = navigate;
  pathRef.current = pathname;
  useEffect(() => {
    if (sessionId && pathRef.current !== '/active') navRef.current('/active');
  }, [sessionId]);
}
