/**
 * Holds off the app's own "a new build was deployed, reload the page"
 * navigation (see main.tsx) while a file is being written to disk.
 *
 * WHY THIS EXISTS — the 0-byte-file bug:
 *
 * Saving through the File System Access API creates the file on disk the
 * moment the user confirms the OS save dialog, but the CONTENT only lands at
 * `writable.close()`, several async round-trips later. Anything that tears the
 * page down in between leaves exactly a 0-byte file where the score should be
 * — and, when overwriting, destroys what was already there.
 *
 * The version check was reliably doing exactly that, because of how its
 * triggers line up with a save:
 *
 *   1. the native save dialog opens, so the page loses focus;
 *   2. the user confirms, the file is created empty, the dialog closes;
 *   3. focus returns to the page — which fires `focus`/`visibilitychange`,
 *      the very events the version check listens on;
 *   4. if a new build had shipped since this tab loaded, it calls
 *      location.replace() immediately, mid-write.
 *
 * So the check fired at the one moment it must not, on every save, and won
 * the race whenever `close()` was slow — which it is exactly where it hurts
 * most, on cloud-synced folders (OneDrive/Drive) where the atomic rename
 * triggers sync and antivirus hooks.
 *
 * Deferring rather than cancelling keeps the point of the version check: the
 * reload still happens, just once the bytes are safely on disk.
 */

let writesInFlight = 0;
let deferredReload: (() => void) | null = null;

function runDeferredReloadIfIdle(): void {
  if (writesInFlight > 0 || !deferredReload) return;
  const reload = deferredReload;
  deferredReload = null;
  reload();
}

/**
 * Runs `write` with page reloads held off until it settles (either way —
 * a failed save must release the hold too, or the app could never reload
 * again). Counted, not a boolean, so concurrent saves can't have the first
 * one to finish release the hold out from under the others.
 */
export async function withReloadHeld<T>(write: () => Promise<T>): Promise<T> {
  writesInFlight += 1;
  try {
    return await write();
  } finally {
    writesInFlight -= 1;
    runDeferredReloadIfIdle();
  }
}

/**
 * Performs `reload` now, or as soon as no file write is in flight. Only the
 * most recent pending reload is kept — they all do the same thing, and the
 * newest carries the newest target version.
 */
export function reloadWhenWritesFinish(reload: () => void): void {
  deferredReload = reload;
  runDeferredReloadIfIdle();
}
