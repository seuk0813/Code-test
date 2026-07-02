import type { Score } from '../types/score';

const AUTOSAVE_KEY = 'piano-sheet-editor:autosave';

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadScoreJson(score: Score): void {
  const blob = new Blob([JSON.stringify(score, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `${score.title || 'score'}.json`);
}

export function readScoreFile(file: File): Promise<Score> {
  return file.text().then((text) => JSON.parse(text) as Score);
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
    return raw ? (JSON.parse(raw) as Score) : null;
  } catch {
    return null;
  }
}
