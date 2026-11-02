import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import { brand } from '@/lib/brand';
import { I18nProvider } from '@/lib/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: `${brand.name} — ${brand.subtitle}`,
  description: 'Conversational access to authorized SAP business processes.',
  robots: { index: false, follow: false },
  ...(brand.icon && { icons: { icon: brand.icon } }),
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: brand.themeColor.light },
    { media: '(prefers-color-scheme: dark)', color: brand.themeColor.dark },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr" data-theme="system" data-brand={brand.id} suppressHydrationWarning>
      <head>
        {/* Blocking, same-origin script (CSP-friendly) to apply the saved theme and language before paint. */}
        <script src="/theme-init.js" />
      </head>
      <body className="h-full overflow-hidden">
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
