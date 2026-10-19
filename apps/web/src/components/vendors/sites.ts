import type { LocationPrecision } from '@prowess/contracts';

/** Something placed on the map: a vendor at its address, or an employee at their work location. */
export interface Place {
  id: string;
  name: string;
  /** The line shown under the name: the address, or the job title and work location. */
  address: string;
  lat: number;
  lng: number;
  precision: LocationPrecision;
  /** Vendors only. */
  isCustomer?: boolean;
  country?: string;
  /** Employees only: the work location as SuccessFactors names it. */
  location?: string;
}

/** Places that share one coordinate. Many vendors carry the same address and many employees the same office, so a pin stands for a site. */
export interface Site {
  key: string;
  lat: number;
  lng: number;
  vendors: Place[];
  /** Nothing here is placed better than by postal code or state. */
  approximate: boolean;
}

export const siteKeyOf = (v: Place) => `${v.lat.toFixed(5)},${v.lng.toFixed(5)}`;

/** Sites with the most places first. */
export function groupSites(vendors: Place[]): Site[] {
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
