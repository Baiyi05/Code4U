'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { DiffScreen } from '@/components/replan/diff-screen';
import { ScenarioPicker } from '@/components/replan/scenario-picker';
import { SCENARIOS_BY_KEY, type ScenarioKey } from '@/lib/demo-data';

export function ReplanScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const raw = params.get('s');
  const key = raw && SCENARIOS_BY_KEY.has(raw as ScenarioKey) ? (raw as ScenarioKey) : null;

  if (key === null) {
    return <ScenarioPicker onPick={(picked) => router.push(`${pathname}?s=${picked}`)} />;
  }

  return <DiffScreen scenarioKey={key} onBack={() => router.push(pathname)} />;
}
