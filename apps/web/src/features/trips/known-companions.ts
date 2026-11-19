import { useMemo } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { useHousehold } from '@/features/household/hooks';
import { useTrips } from './hooks';
import { collectKnownCompanions, type KnownCompanion } from './companions';

export { collectKnownCompanions, companionToMember, householdTripMembers, type KnownCompanion } from './companions';

export function useKnownCompanions(): KnownCompanion[] {
  const { user } = useAuth();
  const { data: trips = [] } = useTrips();
  const { household } = useHousehold();
  return useMemo(
    () => collectKnownCompanions({ trips, household, myUid: user?.uid }),
    [trips, household, user?.uid],
  );
}

