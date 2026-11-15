import { useEffect, useRef, useState } from 'react';

type Detect = (video: HTMLVideoElement) => Promise<string | null>;

interface NativeDetector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: {
      new (o: { formats: string[] }): NativeDetector;
      getSupportedFormats(): Promise<string[]>;
    };
  }
}

/** The browser's own QR detector where it exists; otherwise jsQR on a canvas frame, loaded on first use. */
async function detector(): Promise<Detect> {
  const Native = window.BarcodeDetector;
  if (
    Native &&
    (await Native.getSupportedFormats().catch((): string[] => [])).includes('qr_code')
  ) {
    const d = new Native({ formats: ['qr_code'] });
    return async (v) => (await d.detect(v))[0]?.rawValue ?? null;
  }
  const { default: jsQR } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return async (v) => {
    const scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight, 1));
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    if (!canvas.width || !canvas.height) return null;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return (
      jsQR(data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })?.data ?? null
    );
  };
}

/**
 * Camera QR scanner, only after the user pressed Scan. Frames stay on this device; the camera stops
 * when a Zipply code is found or the dialog closes. A found code only fills the field: the user
 * still presses the button that uses it (spec: nothing is accepted by scanning).
 */
export function Scanner({ onCode }: { onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const stop = () => {
      active = false;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (!active) return stop();
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const detect = await detector();
        const tick = async () => {
          const text = await detect(v).catch(() => null);
          if (!active) return;
          if (text?.startsWith('zipply1.')) {
            stop();
            onCode(text);
          } else timer = setTimeout(() => void tick(), 250);
        };
        void tick();
      } catch {
        if (active) setProblem(true);
        stop();
      }
    })();
    return stop;
  }, [onCode]);

  return problem ? (
    <p role="alert" className="text-[13px] text-gray-600">
      The camera is not available (no permission, no camera, or it is in use). Paste the code
      instead.
    </p>
  ) : (
    <>
      <video
        ref={video}
        muted
        playsInline
        className="aspect-square w-full rounded-lg bg-gray-100 object-cover"
      />
      <p className="mt-3 text-[13px] text-gray-600">
        Point the camera at the QR code on the other device. The picture stays on this device.
      </p>
    </>
  );
}
