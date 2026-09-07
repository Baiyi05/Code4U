'use client';

import { Wand2 } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { BlockCard } from '@/components/itinerary/block-card';
import { BlockDetail } from '@/components/itinerary/block-detail';
import { BudgetBar } from '@/components/itinerary/budget-bar';
import { useTrip } from '@/components/trip-provider';
import { DEMO_DAYS, DEMO_TRIP, blocksForDay, formatRM, walkMinutes } from '@/lib/demo-data';
import { cn } from '@/lib/utils';

export function ItineraryScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { blocks, changedIds, lastAccepted } = useTrip();

  const day = clampDay(Number(params.get('day') ?? 1));
  const openId = params.get('block');

  const dayBlocks = useMemo(() => blocksForDay(blocks, day), [blocks, day]);
  const openBlock = useMemo(
    () => (openId ? (blocks.find((b) => b.id === openId) ?? null) : null),
    [blocks, openId],
  );

  const go = useCallback(
    (next: { day?: number; block?: string | null }, replace = false) => {
      const query = new URLSearchParams(params.toString());
      if (next.day !== undefined) query.set('day', String(next.day));
      if (next.block === null) query.delete('block');
      else if (next.block !== undefined) query.set('block', next.block);
      const url = `${pathname}?${query.toString()}`;
      // push, not replace, so the back button closes the detail rather than
      // leaving the trip — the detail is a state of this screen, not a page
      if (replace) router.replace(url, { scroll: false });
      else router.push(url, { scroll: false });
    },
    [params, pathname, router],
  );

  const dayTotal = dayBlocks.reduce((sum, b) => sum + b.costPerPerson, 0);

  return (
    <>
      <BudgetBar />

      <div className="border-b border-line bg-paper/80">
        <div className="scrollbar-none flex gap-1.5 overflow-x-auto px-4 py-2.5">
          {DEMO_DAYS.map((entry) => {
            const active = entry.day === day;
            const count = blocks.filter((b) => b.day === entry.day).length;
            return (
              <button
                key={entry.day}
                type="button"
                onClick={() => go({ day: entry.day, block: null }, true)}
                className={cn(
                  'shrink-0 rounded-lg border px-3 py-1.5 text-left transition-all',
                  active
                    ? 'border-ink bg-ink text-paper'
                    : 'border-line bg-card text-ink-soft hover:border-ink-faint',
                )}
              >
                <span className="block text-[0.6875rem] leading-none font-medium opacity-70">
                  {entry.weekday}
                </span>
                <span className="mt-1 block text-sm leading-none font-semibold">{entry.date}</span>
                <span className="mt-1 block text-[0.625rem] leading-none opacity-60">
                  {count} block{count === 1 ? '' : 's'}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="px-4 py-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm text-ink-soft">
            {DEMO_DAYS.find((d) => d.day === day)?.long}
          </p>
          <p className="tabular text-sm font-medium">{formatRM(dayTotal)} today</p>
        </div>

        {lastAccepted ? (
          <p className="mt-2 animate-rise rounded-lg bg-added-soft px-3 py-2 text-xs text-added">
            <span className="font-semibold">{lastAccepted.headline}</span> — {lastAccepted.opCount}{' '}
            change{lastAccepted.opCount === 1 ? '' : 's'} accepted.
            {lastAccepted.guardCut.length > 0
              ? ` The budget guard then cut ${lastAccepted.guardCut.length} more.`
              : ''}
          </p>
        ) : null}

        {dayBlocks.length === 0 ? (
          <p className="mt-8 text-center text-sm text-ink-faint">
            Nothing left on this day. A re-plan cleared it.
          </p>
        ) : (
          <div className="mt-3 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-6">
            <ul className="space-y-2">
              {dayBlocks.map((block, index) => (
                <BlockCard
                  key={block.id}
                  block={block}
                  walk={index === 0 ? null : walkMinutes(dayBlocks[index - 1]!, block)}
                  changed={changedIds.has(block.id)}
                  selected={openBlock?.id === block.id}
                  // clicking the open one closes it, which is the only way to
                  // dismiss the panel on a wide screen
                  onOpen={() =>
                    openBlock?.id === block.id ? router.back() : go({ block: block.id })
                  }
                />
              ))}
            </ul>

            {/* On a wide screen the detail is a column, not a layer over the plan */}
            <aside className="sticky top-44 hidden lg:block">
              {openBlock ? (
                <div className="animate-rise overflow-hidden rounded-card border border-line bg-card">
                  <BlockDetail block={openBlock} />
                </div>
              ) : (
                <div className="rounded-card border border-dashed border-line p-6 text-center text-sm text-ink-faint">
                  Pick a block to see why it is on the plan.
                </div>
              )}
            </aside>
          </div>
        )}
      </div>

      {/* Below lg the same component comes up as a sheet */}
      <div className="lg:hidden">
        <Sheet
          open={openBlock !== null}
          onOpenChange={(open) => {
            if (!open) router.back();
          }}
        >
          {openBlock ? (
            <SheetContent title={openBlock.title} className="p-0">
              <BlockDetail block={openBlock} />
            </SheetContent>
          ) : null}
        </Sheet>
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-16 z-20 mx-auto max-w-5xl px-4">
        <div className="flex justify-end">
          <Button asChild size="lg" variant="accent" className="pointer-events-auto shadow-lg">
            <Link href={`/t/${DEMO_TRIP.slug}/replan`}>
              <Wand2 className="size-4" />
              Re-plan
            </Link>
          </Button>
        </div>
      </div>
    </>
  );
}

function clampDay(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(DEMO_DAYS.length, Math.max(1, Math.trunc(value)));
}
