'use client';

import { CalendarDays, Sparkles, Users, Wallet } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { AvatarRow } from '@/components/ui/avatar';
import { useTrip } from '@/components/trip-provider';
import { DEMO_TRIP } from '@/lib/demo-data';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '', label: 'Itinerary', icon: CalendarDays },
  { href: '/profile', label: 'Taste', icon: Sparkles },
  { href: '/budget', label: 'Budget', icon: Wallet },
  { href: '/join', label: 'Join', icon: Users },
] as const;

/**
 * The frame every trip screen sits in.
 *
 * Deliberately not shown on Trip Setup — there is no trip yet at that point, so
 * a trip nav would be lying about where you are.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { members } = useTrip();
  const base = `/t/${DEMO_TRIP.slug}`;
  const bare = pathname.startsWith('/setup');

  if (bare) return <>{children}</>;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-paper/85 backdrop-blur-md">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <Link href={base} className="min-w-0">
            <p className="label-caps text-ink-faint">Detour · {DEMO_TRIP.slug}</p>
            <p className="truncate text-[0.9375rem] leading-tight font-semibold">
              {DEMO_TRIP.destination}
            </p>
          </Link>
          <div className="flex items-center gap-3">
            <AvatarRow members={members} />
            <span className="hidden text-xs text-ink-faint sm:inline">
              {members.length} travelling
            </span>
          </div>
        </div>
      </header>

      <main className="flex-1 pb-24">{children}</main>

      {/* viewportFit is 'cover', so the nav pads itself past the home indicator */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl">
          {TABS.map((tab) => {
            const href = `${base}${tab.href}`;
            const active = tab.href === '' ? pathname === base : pathname.startsWith(href);
            const Icon = tab.icon;
            return (
              <Link
                key={tab.label}
                href={href}
                className={cn(
                  'flex flex-1 flex-col items-center gap-1 py-2.5 text-[0.6875rem] font-medium transition-colors',
                  active ? 'text-accent' : 'text-ink-faint hover:text-ink-soft',
                )}
              >
                <Icon className={cn('size-5', active && 'stroke-[2.25]')} />
                {tab.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
