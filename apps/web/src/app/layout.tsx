import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { brand } from '@/lib/brand';
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
    <html lang="en" data-theme="system" data-brand={brand.id} suppressHydrationWarning>
      <head>
        {/* Blocking, same-origin script (CSP-friendly) to apply the saved theme before paint. */}
        <script src="/theme-init.js" />
      </head>
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
