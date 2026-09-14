/**
 * Structured check diagnostics.
 *
 * Every failure (and every recovery, even successful ones) is tagged
 * with a `DiagnosticCode` instead of a bare string, so the UI can show
 * a precise, actionable explanation and the checker can decide how to
 * react (e.g. force a strategy re-probe after `ANTI_AUTOMATION_DETECTED`,
 * but not after `PERMISSION_DENIED`).
 */

export type DiagnosticCode =
  | 'PERMISSION_DENIED'
  | 'AUTH_REQUIRED'
  | 'NETWORK_ERROR'
  | 'PAGE_LOAD_TIMEOUT'
  | 'PAGE_NOT_READY'
  | 'ANTI_AUTOMATION_DETECTED'
  | 'ELEMENT_NOT_FOUND'
  | 'SELECTOR_RECOVERY_LOW_CONFIDENCE'
  | 'EXTRACTION_EMPTY'
  | 'NEEDS_REPICK'
  | 'ACCESS_CHANGED'
  | 'TAB_CLOSED'
  | 'OK'
  | 'OK_RECOVERED'
  | 'UNKNOWN';

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  /** Extra machine detail (best-candidate score, matched signals, HTTP status, etc.) for the detail panel. */
  detail?: string;
}

const EXPLANATIONS: Record<DiagnosticCode, string> = {
  PERMISSION_DENIED:
    'This extension no longer has permission to read this site. Grant access again from Settings.',
  AUTH_REQUIRED:
    'The page looks like a sign-in screen rather than the monitored content — you may be logged out.',
  NETWORK_ERROR: 'The request to load the page failed (offline, DNS, or connection error).',
  PAGE_LOAD_TIMEOUT: 'The page did not finish loading in time.',
  PAGE_NOT_READY:
    'The page kept changing and never settled, so the check ran out of time.',
  ANTI_AUTOMATION_DETECTED:
    'The site is showing a bot-verification or challenge page instead of its normal content. This is usually temporary — checks keep retrying automatically and never attempt to bypass it.',
  ELEMENT_NOT_FOUND:
    'The monitored value is no longer on the page, and nothing similar enough was found to take its place.',
  SELECTOR_RECOVERY_LOW_CONFIDENCE:
    'The page changed, and the closest match was too uncertain to use automatically.',
  EXTRACTION_EMPTY: 'The monitored spot was found, but it is currently empty.',
  NEEDS_REPICK:
    'The saved element can no longer be found on this page, even when retrying from the last known value. Delete this monitor and pick the value again to resume monitoring.',
  ACCESS_CHANGED:
    'This monitor was created under a different account or workspace. Switch back to the original account and retry — the saved position is kept unchanged so it can recover automatically.',
  TAB_CLOSED: 'The check was interrupted before it finished.',
  OK: 'Checked successfully.',
  OK_RECOVERED: 'The original element moved or changed, but a matching replacement was found automatically.',
  UNKNOWN: 'An unexpected error occurred.',
};

export function explainDiagnostic(code: DiagnosticCode): string {
  return EXPLANATIONS[code] ?? EXPLANATIONS.UNKNOWN;
}

export function diagnostic(code: DiagnosticCode, detail?: string): Diagnostic {
  return { code, message: explainDiagnostic(code), detail };
}

export function formatDiagnostic(d: Diagnostic): string {
  return d.detail ? `${d.message} (${d.detail})` : d.message;
}

/** Codes that indicate persistent conditions where retrying the same strategy immediately won't help. */
export const NON_RETRYABLE_CODES: ReadonlySet<DiagnosticCode> = new Set([
  'PERMISSION_DENIED',
  'AUTH_REQUIRED',
]);

/** Codes that should force a fresh strategy cascade next check instead of trusting the persisted strategy. */
export const FORCE_REPROBE_CODES: ReadonlySet<DiagnosticCode> = new Set([
  'ANTI_AUTOMATION_DETECTED',
  'PAGE_NOT_READY',
  'ELEMENT_NOT_FOUND',
  'SELECTOR_RECOVERY_LOW_CONFIDENCE',
  'EXTRACTION_EMPTY',
  'NEEDS_REPICK',
  'ACCESS_CHANGED',
  'NETWORK_ERROR',
  'PAGE_LOAD_TIMEOUT',
  'TAB_CLOSED',
]);

/**
 * Failure codes where the stored identity itself — not page state, not
 * loading — is what's wrong: the fingerprint no longer resolves to
 * anything trustworthy. These are the only codes eligible for a
 * value-anchored re-anchor attempt (see `buildReanchorFingerprint`),
 * and, once repeated past the permanent threshold, for the terminal
 * `NEEDS_REPICK` state instead of an endless retry loop.
 */
export const STALE_IDENTITY_CODES: ReadonlySet<DiagnosticCode> = new Set([
  'ELEMENT_NOT_FOUND',
  'SELECTOR_RECOVERY_LOW_CONFIDENCE',
  'EXTRACTION_EMPTY',
]);

/**
 * Whether a check failure has reached the terminal identity state: the
 * monitor has a preserved value, the failure is a stale-identity code
 * (every attempt, including value-anchored re-anchor retries, already
 * runs each check), and it has repeated past the permanent threshold.
 * Pure so the checker and tests share the exact decision.
 */
export function shouldMarkNeedsRepick(
  code: DiagnosticCode | null | undefined,
  consecutiveFailures: number,
  hasPriorValue: boolean,
): boolean {
  if (!code || !hasPriorValue) return false;
  if (!STALE_IDENTITY_CODES.has(code)) return false;
  return consecutiveFailures >= PERMANENT_FAILURE_THRESHOLD;
}

/** Number of consecutive check failures before a retryable failure is treated as genuinely unrecoverable (permanent error). */
export const PERMANENT_FAILURE_THRESHOLD = 3;

/**
 * Determines whether a failure should be treated as genuinely unrecoverable (Error status)
 * versus a temporary condition that should preserve the last known good value while retrying.
 */
export function isPermanentFailure(
  code: DiagnosticCode | null | undefined,
  consecutiveFailures: number,
  hasPriorValue: boolean,
): boolean {
  if (!code) return false;
  // The terminal identity state is permanent by construction — it is
  // only ever assigned once the stale-identity threshold below already
  // passed (see `shouldMarkNeedsRepick`).
  if (code === 'NEEDS_REPICK') return true;
  // Non-retryable conditions (permission revoked or login required) cannot self-recover without user action
  if (NON_RETRYABLE_CODES.has(code)) return true;
  // If the monitor has never captured any valid value yet, surface the failure immediately
  if (!hasPriorValue) return true;
  // If it had a valid value, only mark as Error after repeated consecutive failures
  return consecutiveFailures >= PERMANENT_FAILURE_THRESHOLD;
}

/**
 * Codes describing a page-level state that's expected to resolve on its
 * own with no action needed - a CAPTCHA/bot-verification/interstitial
 * page sitting in front of the real one (see `antiAutomation.ts`).
 * These are not "the target is missing" failures: the UI treats them as
 * a distinct temporary/blocked state rather than the generic
 * "No value"/"Error" shown for every other diagnostic, and the checker
 * never extracts or persists a value seen while one of these is active.
 * Kept intentionally small and code-based (not per-site) so it applies
 * uniformly to any site `antiAutomation.ts` recognizes, not just
 * whichever one prompted adding it.
 */
export const TEMPORARY_PAGE_STATE_CODES: ReadonlySet<DiagnosticCode> = new Set([
  'ANTI_AUTOMATION_DETECTED',
]);

export function isTemporaryPageState(code: DiagnosticCode | null | undefined): boolean {
  return code != null && TEMPORARY_PAGE_STATE_CODES.has(code);
}

export type FailureReason =
  | 'value_not_found'
  | 'page_changed'
  | 'page_load_failed'
  | 'blocked'
  | 'auth_required'
  | 'access_changed'
  | 'permission_denied'
  | 'unknown';

export interface FailureStateInfo {
  reason: FailureReason;
  label: string;
  description: string;
  canRetry: boolean;
  actionLabel: string;
}

/**
 * Determines the user-facing failure reason, concise label, and actionable guidance
 * for a failed monitor check, avoiding generic "Error" displays.
 */
export function getFailureStateInfo(
  code?: DiagnosticCode | null,
  errorText?: string | null,
): FailureStateInfo {
  switch (code) {
    case 'ELEMENT_NOT_FOUND':
    case 'EXTRACTION_EMPTY':
      return {
        reason: 'value_not_found',
        label: 'Value not found',
        description:
          code === 'EXTRACTION_EMPTY'
            ? 'The monitored spot is there, but it is currently empty. It will keep checking automatically.'
            : 'The monitored value could not be found on the page. It will keep checking automatically.',
        canRetry: true,
        actionLabel: 'Check now',
      };

    case 'SELECTOR_RECOVERY_LOW_CONFIDENCE':
      return {
        reason: 'page_changed',
        label: 'Page changed',
        description:
          'The page changed and the closest match was too uncertain to use. It will keep checking automatically.',
        canRetry: true,
        actionLabel: 'Check now',
      };

    case 'NEEDS_REPICK':
      return {
        reason: 'page_changed',
        label: 'Needs re-pick',
        description:
          'The saved element can no longer be found on this page, even when retrying from the last known value. Delete this monitor and pick the value again to resume monitoring.',
        canRetry: true,
        actionLabel: 'Check now',
      };

    case 'ACCESS_CHANGED':
      return {
        reason: 'access_changed',
        label: 'Access changed',
        description:
          'This monitor was created under a different account or workspace. Switch back to the original account and try again.',
        canRetry: true,
        actionLabel: 'Check now',
      };

    case 'NETWORK_ERROR':
    case 'PAGE_LOAD_TIMEOUT':
    case 'PAGE_NOT_READY':
    case 'TAB_CLOSED':
      return {
        reason: 'page_load_failed',
        label: "Couldn't load page",
        description:
          code === 'NETWORK_ERROR'
            ? 'The page could not be reached because of a network or connection problem. It will try again automatically.'
            : code === 'PAGE_LOAD_TIMEOUT'
              ? 'The page took too long to load. It will try again automatically.'
              : code === 'PAGE_NOT_READY'
                ? 'The page kept changing and never settled in time. It will try again automatically.'
                : 'The check was interrupted before it finished. It will try again automatically.',
        canRetry: true,
        actionLabel: 'Check now',
      };

    case 'ANTI_AUTOMATION_DETECTED':
      return {
        reason: 'blocked',
        label: 'Blocked',
        description:
          'The site is showing a verification challenge instead of its normal content. This is usually temporary — checks will retry automatically.',
        canRetry: true,
        actionLabel: 'Check now',
      };

    case 'AUTH_REQUIRED':
      return {
        reason: 'auth_required',
        label: 'Sign-in required',
        description:
          'The page is showing a sign-in screen — you may be logged out. Log in to the site in your browser to resume checks.',
        canRetry: true,
        actionLabel: 'Check now',
      };

    case 'PERMISSION_DENIED':
      return {
        reason: 'permission_denied',
        label: 'Permission needed',
        description:
          'Extension access to this site was revoked. Grant access again in Settings.',
        canRetry: false,
        actionLabel: 'Grant access',
      };

    default: {
      // Unknown codes (or missing codes with a stored technical trace)
      // still map to the right human bucket by the trace's shape — but
      // the raw trace itself is never user-facing copy. It stays in
      // storage/history for debugging; the UI shows the fixed sentences
      // below instead.
      if (errorText) {
        const lower = errorText.toLowerCase();
        if (/timeout|timed out|network|offline|dns|connection|load.*failed|frame.*removed|tab.*closed/i.test(lower)) {
          return {
            reason: 'page_load_failed',
            label: "Couldn't load page",
            description:
              'The page took too long to respond. It will try again automatically.',
            canRetry: true,
            actionLabel: 'Check now',
          };
        }
        if (/not found|empty|scanned.*none/i.test(lower)) {
          return {
            reason: 'value_not_found',
            label: 'Value not found',
            description:
              'The monitored value could not be found on the page. It will keep checking automatically.',
            canRetry: true,
            actionLabel: 'Check now',
          };
        }
        if (/confidence|changed|relocat|resembl/i.test(lower)) {
          return {
            reason: 'page_changed',
            label: 'Page changed',
            description:
              'The page changed and the closest match was too uncertain to use. It will keep checking automatically.',
            canRetry: true,
            actionLabel: 'Check now',
          };
        }
      }
      return {
        reason: 'unknown',
        label: 'Check failed',
        description: 'Something unexpected happened. Please try again.',
        canRetry: true,
        actionLabel: 'Check now',
      };
    }
  }
}

/**
 * Chooses the definitive primary diagnostic across multiple executed strategy outcomes.
 * Prioritizes hard blocks (anti-automation, auth, permissions), then picks the final strategy
 * (typically 'live' tab evaluation) over earlier optimistic heuristics like 'fetch'.
 */
export function selectPrimaryDiagnostic(diagnostics: Diagnostic[]): Diagnostic {
  if (diagnostics.length === 0) {
    return diagnostic('UNKNOWN');
  }
  const blocked = diagnostics.find((d) => d.code === 'ANTI_AUTOMATION_DETECTED');
  if (blocked) return blocked;
  const auth = diagnostics.find((d) => d.code === 'AUTH_REQUIRED');
  if (auth) return auth;
  const perm = diagnostics.find((d) => d.code === 'PERMISSION_DENIED');
  if (perm) return perm;

  return diagnostics[diagnostics.length - 1];
}
