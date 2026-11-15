import { describe, expect, it, vi } from 'vitest';
import { registerShell } from './shell';

/** A fake ServiceWorkerContainer and registration, enough for the update flow. */
function fake({ controlled = true, waiting = false } = {}) {
  const posted: unknown[] = [];
  const worker = (state: string) =>
    Object.assign(new EventTarget(), { state, postMessage: (m: unknown) => posted.push(m) });
  const reg = Object.assign(new EventTarget(), {
    waiting: waiting ? worker('installed') : null,
    installing: null as ReturnType<typeof worker> | null,
  });
  const sw = Object.assign(new EventTarget(), {
    controller: controlled ? {} : null,
    register: vi.fn(async () => reg),
  });
  /** A new version finishes installing while this page is open. */
  const install = () => {
    const w = worker('installing');
    reg.installing = w;
    reg.dispatchEvent(new Event('updatefound'));
    w.state = 'installed';
    reg.waiting = w;
    w.dispatchEvent(new Event('statechange'));
  };
  return { sw: sw as unknown as ServiceWorkerContainer, reg, posted, install };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('registerShell (P7-02)', () => {
  it('registers /sw.js and offers nothing on the first install', async () => {
    const f = fake({ controlled: false });
    const onUpdate = vi.fn();
    registerShell(onUpdate, f.sw, vi.fn());
    await flush();
    expect(f.sw.register).toHaveBeenCalledWith('/sw.js');
    f.install();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('offers an update when a new version waits, and never applies it by itself', async () => {
    const f = fake();
    const onUpdate = vi.fn();
    const reload = vi.fn();
    registerShell(onUpdate, f.sw, reload);
    await flush();
    f.install();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(f.posted).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a version already waiting at load is offered too', async () => {
    const f = fake({ waiting: true });
    const onUpdate = vi.fn();
    registerShell(onUpdate, f.sw, vi.fn());
    await flush();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('applying it activates the waiting version, then reloads once it controls the page', async () => {
    const f = fake();
    const reload = vi.fn();
    let apply = () => {};
    registerShell((a) => (apply = a), f.sw, reload);
    await flush();
    f.install();
    apply();
    expect(f.posted).toEqual(['skip-waiting']);
    expect(reload).not.toHaveBeenCalled();
    f.sw.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing without service worker support, or if registration fails', async () => {
    expect(() => registerShell(vi.fn(), undefined, vi.fn())).not.toThrow();
    const f = fake();
    (f.sw.register as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('blocked'));
    registerShell(vi.fn(), f.sw, vi.fn());
    await flush();
  });
});
