'use client';

import { CircleAlert, Crown, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Avatar, AvatarRow } from '@/components/ui/avatar';
import { useTrip } from '@/components/trip-provider';
import { DEMO_TRIP, consensusTags, findConflicts, formatRM } from '@/lib/demo-data';
import { cn } from '@/lib/utils';

const KIND_TINT = {
  budget: 'border-accent/40 bg-accent-soft/40',
  pace: 'border-moved/30 bg-moved-soft/40',
  dietary: 'border-added/30 bg-added-soft/40',
  interest: 'border-removed/30 bg-removed-soft/40',
} as const;

/**
 * Screen 03 — Taste Profile, from the captain's chair.
 *
 * Nothing here is written down anywhere: the tags are the interests two or more
 * people share, and the conflict cards are set arithmetic over the same
 * preferences the rule engine reads. Walk through the questionnaire on screen 05
 * and a card that did not exist appears here, because the input changed.
 */
export function TasteScreen() {
  const { members, preferences, constraints, violations } = useTrip();

  const tags = useMemo(() => consensusTags(preferences), [preferences]);
  const conflicts = useMemo(() => findConflicts(preferences, members), [preferences, members]);
  const memberOf = (id: string) => members.find((m) => m.id === id);
  const captain = members.find((m) => m.isCaptain);
  const unscheduled = violations.filter((v) => v.code === 'missing_forced');

  return (
    <div className="px-4 py-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="label-caps text-ink-faint">Taste profile</p>
          <h1 className="mt-1 text-xl leading-tight font-semibold">
            What {members.length} people agreed on
          </h1>
        </div>
        {captain ? (
          <div className="flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1.5">
            <Crown className="size-3.5 text-accent-ink" />
            <span className="text-xs font-medium text-accent-ink">{captain.displayName}</span>
          </div>
        ) : null}
      </div>

      <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
        <Stat label="Ceiling" value={formatRM(constraints.budgetCeiling)} hint="lowest band, not the average" />
        <Stat label="Pace" value={constraints.pace} hint={`${constraints.blocksPerDay} blocks a day`} />
        <Stat
          label="Hard filters"
          value={String(constraints.excluded.length + constraints.requiredTags.length)}
          hint="no-gos and dietary needs"
        />
      </div>

      <section className="mt-6">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-accent" />
          <h2 className="text-sm font-semibold">Shared ground</h2>
        </div>
        <p className="mt-1 text-xs text-ink-soft">
          Interests more than one of you asked for. These steer the retrieval queries.
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {tags.map((entry) => (
            <span
              key={entry.tag}
              className="flex items-center gap-2 rounded-full border border-line bg-card py-1 pr-2 pl-3"
            >
              <span className="text-sm font-medium capitalize">{entry.tag}</span>
              <AvatarRow
                members={entry.memberIds
                  .map(memberOf)
                  .filter((m): m is NonNullable<typeof m> => Boolean(m))}
              />
            </span>
          ))}
          {tags.length === 0 ? (
            <p className="text-sm text-ink-faint">No overlap yet — everyone wants something different.</p>
          ) : null}
        </div>

        {constraints.requiredTags.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="label-caps text-ink-faint">Must clear</span>
            {constraints.requiredTags.map((tag) => (
              <Badge key={tag} variant="added">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}

        {constraints.excluded.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="label-caps text-ink-faint">Ruled out</span>
            {constraints.excluded.map((tag) => (
              <Badge key={tag} variant="removed">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold">Where you disagree</h2>
        <p className="mt-1 text-xs text-ink-soft">
          Not put to a vote. Each one says what the rule engine did about it, and the captain can
          override any of it.
        </p>

        <div className="mt-3 space-y-2.5">
          {conflicts.map((conflict, index) => (
            <Card
              key={`${conflict.kind}-${index}`}
              className={cn('animate-rise border p-4', KIND_TINT[conflict.kind])}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="label-caps text-ink-soft">{conflict.title}</p>
                <AvatarRow
                  members={[...new Set(conflict.memberIds)]
                    .map(memberOf)
                    .filter((m): m is NonNullable<typeof m> => Boolean(m))}
                />
              </div>
              <p className="mt-2 text-sm leading-snug font-medium">{conflict.detail}</p>
              <p className="mt-2 text-xs leading-relaxed text-ink-soft">{conflict.resolution}</p>
            </Card>
          ))}

          {unscheduled.map((violation) => (
            <Card key={violation.code} className="animate-rise border border-warn/30 bg-warn-soft/50 p-4">
              <div className="flex items-center gap-2">
                <CircleAlert className="size-4 text-warn" />
                <p className="label-caps text-warn">Unscheduled must-do</p>
              </div>
              <p className="mt-2 text-sm leading-snug font-medium">{violation.message}</p>
              <p className="mt-2 text-xs leading-relaxed text-ink-soft">
                The rule engine flags it rather than quietly dropping it. Swap it into a block, or
                let it go — but the captain decides, not the model.
              </p>
              <Button asChild variant="outline" size="sm" className="mt-3">
                <Link href={`/t/${DEMO_TRIP.slug}`}>Open the itinerary</Link>
              </Button>
            </Card>
          ))}

          {conflicts.length === 0 && unscheduled.length === 0 ? (
            <p className="text-sm text-ink-faint">Nothing in conflict. Suspicious, but fine.</p>
          ) : null}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold">Everyone</h2>
        <ul className="mt-3 space-y-2">
          {members.map((member) => {
            const pref = preferences.find((p) => p.memberId === member.id);
            return (
              <li key={member.id} className="flex items-start gap-3 rounded-card border border-line bg-card p-3">
                <Avatar member={member} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {member.displayName}
                    {member.isCaptain ? (
                      <span className="ml-1.5 text-xs font-normal text-accent-ink">captain</span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-soft">
                    {[
                      pref?.budgetBand ? `${pref.budgetBand} budget` : null,
                      pref?.pace ? `${pref.pace} pace` : null,
                      pref?.interests?.join(', '),
                      pref?.dietary?.length ? pref.dietary.join(', ') : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {pref?.mustDo ? (
                    <p className="mt-1 text-xs text-ink-faint">must do: {pref.mustDo}</p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-card border border-line bg-card p-3">
      <p className="label-caps text-ink-faint">{label}</p>
      <p className="tabular mt-1 text-lg leading-none font-semibold capitalize">{value}</p>
      <p className="mt-1 text-[0.6875rem] text-ink-faint">{hint}</p>
    </div>
  );
}
