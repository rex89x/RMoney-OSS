export { RentalsPanel } from './components/rentals-panel';
export { RentalsDashboardCard } from './components/rentals-dashboard-card';
export {
  useRentals, useCreateRental, useUpdateRental, useArchiveRental,
  useRecordRentalIncome, useDeleteRentalIncome,
} from './hooks';
export type { Rental, RentalIncome, RentalAssetType } from './types';
export {
  RENTAL_ASSET_TYPE_LABEL, totalReceivedTWD, netPnLTWD, avgMonthlyIncomeTWD, paybackProgressPct,
  estimateMonthsToPayback, projectedPaybackDate,
  projectedRemainingRecoverableTWD, projectedTotalRecoverableTWD,
  totalProjectedRecoverableTWD, totalProjectedRemainingRecoverableTWD,
  unrecoveredCostTWD, totalUnrecoveredCostTWD,
} from './types';
