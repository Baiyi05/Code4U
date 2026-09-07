import { Suspense } from 'react';

import { ReplanScreen } from '@/components/replan/replan-screen';

/**
 * Screen 06 — Re-plan Diff.
 *
 * The chosen trigger lives in the query string (`?s=delay`), so a particular
 * diff has its own URL and the back button steps from the diff to the trigger
 * list rather than out of the trip.
 */
export default function ReplanPage() {
  return (
    <Suspense fallback={null}>
      <ReplanScreen />
    </Suspense>
  );
}
