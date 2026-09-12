'use client';

import { ArrowRight, ChevronDown, Lock, Minus, Plus } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { PhotoCredit, PlaceImage } from '@/components/itinerary/place-image';
import { WhyThisRows } from '@/components/itinerary/why-this';
import { formatDelta, mediaForPlace, type ReplacementWhy } from '@/lib/demo-data';
import type { Block, DiffOp } from '@/lib/schemas';
import { cn } from '@/lib/utils';

type Kind = 'removed' | 'moved' | 'added';

const KIND_LABEL: Record<Kind, string> = {
  removed: 'REMOVED',
  moved: 'MOVED',
  added: 'ADDED',
};

/**
 * One tickable change. The note is the model's own reason and is never optional.
 *
 * An ADDED row also carries a "Why this" it can expand into — the same four rows
 * screen 05 shows for a block already on the plan, because a replacement has to
 * justify itself on the same terms as anything else.
 */
export function DiffRow({
  entry,
  block,
  why,
  checked,
  onToggle,
}: {
  entry: DiffOp;
  /** the block the op targets, for remove and move */
  block: Block | undefined;
  /** for `add` ops: the four derived Why this lines */
  why: ReplacementWhy | null;
  checked: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const op = entry.op;
  if (op.op === 'keep') return null;

  const kind: Kind = op.op === 'remove' ? 'removed' : op.op === 'move' ? 'moved' : 'added';
  const title = op.op === 'add' ? op.block.title : (block?.title ?? op.blockId);
  const placeId = op.op === 'add' ? op.block.placeId : block?.placeId;
  const media = mediaForPlace(placeId);
  const expandable = op.op === 'add' && why !== null;

  return (
    <li>
      <div
        className={cn(
          'rounded-card border bg-card transition-all',
          checked ? 'border-line' : 'border-line opacity-55',
        )}
      >
        <label className="flex cursor-pointer items-start gap-3 p-3">
          <Checkbox checked={checked} onCheckedChange={onToggle} className="mt-0.5" />

          <PlaceImage media={media} alt="" width={120} className="size-12 shrink-0" />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge variant={kind}>
                {kind === 'removed' ? <Minus className="size-3" /> : null}
                {kind === 'added' ? <Plus className="size-3" /> : null}
                {KIND_LABEL[kind]}
              </Badge>
              <span
                className={cn(
                  'tabular text-sm font-semibold',
                  entry.costDelta < 0
                    ? 'text-added'
                    : entry.costDelta > 0
                      ? 'text-moved'
                      : 'text-ink-faint',
                )}
              >
                {formatDelta(entry.costDelta)}
              </span>
            </div>

            <p className="mt-1.5 text-[0.9375rem] leading-snug font-medium text-balance">{title}</p>

            <p className="tabular mt-0.5 text-xs text-ink-soft">
              {op.op === 'move' && block ? (
                <span className="inline-flex items-center gap-1.5">
                  Day {block.day} {block.startTime}
                  <ArrowRight className="size-3" />
                  Day {op.to.day} {op.to.startTime}
                </span>
              ) : op.op === 'add' ? (
                <>
                  Day {op.block.day} · {op.block.startTime} · {op.block.durationMin} min
                </>
              ) : block ? (
                <>
                  Day {block.day} · {block.startTime} · was RM {block.costPerPerson}
                </>
              ) : null}
            </p>

            <p className="mt-2 text-xs leading-relaxed text-ink-soft">{op.note}</p>

            {entry.violations.length > 0 ? (
              <p className="mt-2 rounded-md bg-warn-soft px-2 py-1 text-[0.6875rem] text-warn">
                {entry.violations[0]?.message}
              </p>
            ) : null}
          </div>
        </label>

        {expandable ? (
          <>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="flex w-full items-center justify-between gap-2 border-t border-line px-3 py-2 text-left text-xs font-medium text-ink-soft transition-colors hover:bg-line-soft/70 hover:text-ink"
            >
              <span>Why this one?</span>
              <ChevronDown
                className={cn('size-4 transition-transform duration-200', open && 'rotate-180')}
              />
            </button>

            {open ? (
              <div className="animate-rise border-t border-line px-3 py-3">
                <PlaceImage
                  media={media}
                  alt={title}
                  width={960}
                  className="mb-3 aspect-video w-full"
                />
                <WhyThisRows
                  compact
                  why={{
                    constraint: why.constraint,
                    budget: why.budget,
                    votes: why.votes,
                    source: why.source
                      ? {
                          text: why.source.chunk,
                          source: why.source.source,
                          url: why.source.url ?? null,
                        }
                      : null,
                  }}
                  emptySource="The retrieval layer returned nothing for this district, so this row stays empty rather than borrowing a quote about somewhere else."
                />
                <PhotoCredit media={media} className="mt-3" />
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </li>
  );
}

/** A block the engine refused to touch. Shown, never tickable. */
export function KeptRow({ block, reason }: { block: Block; reason: string }) {
  return (
    <li className="flex items-start gap-3 rounded-card border border-dashed border-line bg-kept-soft/50 p-3">
      <Lock className="mt-0.5 size-4 shrink-0 text-kept" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <Badge variant="kept">KEPT</Badge>
          <span className="tabular text-sm font-semibold text-ink-faint">
            RM {block.costPerPerson}
          </span>
        </div>
        <p className="mt-1.5 text-[0.9375rem] leading-snug font-medium">{block.title}</p>
        <p className="tabular mt-0.5 text-xs text-ink-soft">
          Day {block.day} · {block.startTime}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-ink-soft">{reason}</p>
      </div>
    </li>
  );
}
