import { z } from 'zod';

export const FlightWatchSchema = z
  .object({
    segmentLabel: z.string().trim().max(20, '區段名稱最多 20 字'),
    tripType: z.enum(['roundtrip', 'oneway', 'openjaw']),
    claudeGroup: z.string().trim().max(20, '群組名稱最多 20 字'),
    origin: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, '請輸入 3 碼 IATA 機場代碼'),
    destination: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, '請輸入 3 碼 IATA 機場代碼'),
    /** 只有 openjaw 檢查；其他行程允許空字串 */
    returnOrigin: z.string().trim().toUpperCase(),
    returnDestination: z.string().trim().toUpperCase(),
    ticketSearch: z.enum(['single', 'separate', 'both']),
    departureStart: z.string().min(1, '請選擇最早出發日'),
    departureEnd: z.string().min(1, '請選擇最晚出發日'),
    minNights: z.coerce.number().int().min(1).max(60),
    maxNights: z.coerce.number().int().min(1).max(90),
    adults: z.coerce.number().int().min(1).max(9),
    selectedCabins: z.array(z.enum(['economy', 'premium_economy', 'business', 'first'])).min(1, '至少選擇一種艙等'),
    nonstopOnly: z.boolean(),
    excludeLowCostCarriers: z.boolean(),
    airlineFilter: z.enum(['all', 'include', 'exclude']),
    airlineCodes: z.array(z.string().trim().min(2).max(80)).max(12),
    scanProvider: z.enum(['duffel', 'claude_api', 'claude']),
    scanFrequency: z.enum(['daily', 'weekdays', 'weekly']),
    weeklyDay: z.coerce.number().int().min(0).max(6),
    notifyOnDeal: z.boolean(),
    notifyOnEveryScan: z.boolean(),
    priceDropPercent: z.coerce.number().int().min(1).max(50),
    maxPriceTWD: z.union([z.literal(''), z.coerce.number().int().positive()]),
    enabled: z.boolean(),
  })
  .superRefine((data, ctx) => {
    if (data.origin.trim().toUpperCase() === data.destination.trim().toUpperCase()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destination'],
        message: '抵達機場不可與出發機場相同',
      });
    }
    if (data.tripType === 'openjaw') {
      const iata = /^[A-Z]{3}$/;
      const returnOrigin = data.returnOrigin.trim().toUpperCase();
      const returnDestination = data.returnDestination.trim().toUpperCase();
      if (!iata.test(returnOrigin)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['returnOrigin'], message: '請輸入回程出發機場（3 碼 IATA）' });
      }
      if (!iata.test(returnDestination)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['returnDestination'], message: '請輸入回程抵達機場（3 碼 IATA）' });
      }
      if (returnOrigin && returnOrigin === returnDestination) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['returnDestination'], message: '回程抵達不可與回程出發相同' });
      }
      if (returnOrigin === data.destination.trim().toUpperCase()
        && returnDestination === data.origin.trim().toUpperCase()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['returnOrigin'], message: '回程與去程相反就是一般來回，請改選「來回」' });
      }
    }
    if (data.departureEnd < data.departureStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['departureEnd'],
        message: '最晚出發日不可早於最早出發日',
      });
    }
    if (data.tripType !== 'oneway' && data.maxNights < data.minNights) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxNights'],
        message: '最多天數不可小於最少天數',
      });
    }
    if (data.airlineFilter !== 'all' && data.airlineCodes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['airlineCodes'],
        message: data.airlineFilter === 'include' ? '請選擇至少一家指定航空公司' : '請選擇至少一家排除航空公司',
      });
    }
  });

export type FlightWatchFormValues = z.input<typeof FlightWatchSchema>;
