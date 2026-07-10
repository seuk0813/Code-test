import { Accidental as VexAccidental, Beam, Curve, Dot, Formatter, Renderer, Stave, StaveConnector, StaveNote, StaveTie, Voice } from 'vexflow';
import type { Accidental, ChordSymbol, Clef, LyricSyllable, NoteEvent, NoteLocation, Score } from '../types/score';
import {
  chordLabel,
  computeScoreRows,
  deriveMelodyNotes,
  isStaffMeasureFull,
  measureCapacityBeats,
  noteBeats,
  pitchToLine,
  pitchToVexKey,
  stemPointsUp,
  vexDurationString,
} from './scoreUtils';

/** Right-hand padding kept clear of notes inside a measure, for free-X mapping. */
const NOTE_AREA_RIGHT_PAD = 16;

/** Per-note accidentals (♯/♭/♮ on individual notes) default to the same
 * glyph size as the notehead itself, which reads as oversized — render them
 * smaller, independently of the notehead's own size. */
const ACCIDENTAL_FONT_SIZE = 21;
/** Horizontal gap between an accidental glyph's right edge and the notehead's left edge. */
const ACCIDENTAL_GAP = 2;
/** Fingering numbers are drawn slightly larger than accidentals, to the right of them. */
const FINGER_FONT_SIZE = 16;
/** Gap between a notehead's right edge and its fingering number. */
const FINGER_GAP = 4;

/**
 * Accidentals are drawn as plain SVG text (like the chord/lyric/title labels
 * below), NOT as VexFlow Accidental modifiers attached via addModifier().
 * VexFlow's own Accidental.format() always adds a fixed padding/spacing
 * overhead to its note's ModifierContext width whenever the note has any
 * accidental at all (regardless of the glyph's own measured width — even
 * forcing that to 0 didn't help). Formatter then sums every tick's modifier
 * width to lay out the whole measure, so adding one accidental reflowed
 * every other note's — and accidental's — X position too. Drawing them
 * manually, entirely outside VexFlow's modifier/formatting system, keeps
 * every other note's position unaffected by whether any given note happens
 * to carry an accidental.
 */
// SMuFL codepoints (Bravura, already the score's music font) for the glyphs
// VexFlow's own Accidental class would otherwise have drawn — see Tables
// .accidentalCodes() in VexFlow's source, which resolves to these same values.
const ACCIDENTAL_GLYPH: Record<Exclude<Accidental, ''>, string> = {
  '#': '',
  b: '',
  n: '',
};

interface AccidentalMark {
  x: number;
  y: number;
  type: Exclude<Accidental, ''>;
  /** null = inherit the default (black) fill, same as the notehead. */
  color: string | null;
}

function drawAccidentalMarks(svg: SVGSVGElement, marks: AccidentalMark[]): void {
  marks.forEach((mark) => {
    const text = document.createElementNS(SVG_NS, 'text');
    // Standard notation puts an accidental just to the LEFT of its notehead
    // — mark.x is the notehead's left edge, and text-anchor "end" grows the
    // glyph leftward from (x - gap) so its right edge stops right there.
    text.setAttribute('x', String(mark.x - ACCIDENTAL_GAP));
    text.setAttribute('y', String(mark.y));
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('font-size', String(ACCIDENTAL_FONT_SIZE));
    text.setAttribute('stroke', 'none');
    if (mark.color) text.setAttribute('fill', mark.color);
    text.textContent = ACCIDENTAL_GLYPH[mark.type];
    svg.appendChild(text);
  });
}

interface ConnectStubMark {
  x: number;
  y: number;
  /** Whether the little hook bulges upward (away from a down-stem) or downward (away from an up-stem). */
  curveUp: boolean;
}

/**
 * A tie/slur that crosses a line break can't be drawn as one continuous
 * curve — the two notes are on different rows, far apart on the page, which
 * would draw one giant diagonal line across the gap between them. Standard
 * notation instead draws a small hook at the end of the line indicating the
 * connection continues — this draws just that stub, poking out past the
 * note (and possibly the measure) rather than reaching all the way to the
 * next row.
 */
function drawConnectStubs(svg: SVGSVGElement, marks: ConnectStubMark[]): void {
  marks.forEach((mark) => {
    const y0 = mark.y + (mark.curveUp ? -6 : 6);
    const midY = y0 + (mark.curveUp ? -6 : 6);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', `M ${mark.x} ${y0} Q ${mark.x + 9} ${midY} ${mark.x + 18} ${y0}`);
    path.setAttribute('stroke', '#000');
    path.setAttribute('stroke-width', '1.2');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);
  });
}

interface FingeringMark {
  x: number;
  y: number;
  finger: number;
  color: string | null;
}

/** Fingering numbers, drawn (like accidentals) as plain SVG text to the right
 * of the notehead — and to the right of the accidental glyph when one is
 * present, so it never overlaps. Rendered in a plain sans-serif, not the
 * music font, so the digit shows as an actual numeral. */
function drawFingeringMarks(svg: SVGSVGElement, marks: FingeringMark[]): void {
  marks.forEach((mark) => {
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(mark.x));
    text.setAttribute('y', String(mark.y + 5));
    text.setAttribute('text-anchor', 'start');
    text.setAttribute('font-size', String(FINGER_FONT_SIZE));
    text.setAttribute('font-family', "'Nanum Gothic', 'Malgun Gothic', sans-serif");
    text.setAttribute('font-weight', '700');
    text.setAttribute('stroke', 'none');
    text.setAttribute('fill', mark.color ?? '#333');
    text.textContent = String(mark.finger);
    svg.appendChild(text);
  });
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const FIRST_MEASURE_WIDTH = 300;
const MEASURE_WIDTH = 220;

/** The X range a measure slot occupies in its row, purely from layout constants — independent of whether that measure actually exists yet. */
function measureSlotXRange(indexInRow: number): { x0: number; x1: number } {
  let x = 10;
  for (let i = 0; i < indexInRow; i++) x += i === 0 ? FIRST_MEASURE_WIDTH : MEASURE_WIDTH;
  const w = indexInRow === 0 ? FIRST_MEASURE_WIDTH : MEASURE_WIDTH;
  return { x0: x, x1: x + w };
}

/**
 * Per-slot widths for one row. Normally each slot just uses its fixed base
 * width. But a row holding the pickup or trailing partial measure needs that
 * one slot narrower (proportional to its own beat fraction, not a full
 * measure's worth) — with the freed width redistributed across the row's
 * OTHER measures so they stay evenly sized, whatever their own count.
 * Applies regardless of how many measures the row happens to hold: a row
 * squeezed to MEASURES_PER_ROW + 1 slots (the pickup/trailing measure plus a
 * full normal row) targets the SAME total width as any other full row, so it
 * doesn't stick out past the normal right edge; a shorter row (fewer total
 * measures in the piece) just keeps its own natural total width instead of
 * being artificially stretched to match a full row.
 */
function computeRowMeasureWidths(row: number[], score: Score, capacity: number): number[] {
  const baseWidths = row.map((_, localIndex) => (localIndex === 0 ? FIRST_MEASURE_WIDTH : MEASURE_WIDTH));

  const lastScoreIndex = score.measures.length - 1;
  const partialLocalIndex = row.findIndex((measureIndex, localIndex) => {
    if (localIndex === 0 && measureIndex === 0 && score.pickupBeats !== undefined) return true;
    if (localIndex === row.length - 1 && measureIndex === lastScoreIndex && score.trailingBeats !== undefined) {
      return true;
    }
    return false;
  });
  if (partialLocalIndex === -1) return baseWidths;

  const partialBeats = partialLocalIndex === 0 ? score.pickupBeats! : score.trailingBeats!;
  const fraction = Math.max(0, Math.min(1, partialBeats / capacity));
  const partialBase = baseWidths[partialLocalIndex];
  // The pickup slot (local index 0) still needs room for the clef/key/time
  // signature glyphs even when very short, so it gets a taller floor than a
  // trailing slot (which only needs room for a note or two).
  const minWidth = partialLocalIndex === 0 ? 150 : 90;
  const partialWidth = Math.max(partialBase * fraction, minWidth);

  const otherBaseSum = baseWidths.reduce((sum, w, i) => (i === partialLocalIndex ? sum : sum + w), 0);
  if (otherBaseSum <= 0) return baseWidths.map((w, i) => (i === partialLocalIndex ? partialWidth : w));

  const naturalTotal = baseWidths.reduce((sum, w) => sum + w, 0);
  const targetRowWidth =
    row.length > MEASURES_PER_ROW ? FIRST_MEASURE_WIDTH + (MEASURES_PER_ROW - 1) * MEASURE_WIDTH : naturalTotal;
  const remaining = targetRowWidth - partialWidth;

  return baseWidths.map((w, i) => (i === partialLocalIndex ? partialWidth : w * (remaining / otherBaseSum)));
}

const ROW_HEIGHT = 320;
// Kept clear of the staff's own clickable "add a ledger-line note" region
// (which reaches STAVE_TOP_MARGIN above the top staff line) so the chord
// band's hitbox doesn't swallow clicks meant to place a high note there.
const CHORD_BAND_Y = 58;
const TREBLE_Y = 60;
const BASS_Y = 185;
const STAVE_TOP_MARGIN = 40;
/**
 * Lead-sheet layout (Score.showMelodyStaff): extra vertical space added to
 * each row for the standalone melody staff (chord band + staff + lyric
 * band) that sits above the piano grand staff, which itself shifts down by
 * this same amount. See MELODY_CHORD_Y/MELODY_STAFF_Y below; the lyric band
 * is positioned dynamically off the melody Stave's own geometry instead (its
 * constructor Y sits up near the clef glyph, not the actual staff lines).
 */
const MELODY_BLOCK_HEIGHT = 150;
/** Mirrors CHORD_BAND_Y's relationship to TREBLE_Y, but for the melody staff. */
const MELODY_CHORD_Y = 58;
const MELODY_STAFF_Y = 60;
const NOTE_HIT_RADIUS = 16;
export const MEASURES_PER_ROW = 4;
/** Vertical space reserved at the very top for the centered title, always shown (even a click-to-edit placeholder). Sized to fit the title font size (see drawHeading's font-size). */
const TITLE_BAND = 82;
/**
 * Extra vertical space reserved right below the title for the composer
 * credit — a dedicated band of its own, not shared with the chord-symbol
 * band or the staff's ledger-line click region (which already occupy nearly
 * all of the row's own top margin), so the composer text can't silently
 * swallow clicks meant for either (see the chord-band/ledger-line collision
 * this project already hit once before).
 */
const COMPOSER_BAND = 22;

/**
 * Font stacks for the printed-score text elements. Korean chord-sheet images
 * like the reference ("일종의 고백") are almost always typeset with the
 * Naver-published, freely-licensed 나눔명조/나눔고딕 (Nanum Myeongjo / Nanum
 * Gothic) family rather than Adobe/Google's own multi-CJK "Noto" faces — the
 * bold title's letterforms and the plain body text both match Nanum's
 * distinct cuts, not Noto's more uniform strokes.
 */
const TITLE_FONT = "'Nanum Myeongjo', Batang, serif";
const CREDIT_FONT = "'Nanum Gothic', 'Malgun Gothic', sans-serif";
// HY중고딕 is a commercial Hanyang font (not a free/embeddable webfont) — used
// when installed locally; falls back to a similar Gothic if it isn't.
const HY_JUNGGOTHIC_FONT = "'HY중고딕', 'HYGothic-Medium', 'Malgun Gothic', sans-serif";
const CHORD_FONT = HY_JUNGGOTHIC_FONT;
const LYRIC_FONT = HY_JUNGGOTHIC_FONT;
const PLACEHOLDER_COLOR = '#b8b8c2';

export interface NoteHitbox {
  measureIndex: number;
  clef: Clef;
  noteIndex: number;
  centerX: number;
  /**
   * X of the note's stem (its "tail"), which for an up-stem note sits at the
   * notehead's right edge and for a down-stem note at its left edge — used
   * for the playback bar so it lines up with the note itself instead of the
   * notehead glyph's left edge (what centerX actually measures).
   */
  stemX: number;
  /** Y of each notehead (a chord has several), for pitch-aware click hit-testing. */
  ys: number[];
  /**
   * X of each notehead, paired index-for-index with `ys`. VexFlow shifts
   * adjacent noteheads (a 2nd apart) left/right so they don't overlap —
   * `centerX` is only the note's own nominal column, so a chord tone that
   * got shifted needs its own X for accurate click hit-testing. Falls back
   * to `centerX` for any pitch VexFlow didn't report a notehead for.
   */
  xs: number[];
}

export interface StaffHitbox {
  measureIndex: number;
  clef: Clef;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  refY0: number;
  spacing: number;
  /** Usable note area (excludes clef/key/time signature glyphs), for grid-snapped previews. */
  contentX0: number;
  contentWidth: number;
  /** Left edge where notes begin (after clef/key/time glyphs). */
  noteStartX: number;
  /** Width of the free-placement note area (noteStartX .. right padding). */
  noteAreaWidth: number;
  /** True when the measure is filled to capacity and auto-formatted. */
  full: boolean;
}

export interface ChordHitbox {
  measureIndex: number;
  chordId: string;
  x: number;
  y: number;
  halfWidth: number;
}

export interface ChordBandHitbox {
  measureIndex: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  measureX: number;
  measureWidth: number;
}

export interface LineBreakHitbox {
  /** Registering a break happens after this measure index. */
  afterMeasureIndex: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface LyricHitbox {
  measureIndex: number;
  lyricId: string;
  x: number;
  y: number;
  halfWidth: number;
  measureX: number;
  measureWidth: number;
}

/** Empty area of the lyric band (between staves) for a measure, click-to-add-lyric target. */
export interface LyricBandHitbox {
  measureIndex: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  y: number;
  measureX: number;
  measureWidth: number;
}

/** The clickable region over the rendered (or placeholder) title text. */
export interface TitleHitbox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  x: number;
  y: number;
}

/** The clickable region over the rendered (or placeholder) composer credit. */
export interface ComposerHitbox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  x: number;
  y: number;
}

export interface RenderResult {
  noteHitboxes: NoteHitbox[];
  staffHitboxes: StaffHitbox[];
  chordHitboxes: ChordHitbox[];
  chordBandHitboxes: ChordBandHitbox[];
  lineBreakHitboxes: LineBreakHitbox[];
  lyricHitboxes: LyricHitbox[];
  lyricBandHitboxes: LyricBandHitbox[];
  titleHitbox: TitleHitbox;
  composerHitbox: ComposerHitbox;
  width: number;
  height: number;
}

const REST_KEY: Record<Clef, string> = {
  treble: 'b/4',
  bass: 'd/3',
};

function buildStaveNotes(
  clef: Clef,
  measureIndex: number,
  notes: NoteEvent[],
  selected: NoteLocation | null,
  hiddenNoteIndex: number | null,
  hiddenPitchIndex: number | null,
  playingNoteIndex: number | null,
  selectedPitchIndex: number | null,
): StaveNote[] {
  return notes.map((note, noteIndex) => {
    const keys = note.isRest ? [REST_KEY[clef]] : note.pitches.map(pitchToVexKey);
    const staveNote = new StaveNote({
      clef,
      keys,
      duration: vexDurationString(note),
      autoStem: true,
    });

    if (note.dotted) {
      Dot.buildAndAttach([staveNote], note.isRest ? { index: 0 } : { all: true });
    }

    // Accidentals are NOT attached as VexFlow modifiers here — see
    // drawAccidentalMarks below for why, and how they're drawn instead.

    // During playback the currently-sounding note is recolored the same red
    // as a selection (real VexFlow styling, so it's pixel-perfectly aligned —
    // never a separately-computed overlay position). `selected` itself is
    // passed as null by the caller while playing, so old selections don't
    // also show red at the same time.
    const isSelected =
      selected &&
      selected.measureIndex === measureIndex &&
      selected.clef === clef &&
      selected.noteIndex === noteIndex;
    const isPlaying = playingNoteIndex === noteIndex;
    if (isSelected || isPlaying) {
      // A chord narrowed to one specific pitch (second click on that
      // notehead — see App.tsx's selectedPitchIndex) recolors just that
      // notehead via setKeyStyle, leaving the chord's other tones alone,
      // instead of setStyle()'s whole-note recolor.
      if (isSelected && !isPlaying && selectedPitchIndex !== null && note.pitches.length > 1) {
        staveNote.setKeyStyle(selectedPitchIndex, { fillStyle: '#d6432b', strokeStyle: '#d6432b' });
      } else {
        staveNote.setStyle({ fillStyle: '#d6432b', strokeStyle: '#d6432b' });
        // Ledger lines are drawn with their own independent style (VexFlow
        // does not inherit the note's setStyle() for them), so a
        // ledger-line note like middle C needs this set explicitly too.
        staveNote.setLedgerLineStyle({ fillStyle: '#d6432b', strokeStyle: '#d6432b' });
      }
    }
    if (hiddenNoteIndex === noteIndex) {
      // Dragging one narrowed chord tone hides only that notehead (it splits
      // off on drop — see App.tsx's handleMoveNote); the rest of the chord
      // must stay visibly in place. A whole-note drag hides the whole note.
      if (hiddenPitchIndex !== null && note.pitches.length > 1) {
        staveNote.setKeyStyle(hiddenPitchIndex, { fillStyle: 'transparent', strokeStyle: 'transparent' });
      } else {
        staveNote.setStyle({ fillStyle: 'transparent', strokeStyle: 'transparent' });
      }
    }

    return staveNote;
  });
}

/**
 * Builds StaveNotes for the read-only lead-sheet melody staff (see
 * Score.showMelodyStaff / deriveMelodyNotes) — a simplified version of
 * buildStaveNotes with none of the selection/drag/playback styling, since
 * this staff is never clicked or edited directly. Accidentals are attached
 * as real VexFlow modifiers here (unlike the treble/bass staves' manual
 * text-based accidentals) because there's no free-X dragging on this staff
 * to keep stable — VexFlow's own modifier layout is simpler and fine.
 */
function buildMelodyStaveNotes(notes: NoteEvent[]): StaveNote[] {
  return notes.map((note) => {
    const keys = note.isRest ? [REST_KEY.treble] : note.pitches.map(pitchToVexKey);
    const staveNote = new StaveNote({ clef: 'treble', keys, duration: vexDurationString(note), autoStem: true });
    if (note.dotted) Dot.buildAndAttach([staveNote], note.isRest ? { index: 0 } : { all: true });
    if (!note.isRest && note.pitches[0]?.accidental) {
      staveNote.addModifier(new VexAccidental(note.pitches[0].accidental), 0);
    }
    return staveNote;
  });
}

export interface DraggingNote {
  measureIndex: number;
  clef: Clef;
  noteIndex: number;
  /** When only one narrowed chord tone is being dragged, hide just that notehead instead of the whole note. */
  pitchIndex?: number | null;
}

/**
 * Groups consecutive beamable notes (8th/16th/32nd, non-rest) that fall
 * within the same beat "pulse" (a quarter note in simple meters, a dotted
 * quarter in compound ones) into arrays ready for `new Beam(group)` — e.g. a
 * 16th + 16th + 8th that together exactly fill one beat become ONE beam
 * (with a partial secondary beam under just the two 16ths), matching
 * standard notation. VexFlow's own `Beam.generateBeams` only reliably beams
 * same-duration runs; mixed durations completing a beat were left with the
 * odd note (like a trailing 8th) unbeamed, so groups are built manually here
 * instead, purely from each note's actual beat duration.
 */
function computeBeamNoteGroups(notes: NoteEvent[], staveNotes: StaveNote[], pulseBeats: number): StaveNote[][] {
  const groups: StaveNote[][] = [];
  let current: StaveNote[] = [];
  let currentPulse = -1;
  let cumulative = 0;
  notes.forEach((note, i) => {
    const beamable = !note.isRest && (note.duration === '8' || note.duration === '16');
    const pulseIndex = Math.floor((cumulative + 1e-6) / pulseBeats);
    if (beamable && pulseIndex === currentPulse) {
      current.push(staveNotes[i]);
    } else {
      if (current.length > 1) groups.push(current);
      current = beamable ? [staveNotes[i]] : [];
      currentPulse = pulseIndex;
    }
    cumulative += noteBeats(note);
  });
  if (current.length > 1) groups.push(current);
  return groups;
}

export function renderScore(
  container: HTMLDivElement,
  score: Score,
  selected: NoteLocation | null,
  draggingNote: DraggingNote | null,
  playingLocations?: { treble: NoteLocation | null; bass: NoteLocation | null } | null,
  selectedPitchIndex?: number | null,
): RenderResult {
  // While playing, the sounding note is recolored instead of any selection —
  // so a prior selection doesn't also show red at the same time.
  const effectiveSelected = playingLocations ? null : selected;
  container.innerHTML = '';

  const rows = computeScoreRows(
    score.measures.length,
    score.lineBreaks,
    score.pickupBeats !== undefined,
    score.trailingBeats !== undefined,
    MEASURES_PER_ROW,
  );

  const capacity = measureCapacityBeats(score.timeSignature);
  const rowMeasureWidths = rows.map((row) => computeRowMeasureWidths(row, score, capacity));
  const rowWidths = rowMeasureWidths.map((widths) => widths.reduce((sum, w) => sum + w, 20));
  // The composer credit always sits above the 4th measure's slot (index 3 in
  // row 0) — even before that measure actually exists — so it never jumps
  // around as measures are added; the canvas is widened to fit that slot if
  // the score doesn't reach it yet.
  const composerSlot = measureSlotXRange(3);
  const width = Math.max(...rowWidths, FIRST_MEASURE_WIDTH + 20, composerSlot.x1 + 20);
  // The composer credit gets its own dedicated band between the title and
  // the first row, so it never has to share pixels with the chord-symbol
  // band or the staff's ledger-line click region below it. `titleBand` (used
  // for row placement) includes that extra space; the title's own clickable
  // area (titleHitbox below) stays sized to just TITLE_BAND so the two don't
  // swallow each other's clicks.
  const titleBand = TITLE_BAND + COMPOSER_BAND;
  const leadSheet = score.showMelodyStaff === true;
  const rowHeight = ROW_HEIGHT + (leadSheet ? MELODY_BLOCK_HEIGHT : 0);
  const height = rows.length * rowHeight + titleBand;

  const renderer = new Renderer(container, Renderer.Backends.SVG);
  renderer.resize(width, height);
  const context = renderer.getContext();

  const noteHitboxes: NoteHitbox[] = [];
  const staffHitboxes: StaffHitbox[] = [];
  const chordHitboxes: ChordHitbox[] = [];
  const chordBandHitboxes: ChordBandHitbox[] = [];
  const lineBreakHitboxes: LineBreakHitbox[] = [];
  const lyricHitboxes: LyricHitbox[] = [];
  const lyricBandHitboxes: LyricBandHitbox[] = [];
  const accidentalMarks: AccidentalMark[] = [];
  const fingeringMarks: FingeringMark[] = [];
  const connectStubs: ConnectStubMark[] = [];
  const connectChains: Record<Clef, { event: NoteEvent; staveNote: StaveNote; rowIndex: number; ys: number[] }[]> = {
    treble: [],
    bass: [],
  };

  rows.forEach((row, rowIndex) => {
    const rowY = rowIndex * rowHeight + titleBand;
    const chordY = rowY + (leadSheet ? MELODY_CHORD_Y : CHORD_BAND_Y);
    const trebleY = rowY + (leadSheet ? TREBLE_Y + MELODY_BLOCK_HEIGHT : TREBLE_Y);
    const bassY = rowY + (leadSheet ? BASS_Y + MELODY_BLOCK_HEIGHT : BASS_Y);
    const melodyY = rowY + MELODY_STAFF_Y;

    let x = 10;
    row.forEach((measureIndex, localIndex) => {
      const measure = score.measures[measureIndex];
      const isRowStart = localIndex === 0;
      const isPieceStart = measureIndex === 0;
      const isLastMeasure = measureIndex === score.measures.length - 1;
      const measureWidth = rowMeasureWidths[rowIndex][localIndex];

      const trebleStave = new Stave(x, trebleY, measureWidth);
      const bassStave = new Stave(x, bassY, measureWidth);

      if (isRowStart) {
        trebleStave.addClef('treble');
        bassStave.addClef('bass');
        if (score.keySignature !== 'C') {
          trebleStave.addKeySignature(score.keySignature);
          bassStave.addKeySignature(score.keySignature);
        }
      }
      if (isPieceStart) {
        trebleStave.addTimeSignature(`${score.timeSignature.numerator}/${score.timeSignature.denominator}`);
        bassStave.addTimeSignature(`${score.timeSignature.numerator}/${score.timeSignature.denominator}`);
      }

      trebleStave.setContext(context).draw();
      bassStave.setContext(context).draw();

      let melodyStave: Stave | null = null;
      if (leadSheet) {
        melodyStave = new Stave(x, melodyY, measureWidth);
        if (isRowStart) {
          melodyStave.addClef('treble');
          if (score.keySignature !== 'C') melodyStave.addKeySignature(score.keySignature);
        }
        if (isPieceStart) {
          melodyStave.addTimeSignature(`${score.timeSignature.numerator}/${score.timeSignature.denominator}`);
        }
        melodyStave.setContext(context).draw();

        const melodyNotes = deriveMelodyNotes(measure.treble.notes);
        const melodyStaveNotes = buildMelodyStaveNotes(melodyNotes);
        if (melodyStaveNotes.length > 0) {
          const melodyVoice = new Voice({ numBeats: capacity, beatValue: 4 }).setStrict(false);
          melodyVoice.addTickables(melodyStaveNotes);
          new Formatter().joinVoices([melodyVoice]).format([melodyVoice], measureWidth - (isRowStart ? 108 : 28));
          melodyVoice.draw(context, melodyStave);
          try {
            const defaultGroups = Beam.getDefaultBeamGroups(`${score.timeSignature.numerator}/${score.timeSignature.denominator}`);
            const pulseBeats = (defaultGroups[0]?.value() ?? 0.25) * 4;
            const beamGroups = computeBeamNoteGroups(melodyNotes, melodyStaveNotes, pulseBeats);
            beamGroups.map((group) => new Beam(group, true)).forEach((b) => b.setContext(context).draw());
          } catch {
            // Beaming is a visual nicety; ignore failures on unusual groupings.
          }
        }
      }

      if (isRowStart) {
        new StaveConnector(trebleStave, bassStave).setType('brace').setContext(context).draw();
        new StaveConnector(trebleStave, bassStave).setType('singleLeft').setContext(context).draw();
      }
      if (isLastMeasure) {
        new StaveConnector(trebleStave, bassStave).setType('boldDoubleRight').setContext(context).draw();
      } else {
        new StaveConnector(trebleStave, bassStave).setType('singleRight').setContext(context).draw();
      }

      const midY = (trebleStave.getYForLine(4) + bassStave.getYForLine(0)) / 2;

      ([
        ['treble', trebleStave, measure.treble.notes, trebleStave.getYForLine(0) - STAVE_TOP_MARGIN, midY],
        ['bass', bassStave, measure.bass.notes, midY, bassStave.getYForLine(4) + STAVE_TOP_MARGIN],
      ] as const).forEach(([clef, stave, notes, y0, y1]) => {
        const hiddenNoteIndex =
          draggingNote && draggingNote.measureIndex === measureIndex && draggingNote.clef === clef
            ? draggingNote.noteIndex
            : null;
        const playingLoc = playingLocations?.[clef];
        const playingNoteIndex =
          playingLoc && playingLoc.measureIndex === measureIndex && playingLoc.clef === clef ? playingLoc.noteIndex : null;
        const hiddenPitchIndex = hiddenNoteIndex !== null ? draggingNote?.pitchIndex ?? null : null;
        const selectedPitchIndexForClef = playingLocations ? null : selectedPitchIndex ?? null;
        const staveNotes = buildStaveNotes(
          clef,
          measureIndex,
          notes,
          effectiveSelected,
          hiddenNoteIndex,
          hiddenPitchIndex,
          playingNoteIndex,
          selectedPitchIndexForClef,
        );

        const refY0 = stave.getYForNote(0);
        const spacing = refY0 - stave.getYForNote(1);
        const noteStartX = stave.getNoteStartX();
        const noteAreaWidth = Math.max(40, stave.getX() + stave.getWidth() - NOTE_AREA_RIGHT_PAD - noteStartX);
        // Once a measure is full it auto-formats (free X positions ignored) so
        // the score tidies itself; until then notes sit where they were placed.
        const full = isStaffMeasureFull({ notes }, score.timeSignature);

        if (staveNotes.length > 0) {
          const voice = new Voice({ numBeats: capacity, beatValue: 4 }).setStrict(false);
          voice.addTickables(staveNotes);

          // Beams must be built before the notes are drawn: creating a Beam
          // marks its notes so they skip drawing their own individual flag.
          // Doing this after voice.draw() left both the flag and the beam
          // rendered on top of each other. Only beam auto-formatted (full)
          // measures; free-placed notes would produce misshapen beams.
          let beams: Beam[] = [];
          if (full) {
            try {
              // Beat "pulse" length, not a fixed quarter-note assumption:
              // simple meters (2/4, 3/4, 4/4, ...) pulse every quarter note;
              // compound/triple meters (6/8, 9/8, 12/8, ...) pulse every
              // dotted quarter — see Beam.getDefaultBeamGroups, VexFlow's own
              // implementation of the standard notation convention, whose
              // first group fraction (of a whole note) converts to beats by ×4.
              const defaultGroups = Beam.getDefaultBeamGroups(`${score.timeSignature.numerator}/${score.timeSignature.denominator}`);
              const pulseBeats = (defaultGroups[0]?.value() ?? 0.25) * 4;
              const beamGroups = computeBeamNoteGroups(notes, staveNotes, pulseBeats);
              // autoStem=true: each note's own StaveNote already picked its
              // OWN stem direction independently (autoStem on StaveNote), so
              // two notes straddling the middle line in the same beam group
              // could end up with opposite stem directions — a real notation
              // error that renders as a squashed beam with a near-zero-length
              // stem on one note. Beam(notes, true) recomputes and forces one
              // consistent direction for the whole group, like real engraving.
              beams = beamGroups.map((group) => new Beam(group, true));
            } catch {
              // Beaming is a visual nicety; ignore failures on unusual groupings.
            }
          }

          // Trailing margin reserved after the last note's onset: a dotted
          // note's dot is a modifier drawn to the notehead's right, and 20px
          // left it sitting flush against (sometimes past) the barline —
          // widen it slightly so the dot always has clear room.
          new Formatter().joinVoices([voice]).format([voice], measureWidth - (isRowStart ? 108 : 28));

          // getAbsoluteX() is only meaningful once each note knows its stave
          // (Voice.draw sets this internally, but we need the formatted X now to
          // compute free-X shifts before drawing).
          staveNotes.forEach((sn) => sn.setStave(stave));

          // Free-X placement: shift each positioned note from its formatted spot
          // to the requested fraction of the note area.
          const centerXs: number[] = staveNotes.map((sn) => sn.getAbsoluteX());
          if (!full) {
            staveNotes.forEach((sn, i) => {
              const fx = notes[i].x;
              if (fx === undefined) return;
              const desiredX = noteStartX + clamp01(fx) * noteAreaWidth;
              sn.setXShift(desiredX - sn.getAbsoluteX());
              centerXs[i] = desiredX;
            });
          }

          voice.draw(context, stave);
          beams.forEach((b) => b.setContext(context).draw());

          // Collect (event, staveNote) in play order per clef so tie/slur
          // curves — drawn once at the very end, after every measure has its
          // note positions — can connect a note to the next one in the staff,
          // even across a measure boundary. rowIndex/ys let that final pass
          // detect a connection crossing a line break (see connectStubs).
          staveNotes.forEach((sn, i) => {
            const note = notes[i];
            const ys = note.isRest
              ? [refY0 - 3 * spacing]
              : note.pitches.map((p) => refY0 - pitchToLine(clef, p.letter, p.octave) * spacing);
            connectChains[clef].push({ event: note, staveNote: sn, rowIndex, ys });
          });

          staveNotes.forEach((sn, noteIndex) => {
            const note = notes[noteIndex];
            const ys = note.isRest
              ? [refY0 - 3 * spacing]
              : note.pitches.map((p) => refY0 - pitchToLine(clef, p.letter, p.octave) * spacing);
            let stemX = centerXs[noteIndex];
            if (!note.isRest) {
              try {
                stemX = sn.getStemX();
              } catch {
                // Some note shapes (e.g. single whole notes) have no stem; fall back to centerX.
              }
            }
            const xs = ys.map((_, pitchIndex) => {
              try {
                return sn.noteHeads[pitchIndex]?.getAbsoluteX() ?? centerXs[noteIndex];
              } catch {
                return centerXs[noteIndex];
              }
            });
            const hb: NoteHitbox = {
              measureIndex,
              clef,
              noteIndex,
              centerX: centerXs[noteIndex],
              stemX,
              ys,
              xs,
            };
            noteHitboxes.push(hb);

            if (!note.isRest) {
              const isSelected =
                effectiveSelected &&
                effectiveSelected.measureIndex === measureIndex &&
                effectiveSelected.clef === clef &&
                effectiveSelected.noteIndex === noteIndex;
              const isPlaying = playingNoteIndex === noteIndex;
              let noteheadRightX = centerXs[noteIndex];
              try {
                noteheadRightX = centerXs[noteIndex] + sn.getGlyphWidth();
              } catch {
                // Some note shapes have no measurable glyph width; fall back to centerX.
              }
              note.pitches.forEach((pitch, pitchIndex) => {
                if (hiddenNoteIndex === noteIndex && (hiddenPitchIndex === null || hiddenPitchIndex === pitchIndex)) return;
                if (!pitch.accidental && pitch.finger === undefined) return;
                let color: string | null = null;
                if (isSelected || isPlaying) {
                  const narrowed =
                    isSelected && !isPlaying && selectedPitchIndexForClef !== null && note.pitches.length > 1;
                  color = narrowed ? (pitchIndex === selectedPitchIndexForClef ? '#d6432b' : null) : '#d6432b';
                }
                if (pitch.accidental) {
                  // Standard notation: the accidental sits to the LEFT of its
                  // notehead, so it uses the note's left edge, not the right.
                  accidentalMarks.push({ x: centerXs[noteIndex], y: ys[pitchIndex], type: pitch.accidental, color });
                }
                if (pitch.finger !== undefined) {
                  // Fingering sits to the right of the notehead — accidentals
                  // no longer live there too, so no extra offset is needed.
                  const fingerX = noteheadRightX + FINGER_GAP;
                  fingeringMarks.push({ x: fingerX, y: ys[pitchIndex], finger: pitch.finger, color });
                }
              });
            }
          });
        }

        const contentStartOffset = isRowStart ? 100 : 20;
        staffHitboxes.push({
          measureIndex,
          clef,
          x0: x,
          x1: x + measureWidth,
          y0,
          y1,
          refY0,
          spacing,
          contentX0: x + contentStartOffset,
          contentWidth: measureWidth - contentStartOffset,
          noteStartX,
          noteAreaWidth,
          full,
        });
      });

      // Chord symbol band above the treble stave.
      measure.chords.forEach((chord: ChordSymbol) => {
        const cx = x + chord.offset * measureWidth;
        chordHitboxes.push({ measureIndex, chordId: chord.id, x: cx, y: chordY, halfWidth: 20 });
      });
      chordBandHitboxes.push({
        measureIndex,
        x0: x,
        x1: x + measureWidth,
        y0: chordY - 14,
        // Kept just above the staff's ledger-line click region even though the
        // chord now sits lower (CHORD_BAND_Y), so tapping just above the staff
        // to place a high note isn't swallowed by the chord band.
        y1: chordY + 3,
        measureX: x,
        measureWidth,
      });

      // Lyric syllables: below the standalone melody staff in lead-sheet
      // layout, or in the band between the two piano staves otherwise.
      // getYForLine(4) is the melody staff's own bottom line — computed from
      // the real Stave geometry (like midY below), not a hardcoded offset
      // from its constructor Y, since that Y sits up near the clef glyph's
      // top rather than the actual staff lines.
      const lyricY = leadSheet && melodyStave ? melodyStave.getYForLine(4) + 20 : midY + 5;
      (measure.lyrics ?? []).forEach((syllable: LyricSyllable) => {
        lyricHitboxes.push({
          measureIndex,
          lyricId: syllable.id,
          x: x + syllable.offset * measureWidth,
          y: lyricY,
          halfWidth: Math.max(9, syllable.text.length * 6),
          measureX: x,
          measureWidth,
        });
      });
      lyricBandHitboxes.push({
        measureIndex,
        x0: x,
        x1: x + measureWidth,
        y0: lyricY - 10,
        y1: lyricY + 10,
        y: lyricY,
        measureX: x,
        measureWidth,
      });

      // Rows now wrap automatically every MEASURES_PER_ROW measures (see
      // computeRows), so no manual "next line" marker is drawn.

      x += measureWidth;
    });
  });

  // Tie/slur curves: a note's `connectToNext` joins it to the following note
  // in the same staff. Drawn last so every note already has its final position.
  (['treble', 'bass'] as const).forEach((clef) => {
    const chain = connectChains[clef];
    for (let i = 0; i < chain.length - 1; i++) {
      const cur = chain[i];
      const next = chain[i + 1];
      if (cur.event.isRest || next.event.isRest || !cur.event.connectToNext) continue;
      try {
        // User-chosen anchor pitch (see ConnectButton in Toolbar.tsx): a tie
        // re-finds the same pitch by key in the next note (falling back to
        // the same index if none matches); a slur just reuses the same
        // chord index on both ends, clamped to the next note's size. Legacy
        // data (no connectKind) always anchors at index 0.
        const curIndex = cur.event.connectKind ? Math.min(cur.event.connectPitchIndex ?? 0, cur.event.pitches.length - 1) : 0;

        if (cur.rowIndex !== next.rowIndex) {
          // The two notes are on different rows (a line break falls between
          // them) — a real curve would have to span the whole gap between
          // rows as one giant diagonal line. Draw a small hook poking out
          // past this note instead (fine if it runs past the measure edge),
          // matching how printed scores mark a tie/slur that continues onto
          // the next line.
          const line = pitchToLine(clef, cur.event.pitches[curIndex].letter, cur.event.pitches[curIndex].octave);
          const noteheadRightX = cur.staveNote.getAbsoluteX() + cur.staveNote.getGlyphWidth();
          connectStubs.push({ x: noteheadRightX, y: cur.ys[curIndex] ?? cur.ys[0], curveUp: !stemPointsUp(line) });
          continue;
        }

        if (cur.event.connectKind) {
          let nextIndex = Math.min(curIndex, next.event.pitches.length - 1);
          if (cur.event.connectKind === 'tie') {
            const curKey = pitchToVexKey(cur.event.pitches[curIndex]);
            const matched = next.event.pitches.findIndex((p) => pitchToVexKey(p) === curKey);
            if (matched >= 0) nextIndex = matched;
          }
          new StaveTie({
            firstNote: cur.staveNote,
            lastNote: next.staveNote,
            firstIndexes: [curIndex],
            lastIndexes: [nextIndex],
          })
            .setContext(context)
            .draw();
        } else {
          // Legacy data saved before connectKind existed: auto-detect by
          // comparing the whole chord (tie only if every pitch matches).
          const sameKeys =
            cur.event.pitches.length === next.event.pitches.length &&
            cur.event.pitches.every((p, pi) => pitchToVexKey(p) === pitchToVexKey(next.event.pitches[pi]));
          if (sameKeys) {
            new StaveTie({ firstNote: cur.staveNote, lastNote: next.staveNote }).setContext(context).draw();
          } else {
            new Curve(cur.staveNote, next.staveNote, {}).setContext(context).draw();
          }
        }
      } catch {
        // Skip connections VexFlow can't render (e.g. mismatched key counts).
      }
    }
  });

  const titleHitbox: TitleHitbox = { x0: 0, x1: width, y0: 0, y1: TITLE_BAND, x: width / 2, y: 48 };
  // Right-aligned above the 4th measure's slot (computed above, fixed by
  // layout geometry regardless of how many measures actually exist yet) —
  // so it sits in its final resting spot from the very first empty measure
  // and never jumps as more measures get added.
  const composerY = TITLE_BAND + COMPOSER_BAND - 8;
  const composerHitbox: ComposerHitbox = {
    x0: composerSlot.x0,
    x1: composerSlot.x1,
    y0: TITLE_BAND,
    y1: titleBand,
    x: composerSlot.x1 - 4,
    y: composerY,
  };

  const svg = container.querySelector('svg');
  if (svg) {
    drawHeading(svg, score, titleHitbox);
    drawComposer(svg, score, composerHitbox);
    drawChordLabels(svg, score, chordHitboxes);
    drawLyrics(svg, score, lyricHitboxes);
    drawLineBreakMarkers(svg, lineBreakHitboxes);
    drawAccidentalMarks(svg, accidentalMarks);
    drawFingeringMarks(svg, fingeringMarks);
    drawConnectStubs(svg, connectStubs);
  }

  return {
    noteHitboxes,
    staffHitboxes,
    chordHitboxes,
    chordBandHitboxes,
    lineBreakHitboxes,
    lyricHitboxes,
    lyricBandHitboxes,
    titleHitbox,
    composerHitbox,
    width,
    height,
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Always drawn (even empty) so there's a click target to add a title; shows a faint placeholder when empty. */
function drawHeading(svg: SVGSVGElement, score: Score, hb: TitleHitbox): void {
  const title = score.title?.trim();
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', String(hb.x));
  text.setAttribute('y', String(hb.y));
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('font-family', TITLE_FONT);
  text.setAttribute('font-size', '46');
  text.setAttribute('font-weight', '800');
  // VexFlow sets stroke="black" stroke-width="1" on the root <svg> for the
  // staff lines; text elements inherit it and get a 1px outline on top of the
  // fill, rendering visibly heavier than the plain HTML input editor. Force
  // fill-only so the committed text matches exactly what was typed.
  text.setAttribute('stroke', 'none');
  text.setAttribute('fill', title ? '#1a1a1a' : PLACEHOLDER_COLOR);
  text.textContent = title || '제목을 입력하려면 클릭하세요';
  svg.appendChild(text);
}

/** Right-aligned credit line above the 4th measure's slot. Click target to add/edit. */
function drawComposer(svg: SVGSVGElement, score: Score, hb: ComposerHitbox): void {
  const composer = score.composer?.trim();
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', String(hb.x));
  text.setAttribute('y', String(hb.y));
  text.setAttribute('text-anchor', 'end');
  text.setAttribute('font-family', CREDIT_FONT);
  text.setAttribute('font-style', 'italic');
  text.setAttribute('font-size', '13');
  text.setAttribute('stroke', 'none'); // fill-only, matching the input editor (see drawHeading)
  text.setAttribute('fill', composer ? '#333' : PLACEHOLDER_COLOR);
  text.textContent = composer || '작곡가를 입력하려면 클릭하세요';
  svg.appendChild(text);
}

function drawLyrics(svg: SVGSVGElement, score: Score, lyricHitboxes: LyricHitbox[]): void {
  lyricHitboxes.forEach((hb) => {
    const syllable = (score.measures[hb.measureIndex].lyrics ?? []).find((l) => l.id === hb.lyricId);
    if (!syllable) return;
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(hb.x));
    text.setAttribute('y', String(hb.y));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-family', LYRIC_FONT);
    text.setAttribute('font-size', '14');
    text.setAttribute('font-weight', '700');
    text.setAttribute('stroke', 'none'); // fill-only, matching the input editor (see drawHeading)
    text.setAttribute('fill', '#333');
    text.textContent = syllable.text;
    svg.appendChild(text);
  });
}


function drawChordLabels(svg: SVGSVGElement, score: Score, chordHitboxes: ChordHitbox[]): void {
  chordHitboxes.forEach((hb) => {
    const measure = score.measures[hb.measureIndex];
    const chord = measure.chords.find((c) => c.id === hb.chordId);
    if (!chord) return;
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(hb.x));
    text.setAttribute('y', String(hb.y));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-family', CHORD_FONT);
    text.setAttribute('font-size', '15');
    text.setAttribute('font-weight', '700');
    text.setAttribute('font-style', 'italic');
    text.setAttribute('stroke', 'none'); // fill-only, matching the input editor (see drawHeading)
    text.setAttribute('fill', '#2f3a8f');
    text.textContent = chordLabel(chord);
    svg.appendChild(text);
  });
}

function drawLineBreakMarkers(svg: SVGSVGElement, markers: LineBreakHitbox[]): void {
  markers.forEach((m) => {
    const midY = (m.y0 + m.y1) / 2;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(m.x0));
    rect.setAttribute('y', String(midY - 12));
    rect.setAttribute('width', String(m.x1 - m.x0));
    rect.setAttribute('height', '24');
    rect.setAttribute('rx', '4');
    rect.setAttribute('fill', '#efeaff');
    rect.setAttribute('stroke', '#aa3bff');
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String((m.x0 + m.x1) / 2));
    text.setAttribute('y', String(midY + 5));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '13');
    text.setAttribute('fill', '#aa3bff');
    text.textContent = '↵';
    svg.appendChild(rect);
    svg.appendChild(text);
  });
}

// --- Click / hover resolution -------------------------------------------------

export interface ClickResultSelect {
  type: 'select';
  measureIndex: number;
  clef: Clef;
  noteIndex: number;
}

export interface ClickResultAdd {
  type: 'add';
  measureIndex: number;
  clef: Clef;
  line: number;
}

export type ClickResult = ClickResultSelect | ClickResultAdd | null;

export function findStaffAt(result: RenderResult, x: number, y: number): StaffHitbox | null {
  return result.staffHitboxes.find((s) => x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1) ?? null;
}

export function resolveClick(result: RenderResult, x: number, y: number): ClickResult {
  const staff = findStaffAt(result, x, y);
  if (!staff) return null;

  // A note is "hit" only near one of its noteheads (pitch-aware), so that
  // clicking clearly above or below a note falls through to an add preview.
  const yRadius = staff.spacing * 0.45;
  const hitNote = result.noteHitboxes.find(
    (n) =>
      n.measureIndex === staff.measureIndex &&
      n.clef === staff.clef &&
      n.ys.some((ny, i) => Math.abs((n.xs[i] ?? n.centerX) - x) < NOTE_HIT_RADIUS && Math.abs(ny - y) < yRadius),
  );
  if (hitNote) {
    return { type: 'select', measureIndex: hitNote.measureIndex, clef: hitNote.clef, noteIndex: hitNote.noteIndex };
  }

  const line = (staff.refY0 - y) / staff.spacing;
  return { type: 'add', measureIndex: staff.measureIndex, clef: staff.clef, line };
}

export function lineAt(staff: StaffHitbox, y: number): number {
  return (staff.refY0 - y) / staff.spacing;
}

/** Fractional (0..1) horizontal position of an X within a staff's free-placement note area. */
export function xFractionAt(staff: StaffHitbox, x: number): number {
  return Math.min(1, Math.max(0, (x - staff.noteStartX) / staff.noteAreaWidth));
}

/** Where a new note should be spliced into the staff's note list for a given click X. */
export function findInsertIndex(result: RenderResult, measureIndex: number, clef: Clef, x: number): number {
  const notes = result.noteHitboxes
    .filter((n) => n.measureIndex === measureIndex && n.clef === clef)
    .sort((a, b) => a.noteIndex - b.noteIndex);
  const next = notes.find((n) => x < n.centerX);
  return next ? next.noteIndex : notes.length;
}

export function findChordAt(result: RenderResult, x: number, y: number): ChordHitbox | null {
  return (
    result.chordHitboxes.find(
      (c) => Math.abs(c.x - x) < c.halfWidth && Math.abs(c.y - y) < 14,
    ) ?? null
  );
}

export function findChordBandAt(result: RenderResult, x: number, y: number): ChordBandHitbox | null {
  return result.chordBandHitboxes.find((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) ?? null;
}

export function findLineBreakAt(result: RenderResult, x: number, y: number): LineBreakHitbox | null {
  return result.lineBreakHitboxes.find((m) => x >= m.x0 && x <= m.x1 && y >= m.y0 && y <= m.y1) ?? null;
}

export function findLyricAt(result: RenderResult, x: number, y: number): LyricHitbox | null {
  return result.lyricHitboxes.find((l) => Math.abs(l.x - x) < l.halfWidth && Math.abs(l.y - y) < 12) ?? null;
}

export function findLyricBandAt(result: RenderResult, x: number, y: number): LyricBandHitbox | null {
  return result.lyricBandHitboxes.find((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) ?? null;
}

export function findTitleAt(result: RenderResult, x: number, y: number): boolean {
  const hb = result.titleHitbox;
  return x >= hb.x0 && x <= hb.x1 && y >= hb.y0 && y <= hb.y1;
}

export function findComposerAt(result: RenderResult, x: number, y: number): boolean {
  const hb = result.composerHitbox;
  return x >= hb.x0 && x <= hb.x1 && y >= hb.y0 && y <= hb.y1;
}

/** Index of the pitch (within a note's own `pitches`) nearest a point — used to narrow a chord selection to a specific pitch. */
export function nearestPitchIndexAt(hb: NoteHitbox, x: number, y: number): number {
  let best = 0;
  let bestDist = Infinity;
  hb.ys.forEach((py, i) => {
    const px = hb.xs[i] ?? hb.centerX;
    const d = Math.hypot(px - x, py - y);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

/** All notes within a generous radius of a point, nearest first — used by note-select mode to pick the closest existing note to a tap. */
export function findNearbyNotesAt(result: RenderResult, x: number, y: number, radius: number): NoteHitbox[] {
  return result.noteHitboxes
    .map((n) => ({ n, d: Math.min(...n.ys.map((ny, i) => Math.hypot((n.xs[i] ?? n.centerX) - x, ny - y))) }))
    .filter(({ d }) => d < radius)
    .sort((a, b) => a.d - b.d)
    .map(({ n }) => n);
}
