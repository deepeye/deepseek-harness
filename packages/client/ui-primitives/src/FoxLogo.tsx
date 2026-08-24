// SmartFox Harness fox mark: a hand-drawn geometric fox-head silhouette
// (symmetric ears + muzzle taper), single currentColor path. Native 22x18,
// rendered 24x19.64 by default; hero usage scales to 34.

import type { IconProps } from './icons/props.ts'

/**
 * Render the fox mark.
 * @param props.size - width in px (default 24; height keeps the 22:18 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the logo svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function FoxLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={(size * 18) / 22}
      className={className}
      viewBox="0 0 22 18"
      fill="none"
      aria-hidden="true"
    >
      <path d="M3 0.5L1.2 5.6L0.7 9.6L11 17.5L21.3 9.6L20.8 5.6L19 0.5L11 3.6Z" fill="currentColor"/>
    </svg>
  )
}
