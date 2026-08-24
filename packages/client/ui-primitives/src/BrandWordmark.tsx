// SmartFox brand wordmark: fox mark + "smartfox" text in one svg (120x24).
// Ink rides currentColor; the text rides the UI font with a fixed
// textLength so the width stays stable across platform fonts.

import type { IconProps } from './icons/props.ts'

/**
 * Render the full brand wordmark.
 * @param props.size - height in px (default 24; width keeps the 120:24 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className }: IconProps) {
  return (
    <svg
      width={(size * 120) / 24}
      height={size}
      className={className}
      viewBox="0 0 120 24"
      fill="none"
      aria-hidden="true"
    >
      {/* Fox mark (same drawing as FoxLogo) in the icon slot, 20 wide. */}
      <g transform="translate(1 3.82) scale(0.90909)">
        <path d="M3 0.5L1.2 5.6L0.7 9.6L11 17.5L21.3 9.6L20.8 5.6L19 0.5L11 3.6Z" fill="currentColor"/>
      </g>
      <text
        x="30"
        y="18.62"
        textLength="90"
        lengthAdjust="spacing"
        fontSize="19"
        fontWeight="600"
        fill="currentColor"
      >
        smartfox
      </text>
    </svg>
  )
}
