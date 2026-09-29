import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Prowess AI — Enterprise Intelligence Workspace',
  description: 'Conversational access to authorized SAP business processes.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f6f8' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0f15' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="system" suppressHydrationWarning>
      <head>
        {/* Blocking, same-origin script (CSP-friendly) to apply the saved theme before paint. */}
        <script src="/theme-init.js" />
      </head>
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
