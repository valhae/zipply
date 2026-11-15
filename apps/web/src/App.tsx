import { PROTOCOL_VERSION } from '@zipply/protocol';
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { ConnectionPanel } from './features/connection/ConnectionPanel';
import type { LinkSnapshot } from './features/connection/link';
import { iceServers, stunHosts } from './features/connection/peer';
import { RequestDialog } from './features/connection/RequestDialog';
import {
  createDiscovery,
  forgetName,
  rememberName,
  storedName,
} from './features/presence/discovery';
import { createPairing } from './features/pairing/pairing';
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
import { LeftoverNotice } from './features/transfer/LeftoverNotice';
import { registerShell } from './features/settings/shell';
import { useTheme } from './features/settings/theme';
import { Button } from './ui/Button';
import { LiveRegion } from './ui/LiveRegion';
import { LockIcon } from './ui/LockIcon';
import { SectionHeader } from './ui/SectionHeader';

// Dev-only `?demo=` fixtures replace live discovery; production builds compile them out.
const demo = import.meta.env.DEV ? readDemo(window.location.search) : null;
const WIDTH = 'mx-auto w-full max-w-[56rem] px-4 sm:px-6';
const ICE = iceServers(import.meta.env.VITE_STUN_URLS as string | undefined);
const STUN = stunHosts(ICE);
// QR and camera code load only when local pairing is opened (spec: lazy QR modules).
const PairingPanel = lazy(() => import('./features/pairing/PairingPanel'));
const IDLE = ['idle', 'ended'];

const onlineEvents = (fn: () => void) => {
  addEventListener('online', fn);
  addEventListener('offline', fn);
  return () => {
    removeEventListener('online', fn);
    removeEventListener('offline', fn);
  };
};

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
  const [notVisible, setNotVisible] = useState(false);
  const [discovery] = useState(() =>
    createDiscovery({
      url: import.meta.env.VITE_SIGNALING_URL as string | undefined,
      customName: storedName(),
      iceServers: ICE,
    }),
  );
  const live = useSyncExternalStore(discovery.subscribe, discovery.getSnapshot);
  const [pairing] = useState(() => createPairing({ iceServers: ICE }));
  const paired = useSyncExternalStore(pairing.subscribe, pairing.getSnapshot);
  const [pairingOpen, setPairingOpen] = useState(false);
  const browserOnline = useSyncExternalStore(onlineEvents, () => navigator.onLine);
  const [applyUpdate, setApplyUpdate] = useState<(() => void) | null>(null);

  // P7-02: the offline shell exists only in production builds (the dev server has no sw.js).
  useEffect(() => {
    if (import.meta.env.PROD) registerShell((apply) => setApplyUpdate(() => apply));
  }, []);

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
  // One connection at a time: online and local pairing never run side by side.
  const pairingBusy = !IDLE.includes(paired.phase);
  const linkBusy = !IDLE.includes(link.phase);
  useEffect(() => {
    if (pairingBusy && link.phase === 'incoming') discovery.decline();
  }, [pairingBusy, link.phase, discovery]);
  const openPairing = () => {
    setPairingOpen(true);
    requestAnimationFrame(() => document.getElementById('pairing-heading')?.scrollIntoView?.());
  };

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
            {!demo && (connection === 'offline' || !browserOnline) && (
              <div role="alert" className="mb-6 rounded-2xl border border-gray-300 p-5">
                <p className="font-medium">
                  {browserOnline && live.presence.unavailable
                    ? 'Discovery temporarily unavailable'
                    : 'Offline — radar unavailable'}
                </p>
                <p className="mt-2 text-[13px] text-gray-600">
                  {browserOnline && live.presence.unavailable
                    ? 'The online service is not reachable or is over its free daily limit. Your files never go through it. Zipply keeps retrying.'
                    : 'The online service cannot be reached, so the radar cannot show anyone.'}{' '}
                  You can still try local pairing: you exchange a code with the other device
                  yourself.
                </p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button variant="primary" onClick={openPairing}>
                    Try local pairing
                  </Button>
                  {live.presence.unavailable && (
                    <Button onClick={discovery.retry}>Retry now</Button>
                  )}
                </div>
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
              <section
                aria-labelledby="local-pairing-card"
                className="rounded-2xl border border-gray-200 p-5"
              >
                <h3 id="local-pairing-card" className="font-medium">
                  Local pairing
                </h3>
                <p className="mt-2 text-[13px] text-gray-600">
                  Connect without the online service by exchanging a code or QR. Best effort: the
                  devices must reach each other directly.
                </p>
                <Button className="mt-4" onClick={openPairing}>
                  Try local pairing
                </Button>
              </section>
            )}
            {!demo && (
              <div className="rounded-2xl border border-gray-200 p-5">
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
            {notVisible && link.phase === 'session' && (
              <p role="alert" className="mb-4 text-[13px] text-gray-600">
                {link.peerName} is not visible right now. Ask them to keep Zipply open with
                Discoverable on, then press Reconnect again.
              </p>
            )}
            <ConnectionPanel
              link={link}
              onCancel={discovery.cancel}
              onDismiss={discovery.dismiss}
              onReconnect={() => setNotVisible(!discovery.reconnect())}
            />
          </section>
        )}
        {pairingOpen && (
          <section aria-labelledby="pairing-heading" className="mt-14">
            <SectionHeader id="pairing-heading" index="03" title="local pairing" />
            <Suspense fallback={<p className="text-[13px] text-gray-600">Loading…</p>}>
              <PairingPanel pairing={pairing} busy={linkBusy} />
            </Suspense>
            {!pairingBusy && paired.phase === 'idle' && (
              <Button className="mt-6" onClick={() => setPairingOpen(false)}>
                Close local pairing
              </Button>
            )}
          </section>
        )}
        {applyUpdate && (
          <div role="status" className="mt-14 rounded-2xl border border-gray-300 p-5">
            <p className="font-medium">A new version of Zipply is ready.</p>
            <p className="mt-2 text-[13px] text-gray-600">
              {linkBusy || pairingBusy
                ? 'Reloading would end the current connection, so finish or close it first.'
                : 'Reload to use it. Nothing you are sharing is affected.'}
            </p>
            <Button className="mt-4" disabled={linkBusy || pairingBusy} onClick={applyUpdate}>
              Reload
            </Button>
          </div>
        )}
        {!demo && <LeftoverNotice />}
      </main>

      <footer className={`${WIDTH} flex h-16 items-center border-t border-gray-200`}>
        <p className="micro text-[10px] text-gray-500">
          In development · protocol v{PROTOCOL_VERSION}
        </p>
      </footer>

      <PeerDetails
        peer={selected}
        stun={STUN}
        canRequest={online && link.phase === 'idle' && !pairingBusy}
        onRequest={(files) => selected && discovery.request(selected.id, selected.name, files)}
        onClose={() => setSelectedId(null)}
      />
      <RequestDialog
        link={link}
        stun={STUN}
        onAccept={discovery.accept}
        onDecline={discovery.decline}
      />
      <LiveRegion message={announcement} />
    </>
  );
}
