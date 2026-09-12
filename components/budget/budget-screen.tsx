'use client';

import { ArrowRight, Lock } from 'lucide-react';
import { useMemo } from 'react';

import { Card } from '@/components/ui/card';
import { Avatar } from '@/components/ui/avatar';
import { useTrip } from '@/components/trip-provider';
import {
  DEMO_DAYS,
  categoryOf,
  expensesOf,
  formatDelta,
  formatRM,
  settleUp,
} from '@/lib/demo-data';
import { cn } from '@/lib/utils';

const CATEGORY_TINT: Record<string, string> = {
  Tickets: 'bg-accent',
  Food: 'bg-moved',
  Sights: 'bg-added',
  Shopping: 'bg-kept',
  Other: 'bg-line',
};

/**
 * Screen 07 — Budget & Split.
 *
 * Every number is computed from the blocks currently on the plan, so accepting a
 * re-plan moves this screen too. Expenses are grouped by who fronted the day,
 * and the settle-up is the smallest set of transfers that squares everyone.
 */
export function BudgetScreen() {
  const { blocks, members, constraints, spent, lastAccepted } = useTrip();

  const expenses = useMemo(() => expensesOf(blocks, members.length), [blocks, members.length]);
  const transfers = useMemo(() => settleUp(expenses, members), [expenses, members]);
  const groupTotal = expenses.reduce((sum, e) => sum + e.amount, 0);

  const categories = useMemo(() => {
    const totals = new Map<string, number>();
    for (const block of blocks) {
      const key = categoryOf(block);
      totals.set(key, (totals.get(key) ?? 0) + block.costPerPerson);
    }
    return [...totals.entries()]
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1]);
  }, [blocks]);

  const lockedTotal = blocks.filter((b) => b.locked).reduce((s, b) => s + b.costPerPerson, 0);
  const memberOf = (id: string) => members.find((m) => m.id === id);

  return (
    <div className="px-4 py-5">
      <p className="label-caps text-ink-faint">Budget &amp; split</p>
      <h1 className="mt-1 text-xl leading-tight font-semibold">Where the money went</h1>

      <Card className="mt-4 p-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="label-caps text-ink-faint">Per person</p>
            <p className="tabular mt-0.5 text-3xl leading-none font-semibold">{formatRM(spent)}</p>
            <p className="mt-1.5 text-xs text-ink-soft">
              of {formatRM(constraints.budgetCeiling)} · {formatRM(groupTotal)} across{' '}
              {members.length} people
            </p>
          </div>
          {lastAccepted ? (
            <p
              className={cn(
                'tabular animate-rise text-sm font-semibold',
                lastAccepted.budgetDelta <= 0 ? 'text-added' : 'text-moved',
              )}
            >
              {formatDelta(lastAccepted.budgetDelta)}
            </p>
          ) : null}
        </div>

        <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-line">
          {categories.map(([name, value]) => (
            <div
              key={name}
              title={`${name} ${formatRM(value)}`}
              className={cn('h-full', CATEGORY_TINT[name] ?? 'bg-line')}
              style={{ width: `${spent > 0 ? (value / spent) * 100 : 0}%` }}
            />
          ))}
        </div>

        <ul className="mt-3 space-y-1.5">
          {categories.map(([name, value]) => (
            <li key={name} className="flex items-center gap-2 text-sm">
              <span className={cn('size-2.5 shrink-0 rounded-full', CATEGORY_TINT[name] ?? 'bg-line')} />
              <span className="flex-1">{name}</span>
              <span className="tabular text-ink-soft">
                {spent > 0 ? Math.round((value / spent) * 100) : 0}%
              </span>
              <span className="tabular w-20 text-right font-medium">{formatRM(value)}</span>
            </li>
          ))}
        </ul>

        <p className="mt-3 flex items-center gap-1.5 border-t border-line pt-3 text-xs text-ink-faint">
          <Lock className="size-3" />
          {formatRM(lockedTotal)} of it is locked — prepaid or booked, and out of reach of a re-plan.
        </p>
      </Card>

      <section className="mt-6">
        <h2 className="text-sm font-semibold">Who paid</h2>
        <ul className="mt-3 space-y-2">
          {expenses.map((expense) => {
            const payer = memberOf(expense.payerId);
            const day = DEMO_DAYS.find((d) => d.day === expense.day);
            return (
              <li
                key={expense.day}
                className="flex items-center gap-3 rounded-card border border-line bg-card p-3"
              >
                {payer ? <Avatar member={payer} /> : null}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {payer?.displayName ?? 'Someone'} · day {expense.day}
                  </p>
                  <p className="text-xs text-ink-faint">
                    {day?.date} · {expense.blockCount} block{expense.blockCount === 1 ? '' : 's'}
                  </p>
                </div>
                <p className="tabular text-sm font-semibold">{formatRM(expense.amount)}</p>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold">Who owes who</h2>
        <p className="mt-1 text-xs text-ink-soft">
          The fewest transfers that square everyone. Nobody sends more than one payment they do not
          have to.
        </p>

        <ul className="mt-3 space-y-2">
          {transfers.map((transfer, index) => {
            const from = memberOf(transfer.fromId);
            const to = memberOf(transfer.toId);
            return (
              <li
                key={`${transfer.fromId}-${transfer.toId}-${index}`}
                className="flex items-center gap-3 rounded-card border border-line bg-card p-3"
              >
                {from ? <Avatar member={from} size="sm" /> : null}
                <span className="text-sm font-medium">{from?.displayName}</span>
                <ArrowRight className="size-3.5 text-ink-faint" />
                {to ? <Avatar member={to} size="sm" /> : null}
                <span className="text-sm font-medium">{to?.displayName}</span>
                <span className="tabular ml-auto text-sm font-semibold">
                  {formatRM(transfer.amount)}
                </span>
              </li>
            );
          })}
          {transfers.length === 0 ? (
            <li className="rounded-card border border-dashed border-line p-4 text-center text-sm text-ink-faint">
              Everyone is square.
            </li>
          ) : null}
        </ul>
      </section>

      <p className="mt-6 text-[0.6875rem] leading-relaxed text-ink-faint">
        Splitting is equal shares — receipt scanning and uneven splits are on the list of things
        this prototype deliberately does not do.
      </p>
    </div>
  );
}
