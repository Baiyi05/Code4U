'use client';

import { Footprints, Lock, LockOpen, MapPin, Repeat } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTrip } from '@/components/trip-provider';
import { PhotoCredit, PlaceImage } from '@/components/itinerary/place-image';
import { SwapPicker } from '@/components/itinerary/swap-picker';
import { WhyThisRows } from '@/components/itinerary/why-this';
import {
  DEMO_DAYS,
  PLACES_BY_ID,
  addressOf,
  citationFor,
  durationLabel,
  endTime,
  formatRM,
  mediaFor,
} from '@/lib/demo-data';
import type { Block } from '@/lib/schemas';

/**
 * Screen 05 — "Why this".
 *
 * The four rows come from WhyThisRows, the same component the ADDED rows on the
 * re-plan diff use, so a block and a proposed replacement explain themselves in
 * exactly the same shape.
 */
export function BlockDetail({ block }: { block: Block }) {
  const { toggleLock } = useTrip();
  const [swapping, setSwapping] = useState(false);
  const place = block.placeId ? PLACES_BY_ID.get(block.placeId) : undefined;
  const day = DEMO_DAYS.find((d) => d.day === block.day);
  const media = mediaFor(block);
  const address = addressOf(block);

  return (
    <div className="flex h-full flex-col">
      <div className="relative shrink-0">
        <PlaceImage
          media={media}
          alt={block.title}
          width={960}
          rounded="rounded-none"
          className="aspect-video w-full"
        />
        {/* keeps the close button legible over a bright photo */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-black/25 to-transparent" />
      </div>

      <div className="border-b border-line px-5 pt-4 pb-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="label-caps text-ink-faint">
            Day {block.day} · {block.startTime}–{endTime(block)}
          </p>
          <p className="tabular text-sm font-semibold">
            {block.costPerPerson === 0 ? 'Free' : `${formatRM(block.costPerPerson)} / person`}
          </p>
        </div>

        <h2 className="mt-1.5 text-lg leading-snug font-semibold text-balance">{block.title}</h2>

        {address ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-sm text-ink-soft">
            <MapPin className="mt-0.5 size-3.5 shrink-0 text-ink-faint" />
            <span>{address}</span>
          </p>
        ) : null}

        <p className="mt-1 text-sm text-ink-faint">
          {[durationLabel(block.durationMin), day?.long].filter(Boolean).join(' · ')}
        </p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {block.locked ? (
            <Badge variant="kept">
              <Lock className="size-3" />
              Locked by the captain
            </Badge>
          ) : null}
          {place?.indoor ? (
            <Badge variant="outline">Indoors</Badge>
          ) : (
            <Badge variant="outline">Open air</Badge>
          )}
          {place?.vegFriendly ? <Badge variant="added">Vegetarian options</Badge> : null}
          {block.createdBy ? <Badge variant="default">from {block.createdBy}</Badge> : null}
        </div>

        <PhotoCredit media={media} className="mt-3" />
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <p className="label-caps text-ink-faint">Why this</p>

        <div className="mt-3">
          <WhyThisRows
            why={{
              budget: block.reason?.budget,
              votes: block.reason?.votes,
              constraint: block.reason?.constraint,
              // what the pipeline attached, else what the corpus holds about
              // this exact place — never a line about somewhere nearby
              source: citationFor(block),
            }}
            emptySource="Nothing retrieved for this one. The retrieval layer never supplies hours or prices, and this screen will not invent a quote to fill the row."
          />
        </div>

        {place && place.lat !== null && place.lng !== null ? (
          <p className="mt-4 flex items-center gap-1.5 text-xs text-ink-faint">
            <Footprints className="size-3.5" />
            {place.name} · {place.lat.toFixed(4)}, {place.lng.toFixed(4)}
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
