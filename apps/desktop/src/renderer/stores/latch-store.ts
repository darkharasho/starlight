import { create } from 'zustand';

interface LatchStore { state: 'idle' | 'waiting' | 'detected' | 'latched' }

export const useLatchState = create<LatchStore>(() => ({ state: 'waiting' }));
