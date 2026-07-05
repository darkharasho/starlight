import { create } from 'zustand';

export interface Detected {
  game: { id: string; name: string; steamAppId?: number | null };
  pid: number;
  name: string;
  confidence: 'exact' | 'name';
}

interface DetectionState {
  detected: Detected | null;
  setDetected: (d: Detected) => void;
  clear: () => void;
}

export const useDetectionStore = create<DetectionState>((set) => ({
  detected: null,
  setDetected: (d) => set({ detected: d }),
  clear: () => set({ detected: null }),
}));
