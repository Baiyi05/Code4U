'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { buildConstraints, totalCost, validateItinerary } from '@/lib/constraints';
import { buildCandidatePool } from '@/lib/generate';
import {
  DEMO_BLOCKS,
  DEMO_MEMBERS,
  DEMO_PLACES,
  DEMO_PREFERENCES,
  DEMO_TRIP,
  type DemoMember,
} from '@/lib/demo-data';
import type { Block, Constraints, Place, Preference, Violation } from '@/lib/schemas';

/**
 * The whole prototype's state: a handful of useState hooks behind a context.
 *
 * Context rather than prop-drilling for one specific reason — the Re-plan screen
 * is its own route. This provider lives in app/(app)/layout.tsx, which App Router
 * does NOT remount on client-side navigation, so an accepted diff is still there
 * when you walk back to the itinerary. Page-level state would be gone.
 *
 * No state library, and nothing is persisted: a hard refresh puts the demo back
 * to its opening position, which is what you want on stage.
 */

export interface AcceptedDiff {
  scenarioKey: string;
  headline: string;
  opIds: string[];
  opCount: number;
  budgetDelta: number;
  /** ids the budget guard cut afterwards, if any */
  guardCut: string[];
}

interface TripState {
  members: DemoMember[];
  preferences: Preference[];
  blocks: Block[];
  places: Place[];
  /** derived from the preferences by the rule engine, never stored */
  constraints: Constraints;
  /** per person, derived from the blocks */
  spent: number;
  /** what the rule engine currently says about the itinerary */
  violations: Violation[];
  /** null until a re-plan is accepted */
  lastAccepted: AcceptedDiff | null;
  /** blocks a re-plan added or moved, so the itinerary can flag them */
  changedIds: ReadonlySet<string>;

  toggleLock: (blockId: string) => void;
  swapPlace: (blockId: string, place: Place) => void;
  acceptDiff: (blocks: Block[], accepted: AcceptedDiff, changedIds: string[]) => void;
  addMember: (member: DemoMember, preference: Preference) => void;
  reset: () => void;
}

const TripContext = createContext<TripState | null>(null);

export function TripProvider({ children }: { children: ReactNode }) {
  const [members, setMembers] = useState<DemoMember[]>(DEMO_MEMBERS);
  const [preferences, setPreferences] = useState<Preference[]>(DEMO_PREFERENCES);
  const [blocks, setBlocks] = useState<Block[]>(DEMO_BLOCKS);
  const [lastAccepted, setLastAccepted] = useState<AcceptedDiff | null>(null);
  const [changedIds, setChangedIds] = useState<ReadonlySet<string>>(new Set<string>());

  // Both of these come out of lib/constraints.ts on every render rather than
  // being tracked in state, so they can never disagree with the blocks on screen.
  const constraints = useMemo(() => buildConstraints(DEMO_TRIP, preferences), [preferences]);

  const violations = useMemo(() => {
    const pool = buildCandidatePool(DEMO_PLACES, constraints);
    return validateItinerary(blocks, constraints, pool.all).violations;
  }, [blocks, constraints]);

  const toggleLock = useCallback((blockId: string) => {
    setBlocks((current) =>
      current.map((block) => (block.id === blockId ? { ...block, locked: !block.locked } : block)),
    );
  }, []);

  const swapPlace = useCallback((blockId: string, place: Place) => {
    setBlocks((current) =>
      current.map((block) =>
        block.id === blockId
          ? {
              ...block,
              placeId: place.id,
              title: place.name,
              subtitle: [place.district, place.category].filter(Boolean).join(' · ') || null,
              costPerPerson: place.estCostPerPerson ?? block.costPerPerson,
              durationMin: place.avgDurationMin ?? block.durationMin,
              // The new place has no retrieved text behind it, so it gets no
              // citation. Carrying the old one over would be a fabrication.
              sourceCitation: null,
              createdBy: 'captain',
              reason: {
                budget: `RM ${place.estCostPerPerson ?? block.costPerPerson} per person.`,
                votes: 'Swapped by the captain — no vote taken.',
                constraint: place.indoor ? 'Indoors, so weather does not decide it.' : 'Open air.',
              },
            }
          : block,
      ),
    );
    setChangedIds((current) => new Set(current).add(blockId));
  }, []);

  const acceptDiff = useCallback((next: Block[], accepted: AcceptedDiff, changed: string[]) => {
    setBlocks(next);
    setLastAccepted(accepted);
    setChangedIds(new Set(changed));
  }, []);

  const addMember = useCallback((member: DemoMember, preference: Preference) => {
    setMembers((current) =>
      current.some((m) => m.id === member.id) ? current : [...current, member],
    );
    setPreferences((current) => [
      ...current.filter((p) => p.memberId !== preference.memberId),
      preference,
    ]);
  }, []);

  const reset = useCallback(() => {
    setMembers(DEMO_MEMBERS);
    setPreferences(DEMO_PREFERENCES);
    setBlocks(DEMO_BLOCKS);
    setLastAccepted(null);
    setChangedIds(new Set<string>());
  }, []);

  const value = useMemo<TripState>(
    () => ({
      members,
      preferences,
      blocks,
      places: DEMO_PLACES,
      constraints,
      spent: totalCost(blocks),
      violations,
      lastAccepted,
      changedIds,
      toggleLock,
      swapPlace,
      acceptDiff,
      addMember,
      reset,
    }),
    [
      members,
      preferences,
      blocks,
      constraints,
      violations,
      lastAccepted,
      changedIds,
      toggleLock,
      swapPlace,
      acceptDiff,
      addMember,
      reset,
    ],
  );

  return <TripContext.Provider value={value}>{children}</TripContext.Provider>;
}

export function useTrip(): TripState {
  const value = useContext(TripContext);
  if (!value) throw new Error('useTrip must be used inside <TripProvider>');
  return value;
}
