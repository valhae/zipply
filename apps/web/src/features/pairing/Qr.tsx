import { useEffect, useState } from 'react';

/**
 * A QR code of a pairing code, drawn as one SVG path (no HTML strings). uqr loads on first use.
 * Always dark on white with a quiet zone, whatever the theme, because scanners expect that.
 */
export function Qr({ text, label }: { text: string; label: string }) {
  const [qr, setQr] = useState<{ size: number; d: string } | null>(null);

  useEffect(() => {
    let active = true;
    void import('uqr').then(({ encode }) => {
      const { size, data } = encode(text, { ecc: 'L', border: 4 });
      let d = '';
      data.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x} ${y}h1v1h-1z`)));
      if (active) setQr({ size, d });
    });
    return () => void (active = false);
  }, [text]);

  if (!qr) return <p className="text-[13px] text-gray-600">Drawing the QR code…</p>;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      className="aspect-square w-full max-w-[22rem] rounded-lg bg-white"
    >
      <path d={qr.d} fill="#000" />
    </svg>
  );
}
