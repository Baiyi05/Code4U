import { AppShell } from '@/components/app-shell';
import { TripProvider } from '@/components/trip-provider';

/**
 * The provider lives here, one level above every screen, so state survives the
 * walk from the itinerary to the re-plan diff and back. App Router keeps a
 * layout mounted across client-side navigation; a page would not.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <TripProvider>
      <AppShell>{children}</AppShell>
    </TripProvider>
  );
}
