/**
 * A short two-note cue for hotkey toggles, so you can tell a cheat went on or
 * off without leaving the game: rising = on, falling = off, low buzz = failed.
 */
let ctx: AudioContext | null = null;

export function playToggleTone(kind: 'on' | 'off' | 'error'): void {
  try {
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    const notes = kind === 'on' ? [660, 990] : kind === 'off' ? [660, 440] : [180, 180];
    notes.forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = kind === 'error' ? 'square' : 'sine';
      osc.frequency.value = freq;
      const t = ctx!.currentTime + i * 0.09;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.085);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t);
      osc.stop(t + 0.09);
    });
  } catch { /* no audio device — the cue is optional */ }
}
