import type { Metadata, Viewport } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Detour — self-healing group itineraries',
  description:
    'A group trip planner that re-plans itself when the day falls apart, without touching what you locked.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#faf9f7',
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
