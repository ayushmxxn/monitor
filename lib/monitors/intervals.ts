/** Selectable check intervals, in minutes. */
export const INTERVAL_OPTIONS = [5, 15, 30, 60, 180, 360, 1440] as const;

/** "5 min" / "3 hr" / "1 day" */
export function formatIntervalMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${minutes / 60} hr`;
  const days = minutes / 1440;
  return `${days} day${days > 1 ? 's' : ''}`;
}
