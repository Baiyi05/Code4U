'use client';

import { ArrowRight, Lock, Minus, Plus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { formatDelta } from '@/lib/demo-data';
import type { Block, DiffOp } from '@/lib/schemas';
import { cn } from '@/lib/utils';

type Kind = 'removed' | 'moved' | 'added';

const KIND_LABEL: Record<Kind, string> = {
  removed: 'REMOVED',
  moved: 'MOVED',
  added: 'ADDED',
};

/** One tickable change. The note is the model's reason and is never optional. */
export function DiffRow({
  entry,
  block,
  checked,
  onToggle,
}: {
  entry: DiffOp;
  /** the block the op targets, for remove and move */
  block: Block | undefined;
  checked: boolean;
  onToggle: () => void;
}) {
  const op = entry.op;
  if (op.op === 'keep') return null;

  const kind: Kind = op.op === 'remove' ? 'removed' : op.op === 'move' ? 'moved' : 'added';
  const title = op.op === 'add' ? op.block.title : (block?.title ?? op.blockId);

  return (
    <li>
      <label
        className={cn(
          'flex cursor-pointer items-start gap-3 rounded-card border bg-card p-3 transition-all',
          checked ? 'border-line' : 'border-line opacity-55',
          'hover:border-ink-faint',
        )}
      >
        <Checkbox checked={checked} onCheckedChange={onToggle} className="mt-0.5" />

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
                entry.costDelta < 0 ? 'text-added' : entry.costDelta > 0 ? 'text-moved' : 'text-ink-faint',
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
          <span className="tabular text-sm font-semibold text-ink-faint">RM {block.costPerPerson}</span>
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
