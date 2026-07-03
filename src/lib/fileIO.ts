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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

/**
 * Renders the on-screen score SVG to a PDF (via an offscreen canvas raster,
 * so it doesn't depend on the browser having the printed fonts installed)
 * and saves it through the same native "Save As" dialog as JSON — falling
 * back to a plain download where the File System Access API isn't available.
 */
export async function saveScorePdf(filename?: string): Promise<void> {
  const svg = document.querySelector<SVGSVGElement>('.staff-container svg');
  if (!svg) return;
  const width = Number(svg.getAttribute('width')) || svg.clientWidth;
  const height = Number(svg.getAttribute('height')) || svg.clientHeight;
  const svgString = new XMLSerializer().serializeToString(svg);
  const svgUrl = URL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }));

  try {
    const img = await loadImage(svgUrl);
    const scale = 2; // rasterize at 2x for a crisper PDF
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pngDataUrl = canvas.toDataURL('image/png');

    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({
      orientation: width >= height ? 'landscape' : 'portrait',
      unit: 'pt',
      format: [width, height],
    });
    doc.addImage(pngDataUrl, 'PNG', 0, 0, width, height);
    const blob = doc.output('blob');

    const base = (filename || 'score').replace(/\.pdf$/i, '');
    if (hasNativeSavePicker()) {
      try {
        const showSaveFilePicker = (window as unknown as { showSaveFilePicker: ShowSaveFilePicker }).showSaveFilePicker;
        const handle = await showSaveFilePicker({
          suggestedName: `${base}.pdf`,
          types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
      }
    }
    downloadBlob(blob, `${base}.pdf`);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
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
