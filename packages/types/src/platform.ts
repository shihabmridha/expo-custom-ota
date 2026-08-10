/** The only two platforms the Expo Updates protocol recognises. */
export const PLATFORMS = ['ios', 'android'] as const;

export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);
}
