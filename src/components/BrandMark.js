// The Amlak mark — a pointed archway (a portal) cut into an olive tile.
//
// This is the SAME artwork as public/favicon.svg. Keep the two in step: the tab
// icon and the in-app mark should never drift into two slightly different logos.
// Pure geometry, no <text> and no font — a favicon SVG can't load a webfont, so
// the mark has to survive as paths.
//
// Drawn on a 32-unit grid so every unit lands on one device pixel at browser-tab
// size, then scales cleanly up to 512.
export default function BrandMark({ size = 30, title = 'Amlak' }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role="img"
      aria-label={title}
      focusable="false"
    >
      <rect width="32" height="32" rx="2.5" fill="#5C6B3C" />
      {/* the arch */}
      <path
        fill="#FBF8F1"
        d="M7.0 26.8 L7.0 16.2 C7.0 10.2 13.4 7.0 16 4.4 C18.6 7.0 25.0 10.2 25.0 16.2 L25.0 26.8 Z"
      />
      {/* the doorway cut back out of it */}
      <path
        fill="#5C6B3C"
        d="M12.2 26.8 L12.2 20.0 C12.2 17.2 15.0 15.2 16 12.9 C17.0 15.2 19.8 17.2 19.8 20.0 L19.8 26.8 Z"
      />
    </svg>
  );
}
