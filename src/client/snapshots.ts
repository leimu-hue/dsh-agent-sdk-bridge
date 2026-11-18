/**
 * The last account answer per provider and login region.
 *
 * A region switch must paint instantly — the browser already knows what the
 * other region looked like a minute ago, and waiting on a CLI round trip to
 * show it is the difference between a page and a spinner. So each region keeps
 * its own snapshot, and the page renders from it before verifying.
 *
 * Keeping the snapshot rule in one place is deliberate: the page needs to read
 * a region's sign-in state before the card has mounted, and a second copy of
 * that rule in the settings page is how the locked view started flashing on
 * region switches.
 *
 * @module dsh-agent-sdk-bridge/client/snapshots
 */

import { readCache, writeCache } from './api.ts'
import type {
  AuthStatus, CodeBuddyAccountPayload, Region,
} from './types.ts'

/** What one CodeBuddy region remembers. */
export interface CodeBuddySnapshot {
  auth?: AuthStatus
  account?: CodeBuddyAccountPayload
  at?: number
}

function read<T>(brand: string, region: Region): T | undefined {
  const cached = readCache<T>(brand, `snapshot:${region}`)
  return cached !== null && typeof cached === 'object' ? cached : undefined
}

function merge<T extends object>(brand: string, region: Region, previous: T | undefined, patch: T): void {
  writeCache(brand, `snapshot:${region}`, { ...(previous ?? {}), ...patch, at: Date.now() })
}

/** The remembered CodeBuddy answer for one region. */
export function codeBuddySnapshot(region: Region): CodeBuddySnapshot | undefined {
  return read<CodeBuddySnapshot>('codebuddy', region)
}

/** Remember part of one CodeBuddy region's answer. */
export function rememberCodeBuddy(region: Region, patch: CodeBuddySnapshot): void {
  merge('codebuddy', region, codeBuddySnapshot(region), patch)
}
