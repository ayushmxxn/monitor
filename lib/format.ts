const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['week', 604_800_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const timeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** "3 hours ago", "just now", etc. */
export function formatRelativeTime(timestamp: number): string {
  const diff = timestamp - Date.now();
  const abs = Math.abs(diff);

  if (abs < 60_000) return 'Just now';

  for (const [unit, ms] of RELATIVE_UNITS) {
    if (abs >= ms) {
      return relativeFormatter.format(Math.round(diff / ms), unit);
    }
  }
  return relativeFormatter.format(Math.round(diff / 60_000), 'minute');
}

/** "Jul 29, 2026, 4:05 PM" */
export function formatDateTime(timestamp: number): string {
  return timeFormatter.format(timestamp);
}
