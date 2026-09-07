'use client';

import { ArrowRight, Check, Copy, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/field';
import { DEMO_TRIP, INVITE_URL, formatRM } from '@/lib/demo-data';
import { TripSchema } from '@/lib/schemas';

/**
 * Screen 01 — Trip Setup.
 *
 * The form is real and validates through the same Zod schema the rest of the
 * project uses, but it deliberately does not rebuild the trip: changing the
 * budget would move the ceiling, and re-deriving an itinerary underneath it
 * needs a model this prototype does not have. It creates the demo trip.
 */
export function SetupScreen() {
  const router = useRouter();
  const [form, setForm] = useState({
    destination: DEMO_TRIP.destination,
    startDate: DEMO_TRIP.startDate,
    endDate: DEMO_TRIP.endDate,
    budget: String(DEMO_TRIP.budgetPerPerson),
    size: '4',
  });
  const [invited, setInvited] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = (): void => {
    const parsed = TripSchema.safeParse({
      ...DEMO_TRIP,
      destination: form.destination.trim(),
      startDate: form.startDate,
      endDate: form.endDate,
      budgetPerPerson: Number(form.budget),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Something in that is not valid.');
      return;
    }
    if (parsed.data.endDate < parsed.data.startDate) {
      setError('The trip cannot end before it starts.');
      return;
    }
    setError(null);
    setInvited(true);
  };

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(INVITE_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 py-8">
      <p className="label-caps text-accent-ink">Detour</p>
      <h1 className="mt-1.5 text-2xl leading-tight font-semibold text-balance">
        A trip that re-plans itself when the day falls apart.
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        Set the frame. Everyone else fills in what they want from a link, and the plan gets built
        against a budget ceiling and a set of hard rules — not a chat window.
      </p>

      <div className="mt-7 space-y-4">
        <div>
          <Label htmlFor="destination">Where</Label>
          <Input
            id="destination"
            className="mt-1.5"
            value={form.destination}
            onChange={(e) => setForm({ ...form, destination: e.target.value })}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="start">From</Label>
            <Input
              id="start"
              type="date"
              className="mt-1.5"
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="end">To</Label>
            <Input
              id="end"
              type="date"
              className="mt-1.5"
              value={form.endDate}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="budget">Budget per person</Label>
            <Input
              id="budget"
              inputMode="numeric"
              className="mt-1.5"
              value={form.budget}
              onChange={(e) => setForm({ ...form, budget: e.target.value.replace(/[^\d]/g, '') })}
            />
            <p className="mt-1 text-[0.6875rem] text-ink-faint">
              {formatRM(Number(form.budget) || 0)} · a hard ceiling, not a target
            </p>
          </div>
          <div>
            <Label htmlFor="size">Group size</Label>
            <Input
              id="size"
              inputMode="numeric"
              className="mt-1.5"
              value={form.size}
              onChange={(e) => setForm({ ...form, size: e.target.value.replace(/[^\d]/g, '') })}
            />
            <p className="mt-1 text-[0.6875rem] text-ink-faint">including you</p>
          </div>
        </div>

        {error ? (
          <p className="rounded-lg bg-removed-soft px-3 py-2 text-xs text-removed">{error}</p>
        ) : null}
      </div>

      <div className="mt-auto pt-8">
        <Button size="lg" variant="accent" className="w-full" onClick={create}>
          Create trip
          <ArrowRight className="size-4" />
        </Button>
        <p className="mt-3 text-center text-[0.6875rem] leading-relaxed text-ink-faint">
          No account, no password. Whoever has the link is in the trip.
        </p>
      </div>

      <Dialog open={invited} onOpenChange={setInvited}>
        <DialogContent>
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-full bg-added-soft text-added">
              <Check className="size-4" />
            </span>
            <DialogTitle>Trip created</DialogTitle>
          </div>
          <DialogDescription className="mt-1.5">
            Send this to the other {Math.max(0, Number(form.size) - 1) || 3}. It opens the
            questionnaire — about 45 seconds each.
          </DialogDescription>

          <div className="mt-4 flex justify-center rounded-xl border border-line bg-white p-4">
            <QRCodeSVG value={INVITE_URL} size={148} level="M" marginSize={0} />
          </div>

          <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-line-soft/60 px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-soft">
              {INVITE_URL}
            </code>
            <Button variant="ghost" size="sm" onClick={copy}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>

          <Button
            variant="accent"
            className="mt-4 w-full"
            onClick={() => router.push(`/t/${DEMO_TRIP.slug}/join`)}
          >
            <Users className="size-4" />
            Fill it in as a member
          </Button>
          <Button
            variant="ghost"
            className="mt-1.5 w-full"
            onClick={() => router.push(`/t/${DEMO_TRIP.slug}`)}
          >
            Skip to the itinerary
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
