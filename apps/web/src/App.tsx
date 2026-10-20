import { PROTOCOL_VERSION } from '@zipply/protocol';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ConnectionPanel } from './features/connection/ConnectionPanel';
import type { LinkSnapshot } from './features/connection/link';
import { iceServers } from './features/connection/peer';
import { RequestDialog } from './features/connection/RequestDialog';
import {
  createDiscovery,
  forgetName,
  rememberName,
  storedName,
} from './features/presence/discovery';
import { NameControl } from './features/presence/NameControl';
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
import { LockIcon } from './ui/LockIcon';
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
  const [announcement, setAnnouncement] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [badRoomLink, setBadRoomLink] = useState(false);
  const [discovery] = useState(() =>
    createDiscovery({
      url: import.meta.env.VITE_SIGNALING_URL as string | undefined,
      customName: storedName(),
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

  const { discoverable, name } = live;
  const changeVisibility = (next: boolean) => {
    discovery.setDiscoverable(next);
    setAnnouncement(next ? 'You are now discoverable.' : 'You are now hidden.');
  };
  const rename = (next: string) => {
    rememberName(next);
    discovery.setDisplayName(next);
    setAnnouncement(`You now appear as ${next}.`);
  };
  const randomName = () => {
    forgetName();
    discovery.randomName();
    setAnnouncement('You now have a new random name.');
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
        <section className="enter pt-8 pb-6 text-center [--i:0] sm:pt-10">
          <h1 className="font-pixel text-4xl leading-none lowercase sm:text-5xl">zipply</h1>
          <p className="mt-3 text-[15px] text-gray-600">
            Private file sharing, directly between browsers.
          </p>
        </section>

        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-12">
          <section aria-labelledby="discovery-heading" className="enter min-w-0 [--i:1]">
            <SectionHeader
              id="discovery-heading"
              index="01"
              title="radar"
              meta={
                live.room ? (
                  <>
                    <LockIcon className="-mt-0.5 mr-1 size-3" /> private room
                  </>
                ) : (
                  'online lobby · not location-based'
                )
              }
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
            <div className="overflow-hidden rounded-2xl border border-gray-200 px-4 pt-8 pb-10 shadow-card sm:px-8">
              <RadarView
                peers={peers}
                selectedId={selectedId}
                onSelect={setSelectedId}
                scanning={connection !== 'offline'}
              />
              <p className="micro mt-10 text-center text-[10px] text-gray-500">
                Tap a dot or a name below to send files
              </p>
            </div>
          </section>

          <section
            aria-labelledby="visibility-heading"
            className="enter grid min-w-0 gap-4 [--i:2] sm:grid-cols-2 lg:sticky lg:top-24 lg:row-span-2 lg:grid-cols-1"
          >
            <h2 id="visibility-heading" className="sr-only">
              Your visibility
            </h2>
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
            {!demo && (
              <div className="rounded-2xl border border-gray-200 p-5 sm:col-span-2 lg:col-span-1">
                <NameControl
                  name={name}
                  custom={live.customName}
                  taken={live.presence.nameTaken}
                  busy={!['idle', 'ended'].includes(link.phase)}
                  onChange={rename}
                  onRandom={randomName}
                />
              </div>
            )}
          </section>

          <section
            aria-labelledby="people-heading"
            className="enter min-w-0 [--i:3] lg:col-start-1"
          >
            <div className="mb-2 flex items-baseline justify-between">
              <h2 id="people-heading" className="micro text-[10px] text-gray-600">
                People
              </h2>
              <span className="micro text-[10px] text-gray-500">{peers.length}</span>
            </div>
            <PeerList
              peers={peers}
              selectedId={selectedId}
              onSelect={setSelectedId}
              locked={!!live.room}
            />
          </section>
        </div>

        {link.phase !== 'idle' && link.phase !== 'incoming' && (
          <section aria-labelledby="connection-heading" className="mt-14">
            <SectionHeader id="connection-heading" index="02" title="connection" />
            <ConnectionPanel
              link={link}
              onCancel={discovery.cancel}
              onDismiss={discovery.dismiss}
            />
          </section>
        )}
      </main>

      <footer className={`${WIDTH} flex h-16 items-center border-t border-gray-200`}>
        <p className="micro text-[10px] text-gray-500">
          In development · protocol v{PROTOCOL_VERSION}
        </p>
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
