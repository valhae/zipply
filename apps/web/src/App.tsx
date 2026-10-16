import { PROTOCOL_VERSION } from '@zipply/protocol';
import { useState } from 'react';
import { PeerDetails } from './features/radar/PeerDetails';
import { PeerList } from './features/radar/PeerList';
import { RadarView } from './features/radar/RadarView';
import { StatusBadge } from './features/radar/StatusBadge';
import { VisibilityControl } from './features/radar/VisibilityControl';
import { readDemo } from './features/radar/fixtures';
import { discoveryStatus, type Connection } from './features/radar/status';
import type { RadarPeer } from './features/radar/types';
import { ThemeControl } from './features/settings/ThemeControl';
import { useTheme } from './features/settings/theme';
import { LiveRegion } from './ui/LiveRegion';
import { SectionHeader } from './ui/SectionHeader';

// Until online discovery exists (Phase 4) the app is truthfully offline with no peers.
const demo = import.meta.env.DEV ? readDemo(window.location.search) : null;
const peers: RadarPeer[] = demo?.peers ?? [];
const connection: Connection = demo?.connection ?? 'offline';
const WIDTH = 'mx-auto w-full max-w-[56rem] px-4 sm:px-6';

export default function App() {
  const [theme, setTheme] = useTheme();
  const [discoverable, setDiscoverable] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = peers.find((p) => p.id === selectedId) ?? null;

  const changeVisibility = (next: boolean) => {
    setDiscoverable(next);
    setAnnouncement(next ? 'You are now discoverable.' : 'You are now hidden.');
  };

  return (
    <>
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-bg/85 pt-[env(safe-area-inset-top)] backdrop-blur-md">
        <div className={`${WIDTH} flex h-14 items-center justify-between gap-3`}>
          <StatusBadge status={discoveryStatus(connection, discoverable)} />
          <ThemeControl value={theme} onChange={setTheme} />
        </div>
      </header>

      <main className={`${WIDTH} pb-20`}>
        <section className="enter py-14 [--i:0] sm:py-20">
          <h1 className="font-pixel text-5xl leading-none lowercase sm:text-6xl">zipply</h1>
          <p className="mt-5 max-w-md text-[17px] leading-relaxed text-gray-600">
            Private file sharing, directly between browsers.
          </p>
          <p className="micro mt-4 text-[10px] text-gray-500">
            In development{connection === 'offline' && ' · online discovery isn’t available yet'}
          </p>
        </section>

        <div className="grid items-start gap-14 lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-16">
          <section
            aria-labelledby="visibility-heading"
            className="enter min-w-0 [--i:1] lg:sticky lg:top-24"
          >
            <SectionHeader id="visibility-heading" index="01" title="visibility" />
            <VisibilityControl
              discoverable={discoverable}
              online={connection === 'online'}
              onChange={changeVisibility}
            />
          </section>

          <section aria-labelledby="discovery-heading" className="enter min-w-0 [--i:2]">
            <SectionHeader
              id="discovery-heading"
              index="02"
              title="discovery"
              meta="online lobby · not location-based"
            />
            <div className="relative overflow-hidden rounded-2xl border border-gray-200 px-6 pt-10 pb-12 shadow-card">
              <div
                aria-hidden="true"
                className="halftone absolute top-0 right-0 size-48 opacity-60 [mask-image:radial-gradient(circle_at_top_right,black,transparent_70%)]"
              />
              <RadarView
                peers={peers}
                selectedId={selectedId}
                scanning={connection !== 'offline'}
              />
            </div>
            <div className="mt-10">
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="micro text-[10px] text-gray-600">People</h3>
                <span className="micro text-[10px] text-gray-500">{peers.length}</span>
              </div>
              <PeerList peers={peers} selectedId={selectedId} onSelect={setSelectedId} />
            </div>
          </section>
        </div>
      </main>

      <footer className={`${WIDTH} flex h-16 items-center border-t border-gray-200`}>
        <p className="micro text-[10px] text-gray-500">protocol v{PROTOCOL_VERSION}</p>
      </footer>

      <PeerDetails peer={selected} onClose={() => setSelectedId(null)} />
      <LiveRegion message={announcement} />
    </>
  );
}
