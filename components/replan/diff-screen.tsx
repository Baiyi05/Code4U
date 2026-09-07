'use client';

import { ArrowLeft, Check, Cpu, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DiffRow, KeptRow } from '@/components/replan/diff-row';
import { useTrip } from '@/components/trip-provider';
import { enforceBudget, totalCost } from '@/lib/constraints';
import { applyDiff } from '@/lib/replan';
import {
  DEMO_TRIP,
  diffFor,
  formatDelta,
  formatRM,
  immovableIdsAt,
  SCENARIOS_BY_KEY,
  type ScenarioKey,
} from '@/lib/demo-data';
import { cn } from '@/lib/utils';

/**
 * Screen 06, second half — the diff.
 *
 * Nothing on this screen is a picture of a diff. The ops came out of
 * lib/replan.ts (see lib/demo-data.test.ts, which generates them); ticking a box
 * re-runs applyDiff() over the itinerary you are actually looking at, and the
 * numbers below are measured from the blocks that come back, not summed from
 * what the ops claim. Accepting writes those blocks into state, so the itinerary
 * really changes.
 */
export function DiffScreen({ scenarioKey, onBack }: { scenarioKey: ScenarioKey; onBack: () => void }) {
  const router = useRouter();
  const { blocks, constraints, acceptDiff } = useTrip();
  const scenario = SCENARIOS_BY_KEY.get(scenarioKey)!;
  const diff = diffFor(scenarioKey);

  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set(diff.ops.map((op) => op.id)),
  );

  const blocksById = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks]);

  // Locked blocks plus anything that has already started at this point in the
  // trip. applyDiff is told explicitly rather than left to assume.
  const immovableIds = useMemo(
    () => immovableIdsAt(blocks, scenario.now),
    [blocks, scenario.now],
  );

  const target = scenario.disruption.type === 'overbudget'
    ? (scenario.disruption.payload?.target ?? constraints.budgetCeiling)
    : constraints.budgetCeiling;

  const preview = useMemo(() => {
    const accepted = diff.ops.filter((op) => ticked.has(op.id));
    const applied = applyDiff(blocks, accepted, {
      tripId: DEMO_TRIP.id,
      immovableIds,
      newId: (i) => `rp-${scenarioKey}-${i + 1}`,
    });

    // The guard runs against the tightened target, so unticking cuts leaves it
    // something to do — and it will still refuse to touch a locked block.
    const guarded = enforceBudget(applied.blocks, { ...constraints, budgetCeiling: target });
    const guardCut = applied.blocks
      .filter((b) => !guarded.some((g) => g.id === b.id))
      .map((b) => b.id);

    return {
      accepted,
      blocks: guarded,
      budgetDelta: totalCost(guarded) - totalCost(blocks),
      opDelta: applied.budgetDelta,
      refusals: applied.violations,
      guardCut,
    };
  }, [blocks, constraints, diff.ops, immovableIds, scenarioKey, target, ticked]);

  const keptBlocks = diff.immovable
    .map((id) => blocksById.get(id))
    .filter((b): b is NonNullable<typeof b> => Boolean(b));

  const affected = diff.ops.length;
  const allTicked = ticked.size === diff.ops.length;

  const toggle = (id: string): void =>
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const accept = (): void => {
    acceptDiff(
      preview.blocks,
      {
        scenarioKey,
        headline: scenario.headline,
        opIds: [...ticked],
        opCount: preview.accepted.length,
        budgetDelta: preview.budgetDelta,
        guardCut: preview.guardCut,
      },
      changedIdsOf(preview.accepted, scenarioKey),
    );
    router.push(`/t/${DEMO_TRIP.slug}?day=${scenario.disruption.day}`);
  };

  return (
    <div className="px-4 py-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-xs text-ink-soft transition-colors hover:text-ink"
      >
        <ArrowLeft className="size-3.5" />
        Other triggers
      </button>

      <header className="mt-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="label-caps text-accent-ink">{scenario.headline}</p>
          <p
            className={cn(
              'tabular text-lg font-semibold',
              preview.budgetDelta <= 0 ? 'text-added' : 'text-moved',
            )}
          >
            {formatDelta(preview.budgetDelta)} / person
          </p>
        </div>

        <p className="mt-1 text-sm text-ink-soft">{scenario.blurb}</p>

        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
          <span>
            {affected} change{affected === 1 ? '' : 's'} proposed
          </span>
          <span>·</span>
          <span>
            {keptBlocks.length} locked block{keptBlocks.length === 1 ? '' : 's'} untouched
          </span>
          <span>·</span>
          <span className="tabular">
            window {diff.window.earliestStart}–{diff.window.latestEnd}
            {diff.window.day !== null ? ` on day ${diff.window.day}` : ' across the rest of the trip'}
          </span>
        </p>

        {diff.shortfall > 0 ? (
          <p className="mt-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
            {formatRM(diff.shortfall)} per person has to come off to reach{' '}
            {formatRM(target)}. The ticked changes hand back{' '}
            {formatRM(Math.abs(preview.opDelta))}.
          </p>
        ) : null}
      </header>

      <div className="mt-4 flex items-center justify-between">
        <p className="label-caps text-ink-faint">Changes</p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setTicked(allTicked ? new Set<string>() : new Set(diff.ops.map((op) => op.id)))
          }
        >
          {allTicked ? 'Clear all' : 'Select all'}
        </Button>
      </div>

      <ul className="mt-2 space-y-2">
        {diff.ops.map((entry) => (
          <DiffRow
            key={entry.id}
            entry={entry}
            block={entry.op.op === 'add' ? undefined : blocksById.get(entry.op.blockId)}
            checked={ticked.has(entry.id)}
            onToggle={() => toggle(entry.id)}
          />
        ))}

        {keptBlocks.map((block) => (
          <KeptRow
            key={block.id}
            block={block}
            reason={
              block.locked
                ? 'Locked by the captain, so the re-plan was not allowed to consider it.'
                : 'Already under way when the re-plan fired — you cannot change what has happened.'
            }
          />
        ))}
      </ul>

      {preview.refusals.length > 0 ? (
        <div className="mt-3 rounded-card border border-removed/30 bg-removed-soft p-3">
          <p className="label-caps text-removed">Refused</p>
          <ul className="mt-1.5 space-y-1">
            {preview.refusals.map((violation, index) => (
              <li key={index} className="text-xs leading-relaxed text-removed">
                {violation.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview.guardCut.length > 0 ? (
        <div className="mt-3 flex items-start gap-2 rounded-card border border-line bg-line-soft/70 p-3">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" />
          <p className="text-xs leading-relaxed text-ink-soft">
            <span className="font-semibold text-ink">Budget guard</span> — the ticked changes do
            not reach {formatRM(target)}, so <code className="font-mono">enforceBudget</code> would
            drop {preview.guardCut.length} more block
            {preview.guardCut.length === 1 ? '' : 's'}, most expensive first. Locked blocks are
            never on that list.
          </p>
        </div>
      ) : null}

      {diff.citations.length > 0 ? (
        <div className="mt-3 rounded-card border border-line bg-card p-3">
          <p className="label-caps text-ink-faint">📖 What the replacements were checked against</p>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-soft italic">
            “{diff.citations[0]?.chunk}”
          </p>
          <p className="mt-1 text-[0.6875rem] text-ink-faint">{diff.citations[0]?.source}</p>
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-2 text-[0.6875rem] text-ink-faint">
        <Cpu className="size-3.5" />
        <span>
          Produced by <code className="font-mono">lib/replan.ts</code> · source{' '}
          <Badge variant="outline">{diff.source}</Badge> · no retry needed · applied here by{' '}
          <code className="font-mono">applyDiff</code>
        </span>
      </div>

      <div className="sticky bottom-20 z-20 mt-5">
        <Button
          size="lg"
          variant="accent"
          className="w-full shadow-lg"
          disabled={preview.accepted.length === 0}
          onClick={accept}
        >
          <Check className="size-4" />
          {allTicked
            ? 'Accept re-plan'
            : `Accept ${preview.accepted.length} change${preview.accepted.length === 1 ? '' : 's'}`}
          <span className="tabular ml-1 opacity-80">{formatDelta(preview.budgetDelta)}</span>
        </Button>
      </div>
    </div>
  );
}

/**
 * Which block ids the itinerary should flag as re-planned afterwards.
 *
 * Added blocks are counted on their own, because that is how applyDiff numbers
 * them: newId is called once per `add`, not once per op.
 */
function changedIdsOf(accepted: ReturnType<typeof diffFor>['ops'], key: string): string[] {
  const ids: string[] = [];
  let added = 0;
  for (const entry of accepted) {
    if (entry.op.op === 'move') ids.push(entry.op.blockId);
    if (entry.op.op === 'add') {
      added += 1;
      ids.push(`rp-${key}-${added}`);
    }
  }
  return ids;
}
