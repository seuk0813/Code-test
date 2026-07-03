import type { Measure, Score } from '../types/score';

const AUTOSAVE_KEY = 'piano-sheet-editor:autosave';

/** Backfills fields added in later versions so older saved scores load cleanly. */
export function normalizeScore(score: Score): Score {
  return {
    ...score,
    lineBreaks: score.lineBreaks ?? [],
    measures: (score.measures ?? []).map(
      (m): Measure => ({
        ...m,
        chords: m.chords ?? [],
        lyrics: m.lyrics ?? [],
      }),
    ),
  };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
interface FileSystemWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}
interface FileSystemFileHandleLike {
  createWritable(): Promise<FileSystemWritable>;
}
type ShowSaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandleLike>;

/** Whether the browser supports the native "Save As" file picker (Chrome/Edge desktop). */
export function hasNativeSavePicker(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

/**
 * Saves the score as JSON via the OS-native "Save As" dialog when the browser
 * supports the File System Access API — the user picks the exact folder and
 * filename, like any desktop program. Falls back to a plain browser download
 * (goes to the default Downloads folder; the browser doesn't allow JS to pick
 * a location without that API) on browsers that don't support it (Safari,
 * Firefox, iOS).
 */
export async function saveScoreJson(score: Score, filename?: string): Promise<void> {
  const base = (filename || score.title || 'score').replace(/\.json$/i, '');
  const blob = new Blob([JSON.stringify(score, null, 2)], { type: 'application/json' });

  if (hasNativeSavePicker()) {
    try {
      const showSaveFilePicker = (window as unknown as { showSaveFilePicker: ShowSaveFilePicker }).showSaveFilePicker;
      const handle = await showSaveFilePicker({
        suggestedName: `${base}.json`,
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      // AbortError = user cancelled the picker; don't fall back to a download in that case.
      if (err instanceof Error && err.name === 'AbortError') return;
      // Any other failure (e.g. picker unsupported at runtime): fall through to plain download.
    }
  }

  downloadBlob(blob, `${base}.json`);
}

/**
 * Saves the score as a PDF via the browser's print dialog. A print-only
 * stylesheet (see App.css) shows just the staff; setting the document title
 * pre-fills the PDF's default filename in the OS/browser save sheet — which is
 * also how it works on iOS Safari ("공유 → PDF로 저장").
 */
export function printScorePdf(filename: string): void {
  const previous = document.title;
  document.title = filename.replace(/\.pdf$/i, '') || 'score';
  const restore = () => {
    document.title = previous;
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
}

export function readScoreFile(file: File): Promise<Score> {
  return file.text().then((text) => normalizeScore(JSON.parse(text) as Score));
}

export function saveAutosave(score: Score): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(score));
  } catch {
    // Ignore storage quota / privacy-mode failures; autosave is best-effort.
  }
}

export function loadAutosave(): Score | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? normalizeScore(JSON.parse(raw) as Score) : null;
  } catch {
    return null;
  }
}
