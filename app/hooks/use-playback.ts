import { useEffect, useMemo, useState } from "react";
import { createPlayhead } from "@/lib/playhead";
import { reducedMotion } from "@/lib/prefs";

export function usePlayback(count: number) {
  const playhead = useMemo(() => createPlayhead(0), []);
  const [hour, setHour] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => playhead.subscribe(() => setHour(Math.round(playhead.get()))), [playhead]);
  useEffect(() => {
    if (playhead.get() > Math.max(0, count - 1)) playhead.set(0);
  }, [count, playhead]);
  useEffect(() => {
    if (!playing || count < 2) return;
    if (reducedMotion()) {
      const timer = setInterval(() => {
        const current = Math.round(playhead.get());
        playhead.set(current >= count - 1 ? 0 : current + 1);
      }, 900);
      return () => clearInterval(timer);
    }
    let frame = 0;
    let previous = performance.now();
    let held = 0;
    function advance(now: number) {
      const elapsed = Math.min(100, now - previous);
      previous = now;
      const position = playhead.get();
      if (position >= count - 1) {
        held += elapsed;
        if (held > 700) {
          playhead.set(0);
          held = 0;
        }
      } else {
        playhead.set(Math.min(count - 1, position + elapsed / 750));
      }
      frame = requestAnimationFrame(advance);
    }
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
  }, [playing, count, playhead]);

  function selectHour(next: number) {
    setPlaying(false);
    playhead.set(Math.max(0, Math.min(Math.max(0, count - 1), next)));
  }

  function reset(hour = 0) {
    setPlaying(false);
    playhead.set(hour);
  }

  return {
    hour,
    playing,
    playhead,
    selectHour,
    reset,
    toggle: () => setPlaying((current) => !current),
  };
}
