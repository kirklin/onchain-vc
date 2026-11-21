import { cn } from "cn";
import { useMemo } from "react";
import { encode } from "uqr";

/** A QR code drawn as one SVG path, black on white whatever the theme so that cameras can read it. */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { size, path } = useMemo(() => {
    const code = encode(value, { ecc: "M", border: 2 });
    const squares = code.data.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : "")));
    return { size: code.size, path: squares.join("") };
  }, [value]);

  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges" className={cn("rounded-xl", className)}>
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
