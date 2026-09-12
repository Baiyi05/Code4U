'use client';

import { ArrowLeft, ArrowRight, Check, PartyPopper } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Chip, Input, Label, Option, OptionGroup } from '@/components/ui/field';
import { Avatar } from '@/components/ui/avatar';
import { useTrip } from '@/components/trip-provider';
import {
  DEMO_TRIP,
  JOINING_MEMBER,
  JOINING_PREFERENCE,
  findConflicts,
} from '@/lib/demo-data';
import type { BudgetBand, Pace, Preference } from '@/lib/schemas';

const INTERESTS = [
  'street food',
  'history',
  'nightlife',
  'parks',
  'museums',
  'theme parks',
  'views',
  'shopping',
  'architecture',
];

const DIETARY = ['vegetarian', 'halal', 'no pork', 'no beef', 'nut allergy'];

/** Five questions, one per screen. The presets are Nabil's, so the demo is one thumb. */
const STEPS = ['Budget', 'Pace', 'Interests', 'Dietary', 'Must-do'] as const;

export function IntakeScreen() {
  const { addMember, members, preferences } = useTrip();
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [draft, setDraft] = useState<Preference>(JOINING_PREFERENCE);

  const alreadyJoined = members.some((m) => m.id === JOINING_MEMBER.id);

  // What this answer set will add to the group, worked out before it is submitted
  const newConflicts = useMemo(() => {
    const before = findConflicts(preferences, members).map((c) => c.title);
    const after = findConflicts([...preferences, draft], [...members, JOINING_MEMBER]);
    return after.filter((c) => !before.includes(c.title));
  }, [draft, members, preferences]);

  const toggleIn = (list: string[] | null, value: string): string[] => {
    const current = list ?? [];
    return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  };

  if (done || alreadyJoined) {
    return (
      <div className="px-4 py-8">
        <div className="mx-auto max-w-md text-center">
          <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-added-soft text-added">
            <PartyPopper className="size-6" />
          </span>
          <h1 className="mt-4 text-xl font-semibold">Done — 47 seconds</h1>
          <p className="mt-2 text-sm text-ink-soft">
            {JOINING_MEMBER.displayName} is in. The group profile has been recalculated — no model
            was involved, it is set arithmetic over what everyone answered.
          </p>

          {newConflicts.length > 0 ? (
            <div className="mt-5 animate-rise rounded-card border border-added/30 bg-added-soft/40 p-4 text-left">
              <p className="label-caps text-added">New in the profile</p>
              <ul className="mt-2 space-y-2">
                {newConflicts.map((conflict) => (
                  <li key={conflict.title}>
                    <p className="text-sm font-medium">{conflict.title}</p>
                    <p className="mt-0.5 text-xs text-ink-soft">{conflict.detail}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <Button asChild variant="accent" size="lg" className="mt-6 w-full">
            <Link href={`/t/${DEMO_TRIP.slug}/profile`}>See the group profile</Link>
          </Button>
        </div>
      </div>
    );
  }

  const last = step === STEPS.length - 1;

  return (
    <div className="px-4 py-5">
      <div className="mx-auto max-w-md">
        <div className="flex items-center gap-3">
          <Avatar member={JOINING_MEMBER} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{JOINING_MEMBER.displayName}</p>
            <p className="text-xs text-ink-faint">joining {DEMO_TRIP.destination}</p>
          </div>
          <p className="tabular text-xs text-ink-faint">
            {step + 1} / {STEPS.length}
          </p>
        </div>

        <Progress value={((step + 1) / STEPS.length) * 100} className="mt-3" />

        <div key={step} className="mt-6 animate-rise">
          {step === 0 ? (
            <Question title="What are you comfortable spending?" hint="Per person, for the whole trip.">
              <OptionGroup
                className="space-y-2"
                value={draft.budgetBand ?? ''}
                onValueChange={(v) => setDraft({ ...draft, budgetBand: v as BudgetBand })}
              >
                <Option value="low" title="Keep it cheap" hint="Up to 85% of the trip budget" />
                <Option value="mid" title="Somewhere in the middle" hint="Up to 95%" />
                <Option value="high" title="Happy to spend" hint="The full trip budget" />
              </OptionGroup>
            </Question>
          ) : null}

          {step === 1 ? (
            <Question title="How full should the days be?" hint="This decides blocks per day.">
              <OptionGroup
                className="space-y-2"
                value={draft.pace ?? ''}
                onValueChange={(v) => setDraft({ ...draft, pace: v as Pace })}
              >
                <Option value="chill" title="Slow" hint="Three things a day, long meals" />
                <Option value="balanced" title="Balanced" hint="Four things a day" />
                <Option value="packed" title="Packed" hint="Five things a day, early starts" />
              </OptionGroup>
            </Question>
          ) : null}

          {step === 2 ? (
            <Question title="What are you here for?" hint="Pick as many as you like.">
              <div className="flex flex-wrap gap-2">
                {INTERESTS.map((interest) => (
                  <Chip
                    key={interest}
                    selected={(draft.interests ?? []).includes(interest)}
                    onClick={() =>
                      setDraft({ ...draft, interests: toggleIn(draft.interests, interest) })
                    }
                  >
                    {interest}
                  </Chip>
                ))}
              </div>
            </Question>
          ) : null}

          {step === 3 ? (
            <Question
              title="Anything you cannot eat?"
              hint="Every meal block has to clear all of these at once, for everyone."
            >
              <div className="flex flex-wrap gap-2">
                {DIETARY.map((diet) => (
                  <Chip
                    key={diet}
                    selected={(draft.dietary ?? []).includes(diet)}
                    onClick={() => setDraft({ ...draft, dietary: toggleIn(draft.dietary, diet) })}
                  >
                    {diet}
                  </Chip>
                ))}
              </div>
            </Question>
          ) : null}

          {step === 4 ? (
            <Question
              title="One thing you would be sad to miss?"
              hint="It becomes a hard requirement — the plan has to include it or say why it does not."
            >
              <div className="space-y-3">
                <div>
                  <Label htmlFor="mustdo">Must do</Label>
                  <Input
                    id="mustdo"
                    className="mt-1.5"
                    value={draft.mustDo ?? ''}
                    onChange={(e) => setDraft({ ...draft, mustDo: e.target.value || null })}
                    placeholder="Kuromon Market"
                  />
                </div>
                <div>
                  <Label htmlFor="nogo">And one thing you would rather skip</Label>
                  <Input
                    id="nogo"
                    className="mt-1.5"
                    value={draft.noGo ?? ''}
                    onChange={(e) => setDraft({ ...draft, noGo: e.target.value || null })}
                    placeholder="optional"
                  />
                </div>
              </div>
            </Question>
          ) : null}
        </div>

        {newConflicts.length > 0 && step >= 3 ? (
          <p className="mt-4 animate-rise rounded-lg bg-moved-soft px-3 py-2 text-xs text-moved">
            Heads up — this adds a{' '}
            <span className="font-semibold">{newConflicts[0]?.title.toLowerCase()}</span> conflict
            the group does not have yet. The captain will see it.
          </p>
        ) : null}

        <div className="mt-6 flex gap-2">
          <Button
            variant="outline"
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <Button
            variant="accent"
            className="flex-1"
            onClick={() => {
              if (last) {
                addMember(JOINING_MEMBER, draft);
                setDone(true);
              } else {
                setStep((s) => s + 1);
              }
            }}
          >
            {last ? (
              <>
                <Check className="size-4" />
                Done
              </>
            ) : (
              <>
                Next
                <ArrowRight className="size-4" />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Question({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h1 className="text-lg leading-snug font-semibold text-balance">{title}</h1>
      <p className="mt-1.5 text-sm text-ink-soft">{hint}</p>
      <div className="mt-4">{children}</div>
    </div>
  );
}
