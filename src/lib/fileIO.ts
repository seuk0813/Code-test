import type { ChordSymbol, Measure, Score } from '../types/score';
import { parseChordText } from './scoreUtils';
import { renderScore } from './vexflowRenderer';

const AUTOSAVE_KEY = 'piano-sheet-editor:autosave';
const RECENT_SCORES_KEY = 'piano-sheet-editor:recent-scores';
const RECENT_SCORES_LIMIT = 5;

export interface RecentScoreEntry {
  id: string;
  title: string;
  savedAt: number;
  score: Score;
}

/**
 * A chord's root/accidental/quality are re-derived from its own `text` on
 * every load — self-healing any stale values a chord was left with from
 * before a parseChordText fix (e.g. an older save's "Dm6/A" whose text was
 * typed back when an unrecognized quality suffix like "m6" made parsing fail
 * outright, silently leaving root/accidental at whatever they'd been before
 * — see parseChordText). Scale-degree labeling reads root/accidental, not
 * text, so two chords that show identical text can otherwise carry
 * different, inconsistent roots depending on when each was last edited.
 */
function reparseChord(chord: ChordSymbol): ChordSymbol {
  if (chord.text === undefined) return chord;
  const parsed = parseChordText(chord.text);
  if (!parsed) return chord;
  return { ...chord, root: parsed.root, accidental: parsed.accidental, quality: parsed.quality };
}

/** Backfills fields added in later versions so older saved scores load cleanly. */
export function normalizeScore(score: Score): Score {
  return {
    ...score,
    lineBreaks: score.lineBreaks ?? [],
    measures: (score.measures ?? []).map(
      (m): Measure => ({
        ...m,
        chords: (m.chords ?? []).map(reparseChord),
        lyrics: m.lyrics ?? [],
        restMarks: m.restMarks ?? [],
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
 * VexFlow's note/clef/rest glyphs are drawn as <text> in a custom music font
 * (Bravura/Academico) registered on the live document via the FontFace API.
 * An <img> decoding a blob-URL SVG runs in an isolated context that can't see
 * that registration, so those glyphs silently render as nothing (ordinary
 * text like the title still shows because it falls back to a system font —
 * music glyphs have no such fallback). Embedding the same font data VexFlow
 * itself uses as a self-contained @font-face inside the serialized SVG fixes
 * it without depending on network access at save time.
 */
async function embedMusicFonts(svg: SVGSVGElement): Promise<SVGSVGElement> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  try {
    const [{ Bravura }, { Academico }] = await Promise.all([
      import('./vendor/bravuraFont'),
      import('./vendor/academicoFont'),
    ]);
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `
      @font-face { font-family: 'Bravura'; src: url(${Bravura}) format('woff2'); }
      @font-face { font-family: 'Academico'; src: url(${Academico}) format('woff2'); }
    `;
    clone.insertBefore(style, clone.firstChild);
  } catch {
    // Best-effort — if the font chunk fails to load, fall back to the plain clone.
  }
  return clone;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Fetches a Google Font subset covering exactly `text` (the CSS2 API's
 * `text=` parameter returns a single already-subsetted @font-face — far
 * smaller than the full Korean charset) and inlines it as a base64 data URL.
 * Returns null (caller just skips embedding) if the text is empty or the
 * fetch fails, e.g. offline — matches the on-screen fallback in that case.
 */
async function fetchGoogleFontFace(family: string, weight: number, text: string): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const cssUrl = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:wght@${weight}&text=${encodeURIComponent(trimmed)}&display=swap`;
    const cssRes = await fetch(cssUrl);
    if (!cssRes.ok) return null;
    const css = await cssRes.text();
    const match = css.match(/src:\s*url\(([^)]+)\)\s*format\('([^']+)'\)/);
    if (!match) return null;
    const [, fontUrl, format] = match;
    const fontRes = await fetch(fontUrl);
    if (!fontRes.ok) return null;
    const base64 = arrayBufferToBase64(await fontRes.arrayBuffer());
    return `@font-face { font-family: '${family}'; font-weight: ${weight}; src: url(data:font/${format};base64,${base64}) format('${format}'); }`;
  } catch {
    return null;
  }
}

/**
 * Embeds Nanum Myeongjo (title) and Nanum Gothic (composer/lyrics) as
 * self-contained @font-face rules covering exactly this score's text —
 * same reasoning as embedMusicFonts, but for regular Korean text: the live
 * editor has these loaded via the page's Google Fonts <link>, invisible to
 * the isolated <img> context used to rasterize the SVG for PDF export, so
 * without this the title/composer silently fall back to a generic system
 * font instead of matching the on-screen editor. (Lyrics use Batang, a
 * system serif — not a webfont — so they render the same on screen and in
 * the raster without needing to be embedded.)
 */
async function embedTextFonts(svg: SVGSVGElement, score: Score): Promise<SVGSVGElement> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const titleText = score.title?.trim() || '제목을 입력하려면 클릭하세요';
  const composerText = score.composer?.trim() || '작곡가를 입력하려면 클릭하세요';

  const [titleFace, gothicFace] = await Promise.all([
    fetchGoogleFontFace('Nanum Myeongjo', 800, titleText),
    fetchGoogleFontFace('Nanum Gothic', 400, composerText),
  ]);
  const rules = [titleFace, gothicFace].filter((rule): rule is string => rule !== null);
  if (rules.length > 0) {
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = rules.join('\n');
    clone.insertBefore(style, clone.firstChild);
  }
  return clone;
}

/** Measures per PDF page — a new page starts every 16 measures (4 rows of the standard 4-per-row layout). The 멜로디+가사 (lead-sheet) layout adds an extra melody/lyric staff per row, so each row takes noticeably more vertical space — 12 measures (3 rows) keeps a page from being squeezed as tightly as the plain piano layout's 16. */
const MEASURES_PER_PDF_PAGE = 16;
const MEASURES_PER_PDF_PAGE_MELODY = 12;

/** True when a measure has nothing in it (no notes/rests, no chord symbols, no lyrics). */
function isBlankMeasure(measure: Measure): boolean {
  return (
    measure.treble.notes.length === 0 &&
    measure.bass.notes.length === 0 &&
    measure.chords.length === 0 &&
    measure.lyrics.length === 0
  );
}

/**
 * Drops wholly-empty measures off the END of the score before PDF export.
 * Composing often leaves a few blank "scratch" measures added via the + FAB
 * but never filled in — left in, they render as empty trailing staff rows
 * that inflate the page's height for no visual content, which throws off
 * drawPngFitToA4Page's fit-to-page math (a page padded with blank rows looks
 * "taller" than its real content, so the fit shrinks it by width and leaves
 * unusually wide left/right margins). Trimming them means a page's margins
 * only ever reflect its actual notation, matching a page that never had any
 * trailing blank staves in the first place. Never trims below 1 measure.
 */
function trimTrailingBlankMeasures(score: Score): Score {
  let end = score.measures.length;
  while (end > 1 && isBlankMeasure(score.measures[end - 1])) end--;
  if (end === score.measures.length) return score;
  const measures = score.measures.slice(0, end);
  const lineBreaks = score.lineBreaks.filter((b) => b < end - 1);
  return { ...score, measures, lineBreaks };
}

/**
 * Splits a score into page-sized chunks of measures for PDF export. Manual
 * line breaks are kept only where they fall inside their chunk and reindexed
 * relative to it; each chunk otherwise keeps the score's title/composer/
 * tempo/key/time signature so every page renders as a normal, complete score
 * for just that slice of measures.
 */
function chunkScoreForPdf(score: Score): Score[] {
  const perPage = score.showMelodyStaff ? MEASURES_PER_PDF_PAGE_MELODY : MEASURES_PER_PDF_PAGE;
  const chunks: Score[] = [];
  for (let start = 0; start < score.measures.length; start += perPage) {
    const end = Math.min(start + perPage, score.measures.length);
    const measures = score.measures.slice(start, end);
    const lineBreaks = score.lineBreaks.filter((b) => b >= start && b < end - 1).map((b) => b - start);
    chunks.push({ ...score, measures, lineBreaks });
  }
  return chunks.length > 0 ? chunks : [score];
}

/**
 * Renders one score (or page-chunk of one) into a detached, offscreen
 * container and rasterizes it to a PNG data URL — via canvas rather than
 * depending on the browser having the printed fonts installed. Renders its
 * own clean, unselected copy rather than reusing the live on-screen SVG, so
 * whatever note happens to be selected/highlighted red on screen doesn't
 * leak into the saved file.
 */
async function renderScoreToPng(score: Score): Promise<{ dataUrl: string; width: number; height: number }> {
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-99999px';
  container.style.top = '0';
  document.body.appendChild(container);

  try {
    renderScore(container, score, null, null, null);
    const svg = container.querySelector<SVGSVGElement>('svg');
    if (!svg) return { dataUrl: '', width: 0, height: 0 };
    const width = Number(svg.getAttribute('width')) || svg.clientWidth;
    const height = Number(svg.getAttribute('height')) || svg.clientHeight;
    const withMusicFonts = await embedMusicFonts(svg);
    const embedded = await embedTextFonts(withMusicFonts, score);
    const svgString = new XMLSerializer().serializeToString(embedded);
    const svgUrl = URL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const img = await loadImage(svgUrl);
      const scale = 2; // rasterize at 2x for a crisper PDF
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) return { dataUrl: '', width: 0, height: 0 };
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return { dataUrl: canvas.toDataURL('image/png'), width, height };
    } finally {
      URL.revokeObjectURL(svgUrl);
    }
  } finally {
    document.body.removeChild(container);
  }
}

// A4 in points (72dpi) and the margin kept clear on every side.
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const PDF_MARGIN_PT = 28;

/**
 * Draws a rasterized page's PNG onto the current page of `doc`, scaled to
 * fit within the A4 margins (keeping its aspect ratio) and pinned to the
 * top, over an explicitly white-filled page — so a page with only a few
 * measures still produces a full, clean A4 sheet instead of a page sized to
 * the score's own odd landscape dimensions (which used to leave a black/
 * clipped edge and a non-standard page size).
 */
function drawPngFitToA4Page(doc: import('jspdf').jsPDF, dataUrl: string, width: number, height: number): void {
  doc.setFillColor(255, 255, 255);
  doc.rect(0, 0, A4_WIDTH_PT, A4_HEIGHT_PT, 'F');
  if (!dataUrl) return;

  const availW = A4_WIDTH_PT - PDF_MARGIN_PT * 2;
  const availH = A4_HEIGHT_PT - PDF_MARGIN_PT * 2;
  const aspect = width / height;
  let drawW = availW;
  let drawH = availW / aspect;
  if (drawH > availH) {
    drawH = availH;
    drawW = availH * aspect;
  }
  const offX = (A4_WIDTH_PT - drawW) / 2;
  const offY = PDF_MARGIN_PT;
  doc.addImage(dataUrl, 'PNG', offX, offY, drawW, drawH);
}

/**
 * Renders the score to a PDF and saves it through the same native "Save As"
 * dialog as JSON — falling back to a plain download where the File System
 * Access API isn't available. Long scores are split one page per 16
 * measures (12 in 멜로디+가사 mode — see MEASURES_PER_PDF_PAGE/
 * MEASURES_PER_PDF_PAGE_MELODY), each its own single A4 page. Every page
 * gets a centered "-N-" page number at the bottom.
 */
export async function saveScorePdf(score: Score, filename?: string): Promise<void> {
  const pages = chunkScoreForPdf(trimTrailingBlankMeasures(score));
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });

  for (let i = 0; i < pages.length; i++) {
    if (i > 0) doc.addPage();
    const { dataUrl, width, height } = await renderScoreToPng(pages[i]);
    drawPngFitToA4Page(doc, dataUrl, width, height);
    doc.setFontSize(10);
    doc.setTextColor(80, 80, 80);
    doc.text(`- ${i + 1} -`, A4_WIDTH_PT / 2, A4_HEIGHT_PT - PDF_MARGIN_PT / 2, { align: 'center' });
  }

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

/** Returns the up-to-5 most recently saved/loaded scores, newest first. */
export function getRecentScores(): RecentScoreEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_SCORES_KEY);
    if (!raw) return [];
    const entries = JSON.parse(raw) as RecentScoreEntry[];
    return entries.map((e) => ({ ...e, score: normalizeScore(e.score) }));
  } catch {
    return [];
  }
}

/**
 * Records a score as "recently worked on" — called after every successful
 * save or load — keeping only the 5 newest (deduped by title, so re-saving
 * the same piece over and over just bumps its position instead of piling up
 * duplicates). Best-effort: silently no-ops on storage failures.
 */
export function saveRecentScore(score: Score): void {
  try {
    const existing = getRecentScores().filter((e) => e.title !== score.title);
    const entry: RecentScoreEntry = { id: `r-${Date.now()}`, title: score.title || '제목 없는 악보', savedAt: Date.now(), score };
    const next = [entry, ...existing].slice(0, RECENT_SCORES_LIMIT);
    localStorage.setItem(RECENT_SCORES_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota / privacy-mode failures — this is a convenience feature only.
  }
}
