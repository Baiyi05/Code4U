'use client';

import { ExternalLink, Footprints, Lock, LockOpen, Repeat } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTrip } from '@/components/trip-provider';
import { SwapPicker } from '@/components/itinerary/swap-picker';
import {
  DEMO_DAYS,
  PLACES_BY_ID,
  durationLabel,
  endTime,
  formatRM,
} from '@/lib/demo-data';
import type { Block } from '@/lib/schemas';

/**
 * Screen 05 — "Why this".
 *
 * The four rows are the product's first principle made literal: a block that
 * cannot say why it is on the plan should not be on the plan. BUDGET, VOTES and
 * CONSTRAINT come off block.reason; 📖 SOURCE only appears when there is a real
 * retrieved chunk behind it, and is left out entirely when there is not, rather
 * than filled with something plausible.
 */
export function BlockDetail({ block }: { block: Block }) {
  const { toggleLock } = useTrip();
  const [swapping, setSwapping] = useState(false);
  const place = block.placeId ? PLACES_BY_ID.get(block.placeId) : undefined;
  const day = DEMO_DAYS.find((d) => d.day === block.day);
  const reason = block.reason;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-5 pt-5 pb-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="label-caps text-ink-faint">
            Day {block.day} · {block.startTime}–{endTime(block)}
          </p>
          <p className="tabular text-sm font-semibold">
            {block.costPerPerson === 0 ? 'Free' : `${formatRM(block.costPerPerson)} / person`}
          </p>
        </div>

        <h2 className="mt-1.5 text-lg leading-snug font-semibold text-balance">{block.title}</h2>

        <p className="mt-1 text-sm text-ink-soft">
          {[place?.district, durationLabel(block.durationMin), day?.long]
            .filter(Boolean)
            .join(' · ')}
        </p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {block.locked ? (
            <Badge variant="kept">
              <Lock className="size-3" />
              Locked by the captain
            </Badge>
          ) : null}
          {place?.indoor ? <Badge variant="outline">Indoors</Badge> : <Badge variant="outline">Open air</Badge>}
          {place?.vegFriendly ? <Badge variant="added">Vegetarian options</Badge> : null}
          {block.createdBy ? <Badge variant="default">from {block.createdBy}</Badge> : null}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <p className="label-caps text-ink-faint">Why this</p>

        <dl className="mt-3 space-y-3">
          <WhyRow label="BUDGET" tone="text-accent-ink" value={reason?.budget} />
          <WhyRow label="VOTES" tone="text-moved" value={reason?.votes} />
          <WhyRow label="CONSTRAINT" tone="text-added" value={reason?.constraint} />

          {block.sourceCitation ? (
            <div className="rounded-xl border border-line bg-line-soft/60 p-3">
              <dt className="label-caps text-ink-faint">📖 Source</dt>
              <dd className="mt-1.5">
                <p className="text-sm leading-relaxed text-ink italic">
                  “{block.sourceCitation.text}”
                </p>
                <p className="mt-2 flex items-center gap-1 text-xs text-ink-soft">
                  {block.sourceCitation.source}
                  {block.sourceCitation.url ? (
                    <a
                      href={block.sourceCitation.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-accent underline underline-offset-2"
                    >
                      open
                      <ExternalLink className="size-3" />
                    </a>
                  ) : null}
                </p>
              </dd>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-line p-3">
              <dt className="label-caps text-ink-faint">📖 Source</dt>
              <dd className="mt-1 text-xs text-ink-faint">
                Nothing retrieved for this one. The retrieval layer never supplies hours or
                prices, and this screen will not invent a quote to fill the row.
              </dd>
            </div>
          )}
        </dl>

        {place && place.lat !== null && place.lng !== null ? (
          <p className="mt-4 flex items-center gap-1.5 text-xs text-ink-faint">
            <Footprints className="size-3.5" />
            {place.name} · {place.district ?? 'Osaka'} · {place.lat.toFixed(4)},{' '}
            {place.lng.toFixed(4)}
          </p>
        ) : null}

        {swapping ? (
          <div className="mt-5">
            <SwapPicker block={block} onDone={() => setSwapping(false)} />
          </div>
        ) : null}
      </div>

      <div className="flex gap-2 border-t border-line px-5 py-4">
        <Button
          variant={block.locked ? 'soft' : 'outline'}
          className="flex-1"
          onClick={() => toggleLock(block.id)}
        >
          {block.locked ? <LockOpen className="size-4" /> : <Lock className="size-4" />}
          {block.locked ? 'Unlock' : 'Lock'}
        </Button>
        <Button
          variant="outline"
          className="flex-1"
          disabled={block.locked}
          onClick={() => setSwapping((v) => !v)}
        >
          <Repeat className="size-4" />
          Swap
        </Button>
      </div>
    </div>
  );
}

function WhyRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | null | undefined;
  tone: string;
}) {
  if (!value) return null;
  return (
    <div className="flex gap-3">
      <dt className={`label-caps w-[5.5rem] shrink-0 pt-0.5 ${tone}`}>{label}</dt>
      <dd className="flex-1 text-sm leading-relaxed text-ink">{value}</dd>
    </div>
  );
}
