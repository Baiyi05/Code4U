import type { Metadata, Viewport } from 'next';

import './globals.css';

/**
 * Installable on a phone, but not offline-capable: there is no service worker
 * yet, on purpose. Add-to-home-screen is what a judge does with a demo link;
 * caching strategy is a decision for when there is a real backend to cache.
 */
export const metadata: Metadata = {
  title: 'Detour4U — self-healing group itineraries',
  description:
    'A group trip planner that re-plans itself when the day falls apart, without touching what you locked.',
  applicationName: 'Detour4U',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    title: 'Detour4U',
    statusBarStyle: 'default',
  },
  icons: {
    icon: [
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The header sits on --color-paper, so the status bar matches it
  themeColor: '#faf9f7',
  // The bottom nav is fixed; let the page paint under the home indicator
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/*
       * suppressHydrationWarning is here because extensions — Grammarly is the
       * usual one — inject attributes such as data-gr-ext-installed onto <body>
       * before React hydrates, which React then reports as a mismatch we did not
       * cause.
       *
       * It stays on this one element. The flag only covers the element's own
       * attributes and text and does not pass down, so a real hydration bug
       * anywhere inside the tree is still reported.
       */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
