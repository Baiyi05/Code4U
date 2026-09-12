'use client';

import { AlertTriangle, Lock } from 'lucide-react';

import { Progress } from '@/components/ui/progress';
import { useTrip } from '@/components/trip-provider';
import { formatDelta, formatRM } from '@/lib/demo-data';
import { cn } from '@/lib/utils';

/**
 * The fixed strip at the top of the itinerary.
 *
 * Every number on it is derived: `spent` is totalCost() over the current blocks,
 * the ceiling is what buildConstraints() worked out from the group's budget
 * bands. Accept a re-plan and both move on their own.
 */
export function BudgetBar() {
  const { spent, constraints, blocks, lastAccepted, violations } = useTrip();
  const ceiling = constraints.budgetCeiling;
  const pct = ceiling > 0 ? (spent / ceiling) * 100 : 0;
  const remaining = ceiling - spent;
  const lockedTotal = blocks
    .filter((b) => b.locked)
    .reduce((sum, b) => sum + b.costPerPerson, 0);
  const over = remaining < 0;
  const tight = !over && pct > 85;

  return (
    <div className="sticky top-[3.75rem] z-20 border-b border-line bg-paper/90 px-4 py-3 backdrop-blur-md">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="label-caps text-ink-faint">Budget · per person</p>
          <p data-testid="budget-spent" className="tabular text-xl leading-tight font-semibold">
            {formatRM(spent)}
            <span className="ml-1.5 text-sm font-normal text-ink-faint">of {formatRM(ceiling)}</span>
          </p>
        </div>
        <div className="text-right">
          <p
            className={cn(
              'tabular text-sm font-semibold',
              over ? 'text-removed' : tight ? 'text-warn' : 'text-added',
            )}
          >
            {over ? `${formatRM(Math.abs(remaining))} over` : `${formatRM(remaining)} left`}
          </p>
          {lastAccepted ? (
            <p
              className={cn(
                'tabular animate-rise text-xs font-medium',
                lastAccepted.budgetDelta <= 0 ? 'text-added' : 'text-moved',
              )}
            >
              {formatDelta(lastAccepted.budgetDelta)} from the re-plan
            </p>
          ) : (
            <p className="flex items-center justify-end gap-1 text-xs text-ink-faint">
              <Lock className="size-3" />
              {formatRM(lockedTotal)} locked
            </p>
          )}
        </div>
      </div>

      <Progress
        value={Math.min(100, pct)}
        className="mt-2.5 h-1.5"
        indicatorClassName={over ? 'bg-removed' : tight ? 'bg-warn' : 'bg-accent'}
      />

      {violations.length > 0 ? (
        <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-warn-soft px-2.5 py-2 text-xs text-warn">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span>
            <span className="font-semibold">{violations[0]?.code.replace(/_/g, ' ')}</span>
            {' — '}
            {violations[0]?.message}
          </span>
        </div>
      ) : null}
    </div>
  );
}
