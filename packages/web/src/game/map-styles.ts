/**
 * Map style constants and URL resolution for OpenFreeMap.
 */

export const OPENFREEMAP_STYLES = [
  { key: 'liberty', label: 'Liberty' },
  { key: 'bright', label: 'Bright' },
  { key: 'positron', label: 'Positron' },
  { key: 'dark-matter', label: 'Dark Matter' },
] as const;

export function resolveStyleUrl(styleName: string): string {
  return `https://tiles.openfreemap.org/styles/${styleName}`;
}
