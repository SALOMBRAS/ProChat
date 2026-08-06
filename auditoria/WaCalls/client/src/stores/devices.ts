import { create } from "zustand";

type State = {
  micId: string | null;
  outId: string | null;
  setMic: (id: string) => void;
  setOut: (id: string) => void;
};

export const useDevices = create<State>((set) => ({
  micId: null,
  outId: null,
  setMic: (id) => set({ micId: id || null }),
  setOut: (id) => set({ outId: id || null }),
}));
