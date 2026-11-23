import type { GameOwner } from './game-owner.js';

let owner: GameOwner | null = null;

export function setGameOwner(o: GameOwner): void { owner = o; }

export function getGameOwner(): GameOwner {
  if (!owner) throw new Error('game owner not initialised');
  return owner;
}
