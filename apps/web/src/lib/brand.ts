/**
 * Front-end brand. One code base serves several organizations: each gets its
 * own static export, chosen at build time with NEXT_PUBLIC_BRAND, and all of
 * them call the same orchestrator. A brand changes names, the mark and the
 * color tokens (globals.css, `:root[data-brand=…]`) — never behavior.
 */
export interface Brand {
  id: 'prowess' | 'wtco';
  /** Product name shown in the workspace. */
  name: string;
  subtitle: string;
  /** Browser tab icon under /public; the default brand uses app/icon.svg. */
  icon?: string;
  /** The organization's symbol under /public, in color for a light surface. */
  logo?: string;
  themeColor: { light: string; dark: string };
}

const BRANDS: Record<Brand['id'], Brand> = {
  prowess: {
    id: 'prowess',
    name: 'Prowess AI',
    subtitle: 'Enterprise Intelligence Workspace',
    themeColor: { light: '#f5f6f7', dark: '#12171c' },
  },
  wtco: {
    id: 'wtco',
    name: 'WTCO AI',
    subtitle: 'Water Transmission Company',
    icon: '/brands/wtco-icon.svg',
    logo: '/brands/wtco-mark.svg',
    themeColor: { light: '#1c4f90', dark: '#1c4f90' },
  },
};

const requested = process.env.NEXT_PUBLIC_BRAND;

export const brand: Brand = requested && requested in BRANDS ? BRANDS[requested as Brand['id']] : BRANDS.prowess;
