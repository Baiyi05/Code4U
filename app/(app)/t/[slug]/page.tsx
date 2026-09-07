import { Suspense } from 'react';

import { ItineraryScreen } from '@/components/itinerary/itinerary-screen';

/**
 * Screen 04 — Itinerary, and screen 05 (Block Detail) alongside it.
 *
 * Both the day tab and the open block live in the query string, so every state
 * this screen can be in has its own shareable URL and the browser's back button
 * closes the detail panel instead of leaving the trip.
 */
export default function ItineraryPage() {
  return (
    <Suspense fallback={null}>
      <ItineraryScreen />
    </Suspense>
  );
}
