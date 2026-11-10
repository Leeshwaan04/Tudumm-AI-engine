/**
 * Tudumm mark: "two beats". A small saffron dot, then a larger one set higher and to the
 * right (ta… DUMM). Reads as a drum hit and a rising price.
 */
export function LogoMark({ size = 22, tile = false, title }: { size?: number; tile?: boolean; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className="logo-mark"
    >
      {tile && <rect width="32" height="32" rx="7" fill="#0A0B0D" />}
      <circle cx="9.6" cy="20.6" r="3.3" fill="#F5B841" opacity="0.78" />
      <circle cx="20.2" cy="12.8" r="6.4" fill="#F5B841" />
    </svg>
  );
}

export function Wordmark({ height = 24, withMark = true }: { height?: number; withMark?: boolean }) {
  // 120 x 32 canvas: mark at left, lowercase serif wordmark baseline-aligned
  const w = withMark ? 124 : 88;
  return (
    <svg
      height={height}
      width={(height / 32) * w}
      viewBox={`0 0 ${w} 32`}
      role="img"
      aria-label="tudumm"
      className="logo-word"
    >
      {withMark && (
        <g>
          <circle cx="8.6" cy="21.4" r="3" fill="#F5B841" opacity="0.78" />
          <circle cx="18.4" cy="13.8" r="5.8" fill="#F5B841" />
        </g>
      )}
      <text
        x={withMark ? 32 : 0}
        y="25"
        fill="#EEEAE0"
        fontFamily='"Instrument Serif", ui-serif, Georgia, serif'
        fontSize="29"
        letterSpacing="-0.3"
      >
        tudumm
      </text>
    </svg>
  );
}
