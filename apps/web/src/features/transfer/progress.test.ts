// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRate } from './progress';

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('createRate (P6-09)', () => {
  it('has no speed or ETA until there are measurements', () => {
    const c = clock();
    const rate = createRate(c.now);
    expect(rate.stats(100)).toEqual({ speed: null, average: null, eta: null });
    rate.add(0);
    expect(rate.stats(100)).toEqual({ speed: null, average: null, eta: null });
  });

  it('reports speed and average, but no ETA before 5 s of steady data', () => {
    const c = clock();
    const rate = createRate(c.now);
    for (let s = 0; s <= 4; s++) {
      rate.add(s * 1000);
      c.advance(1000);
    }
    expect(rate.stats(10_000)).toEqual({ speed: 1000, average: 1000, eta: null });
  });

  it('gives an ETA from the rolling average once the rate is steady', () => {
    const c = clock();
    const rate = createRate(c.now);
    for (let s = 0; s <= 6; s++) {
      rate.add(s * 1000);
      if (s < 6) c.advance(1000);
    }
    expect(rate.stats(9000)).toEqual({ speed: 1000, average: 1000, eta: 9 });
  });

  it('withholds the ETA while the current speed is far from the average', () => {
    const c = clock();
    const rate = createRate(c.now);
    let bytes = 0;
    for (let s = 0; s <= 8; s++) {
      rate.add(bytes);
      bytes += s < 6 ? 1000 : 100; // sudden slowdown
      c.advance(1000);
    }
    expect(rate.stats(10_000).eta).toBeNull();
  });

  it('averages over a rolling 10 s window', () => {
    const c = clock();
    const rate = createRate(c.now);
    for (let s = 0; s <= 30; s++) {
      rate.add(s < 15 ? s * 100 : 1400 + (s - 14) * 1000);
      c.advance(1000);
    }
    expect(rate.stats(0).average).toBe(1000);
  });

  it('starts again after reset (a resume jumps the byte count)', () => {
    const c = clock();
    const rate = createRate(c.now);
    rate.add(0);
    c.advance(1000);
    rate.add(1000);
    rate.reset();
    rate.add(50_000);
    expect(rate.stats(1).speed).toBeNull();
  });
});
