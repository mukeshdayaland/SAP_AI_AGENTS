/**
 * Front-end brand. One code base serves several organizations: each gets its
 * own static export, chosen at build time with NEXT_PUBLIC_BRAND, and all of
 * them call the same orchestrator. A brand changes names, the mark, the color
 * tokens (globals.css, `:root[data-brand=…]`) and which panels are shown —
 * never what the workspace can do.
 */
export interface Brand {
  id: 'prowess' | 'wtco';
  /** Product name shown in the workspace. */
  name: string;
  subtitle: string;
  /** The subtitle in other interface languages; the product name stays as it is. */
  i18n?: Partial<Record<'ar', { subtitle: string }>>;
  /** Browser tab icon under /public; the default brand uses app/icon.svg. */
  icon?: string;
  /** The organization's symbol under /public, in color for a light surface. */
  logo?: string;
  themeColor: { light: string; dark: string };
  /** Pin the conversation's latest process run beside the chat on wide screens; the run still shows in the conversation. */
  processPanel: boolean;
}

const BRANDS: Record<Brand['id'], Brand> = {
  prowess: {
    id: 'prowess',
    name: 'Prowess AI',
    subtitle: 'Enterprise Intelligence Workspace',
    i18n: { ar: { subtitle: 'مساحة عمل ذكاء المؤسسات' } },
    themeColor: { light: '#f5f6f7', dark: '#12171c' },
    processPanel: true,
  },
  wtco: {
    id: 'wtco',
    name: 'WTCO AI',
    subtitle: 'Water Transmission Company',
    i18n: { ar: { subtitle: 'شركة نقل المياه' } },
    icon: '/brands/wtco-icon.svg',
    logo: '/brands/wtco-mark.svg',
    themeColor: { light: '#1c4f90', dark: '#1c4f90' },
    processPanel: false,
  },
};

const requested = process.env.NEXT_PUBLIC_BRAND;

export const brand: Brand = requested && requested in BRANDS ? BRANDS[requested as Brand['id']] : BRANDS.prowess;
