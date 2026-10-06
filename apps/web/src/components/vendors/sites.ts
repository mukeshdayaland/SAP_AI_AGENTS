import type { VendorLocation } from '@prowess/contracts';

/** Vendors that share one coordinate. Many vendors carry the same address, so a pin stands for a site, not a vendor. */
export interface Site {
  key: string;
  lat: number;
  lng: number;
  vendors: VendorLocation[];
  /** No vendor here is placed better than by postal code or state. */
  approximate: boolean;
}

export const siteKeyOf = (v: VendorLocation) => `${v.lat.toFixed(5)},${v.lng.toFixed(5)}`;

/** Sites with the most vendors first. */
export function groupSites(vendors: VendorLocation[]): Site[] {
  const sites = new Map<string, Site>();
  for (const v of vendors) {
    const key = siteKeyOf(v);
    const site = sites.get(key);
    if (site) {
      site.vendors.push(v);
      site.approximate &&= v.precision === 'approximate';
    } else {
      sites.set(key, { key, lat: v.lat, lng: v.lng, vendors: [v], approximate: v.precision === 'approximate' });
    }
  }
  return [...sites.values()].sort((a, b) => b.vendors.length - a.vendors.length);
}
