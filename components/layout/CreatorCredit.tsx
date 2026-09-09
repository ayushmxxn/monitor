import { CREATOR_HANDLE, CREATOR_TWITTER_URL } from '@/lib/constants';

/**
 * "Made by" credit shown in the settings footer.
 */
export function CreatorCredit() {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      Made by
      <a
        href={CREATOR_TWITTER_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-foreground hover:underline"
      >
        {CREATOR_HANDLE}
      </a>
    </span>
  );
}
