'use client';

import { CloudRain, DoorClosed, PlaneLanding, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { DEMO_SCENARIOS, diffFor, type ScenarioKey } from '@/lib/demo-data';

const ICONS: Record<ScenarioKey, LucideIcon> = {
  delay: PlaneLanding,
  weather: CloudRain,
  closed: DoorClosed,
  overbudget: Wallet,
};

/**
 * Screen 06, first half — what went wrong.
 *
 * Four triggers, one per disruption type the engine knows about. A real build
 * gets here from a flight webhook or a weather poll; §10 keeps those out of a
 * demo on purpose, so the captain presses the button instead.
 */
export function ScenarioPicker({ onPick }: { onPick: (key: ScenarioKey) => void }) {
  return (
    <div className="px-4 py-5">
      <p className="label-caps text-ink-faint">Re-plan</p>
      <h1 className="mt-1 text-xl leading-tight font-semibold">What has gone wrong?</h1>
      <p className="mt-1.5 text-sm text-ink-soft">
        Pick what happened. The rule engine works out what may change, and nothing is applied
        until you accept it.
      </p>

      <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
        {DEMO_SCENARIOS.map((scenario) => {
          const Icon = ICONS[scenario.key];
          const diff = diffFor(scenario.key);
          const changes = diff.ops.length;
          return (
            <Card key={scenario.key} className="overflow-hidden p-0">
              <button
                type="button"
                onClick={() => onPick(scenario.key)}
                className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-line-soft/70"
              >
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
                  <Icon className="size-4.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.9375rem] font-semibold">{scenario.label}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-ink-soft">
                    {scenario.blurb}
                  </span>
                  <span className="tabular mt-2 block text-[0.6875rem] text-ink-faint">
                    {changes} change{changes === 1 ? '' : 's'} · day{' '}
                    {scenario.disruption.day} · fires at {scenario.now.time}
                  </span>
                </span>
              </button>
            </Card>
          );
        })}
      </div>

      <p className="mt-4 text-[0.6875rem] leading-relaxed text-ink-faint">
        Each diff was produced by <code className="font-mono">lib/replan.ts</code> against the
        itinerary below and committed with the app. Accepting one runs{' '}
        <code className="font-mono">applyDiff</code> and{' '}
        <code className="font-mono">enforceBudget</code> in your browser, so the plan and the
        budget really do change.
      </p>
    </div>
  );
}
