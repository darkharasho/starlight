import type { Session } from './session.js';
import type { SpeedStatus } from './types.js';

/**
 * Sets the game's clock speed (0.1 to 10). The timing hooks stay installed at 1.0 as a
 * pass-through, so game time never jumps; the original bytes come back when the session ends
 * (detach, connection drop or daemon exit).
 */
export async function setSpeed(s: Session, speed: number): Promise<SpeedStatus> {
  return s.client.call('speed_set', { handle: s.handle, speed });
}

export async function getSpeed(s: Session): Promise<SpeedStatus> {
  return s.client.call('speed_get', { handle: s.handle });
}
