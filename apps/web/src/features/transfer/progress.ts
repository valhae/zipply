const WINDOW_MS = 10_000;
const SPEED_MS = 2000;
const ETA_AFTER_MS = 5000;

/**
 * Transfer rate from confirmed byte counts (P6-09): current speed over ~2 s, a rolling 10 s
 * average, and an ETA only after 5 s and while the speed stays within half of the average.
 */
export function createRate(now: () => number = Date.now) {
  let samples: { t: number; bytes: number }[] = [];
  let start = 0;

  return {
    reset() {
      samples = [];
    },
    add(bytes: number) {
      const t = now();
      if (samples.length === 0) start = t;
      samples.push({ t, bytes });
      while (samples.length > 2 && samples[1]!.t <= t - WINDOW_MS) samples.shift();
    },
    /** Bytes per second; `eta` in seconds for `remaining` bytes. */
    stats(remaining: number) {
      const last = samples.at(-1);
      if (!last || samples.length < 2) return { speed: null, average: null, eta: null };
      const per = (a: { t: number; bytes: number }) =>
        last.t > a.t ? ((last.bytes - a.bytes) * 1000) / (last.t - a.t) : 0;
      const average = per(samples[0]!);
      let i = samples.findIndex((s) => s.t >= last.t - SPEED_MS);
      if (i === samples.length - 1) i--;
      const speed = per(samples[i]!);
      const steady =
        last.t - start >= ETA_AFTER_MS && average > 0 && Math.abs(speed - average) <= average / 2;
      return { speed, average, eta: steady ? Math.round(remaining / average) : null };
    },
  };
}
