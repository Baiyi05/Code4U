'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { DiffScreen } from '@/components/replan/diff-screen';
import { ScenarioPicker } from '@/components/replan/scenario-picker';
import { SCENARIOS_BY_KEY, type ScenarioKey } from '@/lib/demo-data';

/** How much of a typed trigger is carried in the URL. */
const NOTE_LIMIT = 140;

export function ReplanScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const raw = params.get('s');
  const key = raw && SCENARIOS_BY_KEY.has(raw as ScenarioKey) ? (raw as ScenarioKey) : null;
  const note = params.get('note')?.slice(0, NOTE_LIMIT) ?? null;

  if (key === null) {
    return (
      <ScenarioPicker
        onPick={(picked, typed) => {
          const query = new URLSearchParams({ s: picked });
          if (typed) query.set('note', typed.slice(0, NOTE_LIMIT));
          router.push(`${pathname}?${query.toString()}`);
        }}
      />
    );
  }

  return <DiffScreen scenarioKey={key} note={note} onBack={() => router.push(pathname)} />;
}
