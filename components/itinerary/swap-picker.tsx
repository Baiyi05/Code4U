'use client';

import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { useTrip } from '@/components/trip-provider';
import { filterCandidates, validateItinerary } from '@/lib/constraints';
import { formatRM } from '@/lib/demo-data';
import type { Block, Place } from '@/lib/schemas';

/**
 * Alternatives for one block.
 *
 * The list is not hand-picked: it is filterCandidates() for that day, minus the
 * places already on the plan, minus anything that validateItinerary() would
 * reject once swapped in. So every option offered is one the rule engine will
 * accept — the check runs before the option is shown, not after it is taken.
 */
export function SwapPicker({ block, onDone }: { block: Block; onDone: () => void }) {
  const { blocks, places, constraints, swapPlace } = useTrip();

  const options = useMemo(() => {
    const inUse = new Set(blocks.map((b) => b.placeId).filter(Boolean));
    const dayPool = filterCandidates(places, constraints, block.day).filter(
      (place) => !inUse.has(place.id),
    );
    const candidates = [...dayPool, ...places.filter((p) => p.id === block.placeId)];

    return dayPool
      .filter((place) => {
        const swapped = blocks.map((b) =>
          b.id === block.id
            ? {
                ...b,
                placeId: place.id,
                title: place.name,
                costPerPerson: place.estCostPerPerson ?? b.costPerPerson,
                durationMin: place.avgDurationMin ?? b.durationMin,
              }
            : b,
        );
        return validateItinerary(swapped, constraints, candidates).violations.length === 0;
      })
      .sort((a, b) => (a.estCostPerPerson ?? 0) - (b.estCostPerPerson ?? 0))
      .slice(0, 6);
  }, [block, blocks, places, constraints]);

  return (
    <div className="rounded-xl border border-line bg-line-soft/50 p-3">
      <div className="flex items-center justify-between">
        <p className="label-caps text-ink-faint">Swap for</p>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>

      {options.length === 0 ? (
        <p className="mt-2 text-xs text-ink-soft">
          Nothing else in the candidate list fits this slot without breaking a rule.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {options.map((place: Place) => (
            <li key={place.id}>
              <button
                type="button"
                onClick={() => {
                  swapPlace(block.id, place);
                  onDone();
                }}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-card px-3 py-2.5 text-left transition-colors hover:border-accent"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{place.name}</span>
                  <span className="block truncate text-xs text-ink-faint">
                    {[place.district, place.category, place.indoor ? 'indoors' : 'open air']
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="tabular shrink-0 text-sm font-semibold">
                  {formatRM(place.estCostPerPerson ?? 0)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2.5 text-[0.6875rem] leading-relaxed text-ink-faint">
        Only options the rule engine accepts are listed — opening hours, the day’s closures and
        the budget ceiling are all checked before an option appears here.
      </p>
    </div>
  );
}
