/**
 * Shared infrastructure types.
 *
 * Domain types for the monitoring feature itself (e.g. `Monitor`,
 * `MonitorCheck`) intentionally live outside this foundation - they'll
 * be introduced with that feature so the schema can be designed
 * alongside its storage and background scheduling needs instead of
 * being guessed at up front.
 */

/** Re-exported here so app code can `import type { AppSettings } from '@/types'`. */
export type { AppSettings } from '@/lib/storage/schema';
export type { AppInfo, ProtocolMap } from '@/lib/messaging/protocol';
export type { AppError, ErrorCode, Result } from '@/lib/errors';
