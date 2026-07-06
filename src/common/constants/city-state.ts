/**
 * Bookings only store a free-text `city`, not a `state`. This maps known
 * operating cities to their state so reports can be filtered/grouped by
 * state without a schema change. Extend as operations reach new cities —
 * anything not listed here simply won't match any state filter.
 */
export const CITY_STATE_MAP: Record<string, string> = {
  Bhubaneswar: 'Odisha',
  Cuttack: 'Odisha',
  Rourkela: 'Odisha',
  Brahmapur: 'Odisha',
  Berhampur: 'Odisha',
  Puri: 'Odisha',
  Sambalpur: 'Odisha',
};

export function citiesForState(state: string): string[] {
  return Object.entries(CITY_STATE_MAP)
    .filter(([, s]) => s === state)
    .map(([city]) => city);
}

export function allStates(): string[] {
  return Array.from(new Set(Object.values(CITY_STATE_MAP))).sort();
}
