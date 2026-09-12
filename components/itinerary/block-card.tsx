'use client';

import { Footprints, Lock, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { PlaceImage } from '@/components/itinerary/place-image';
import { durationLabel, endTime, formatRM, mediaFor } from '@/lib/demo-data';
import type { Block } from '@/lib/schemas';
import { cn } from '@/lib/utils';

export function BlockCard({
  block,
  walk,
  changed,
  selected,
  onOpen,
}: {
  block: Block;
  /** estimated walking minutes from the previous block, if both have coordinates */
  walk: number | null;
  changed: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <li>
      {walk !== null && walk > 0 ? (
        <div className="flex items-center gap-1.5 py-1.5 pl-[3.5rem] text-xs text-ink-faint">
          <Footprints className="size-3.5" />
          <span>~{walk} min walk</span>
        </div>
      ) : null}

      <button
        type="button"
        data-testid="block-card"
        onClick={onOpen}
        aria-current={selected}
        className={cn(
          'flex w-full items-start gap-3 rounded-card border bg-card p-3 text-left transition-all',
          'hover:border-ink-faint hover:shadow-[0_2px_10px_rgba(15,23,42,0.06)] active:scale-[0.995]',
          selected ? 'border-accent shadow-[0_0_0_1px_var(--color-accent)]' : 'border-line',
          changed && 'animate-rise',
        )}
      >
        <div className="w-11 shrink-0 pt-0.5">
          <p className="tabular text-sm leading-tight font-semibold">{block.startTime}</p>
          <p className="tabular text-[0.6875rem] text-ink-faint">{endTime(block)}</p>
        </div>

        <PlaceImage
          media={mediaFor(block)}
          alt=""
          width={250}
          className="size-16 shrink-0"
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[0.9375rem] leading-snug font-medium text-balance">{block.title}</p>
            <p className="tabular shrink-0 text-sm font-semibold">
              {block.costPerPerson === 0 ? (
                <span className="text-added">Free</span>
              ) : (
                formatRM(block.costPerPerson)
              )}
            </p>
          </div>

          {block.subtitle ? (
            <p className="mt-0.5 truncate text-xs text-ink-soft">{block.subtitle}</p>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[0.6875rem] text-ink-faint">
              {durationLabel(block.durationMin)}
            </span>
            {block.locked ? (
              <Badge variant="kept">
                <Lock className="size-3" />
                Locked
              </Badge>
            ) : null}
            {changed ? (
              <Badge variant="added">
                <Sparkles className="size-3" />
                Re-planned
              </Badge>
            ) : null}
            {block.sourceCitation ? <Badge variant="outline">📖 Source</Badge> : null}
          </div>
        </div>
      </button>
    </li>
  );
}
