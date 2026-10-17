import { PROTOCOL_VERSION } from '@zipply/protocol';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ConnectionPanel } from './features/connection/ConnectionPanel';
import type { LinkSnapshot } from './features/connection/link';
import { iceServers } from './features/connection/peer';
import { RequestDialog } from './features/connection/RequestDialog';
import { createDiscovery, randomDisplayName } from './features/presence/discovery';
import { RoomControl } from './features/presence/RoomControl';
import { createRoom, readRoom } from './features/presence/room';
import { PeerDetails } from './features/radar/PeerDetails';
import { PeerList } from './features/radar/PeerList';
import { RadarView } from './features/radar/RadarView';
import { StatusBadge } from './features/radar/StatusBadge';
import { VisibilityControl } from './features/radar/VisibilityControl';
import { readDemo } from './features/radar/fixtures';
import { discoveryStatus, type Connection } from './features/radar/status';
import type { PeerState, RadarPeer } from './features/radar/types';
import { ThemeControl } from './features/settings/ThemeControl';
import { useTheme } from './features/settings/theme';
import { Button } from './ui/Button';
import { LiveRegion } from './ui/LiveRegion';
import { SectionHeader } from './ui/SectionHeader';

// Dev-only `?demo=` fixtures replace live discovery; production builds compile them out.
const demo = import.meta.env.DEV ? readDemo(window.location.search) : null;
const WIDTH = 'mx-auto w-full max-w-[56rem] px-4 sm:px-6';

function peerState(link: LinkSnapshot, peerId: string): PeerState {
  if (link.peerId !== peerId) return 'available';
  if (link.phase === 'session') return 'connected';
  return ['requesting', 'incoming', 'connecting'].includes(link.phase) ? 'pending' : 'available';
}

export default function App() {
  const [theme, setTheme] = useTheme();
  const [discoverable, setDiscoverable] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [displayName] = useState(randomDisplayName);
  const [badRoomLink, setBadRoomLink] = useState(false);
  const [discovery] = useState(() =>
    createDiscovery({
      url: import.meta.env.VITE_SIGNALING_URL as string | undefined,
      displayName,
      iceServers: iceServers(import.meta.env.VITE_STUN_URLS as string | undefined),
    }),
  );
  const live = useSyncExternalStore(discovery.subscribe, discovery.getSnapshot);

  useEffect(() => {
    if (demo) return;
    let active = true;
    void readRoom(window.location.hash).then((room) => {
      if (!active) return;
      // A room link that fails validation must not silently land the user in the public lobby.
      setBadRoomLink(!room && window.location.hash.startsWith('#room='));
      discovery.setRoom(room);
      discovery.start();
    });
    return () => {
      active = false;
      discovery.stop();
    };
  }, [discovery]);

  const { link } = live;
  const connection: Connection = demo?.connection ?? live.presence.status;
  const peers: RadarPeer[] =
    demo?.peers ??
    live.presence.peers.map((p) => ({
      id: p.peerId,
      name: p.displayName,
      state: peerState(link, p.peerId),
    }));
  const selected = peers.find((p) => p.id === selectedId) ?? null;
  const online = !demo && live.presence.status === 'online';

  const changeVisibility = (next: boolean) => {
    setDiscoverable(next);
    discovery.setDiscoverable(next);
    setAnnouncement(next ? 'You are now discoverable.' : 'You are now hidden.');
  };
  const enterRoom = async (create: boolean) => {
    const room = create ? await createRoom() : null;
    history.replaceState(
      null,
      '',
      room ? `#room=${room.capability}` : location.pathname + location.search,
    );
    setSelectedId(null);
    setBadRoomLink(false);
    discovery.setRoom(room);
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
            In development · you appear as {displayName}
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
            {!demo && (
              <RoomControl
                room={live.room}
                invalid={live.presence.roomInvalid || badRoomLink}
                onCreate={() => void enterRoom(true)}
                onLeave={() => void enterRoom(false)}
              />
            )}
          </section>

          <section aria-labelledby="discovery-heading" className="enter min-w-0 [--i:2]">
            <SectionHeader
              id="discovery-heading"
              index="02"
              title="discovery"
              meta={live.room ? 'private room' : 'online lobby · not location-based'}
            />
            {live.presence.unavailable && (
              <div role="alert" className="mb-6 rounded-2xl border border-gray-300 p-5">
                <p className="font-medium">Discovery temporarily unavailable</p>
                <p className="mt-2 text-[13px] text-gray-600">
                  The online service is not reachable or is over its free daily limit. Your files
                  never go through it. Zipply keeps retrying; pairing without the online service is
                  planned but not available yet.
                </p>
                <Button className="mt-4" onClick={discovery.retry}>
                  Retry now
                </Button>
              </div>
            )}
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

        {link.phase !== 'idle' && link.phase !== 'incoming' && (
          <section aria-labelledby="connection-heading" className="mt-14">
            <SectionHeader id="connection-heading" index="03" title="connection" />
            <ConnectionPanel
              link={link}
              onCancel={discovery.cancel}
              onDismiss={discovery.dismiss}
            />
          </section>
        )}
      </main>

      <footer className={`${WIDTH} flex h-16 items-center border-t border-gray-200`}>
        <p className="micro text-[10px] text-gray-500">protocol v{PROTOCOL_VERSION}</p>
      </footer>

      <PeerDetails
        peer={selected}
        canRequest={online && link.phase === 'idle'}
        onRequest={(files) => selected && discovery.request(selected.id, selected.name, files)}
        onClose={() => setSelectedId(null)}
      />
      <RequestDialog link={link} onAccept={discovery.accept} onDecline={discovery.decline} />
      <LiveRegion message={announcement} />
    </>
  );
}
