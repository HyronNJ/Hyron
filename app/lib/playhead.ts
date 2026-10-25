import { useSyncExternalStore } from "react";

/** Shared fractional-hour playhead. */
export type Playhead = {
  get: () => number;
  set: (t: number) => void;
  subscribe: (fn: () => void) => () => void;
};
export function createPlayhead(initial = 0): Playhead {
  let t = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => t,
    set: (next) => {
      if (next === t || !Number.isFinite(next)) return;
      t = next;
      listeners.forEach((fn) => fn());
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
export function usePlayhead(playhead: Playhead) {
  return useSyncExternalStore(playhead.subscribe, playhead.get, playhead.get);
}
