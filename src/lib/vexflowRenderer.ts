import {
  Beam,
  Curve,
  Dot,
  Formatter,
  GraceNote,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  StaveTie,
  Stem,
  TickContext,
  Tuplet,
  Voice,
} from 'vexflow';
import type { RenderContext } from 'vexflow';
import type { Accidental, ChordSymbol, Clef, DurationValue, LyricSyllable, Measure, NoteEvent, NoteLocation, OttavaKind, PartId, Score, TimeSignature } from '../types/score';
import {
  ALL_PARTS,
  chordLabel,
  computeScaleDegreeLabels,
  computeScoreRows,
  isStaffMeasureFull,
  measureCapacityBeats,
  measureDurationBeats,
  measureTimeSignature,
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
/** A grace note is engraved at roughly 2/3 the size of a full note, so its own
 * accidental has to shrink with it — at the full ACCIDENTAL_FONT_SIZE a flat
 * printed nearly as tall as the little notehead's whole stem. */
const GRACE_ACCIDENTAL_FONT_SIZE = 15;
/** Horizontal gap between an accidental glyph's right edge and the notehead's left edge. */
const ACCIDENTAL_GAP = 2;
/** Roughly how wide ♯/♭/♮ print at ACCIDENTAL_FONT_SIZE. Only used to work out
 * how far left of a notehead its accidental reaches, so a grace note can be
 * placed clear of it (see graceHostLeftBound) — the glyphs themselves are
 * right-anchored and never depend on this. */
const ACCIDENTAL_GLYPH_WIDTH = 11;

/** Leftmost X anything already occupies for a note: its own notehead, or its
 * accidental when it has one. What a grace note has to stay clear of. */
function graceHostLeftBound(noteheadLeftX: number, leftmostAccidentalAnchorX: number | null): number {
  if (leftmostAccidentalAnchorX === null) return noteheadLeftX;
  return Math.min(noteheadLeftX, leftmostAccidentalAnchorX - ACCIDENTAL_GAP - ACCIDENTAL_GLYPH_WIDTH);
}
/** Fingering numbers are drawn slightly larger than accidentals, to the right of them. */
const FINGER_FONT_SIZE = 16;
/** Gap between a notehead's right edge and its fingering number. */
const FINGER_GAP = 4;
const DEGREE_GAP = 10;

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
  /** Overrides ACCIDENTAL_FONT_SIZE — only a grace note's own accidental uses this (see GRACE_ACCIDENTAL_FONT_SIZE). */
  fontSize?: number;
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
    text.setAttribute('font-size', String(mark.fontSize ?? ACCIDENTAL_FONT_SIZE));
    text.setAttribute('stroke', 'none');
    if (mark.color) text.setAttribute('fill', mark.color);
    text.textContent = ACCIDENTAL_GLYPH[mark.type];
    svg.appendChild(text);
  });
}

/**
 * The short slur every acciaccatura carries, from its own notehead into the
 * note it decorates. VexFlow draws this itself for a GraceNoteGroup, but the
 * grace note is no longer a group modifier (see drawGraceNote for why), so
 * the curve is drawn by hand from the two noteheads' final positions.
 */
interface GraceSlurMark {
  /** Grace notehead center. */
  x0: number;
  y0: number;
  /** Host notehead center. */
  x1: number;
  y1: number;
  /** Bulge away from the stems: up when the grace note's stem points down, down when it points up. */
  curveUp: boolean;
  color: string | null;
}

function drawGraceSlurs(svg: SVGSVGElement, marks: GraceSlurMark[]): void {
  marks.forEach((mark) => {
    const dir = mark.curveUp ? -1 : 1;
    // Start/end just clear of each notehead so the curve reads as connecting
    // them rather than growing out of the middle of either glyph.
    const y0 = mark.y0 + dir * 7;
    const y1 = mark.y1 + dir * 7;
    const midY = Math.max(y0 * dir, y1 * dir) * dir + dir * 6;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', `M ${mark.x0} ${y0} Q ${(mark.x0 + mark.x1) / 2} ${midY} ${mark.x1} ${y1}`);
    path.setAttribute('stroke', mark.color ?? '#000');
    path.setAttribute('stroke-width', '1.1');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);
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

interface DegreeMark {
  x: number;
  y: number;
  text: string;
  /** Whether this mark's own note/pitch is the currently selected one — see
   * drawDegreeMarks' `emphasize` param: in 도수 입력 모드 the underlying note
   * is dimmed to near-invisibility, so "the note got selected" red styling
   * alone doesn't read; the digit itself needs its own distinct selected
   * look instead. */
  selected: boolean;
}

/** Scale-degree labels (see Score.showScaleDegrees / scoreUtils.scaleDegreeFor),
 * drawn just to the right of each note's highest pitch — like a numeric-
 * keypad entry sitting next to the note it annotates, not above the glyph.
 * `emphasize` (도수 입력 모드 — see renderScore's degreeInputMode) leans on
 * everything ELSE having been dimmed behind them (see the dim-group wrap in
 * renderScore) rather than on any decoration of its own: a chord's stacked
 * digits sit close enough together that a pill/circle behind each one merged
 * into a wall of green and buried the numbers it was supposed to highlight
 * (#246). The selected digit is called out by COLOR instead — it can't use a
 * white-on-solid fill any more with no shape behind it, and the red applied
 * to a clicked note lands on the (dimmed-out) note rather than the digit, so
 * it needs its own visible marker. Click targeting is unaffected either way:
 * findDegreeMarkAt claims its own radius explicitly (see DegreeMarkHitbox). */
function drawDegreeMarks(svg: SVGSVGElement, marks: DegreeMark[], emphasize = false): void {
  const fontSize = emphasize ? 13 : 12;
  marks.forEach((mark) => {
    const showSelected = emphasize && mark.selected;
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(mark.x));
    text.setAttribute('y', String(mark.y + 4));
    text.setAttribute('text-anchor', 'start');
    text.setAttribute('font-size', String(showSelected ? fontSize + 2 : fontSize));
    text.setAttribute('font-family', "'Nanum Gothic', 'Malgun Gothic', sans-serif");
    text.setAttribute('font-weight', '700');
    text.setAttribute('stroke', 'none');
    text.setAttribute('fill', showSelected ? '#2563eb' : '#2f9e44');
    text.textContent = mark.text;
    svg.appendChild(text);
  });
}

/** SMuFL (Bravura) rest codepoints, keyed by the same DurationValue used for
 * real notes — picks which rest glyph shape is drawn (set once at placement
 * time). The glyph's on-screen SIZE is a separate concern, see RestMark.scale. */
const REST_MARK_GLYPH: Record<DurationValue, string> = {
  w: String.fromCodePoint(0xe4e3),
  h: String.fromCodePoint(0xe4e4),
  q: String.fromCodePoint(0xe4e5),
  '8': String.fromCodePoint(0xe4e6),
  '16': String.fromCodePoint(0xe4e7),
  '32': String.fromCodePoint(0xe4e8),
};

/** Base rendered font-size (px) for a rest mark glyph at scale 1. */
const REST_MARK_BASE_FONT_SIZE = 40;

function restMarkFontSize(scale: number): number {
  return REST_MARK_BASE_FONT_SIZE * scale;
}

/** Half-width/height of a rest mark's rough bounding box at a given font-size
 * — shared by hitbox generation and drawing so the 4 corner handles line up
 * exactly with what's drawn. */
function restMarkHalfExtent(fontSize: number): { halfW: number; halfH: number } {
  return { halfW: fontSize * 0.42, halfH: fontSize * 0.58 };
}

/** Visual-only rest marks (see RestMark / #187) — a rest glyph sketched
 * wherever the user dropped it. Drawn boldly (not faint) so it's clearly
 * visible, but in a distinct color so it doesn't read as a real, played rest
 * (which would be a black notehead flag like every other note). Purely an
 * annotation: never affects beat capacity, playback, or MusicXML/MIDI export.
 * A selected mark additionally gets a soft highlight disc and 4 tiny corner
 * handles (drag one to resize, see RestMarkHandleHitbox / setRestMarkScale). */
function drawRestMarks(svg: SVGSVGElement, marks: RestMarkHitbox[], handles: RestMarkHandleHitbox[]): void {
  marks.forEach((mark) => {
    const fontSize = restMarkFontSize(mark.scale);
    if (mark.selected) {
      const { halfW, halfH } = restMarkHalfExtent(fontSize);
      const highlight = document.createElementNS(SVG_NS, 'rect');
      highlight.setAttribute('x', String(mark.x - halfW - 4));
      highlight.setAttribute('y', String(mark.y - halfH - 4));
      highlight.setAttribute('width', String((halfW + 4) * 2));
      highlight.setAttribute('height', String((halfH + 4) * 2));
      highlight.setAttribute('rx', '6');
      highlight.setAttribute('fill', '#5b3fa0');
      highlight.setAttribute('opacity', '0.14');
      svg.appendChild(highlight);
    }
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(mark.x));
    text.setAttribute('y', String(mark.y));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', String(fontSize));
    text.setAttribute('font-family', 'Bravura');
    text.setAttribute('stroke', 'none');
    text.setAttribute('fill', mark.selected ? '#c0392b' : '#5b3fa0');
    text.setAttribute('opacity', '1');
    text.textContent = REST_MARK_GLYPH[mark.duration] ?? REST_MARK_GLYPH.q;
    svg.appendChild(text);
  });

  handles.forEach((h) => {
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', String(h.x));
    dot.setAttribute('cy', String(h.y));
    dot.setAttribute('r', '4');
    dot.setAttribute('fill', '#ffffff');
    dot.setAttribute('stroke', '#c0392b');
    dot.setAttribute('stroke-width', '1.5');
    svg.appendChild(dot);
  });
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** How much less horizontal room a rest gets relative to an actual sounding
 * note of the same duration, in the beat-weighted layout below — a rest is
 * empty time and doesn't need visual room for readability, so giving it its
 * full duration-proportional share (like a long rest sitting between two
 * short notes) just crowds the actual notes for no benefit (see #230). */
const REST_WEIGHT = 0.35;

/** A small fixed gap (px) reserved after the very last note's onset in the
 * beat-weighted layout below — without it, the last note (see
 * buildBeatWeightMap's `total`) lands flush against the note area's right
 * edge, right up against the barline with zero breathing room (see #231's
 * "no trailing gap" fix). A tiny bit of space there reads more natural, the
 * same way real engraving never sits a notehead exactly on the barline. */
const TRAILING_GAP_PX = 8;

/** Mirrors TRAILING_GAP_PX at the start of the note area — without it, the
 * very FIRST note (fraction 0) sits flush against the clef/key/time glyphs
 * with zero left margin, most noticeably a lone whole note pinned right up
 * against them. Reserving a leading gap gives it breathing room, and as a
 * side effect narrows the middle gap for exactly-two-notes-spanning-the-
 * measure cases (e.g. two half notes) — the last note's own position still
 * lands at the same spot as before (TRAILING_GAP_PX from the right edge,
 * independent of this), so only the notes BEFORE it shift right, closing
 * the gap between them by this amount (see #235, #236). Scales with the
 * measure's own note area (a fixed px value reads as barely-there on a
 * normal-width measure but way too much on a narrow shrunk-for-sparse-
 * content one — see #234) instead of a flat constant, capped so it doesn't
 * eat too much of a very wide measure's area either. */
const LEADING_GAP_FRACTION = 0.1;
const LEADING_GAP_MAX_PX = 24;
/** Hard ceiling on the leading gap as a share of the room each note actually
 * gets. Sizing the gap off the measure's total width alone made it grow with
 * the measure while the per-note spacing inside it SHRANK — a busy measure of
 * 16ths ended up reserving a bigger margin before its first note (40px) than
 * it gave between consecutive notes (23px), which is exactly the dead space
 * at the start of each measure that #243 reports. Tying the cap to average
 * per-note spacing keeps a sparse measure's breathing room (a lone whole note
 * still clears the clef comfortably) while letting a dense one give nearly
 * all of its width back to the notes. */
const LEADING_GAP_SPACING_FRACTION = 0.45;
function leadingGapFor(noteAreaWidth: number, noteCount = 1): number {
  const averageSpacing = noteAreaWidth / Math.max(1, noteCount);
  return Math.min(LEADING_GAP_MAX_PX, noteAreaWidth * LEADING_GAP_FRACTION, averageSpacing * LEADING_GAP_SPACING_FRACTION);
}

/**
 * Builds a shared raw-beat → cumulative-"visual weight" mapping for one
 * measure, merging every voice given (e.g. [trebleNotes, bassNotes] for the
 * grand staff, or just [melodyNotes] alone) so all of them consult the
 * IDENTICAL mapping when positioning their own notes — required for
 * grand-staff alignment (#220): if each clef discounted its OWN rests
 * independently, a bass note sounding while the treble rests (or vice versa)
 * would land at a different weighted position between clefs, throwing them
 * out of vertical alignment even though they share the same real beat. A
 * time span only counts as "silent" (and gets compressed by REST_WEIGHT)
 * when EVERY given voice is resting (or has nothing written) there — real
 * content in even ONE voice keeps that span at full width. `total` (the
 * denominator every note's own weight gets divided by) is pinned to the
 * weight AT THE LATEST ONSET across every voice — not the weight at the end
 * of the latest-ending note — so the very last note (whichever voice it's
 * in, whatever its own duration) always lands exactly at the right edge of
 * the note area, instead of leaving a trailing gap sized to its own
 * duration before the barline (#231). Every earlier note's position is
 * still proportional within that same total, so this also naturally
 * stretches a partially-written measure's notes across the whole available
 * area instead of confining them to a fraction of it with blank space left
 * for beats nobody has written yet.
 */
function buildBeatWeightMap(voices: NoteEvent[][]): { weightAt: (beat: number) => number; total: number } {
  interface Span {
    start: number;
    end: number;
    isRest: boolean;
  }
  const spansPerVoice: Span[][] = voices.map((notes) => {
    const spans: Span[] = [];
    let beat = 0;
    for (const n of notes) {
      const beats = noteBeats(n);
      spans.push({ start: beat, end: beat + beats, isRest: n.isRest || n.pitches.length === 0 });
      beat += beats;
    }
    return spans;
  });

  const boundariesSet = new Set<number>([0]);
  spansPerVoice.forEach((spans) => spans.forEach((s) => {
    boundariesSet.add(s.start);
    boundariesSet.add(s.end);
  }));
  const boundaries = Array.from(boundariesSet).sort((a, b) => a - b);

  const isSilentAt = (b0: number, b1: number): boolean => {
    const mid = (b0 + b1) / 2;
    return spansPerVoice.every((spans) => {
      const covering = spans.find((s) => mid >= s.start && mid < s.end);
      return !covering || covering.isRest;
    });
  };

  const cumAt: number[] = [0];
  for (let i = 1; i < boundaries.length; i++) {
    const b0 = boundaries[i - 1];
    const b1 = boundaries[i];
    const silent = isSilentAt(b0, b1);
    cumAt.push(cumAt[i - 1] + (b1 - b0) * (silent ? REST_WEIGHT : 1));
  }

  const weightAt = (beat: number): number => {
    // A note's own onset beat is, by construction, always one of the
    // boundaries above (every voice's own onsets were added to the set) —
    // the interpolation fallback only matters for an off-boundary query.
    const idx = boundaries.findIndex((b) => Math.abs(b - beat) < 1e-6);
    if (idx !== -1) return cumAt[idx];
    let lo = 0;
    while (lo < boundaries.length - 1 && boundaries[lo + 1] <= beat) lo++;
    if (lo >= boundaries.length - 1) return cumAt[cumAt.length - 1] ?? 0;
    const b0 = boundaries[lo];
    const b1 = boundaries[lo + 1];
    const t = b1 > b0 ? (beat - b0) / (b1 - b0) : 0;
    return cumAt[lo] + t * (cumAt[lo + 1] - cumAt[lo]);
  };

  const lastOnset = spansPerVoice.reduce((max, spans) => spans.reduce((m, s) => Math.max(m, s.start), max), 0);

  return { weightAt, total: weightAt(lastOnset) };
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

// A note's contribution to how much horizontal room its measure "wants" —
// see measureContentWeight. NOTE_WIDTH_MIN is a fixed floor per note (room
// for its head/accidental/flag regardless of how short the note is);
// NOTE_WIDTH_PER_BEAT scales with the SQUARE ROOT of the note's own beat
// duration (diminishing returns, not linear — a whole note shouldn't get 16x
// the width of a 16th note just because it's 16x as long, but it should get
// noticeably more than an equal-count run of short notes).
const NOTE_WIDTH_MIN = 15;
const NOTE_WIDTH_PER_BEAT = 26;

/** A fully-notated measure's "typical" content weight (one beat-long note
 * per beat of its capacity) — the reference point computeRowMeasureWidths
 * scales a sparse measure's SLOT WIDTH down against (see WRITTEN_FRACTION_FLOOR
 * below), and the floor measureContentWeight itself falls back to. */
function fullMeasureWeight(timeSignature: TimeSignature): number {
  return measureCapacityBeats(timeSignature) * (NOTE_WIDTH_MIN + NOTE_WIDTH_PER_BEAT);
}

/** A measure with real notes in it still needs a floor below which it won't
 * collapse (regardless of how short its own notes are) — but that floor
 * scales with how much of the measure is actually WRITTEN (last note's own
 * span / capacity), not the full capacity outright, down to
 * WRITTEN_FRACTION_FLOOR (so a bare handful-of-beats measure gets a
 * meaningfully smaller floor than a fully-notated one, instead of both
 * claiming the exact same "typical full measure" width — see #234: a lone
 * half-note chord sitting in an otherwise-blank 4/4 measure was rendered
 * pinned flush-left with a huge dead gap after it, because the measure's
 * SLOT was sized as if it were fully written even though only half of it
 * was). A never-touched measure (0 notes) still gets the floor itself, so a
 * mid-composition score doesn't collapse its still-empty measures to
 * nothing next to a denser neighbor. */
const WRITTEN_FRACTION_FLOOR = 0.4;

/** How much horizontal room a measure's own note content wants, independent
 * of the fixed per-slot base width — feeds computeRowMeasureWidths' weighted
 * redistribution below. A dense passage (many notes and/or short durations —
 * most commonly a busy bass-clef 16th-note run) needs meaningfully more room
 * per note than a sparse one just to keep noteheads/accidentals/chord
 * labels from crowding together, even when both measures nominally span the
 * same number of beats. Real engraving gives measures unequal width for
 * exactly this reason, instead of clamping every measure in a row to one
 * fixed size regardless of what's actually written in it. Takes the denser
 * of the two clefs, since they share one measure width. */
function measureContentWeight(measure: Measure, timeSignature: TimeSignature): number {
  // A measure with NOTHING written yet (not composed at all — most often a
  // freshly-added trailing measure the user hasn't reached) keeps its full
  // traditional slot width instead of shrinking toward WRITTEN_FRACTION_FLOOR
  // below. Shrinking these too collapses the whole ROW narrower than a
  // normal row, stranding blank page space to the right of the score
  // instead of the row filling the screen (see #237) — the written-fraction
  // floor is only for a measure that HAS some real content but not enough
  // of it to fill its own capacity (see #234's "lone note in an otherwise-
  // blank measure" fix, which this must not undo).
  if (measure.treble.notes.length === 0 && measure.bass.notes.length === 0) {
    return fullMeasureWeight(timeSignature);
  }
  const perClef = (notes: NoteEvent[]) =>
    notes.reduce((sum, n) => sum + NOTE_WIDTH_MIN + NOTE_WIDTH_PER_BEAT * Math.sqrt(Math.max(noteBeats(n), 0.01)), 0);
  const treble = perClef(measure.treble.notes);
  const bass = perClef(measure.bass.notes);
  const writtenBeats = (notes: NoteEvent[]) => notes.reduce((sum, n) => sum + noteBeats(n), 0);
  const capacity = measureCapacityBeats(timeSignature);
  const writtenFraction = Math.min(1, Math.max(writtenBeats(measure.treble.notes), writtenBeats(measure.bass.notes)) / capacity);
  const baseline = fullMeasureWeight(timeSignature) * Math.max(writtenFraction, WRITTEN_FRACTION_FLOOR);
  return Math.max(treble, bass, baseline);
}

/**
 * Per-slot widths for one row. Each non-partial slot's share of the row's
 * total target width is weighted by its own measure's note content (see
 * measureContentWeight), instead of every slot simply getting the same
 * fixed base width — so a measure with a dense passage gets noticeably more
 * room than a sparse neighbor in the same row (see #229). A row holding the
 * pickup or trailing partial measure still needs that one slot sized
 * proportional to its own beat fraction (not content-weighted like a normal
 * measure, since its width represents "how much of a full measure this
 * covers"), with the freed width folded into the weighted redistribution
 * across the row's other measures. Applies regardless of how many measures
 * the row happens to hold: a row squeezed to MEASURES_PER_ROW + 1 slots (the
 * pickup/trailing measure plus a full normal row) targets the SAME total
 * width as any other full row, so it doesn't stick out past the normal right
 * edge; a shorter row (fewer total measures in the piece) just keeps its own
 * natural total width instead of being artificially stretched to match a
 * full row.
 */
function computeRowMeasureWidths(row: number[], score: Score, capacity: number, focusedMeasureIndex?: number | null): number[] {
  const baseWidths = row.map((_, localIndex) => (localIndex === 0 ? FIRST_MEASURE_WIDTH : MEASURE_WIDTH));

  const lastScoreIndex = score.measures.length - 1;
  const partialLocalIndex = row.findIndex((measureIndex, localIndex) => {
    if (localIndex === 0 && measureIndex === 0 && score.pickupBeats !== undefined) return true;
    if (localIndex === row.length - 1 && measureIndex === lastScoreIndex && score.trailingBeats !== undefined) {
      return true;
    }
    return false;
  });

  const contentWeights = row.map((measureIndex, localIndex) => {
    if (localIndex === partialLocalIndex) return 0;
    const measure = score.measures[measureIndex];
    const timeSignature = measureTimeSignature(score, measureIndex);
    if (!measure) return fullMeasureWeight(timeSignature);
    const contentWeight = measureContentWeight(measure, timeSignature);
    // The measure the user is actively working in never shrinks below its
    // typical full width, even while sparsely written — placing a measure's
    // very first note otherwise immediately shrank its slot toward
    // WRITTEN_FRACTION_FLOOR, cramping the room available to click in the
    // NEXT note right when the user most needs it. It's still free to grow
    // past full width for genuinely dense content (Math.max keeps that), and
    // reflows back down to its normal content-scaled width once focus moves
    // to a different measure.
    return measureIndex === focusedMeasureIndex ? Math.max(contentWeight, fullMeasureWeight(timeSignature)) : contentWeight;
  });
  // A hand-dragged measure width (see Measure.widthScale) only shifts that
  // measure's SHARE of its row, never the row's own total: it's deliberately
  // left out of naturalTotal below, so widening one measure narrows its
  // neighbours instead of pushing the whole system off the right edge of the
  // page (and shrinking one lets the neighbours reclaim that space).
  const weights = contentWeights.map((w, localIndex) => w * (score.measures[row[localIndex]]?.widthScale ?? 1));
  const weightSum = weights.reduce((sum, w) => sum + w, 0);

  // Each non-partial slot's natural (pre-redistribution) width scales down
  // toward WRITTEN_FRACTION_FLOOR when its own content is sparse (see
  // measureContentWeight) — capped at 1 so a fully (or densely) written
  // measure keeps its traditional full slot width, unchanged from before
  // this scaling existed. This is what actually shrinks a sparsely-notated
  // row's TOTAL width, instead of only changing how a fixed total gets
  // redistributed among that row's measures — redistribution alone can't
  // fix a lone note's dead trailing gap, since it only reallocates share of
  // a total that stayed the same size regardless of content (see #234).
  const naturalTotal = row.reduce((sum, measureIndex, localIndex) => {
    if (localIndex === partialLocalIndex) return sum;
    const timeSignature = measureTimeSignature(score, measureIndex);
    const scale = Math.min(1, contentWeights[localIndex] / fullMeasureWeight(timeSignature));
    return sum + baseWidths[localIndex] * scale;
  }, 0);
  const targetRowWidth =
    row.length > MEASURES_PER_ROW ? FIRST_MEASURE_WIDTH + (MEASURES_PER_ROW - 1) * MEASURE_WIDTH : naturalTotal;

  let partialWidth = 0;
  if (partialLocalIndex !== -1) {
    const partialBeats = partialLocalIndex === 0 ? score.pickupBeats! : score.trailingBeats!;
    const fraction = Math.max(0, Math.min(1, partialBeats / capacity));
    const partialBase = baseWidths[partialLocalIndex];
    // The pickup slot (local index 0) still needs room for the clef/key/time
    // signature glyphs even when very short, so it gets a taller floor than a
    // trailing slot (which only needs room for a note or two).
    const minWidth = partialLocalIndex === 0 ? 150 : 90;
    partialWidth = Math.max(partialBase * fraction, minWidth);
  }

  if (weightSum <= 0) return baseWidths.map((w, i) => (i === partialLocalIndex ? partialWidth : w));

  // The row-start slot alone reserves extra fixed width for the clef/key/
  // time-signature glyphs at the start of a staff line (see the measureWidth
  // - (isRowStart ? 108 : 28) split used when formatting notes) — its own
  // FIRST_MEASURE_WIDTH is bigger than MEASURE_WIDTH by (108-28) for exactly
  // this reason. Splitting the row's width purely by content weight ignores
  // that gap: two measures with IDENTICAL content would get identical raw
  // widths, leaving the row-start slot with meaningfully LESS actual note
  // room once its bigger glyph reservation is subtracted out — exactly the
  // "first measure looks cramped even though 2nd/3rd have room" bug (#231).
  // Carve this fixed overhead off the top for the row-start slot (when it
  // isn't already the specially-sized partial slot) before splitting what's
  // left by content weight, then add it back on — so equal-content measures
  // still end up with equal USABLE note area, and denser ones still get
  // proportionally more on top of that shared baseline.
  const FIRST_SLOT_OVERHEAD = FIRST_MEASURE_WIDTH - MEASURE_WIDTH;
  const firstSlotOverhead = partialLocalIndex === 0 ? 0 : FIRST_SLOT_OVERHEAD;
  const remaining = targetRowWidth - partialWidth - firstSlotOverhead;
  return row.map((_, i) => {
    if (i === partialLocalIndex) return partialWidth;
    const minWidth = i === 0 ? 150 : 90;
    const overhead = i === 0 ? firstSlotOverhead : 0;
    return Math.max(minWidth, overhead + remaining * (weights[i] / weightSum));
  });
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
/** Gap (px) between a grace notehead's RIGHT edge and its host notehead's
 * LEFT edge — the whole point of drawGraceNote's manual placement is that
 * this distance is exact and identical everywhere, instead of whatever
 * VexFlow's modifier layout happened to leave. Tight, but wide enough that
 * findGraceNoteAt's own x-tolerance (see there) can't reach the host's
 * center and steal a click meant for it. */
const GRACE_HOST_GAP_PX = 9;
/** Horizontal room a grace note occupies to the left of its host: its own
 * notehead plus GRACE_HOST_GAP_PX, plus a little for an accidental when it
 * has one. Reserved as leading space when the FIRST note of a measure
 * carries a grace note, so the grace note can't back into the clef/meter
 * glyphs (it is placed off its host, so nothing else would hold room for it). */
const GRACE_SLOT_PX = 20;
const GRACE_ACCIDENTAL_SLOT_PX = 11;
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
/** Measure numbers: small and pale, so they read as a reference you can find
 * when you look for it rather than as part of the music. */
const MEASURE_NUMBER_FONT_SIZE = 9;
const MEASURE_NUMBER_COLOR = '#a0a6b4';
/** How far above the chord band the number sits — clear of the tallest chord
 * symbol, so the two never overlap. */
const MEASURE_NUMBER_RISE = 26;

export interface NoteHitbox {
  measureIndex: number;
  clef: PartId;
  noteIndex: number;
  /**
   * Middle of the note's notehead glyph — where the note LOOKS like it is, so
   * this is what anything the user aims at should measure against.
   *
   * Deliberately not VexFlow's own idea of a note's X, which is the notehead's
   * LEFT EDGE. That is the right anchor for drawing (accidentals hang off it,
   * ledger lines start there) and the renderer keeps using it internally, but
   * as a click target it is half a notehead off — see where this is built.
   */
  centerX: number;
  /**
   * X of the note's stem (its "tail"), which for an up-stem note sits at the
   * notehead's right edge and for a down-stem note at its left edge — used
   * for the playback bar so it lines up with the note's stem rather than the
   * middle of its head.
   */
  stemX: number;
  /** Y of each notehead (a chord has several), for pitch-aware click hit-testing. */
  ys: number[];
  /**
   * Middle of each notehead, paired index-for-index with `ys`. VexFlow shifts
   * adjacent noteheads (a 2nd apart) left/right so they don't overlap —
   * `centerX` is only the note's own nominal column, so a chord tone that
   * got shifted needs its own X for accurate click hit-testing. Falls back
   * to `centerX` for any pitch VexFlow didn't report a notehead for.
   */
  xs: number[];
}

/** Click target for the small grace-note head attached to a host note (see
 * NoteEvent.graceNote and attachGraceNote) — lets it be selected independently
 * of its host, for pitch/position edits and deletion (see StaffEditor). */
export interface GraceNoteHitbox {
  measureIndex: number;
  clef: PartId;
  /** The HOST note's index — a grace note has no index of its own, it's a sub-object of its host. */
  noteIndex: number;
  x: number;
  y: number;
}

/** Click target for a scale-degree label (see DegreeMark), only meaningful
 * (and only populated) in 도수 입력 모드 — snaps a click on the enlarged
 * digit straight to the exact note/pitch it annotates, since the label sits
 * offset to the right of its notehead (see DEGREE_GAP) and, enlarged, can
 * visually overlap a neighboring note; without this the click fell through
 * to whichever note happened to be nearest, not necessarily the one whose
 * digit was actually clicked. */
export interface DegreeMarkHitbox {
  measureIndex: number;
  clef: PartId;
  noteIndex: number;
  pitchIndex: number;
  x: number;
  y: number;
  /** The currently-displayed degree text (e.g. "b5", "b13") — lets a click
   * handler offer a same-slot alternate spelling (see alternateDegreeSpelling
   * in scoreUtils.ts) without having to recompute the label itself. */
  text: string;
}

/** Click target for a visual-only rest mark (see RestMark / #187). */
export interface RestMarkHitbox {
  measureIndex: number;
  clef: Clef;
  restMarkId: string;
  x: number;
  y: number;
  duration: DurationValue;
  /** On-screen visual size multiplier (RestMark.scale, default 1) — independent of duration. */
  scale: number;
  selected: boolean;
}

/** One of the 4 tiny corner dots shown on a selected rest mark — dragging it
 * changes RestMarkHitbox.scale (see setRestMarkScale in scoreUtils). */
export interface RestMarkHandleHitbox {
  measureIndex: number;
  clef: Clef;
  restMarkId: string;
  corner: 'nw' | 'ne' | 'sw' | 'se';
  x: number;
  y: number;
  /** The rest mark's own anchor point — the handle drag measures distance from this. */
  centerX: number;
  centerY: number;
}

export interface StaffHitbox {
  measureIndex: number;
  clef: PartId;
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
  /**
   * Every written staff's notes, the lead-sheet melody staff's included —
   * each entry says which part it belongs to (NoteHitbox.clef), so a lookup
   * by (measureIndex, clef, noteIndex) is unambiguous on its own.
   *
   * The melody staff used to need a parallel pair of arrays, because back
   * when it was a view of the treble staff its hitboxes carried the SAME
   * identity as the treble ones and could only be told apart by which array
   * they were in. It is its own part now (see Measure.melody), so it is just
   * another clef in here.
   */
  noteHitboxes: NoteHitbox[];
  staffHitboxes: StaffHitbox[];
  chordHitboxes: ChordHitbox[];
  chordBandHitboxes: ChordBandHitbox[];
  graceNoteHitboxes: GraceNoteHitbox[];
  degreeMarkHitboxes: DegreeMarkHitbox[];
  restMarkHitboxes: RestMarkHitbox[];
  /** The 4 tiny drag-corners shown only on the currently-selected rest mark (see selectedRestMark param). */
  restMarkHandleHitboxes: RestMarkHandleHitbox[];
  lineBreakHitboxes: LineBreakHitbox[];
  lyricHitboxes: LyricHitbox[];
  lyricBandHitboxes: LyricBandHitbox[];
  titleHitbox: TitleHitbox;
  composerHitbox: ComposerHitbox;
  width: number;
  height: number;
}

/** The real clef VexFlow should draw a part in — it has no notion of our
 * melody part, which is written in treble clef (see PartId). */
function vexClefFor(part: PartId): Clef {
  return part === 'melody' ? 'treble' : part;
}

const REST_KEY: Record<PartId, string> = {
  treble: 'b/4',
  bass: 'd/3',
  // The melody staff is written in treble clef, so its rests sit identically.
  melody: 'b/4',
};

/**
 * Builds `note.graceNote` (see NoteEvent.graceNote) as a slashed acciaccatura
 * — but does NOT attach it to its host in any way. It is a free-standing
 * note that drawGraceNote positions and draws by hand once the host's final
 * X is known.
 *
 * It used to be a GraceNoteGroup modifier on the host StaveNote, and that is
 * exactly what made grace notes unplaceable. A GraceNoteGroup positions
 * itself off its host's PRE-format tick-context X, not the host's final
 * drawn X — and every staff here overrides note X after formatting (free-X
 * drags, and the beat-proportional spacing of #224). So the grace note
 * stayed behind wherever its host would have been, landing either smeared
 * on top of some other note or stranded way off next to the clef, depending
 * on which direction its host had moved. Re-applying the host's shift to the
 * group's own xShift did not track it either — VexFlow clamps that.
 *
 * Drawing it manually makes its position a plain subtraction from the host's
 * real notehead X, which is always right, and lets grace-bearing measures use
 * the same spacing rules as every other measure (they used to be excluded, at
 * the cost of grand-staff alignment). The accidental is hand-drawn too, for
 * the same reason the main staves' are — see drawAccidentalMarks.
 *
 * `position` only affects playback timing (see playback.ts's isAfter), never
 * which side it draws on: printed music always shows a grace note leading
 * into the note it decorates. `isSelected` recolors it red like a selected
 * main note (see StaffEditor's grace-note selection).
 */
function buildGraceNote(note: NoteEvent, clef: PartId, isSelected: boolean): GraceNote | null {
  if (!note.graceNote || note.isRest) return null;
  const g = note.graceNote;
  const graceStaveNote = new GraceNote({
    clef: vexClefFor(clef),
    keys: [pitchToVexKey({ letter: g.letter, accidental: g.accidental ?? '', octave: g.octave })],
    duration: g.duration ?? '8',
    slash: true,
  });
  if (isSelected) {
    graceStaveNote.setStyle({ fillStyle: '#d6432b', strokeStyle: '#d6432b' });
    graceStaveNote.setLedgerLineStyle({ fillStyle: '#d6432b', strokeStyle: '#d6432b' });
  }
  return graceStaveNote;
}

/** Room a grace note needs to the left of its host's notehead, accidental included. */
function graceSlotWidth(note: NoteEvent): number {
  if (!note.graceNote || note.isRest) return 0;
  return GRACE_SLOT_PX + (note.graceNote.accidental ? GRACE_ACCIDENTAL_SLOT_PX : 0);
}

/**
 * Places `gn` immediately to the LEFT of its host and draws it, plus its slur
 * into the host and (if any) its own accidental. Called only after the host
 * has been drawn and its accidentals measured, so both `hostLeftBoundX` and
 * `host.getNoteHeadBeginX()` are final.
 *
 * `hostLeftBoundX` is the leftmost X the host already occupies — its notehead,
 * or its own accidental when it carries one (see graceHostLeftBound). Placing
 * against the notehead alone printed the grace note straight through the
 * host's flat/sharp, since that glyph hangs in exactly the space the grace
 * note wants.
 *
 * A free-standing note still needs a TickContext to have an absolute X at all
 * (Note.getAbsoluteX reads tickContext.getX()), so it gets a throwaway one of
 * its own. Returns the grace notehead's center for the hitbox, or null if any
 * of the geometry was unmeasurable.
 */
function drawGraceNote(
  context: RenderContext,
  stave: Stave,
  host: StaveNote,
  hostLeftBoundX: number,
  gn: GraceNote,
  accidental: Exclude<Accidental, ''> | null,
  marks: { accidentals: AccidentalMark[]; slurs: GraceSlurMark[] },
): { x: number; y: number } | null {
  try {
    gn.setStave(stave);
    gn.setContext(context);
    const tickContext = new TickContext();
    tickContext.addTickable(gn);
    tickContext.preFormat();

    const glyphWidth = gn.getGlyphWidth();
    // Right edge of the grace notehead sits GRACE_HOST_GAP_PX left of whatever
    // the host's leftmost glyph is — so that gap is the same constant
    // everywhere, whatever either note's size, stem side, or accidental.
    const targetLeftX = hostLeftBoundX - GRACE_HOST_GAP_PX - glyphWidth;
    // Placed by moving the TickContext, NOT by setXShift. The two are not
    // interchangeable here: an acciaccatura's slash is drawn from
    // getAbsoluteX() (see GraceNote.draw), which does NOT include xShift,
    // while its notehead is drawn from getNoteHeadBeginX(), which does. Shift
    // the note and the slash stays behind, stranded as a bare diagonal stroke
    // out over the staff. Moving the tick context moves both together, since
    // getAbsoluteX() reads straight off it.
    tickContext.setX(tickContext.getX() + (targetLeftX - gn.getAbsoluteX()));
    gn.draw();

    const graceCenterX = targetLeftX + glyphWidth / 2;
    const graceY = gn.getYs()[0];
    const hostY = host.getYs()[0];
    // The selection recolor lives on the GraceNote itself (buildGraceNote);
    // reading it back keeps the hand-drawn accidental and slur in the same
    // color as the notehead without a second copy of the "is this selected"
    // rule that could drift out of step with it.
    const color = gn.getStyle()?.fillStyle ?? null;

    if (accidental) {
      marks.accidentals.push({
        x: targetLeftX,
        y: graceY,
        type: accidental,
        color,
        fontSize: GRACE_ACCIDENTAL_FONT_SIZE,
      });
    }
    marks.slurs.push({
      x0: graceCenterX,
      y0: graceY,
      // Ends under the host's own notehead, not under its accidental — the
      // slur connects the two NOTES.
      x1: host.getNoteHeadBeginX() + host.getGlyphWidth() / 2,
      y1: hostY,
      curveUp: gn.getStemDirection() === Stem.DOWN,
      color,
    });
    return { x: graceCenterX, y: graceY };
  } catch {
    // Unmeasurable geometry (an unusual note shape) — skip the grace note
    // rather than abort the whole row's render.
    return null;
  }
}

function buildStaveNotes(
  clef: PartId,
  measureIndex: number,
  notes: NoteEvent[],
  selected: NoteLocation | null,
  hiddenNoteIndex: number | null,
  hiddenPitchIndex: number | null,
  playingNoteIndex: number | null,
  selectedPitchIndex: number | null,
  selectedGrace: NoteLocation | null,
): { staveNotes: StaveNote[]; graceNotes: (GraceNote | null)[] } {
  const graceNotes: (GraceNote | null)[] = [];
  const staveNotes = notes.map((note, noteIndex) => {
    const keys = note.isRest ? [REST_KEY[clef]] : note.pitches.map(pitchToVexKey);
    const staveNote = new StaveNote({
      clef: vexClefFor(clef),
      keys,
      duration: vexDurationString(note),
      autoStem: true,
    });

    if (note.dotted) {
      Dot.buildAndAttach([staveNote], note.isRest ? { index: 0 } : { all: true });
    }

    const isGraceSelected =
      !!selectedGrace &&
      selectedGrace.measureIndex === measureIndex &&
      selectedGrace.clef === clef &&
      selectedGrace.noteIndex === noteIndex;
    graceNotes.push(buildGraceNote(note, clef, isGraceSelected));

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
  return { staveNotes, graceNotes };
}

export interface DraggingNote {
  measureIndex: number;
  clef: PartId;
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
function computeBeamNoteGroups(
  notes: NoteEvent[],
  staveNotes: StaveNote[],
  pulseBeats: number,
  chordChangeBeats: number[] = [],
): StaveNote[][] {
  const groups: StaveNote[][] = [];
  const groupIndices: number[][] = [];
  const onsetBeats: number[] = [];
  let current: StaveNote[] = [];
  let currentIndices: number[] = [];
  let currentPulse = -1;
  let cumulative = 0;
  notes.forEach((note, i) => {
    onsetBeats[i] = cumulative;
    const beamable = !note.isRest && (note.duration === '8' || note.duration === '16' || note.duration === '32');
    const pulseIndex = Math.floor((cumulative + 1e-6) / pulseBeats);
    if (beamable && pulseIndex === currentPulse) {
      current.push(staveNotes[i]);
      currentIndices.push(i);
    } else {
      if (current.length > 1) {
        groups.push(current);
        groupIndices.push(currentIndices);
      }
      current = beamable ? [staveNotes[i]] : [];
      currentIndices = beamable ? [i] : [];
      currentPulse = pulseIndex;
    }
    cumulative += noteBeats(note);
  });
  if (current.length > 1) {
    groups.push(current);
    groupIndices.push(currentIndices);
  }

  // Adjacent beat-pulse groups that are ENTIRELY plain (non-dotted) 8th
  // notes merge into one longer beam — e.g. 4 consecutive 8ths spanning two
  // beats read as a single run rather than 2+2, matching how lead-sheet/pop
  // engraving usually beams a half-measure of straight 8ths. Mixed-duration
  // or 16th-note groups (item 115's beat-completing pairs) are untouched.
  // Never merged across a chord-symbol change, though — a chord change
  // mid-run visually reads as one undifferentiated beam otherwise, hiding
  // exactly the harmonic boundary a lead-sheet reader most needs to see.
  const EPS = 1e-6;
  const hasChordChangeAt = (beat: number) => chordChangeBeats.some((b) => Math.abs(b - beat) < EPS);
  const merged: StaveNote[][] = [];
  // Triplet eighths (NoteEvent.tuplet) take 2/3 the time of a plain eighth,
  // so a triplet's beam must never fuse with an adjacent plain-eighth beat's
  // beam — they're rhythmically different runs even though both read as "8"
  // duration; merging them drew one long beam spanning both with only the
  // triplet's own "3" bracket over part of it (see computeTupletGroups),
  // which looked like a single (wrong) beamed run instead of two.
  const isPureEighthGroup = (indices: number[]) => indices.every((idx) => notes[idx].duration === '8' && !notes[idx].dotted && !notes[idx].tuplet);
  groups.forEach((group, gi) => {
    const indices = groupIndices[gi];
    const prev = merged[merged.length - 1];
    const prevIndices = groupIndices[gi - 1];
    if (
      prev &&
      prevIndices &&
      prevIndices[prevIndices.length - 1] + 1 === indices[0] &&
      isPureEighthGroup(prevIndices) &&
      isPureEighthGroup(indices) &&
      !hasChordChangeAt(onsetBeats[indices[0]])
    ) {
      prev.push(...group);
    } else {
      merged.push([...group]);
    }
  });
  return merged;
}

/**
 * Groups runs of exactly 3 consecutive 셋잇단음표 (triplet, NoteEvent.tuplet)
 * notes of the SAME duration into brackets for `new Tuplet(group)` — the
 * standard "3" bracket over a run of 3 same-value notes. A run that isn't a
 * multiple of 3 (e.g. only 1-2 tupleted notes in a row, or a differently-
 * tupleted note breaking the chain) simply doesn't get a bracket for its
 * leftover notes; they still sound/export correctly via noteBeats, they just
 * read without the visual "3" — an edge case, not a correctness issue.
 */
function computeTupletGroups(notes: NoteEvent[], staveNotes: StaveNote[]): StaveNote[][] {
  const groups: StaveNote[][] = [];
  let run: StaveNote[] = [];
  let runDuration: DurationValue | null = null;
  const flushRun = () => {
    for (let i = 0; i + 2 < run.length; i += 3) groups.push(run.slice(i, i + 3));
    run = [];
    runDuration = null;
  };
  notes.forEach((note, i) => {
    if (note.tuplet && (runDuration === null || note.duration === runDuration)) {
      run.push(staveNotes[i]);
      runDuration = note.duration;
    } else {
      flushRun();
      if (note.tuplet) {
        run = [staveNotes[i]];
        runDuration = note.duration;
      }
    }
  });
  flushRun();
  return groups;
}

/** Beat positions (within a measure, 0-based) where a NEW chord symbol
 * starts partway through — every chord's own beat except the earliest one,
 * which governs the whole measure from its start regardless of its stored
 * offset (see flattenChords in scoreUtils). Feeds computeBeamNoteGroups so
 * the "merge adjacent eighth groups into one beam" step never beams
 * straight through a chord change. */
function chordChangeBeatsIn(measure: Measure, measureDuration: number): number[] {
  const sorted = [...(measure.chords ?? [])].sort((a, b) => a.offset - b.offset);
  return sorted.slice(1).map((c) => c.offset * measureDuration);
}

export function renderScore(
  container: HTMLDivElement,
  score: Score,
  selected: NoteLocation | null,
  draggingNote: DraggingNote | null,
  playingLocations?: Partial<Record<PartId, NoteLocation | null>> | null,
  selectedPitchIndex?: number | null,
  selectedGrace?: NoteLocation | null,
  /** Currently-selected rest mark (see RestMark / #187) — draws its 4 corner handles. */
  selectedRestMark?: { measureIndex: number; restMarkId: string } | null,
  /** 도수 입력 모드 (see App's degreeInputMode): dims every other rendered
   * element and enlarges the scale-degree marks so they read as the primary
   * focus while entering/deleting them (see the dim-group wrap below and
   * drawDegreeMarks' `emphasize` param). */
  degreeInputMode?: boolean,
  /** The measure the user is actively working in (see App's focusedMeasureIndex)
   * — kept at its typical full width regardless of how little is written yet,
   * so placing a measure's first note doesn't immediately cramp the room left
   * to add the next one (see computeRowMeasureWidths). */
  focusedMeasureIndex?: number | null,
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
  const rowMeasureWidths = rows.map((row) => computeRowMeasureWidths(row, score, capacity, focusedMeasureIndex));
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
  const graceNoteHitboxes: GraceNoteHitbox[] = [];
  const degreeMarkHitboxes: DegreeMarkHitbox[] = [];
  const restMarkHitboxes: RestMarkHitbox[] = [];
  const restMarkHandleHitboxes: RestMarkHandleHitbox[] = [];
  const chordBandHitboxes: ChordBandHitbox[] = [];
  const lineBreakHitboxes: LineBreakHitbox[] = [];
  const lyricHitboxes: LyricHitbox[] = [];
  const lyricBandHitboxes: LyricBandHitbox[] = [];
  const accidentalMarks: AccidentalMark[] = [];
  const measureNumberMarks: MeasureNumberMark[] = [];
  const graceSlurMarks: GraceSlurMark[] = [];
  const fingeringMarks: FingeringMark[] = [];
  const degreeMarks: DegreeMark[] = [];
  const degreeLabels = computeScaleDegreeLabels(score);
  const connectStubs: ConnectStubMark[] = [];
  const connectChains: Record<PartId, { event: NoteEvent; staveNote: StaveNote; rowIndex: number; ys: number[] }[]> = {
    treble: [],
    bass: [],
    melody: [],
  };
  const ottavaChains: Record<PartId, OttavaChainEntry[]> = { treble: [], bass: [], melody: [] };

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
      // A 못갖춘마디 is an upbeat into bar 1, not a bar of its own, so it goes
      // unnumbered and the count starts at 1 on the measure after it.
      const measureNumber = score.pickupBeats !== undefined ? measureIndex : measureIndex + 1;
      if (measureNumber > 0) {
        measureNumberMarks.push({ x: x + 3, y: chordY - MEASURE_NUMBER_RISE, text: String(measureNumber) });
      }
      // This measure's own time signature (Measure.timeSignatureOverride, if
      // set — see measureTimeSignature) — the glyph is redrawn whenever it
      // differs from the PREVIOUS measure's, both when a mid-piece override
      // starts and again when the next measure reverts back to normal.
      const effectiveTimeSignature = measureTimeSignature(score, measureIndex);
      const showTimeSignature =
        isPieceStart ||
        (measureIndex > 0 &&
          (effectiveTimeSignature.numerator !== measureTimeSignature(score, measureIndex - 1).numerator ||
            effectiveTimeSignature.denominator !== measureTimeSignature(score, measureIndex - 1).denominator));
      // Reused by both the melody staff and the treble/bass staves below —
      // see chordChangeBeatsIn and computeBeamNoteGroups' chord-change guard.
      const chordChangeBeats = chordChangeBeatsIn(measure, measureDurationBeats(score, measureIndex));

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
      if (showTimeSignature) {
        trebleStave.addTimeSignature(`${effectiveTimeSignature.numerator}/${effectiveTimeSignature.denominator}`);
        bassStave.addTimeSignature(`${effectiveTimeSignature.numerator}/${effectiveTimeSignature.denominator}`);
      }

      // The treble clef glyph is wider than the bass clef glyph (and either
      // can carry a key/time signature independently), so each stave's own
      // auto-computed note-start X can differ by several pixels even though
      // both measures hold the exact same beats — a same-beat note in one
      // clef then renders slightly left/right of its counterpart in the
      // other. Pin both staves to the wider of the two so every beat lines
      // up vertically across the grand staff, matching how real engraving
      // aligns simultaneous notes between clefs.
      // Shared by BOTH clefs' beat-weighted positioning below (see
      // buildBeatWeightMap) so a treble note and a simultaneous bass note
      // land at the identical X regardless of how many rests either clef
      // has elsewhere in the measure.
      const grandStaffBeatMap = buildBeatWeightMap([measure.treble.notes, measure.bass.notes]);
      // A chord symbol sits above the treble staff only, so it never visually
      // collides with the BASS clef/key glyphs — the narrower of the two
      // clefs' own note-start (usually bass, since a treble clef glyph is
      // wider) is a valid left bound for it, even though the notes
      // themselves must still pin to the wider (sharedNoteStartX) one below
      // to stay vertically aligned across the grand staff.
      const chordLeftBoundX = Math.min(trebleStave.getNoteStartX(), bassStave.getNoteStartX());
      const sharedNoteStartX = Math.max(trebleStave.getNoteStartX(), bassStave.getNoteStartX());
      trebleStave.setNoteStartX(sharedNoteStartX);
      bassStave.setNoteStartX(sharedNoteStartX);

      trebleStave.setContext(context).draw();
      bassStave.setContext(context).draw();

      let melodyStave: Stave | null = null;
      if (leadSheet) {
        melodyStave = new Stave(x, melodyY, measureWidth);
        if (isRowStart) {
          melodyStave.addClef('treble');
          if (score.keySignature !== 'C') melodyStave.addKeySignature(score.keySignature);
        }
        if (showTimeSignature) {
          melodyStave.addTimeSignature(`${effectiveTimeSignature.numerator}/${effectiveTimeSignature.denominator}`);
        }
        melodyStave.setContext(context).draw();
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

      // Every written staff — the two piano clefs and, in lead-sheet layout,
      // the melody part (see Measure.melody) — goes through ONE rendering
      // pass. The melody staff used to have a parallel pass of its own, which
      // is why it quietly lacked selection/playback highlighting, chord
      // accidental columns, fingerings and degree labels that the piano
      // staves had; sharing the pass is what gives it all of them.
      //
      // What stays per-staff is spacing: the melody has its own rhythm, so it
      // gets its own beat-weight map and its own leading gap, and its voice
      // is formatted on its own (see below). Only treble and bass share a map,
      // because only they have to line up vertically with each other.
      const melodyBeatMap = buildBeatWeightMap([measure.melody.notes]);
      const pianoGapNoteCount = Math.max(measure.treble.notes.length, measure.bass.notes.length);
      const staffSources: [PartId, Stave, NoteEvent[], number, number][] = [
        ['treble', trebleStave, measure.treble.notes, trebleStave.getYForLine(0) - STAVE_TOP_MARGIN, midY],
        ['bass', bassStave, measure.bass.notes, midY, bassStave.getYForLine(4) + STAVE_TOP_MARGIN],
      ];
      if (melodyStave) {
        staffSources.unshift([
          'melody',
          melodyStave,
          measure.melody.notes,
          melodyStave.getYForLine(0) - STAVE_TOP_MARGIN,
          melodyStave.getYForLine(4) + STAVE_TOP_MARGIN,
        ]);
      }

      const clefEntries = staffSources.map(([clef, stave, notes, y0, y1]) => {
        const isPiano = clef !== 'melody';
        const beatMap = isPiano ? grandStaffBeatMap : melodyBeatMap;
        const gapNoteCount = isPiano ? pianoGapNoteCount : notes.length;
        // A grace note is drawn by hand off its host's final notehead X (see
        // drawGraceNote), not as a VexFlow modifier, so it takes no part in
        // formatting and adds no width of its own anywhere. Nothing therefore
        // holds room for one hanging off the measure's FIRST note, which is
        // the one place it could back into the clef/key/time glyphs — so that
        // one case reserves its width explicitly, as leading gap. Both piano
        // clefs must resolve to the SAME reserve or simultaneous notes would
        // stop lining up vertically across the grand staff; the melody staff
        // answers only to itself. (This replaces the old "grace-bearing
        // measures opt out of beat-proportional spacing" workaround, which
        // traded away that alignment — #220 — to keep GraceNoteGroup's
        // fragile modifier placement intact.)
        const graceLeadReserve = isPiano
          ? Math.max(
              0,
              ...(['treble', 'bass'] as Clef[]).map((c) => {
                const first = measure[c].notes[0];
                return first ? graceSlotWidth(first) : 0;
              }),
            )
          : notes[0]
            ? graceSlotWidth(notes[0])
            : 0;
        const hiddenNoteIndex =
          draggingNote && draggingNote.measureIndex === measureIndex && draggingNote.clef === clef
            ? draggingNote.noteIndex
            : null;
        const playingLoc = playingLocations?.[clef];
        const playingNoteIndex =
          playingLoc && playingLoc.measureIndex === measureIndex && playingLoc.clef === clef ? playingLoc.noteIndex : null;
        const hiddenPitchIndex = hiddenNoteIndex !== null ? draggingNote?.pitchIndex ?? null : null;
        const selectedPitchIndexForClef = playingLocations ? null : selectedPitchIndex ?? null;
        const { staveNotes, graceNotes } = buildStaveNotes(
          clef,
          measureIndex,
          notes,
          effectiveSelected,
          hiddenNoteIndex,
          hiddenPitchIndex,
          playingNoteIndex,
          selectedPitchIndexForClef,
          playingLocations ? null : selectedGrace ?? null,
        );

        const refY0 = stave.getYForNote(0);
        const spacing = refY0 - stave.getYForNote(1);
        const noteStartX = stave.getNoteStartX();
        const noteAreaWidth = Math.max(40, stave.getX() + stave.getWidth() - NOTE_AREA_RIGHT_PAD - noteStartX);
        // A measure being full only decides the DEFAULT layout (auto-formatted
        // so the score tidies itself); a note the user has explicitly dragged
        // (notes[i].x) keeps its manual position either way — see #241.
        const full = isStaffMeasureFull({ notes }, effectiveTimeSignature);

        // Rest marks are a piano-staff overlay only (RestMark.clef is a Clef,
        // not a PartId) — the melody staff writes real rests instead.
        const restMarkClef = isPiano ? (clef as Clef) : null;
        if (restMarkClef !== null) (measure.restMarks ?? []).filter((r) => r.clef === restMarkClef).forEach((r) => {
          const scale = r.scale ?? 1;
          const isSelected = !!selectedRestMark && selectedRestMark.measureIndex === measureIndex && selectedRestMark.restMarkId === r.id;
          const markX = x + r.offset * measureWidth;
          const markY = refY0 - r.line * spacing;
          restMarkHitboxes.push({
            measureIndex,
            clef: restMarkClef,
            restMarkId: r.id,
            x: markX,
            y: markY,
            duration: r.duration ?? 'q',
            scale,
            selected: isSelected,
          });
          if (isSelected) {
            const { halfW, halfH } = restMarkHalfExtent(restMarkFontSize(scale));
            (['nw', 'ne', 'sw', 'se'] as const).forEach((corner) => {
              restMarkHandleHitboxes.push({
                measureIndex,
                clef: restMarkClef,
                restMarkId: r.id,
                corner,
                x: markX + (corner === 'nw' || corner === 'sw' ? -halfW : halfW),
                y: markY + (corner === 'nw' || corner === 'ne' ? -halfH : halfH),
                centerX: markX,
                centerY: markY,
              });
            });
          }
        });

        const voice = staveNotes.length > 0 ? new Voice({ numBeats: capacity, beatValue: 4 }).setStrict(false) : null;
        if (voice) voice.addTickables(staveNotes);

        return { clef, stave, notes, y0, y1, staveNotes, graceNotes, hiddenNoteIndex, playingNoteIndex, hiddenPitchIndex, selectedPitchIndexForClef, refY0, spacing, noteStartX, noteAreaWidth, full, voice, beatMap, gapNoteCount, graceLeadReserve };
      });

      // Format treble and bass voices TOGETHER (not independently, as before)
      // so a note that lands on the same beat in each clef ends up at the
      // same X — otherwise a modifier that only one clef has (most commonly
      // a grace note, whose GraceNoteGroup reserves real width) pushes just
      // that stave's later notes rightward, throwing the grand staff out of
      // vertical alignment from that beat onward (see #220 — a grace note on
      // 도 no longer lining up with the simultaneous bass note below it).
      // Trailing margin reserved after the last note's onset: a dotted
      // note's dot is a modifier drawn to the notehead's right, and 20px
      // left it sitting flush against (sometimes past) the barline — widen
      // it slightly so the dot always has clear room.
      const jointVoices = clefEntries.map((e) => e.voice).filter((v): v is Voice => v !== null);
      if (jointVoices.length > 0) {
        new Formatter().joinVoices(jointVoices).format(jointVoices, measureWidth - (isRowStart ? 108 : 28));
      }

      clefEntries.forEach(({ clef, stave, notes, y0, y1, staveNotes, graceNotes, hiddenNoteIndex, playingNoteIndex, hiddenPitchIndex, selectedPitchIndexForClef, refY0, spacing, noteStartX, noteAreaWidth, full, voice, beatMap, gapNoteCount, graceLeadReserve }) => {
        if (voice) {
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
              const defaultGroups = Beam.getDefaultBeamGroups(`${effectiveTimeSignature.numerator}/${effectiveTimeSignature.denominator}`);
              const pulseBeats = (defaultGroups[0]?.value() ?? 0.25) * 4;
              const beamGroups = computeBeamNoteGroups(notes, staveNotes, pulseBeats, chordChangeBeats);
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
          // Triplet brackets aren't gated by `full` the way auto-beaming is —
          // a tupleted note's reduced beat cost (see noteBeats) is correct
          // whether or not the measure happens to be exactly full. VexFlow
          // defaults every Tuplet to LOCATION_TOP regardless of the notes'
          // own stem direction — reads wrong (bracket floating away from the
          // beam) whenever the group's stems point down (typically because
          // the notes sit high on the staff). Follow the beam/stems instead,
          // like real engraving: bracket below when stems are down.
          const tuplets = computeTupletGroups(notes, staveNotes).map((g) => {
            const stemsDown = g[0]?.getStemDirection() === Stem.DOWN;
            return new Tuplet(g, stemsDown ? { location: Tuplet.LOCATION_BOTTOM } : undefined);
          });

          // getAbsoluteX() is only meaningful once each note knows its stave
          // (Voice.draw sets this internally, but we need the formatted X now to
          // compute free-X shifts before drawing).
          staveNotes.forEach((sn) => sn.setStave(stave));

          // Free-X placement: shift each positioned note from its formatted spot
          // to the requested fraction of the note area.
          const centerXs: number[] = staveNotes.map((sn) => sn.getAbsoluteX());
          // The two piano clefs share one width, so the denser one governs how
          // much room a leading gap may take (same "denser clef wins" rule
          // measureContentWeight uses) — and both must resolve to the SAME gap,
          // or a treble note and its simultaneous bass note would stop lining
          // up vertically. The melody staff counts only its own notes (see
          // gapNoteCount). A grace note on the first note widens it just enough
          // to hold that grace note (see graceLeadReserve).
          const leadingGap = Math.max(leadingGapFor(noteAreaWidth, gapNoteCount), graceLeadReserve);
          {
            // VexFlow's own formatted/joinVoices spacing is NOT proportional
            // to duration (see #224 — a beat shared with the other clef's
            // longer note gets pulled much wider than one that isn't, a
            // visibly uneven "zigzag"). Override with a beat-weighted X
            // instead, from this staff's own map (see buildBeatWeightMap):
            // the two piano clefs share one, so a treble note and a
            // simultaneous bass note still land at the identical X, while the
            // melody staff — an independent part with its own rhythm — uses
            // its own and is under no obligation to line up with them. The map
            // only spans the furthest content written in EITHER clef (not
            // necessarily the full measure capacity), so a partially-written
            // measure's notes stretch across the whole available width
            // instead of being confined to a fraction of it — and rests are
            // compressed relative to real notes (see REST_WEIGHT) so a long
            // rest sitting between two short notes doesn't crowd them (see
            // #230). A note the user has explicitly dragged (free-X — see
            // notes[i].x) keeps that manual position instead, even once the
            // measure fills up and would otherwise auto-arrange (#241).
            const weightedAreaWidth = Math.max(0, noteAreaWidth - leadingGap - TRAILING_GAP_PX);
            let cumBeat = 0;
            staveNotes.forEach((sn, i) => {
              const fx = notes[i].x;
              const target =
                fx !== undefined
                  ? noteStartX + clamp01(fx) * noteAreaWidth
                  : noteStartX +
                    leadingGap +
                    clamp01(beatMap.total > 0 ? beatMap.weightAt(cumBeat) / beatMap.total : 0) * weightedAreaWidth;
              sn.setXShift(target - sn.getAbsoluteX());
              centerXs[i] = target;
              cumBeat += noteBeats(notes[i]);
            });
          }

          voice.draw(context, stave);
          beams.forEach((b) => b.setContext(context).draw());
          tuplets.forEach((t) => t.setContext(context).draw());

          // Leftmost accidental anchor X per note, filled in by the pass below
          // — a grace note has to be placed clear of its host's accidental,
          // not just its notehead (see graceHostLeftBound). null = no accidental.
          const accidentalAnchorXs: (number | null)[] = staveNotes.map(() => null);

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
            // 옥타브 표시 brackets are grouped and drawn at the very end, once
            // every note has a final position — same reason the tie curves are.
            // Pushed in the same play order, so consecutive entries really are
            // consecutive notes of that part.
            // The bracket has to clear the whole drawn note, not just its
            // noteheads — a tall up-stem or a flag reaches well past them, and
            // measuring noteheads alone printed the "8va" label straight
            // through the first note's stem. The bounding box covers stems,
            // flags, beams and ledger lines; noteheads are the fallback for
            // shapes it can't measure.
            let noteTop = Math.min(...ys);
            let noteBottom = Math.max(...ys);
            try {
              const bb = sn.getBoundingBox();
              noteTop = Math.min(noteTop, bb.getY());
              noteBottom = Math.max(noteBottom, bb.getY() + bb.getH());
            } catch {
              // Not measurable on this note shape — the notehead extents stand.
            }
            ottavaChains[clef].push({
              kind: note.ottava,
              rowIndex,
              x0: centerXs[i] - spacing * 0.7,
              x1: centerXs[i] + spacing * 0.7,
              minY: noteTop,
              maxY: noteBottom,
              topLineY: refY0 - 4 * spacing,
              bottomLineY: refY0,
            });
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
            // VexFlow reports a note's X as its notehead's LEFT EDGE, not the
            // middle of the glyph — `centerXs` (the drawing anchor) is that
            // left edge, which is what accidentals and ledger lines want. A
            // click target must not be: pointing at a note means pointing at
            // the middle of the round black head you can see, so every hitbox
            // X below is shifted to the glyph's true centre.
            //
            // Without this the whole ±NOTE_HIT_RADIUS window sat half a
            // notehead too far left, and a click aimed dead-centre at a note
            // could miss it while a click just off its left side hit — you had
            // to aim slightly left of whatever you wanted. Most visible at a
            // measure's left edge, where the misaimed click lands on the
            // barline/clef area instead of on a neighbouring note.
            let headGlyphWidth = 0;
            try {
              headGlyphWidth = sn.getGlyphWidth();
            } catch {
              // Unmeasurable glyph — leave the anchor at the left edge, as before.
            }
            // A chord containing a SECOND can't print both noteheads in one
            // column, so VexFlow shifts one of them a full notehead sideways,
            // toward the stem side. That head has to be clickable where it is
            // actually drawn, so its own X carries the same displacement.
            //
            // Derived from the note's base X rather than read off the head
            // itself: NoteHead.getAbsoluteX() applies the displacement a
            // SECOND time on top of the already-displaced position it stores
            // at draw time, reporting a displaced head one whole notehead
            // further out than it is drawn. That put the displaced head's
            // click target off the head entirely — it could not be grabbed at
            // all — which is the same trap the accidental placement below
            // documents and avoids in the same way.
            const stemDirection = (() => {
              try {
                return sn.getStemDirection() === Stem.DOWN ? -1 : 1;
              } catch {
                return 1;
              }
            })();
            const displacedHeads = (() => {
              try {
                const heads = (sn as unknown as { noteHeads?: { isDisplaced(): boolean }[] }).noteHeads;
                if (heads && heads.length === note.pitches.length) return heads.map((h) => h.isDisplaced());
              } catch {
                // Not measurable on this note shape — treat nothing as displaced.
              }
              return null;
            })();
            const xs = ys.map(
              (_, pitchIndex) =>
                centerXs[noteIndex] + (displacedHeads?.[pitchIndex] ? headGlyphWidth * stemDirection : 0) + headGlyphWidth / 2,
            );
            const hb: NoteHitbox = {
              measureIndex,
              clef,
              noteIndex,
              centerX: centerXs[noteIndex] + headGlyphWidth / 2,
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

              note.pitches.forEach((_pitch, pitchIndex) => {
                const degreeText = degreeLabels.get(`${clef}:${measureIndex}:${noteIndex}:${pitchIndex}`);
                if (degreeText) {
                  // Placed to the right of the notehead, like a numeric-keypad
                  // scale-degree entry sits next to the note it annotates —
                  // matches where fingering marks go (see FINGER_GAP below),
                  // just a bit further out so the two don't collide. Each
                  // pitch in a chord gets its own label at its own Y — a
                  // stacked voicing used to only ever compute/show one
                  // degree for the whole chord (the bottom pitch), leaving
                  // every other note in it unlabeled.
                  const markX = noteheadRightX + DEGREE_GAP;
                  const markY = ys[pitchIndex];
                  const markSelected =
                    !!isSelected &&
                    (selectedPitchIndexForClef === null || note.pitches.length === 1 || pitchIndex === selectedPitchIndexForClef);
                  degreeMarks.push({ x: markX, y: markY, text: degreeText, selected: markSelected });
                  degreeMarkHitboxes.push({ measureIndex, clef, noteIndex, pitchIndex, x: markX, y: markY, text: degreeText });
                }
              });

              const markColorFor = (pitchIndex: number): string | null => {
                if (!isSelected && !isPlaying) return null;
                const narrowed = isSelected && !isPlaying && selectedPitchIndexForClef !== null && note.pitches.length > 1;
                return narrowed ? (pitchIndex === selectedPitchIndexForClef ? '#d6432b' : null) : '#d6432b';
              };

              // Accidentals are drawn by hand rather than as VexFlow Accidental
              // modifiers (so they can be recolored along with their note), so
              // each one is placed just left of ITS OWN notehead. That single
              // rule is what makes them line up: noteheads in a chord almost
              // all share one x, so their accidentals land in one even column
              // at a uniform distance (#249). The exception carries its own
              // justification — a chord containing a SECOND has that notehead
              // displaced sideways by VexFlow, and its accidental simply
              // travels with it, which both keeps it off the displaced head
              // (#248) and reads as deliberate rather than scattered.
              //
              // Reading each head's own x is what makes this work; an earlier
              // pass anchored every accidental to the note's single base x
              // (drawing them through a displaced head) and then to the
              // leftmost head with a stagger (which pushed accidentals far
              // from the notes they belong to, and split chords stacked in
              // thirds that would have sat together perfectly well).
              // Every accidental hangs off ITS OWN notehead, so it always sits
              // the same short distance from the note it belongs to (#249).
              //
              // The subtlety is that a chord containing a SECOND can't print
              // both noteheads in one column, so VexFlow shifts one of them
              // sideways by exactly one notehead width — toward the stem side.
              // An accidental has to travel with its own head or it ends up
              // stranded far from its note (which is what a previous pass did
              // by anchoring every accidental to the chord's leftmost head).
              //
              // NoteHead.getAbsoluteX() is NOT usable for this: it reports the
              // displacement twice (a head that renders one width across is
              // reported two widths across), so the position is derived from
              // the note's own X plus the displacement flag instead.
              const displacedHeads = (() => {
                try {
                  const heads = (sn as unknown as { noteHeads?: { isDisplaced(): boolean }[] }).noteHeads;
                  if (heads && heads.length === note.pitches.length) return heads.map((h) => h.isDisplaced());
                } catch {
                  // Not measurable on this note shape — treat nothing as displaced.
                }
                return null;
              })();
              let headGlyphWidth = 0;
              try {
                headGlyphWidth = sn.getGlyphWidth();
              } catch {
                // Leaves every head at the note's base X, as before.
              }
              const stemDirection = sn.getStemDirection() === Stem.DOWN ? -1 : 1;
              // Accidentals belong to the LEFT of the whole chord — dropping
              // one into the gap between a displaced head and its neighbour
              // prints it straight over that neighbour's notehead. So the
              // column starts at the leftmost head, which is the base X unless
              // a down-stem chord pushed a displaced head one width left.
              const displacedLeft = stemDirection < 0 && !!displacedHeads?.some(Boolean);
              const accidentalBaseX = centerXs[noteIndex] - (displacedLeft ? headGlyphWidth : 0);
              // Then a single shared column, so they read as an even stack a
              // uniform short distance from the notes (#249). Only a pair
              // closer than one staff space — an actual SECOND — is pushed out
              // to a second column, since at half a space the two glyphs
              // genuinely print on top of each other. Thirds and wider share
              // the column cleanly, so an ordinary stacked chord stays exactly
              // aligned.
              const accidentalColumnWidth = spacing;
              const accidentalMinSeparation = spacing * 0.9;
              const columnYs: number[][] = [];
              note.pitches
                .map((pitch, pitchIndex) => ({ pitch, pitchIndex }))
                .filter(
                  ({ pitch, pitchIndex }) =>
                    !!pitch.accidental &&
                    !(hiddenNoteIndex === noteIndex && (hiddenPitchIndex === null || hiddenPitchIndex === pitchIndex)),
                )
                .sort((a, b) => ys[a.pitchIndex] - ys[b.pitchIndex])
                .forEach(({ pitch, pitchIndex }) => {
                  const y = ys[pitchIndex];
                  let column = columnYs.findIndex((taken) => taken.every((other) => Math.abs(other - y) >= accidentalMinSeparation));
                  if (column === -1) {
                    columnYs.push([]);
                    column = columnYs.length - 1;
                  }
                  columnYs[column].push(y);
                  const accidentalX = accidentalBaseX - column * accidentalColumnWidth;
                  accidentalAnchorXs[noteIndex] = Math.min(accidentalAnchorXs[noteIndex] ?? Infinity, accidentalX);
                  accidentalMarks.push({
                    x: accidentalX,
                    y,
                    type: pitch.accidental as Exclude<Accidental, ''>,
                    color: markColorFor(pitchIndex),
                  });
                });

              note.pitches.forEach((pitch, pitchIndex) => {
                if (hiddenNoteIndex === noteIndex && (hiddenPitchIndex === null || hiddenPitchIndex === pitchIndex)) return;
                if (pitch.finger === undefined) return;
                // Fingering sits to the right of the notehead — accidentals
                // no longer live there too, so no extra offset is needed.
                fingeringMarks.push({ x: noteheadRightX + FINGER_GAP, y: ys[pitchIndex], finger: pitch.finger, color: markColorFor(pitchIndex) });
              });
            }
          });

          // Grace notes go LAST, by hand, off each host's now-final geometry
          // (see drawGraceNote) — never as a modifier VexFlow positions for
          // us. It has to run after the accidental pass above, since a grace
          // note is placed clear of its host's accidental as well as its
          // notehead, and that pass is what measures where the accidental
          // landed. Hitboxes come straight from the same placement, so click
          // targets and drawn pixels can't disagree.
          graceNotes.forEach((gn, noteIndex) => {
            if (!gn) return;
            const g = notes[noteIndex].graceNote;
            const host = staveNotes[noteIndex];
            let placed: { x: number; y: number } | null = null;
            try {
              placed = drawGraceNote(
                context,
                stave,
                host,
                graceHostLeftBound(host.getNoteHeadBeginX(), accidentalAnchorXs[noteIndex]),
                gn,
                (g?.accidental || null) as Exclude<Accidental, ''> | null,
                { accidentals: accidentalMarks, slurs: graceSlurMarks },
              );
            } catch {
              // Host geometry unmeasurable — fall back to its nominal X below.
            }
            const gx = placed?.x ?? centerXs[noteIndex];
            const gy = placed?.y ?? (g ? refY0 - pitchToLine(clef, g.letter, g.octave) * spacing : refY0);
            graceNoteHitboxes.push({ measureIndex, clef, noteIndex, x: gx, y: gy });
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

      // Chord symbol band above the treble stave. Unlike lyrics (purely
      // decorative), a chord's `offset` also drives which one is "active" at
      // a given note for scale-degree labeling (see flattenChords in
      // scoreUtils, which treats offset as a fraction of the measure's BEAT
      // duration, i.e. of the note-content area only). Positioning the label
      // itself the same way — relative to noteStartX/noteAreaWidth rather
      // than the full stave span (which also includes the clef/key/time
      // glyphs on a row-starting measure) — keeps "where the chord visually
      // sits" and "which beat it's considered to start at" in the same
      // coordinate space, so a chord dragged to line up with a note actually
      // lines up with that note's beat too.
      const chordNoteAreaWidth = Math.max(40, x + measureWidth - NOTE_AREA_RIGHT_PAD - chordLeftBoundX);
      // A chord dropped exactly on a note (see StaffEditor's chord-drag snap)
      // stores an offset computed from that note's BEAT, which VexFlow's own
      // formatter doesn't necessarily lay out at a perfectly linear fraction
      // of the note area (accidentals, varying durations etc. can shift
      // things unevenly) — so recomputing its pixel X from the linear
      // formula alone can drift a few/several px off the actual notehead the
      // drag's live ghost/guide line showed (this is exactly what made a
      // chord like "Bb/F" read as pulled too far left of the notes it
      // labels). When the chord's beat exactly matches a real note's onset
      // (in either clef), use that note's own rendered x directly so the
      // committed position matches what was shown while dragging. Otherwise,
      // rather than falling straight back to the whole-measure linear
      // formula, interpolate between the nearest surrounding note onsets
      // proportional to the beat gap between them — this tracks VexFlow's own
      // (non-linear, duration-aware) spacing far more closely than a single
      // measure-wide straight line, since it only ever extrapolates across the
      // one local gap the chord actually falls within.
      //
      // Which staves' onsets are pooled follows which staff the chord band
      // actually sits above: in lead-sheet layout that is the melody staff
      // (an independent part, spaced by its own rhythm — see Measure.melody),
      // so pooling the piano's onsets there would line chords up with notes
      // that aren't under them. Otherwise it's both piano clefs.
      const measureDuration = measureDurationBeats(score, measureIndex);
      const chordAnchorParts: PartId[] = leadSheet ? ['melody'] : ['treble', 'bass'];
      const xForBeat = (targetBeat: number): number | null => {
        const EPS = 1e-3;
        const onsets: { beat: number; x: number }[] = [];
        for (const c of chordAnchorParts) {
          let beat = 0;
          const clefNotes = measure[c].notes;
          for (let i = 0; i < clefNotes.length; i++) {
            const hb = noteHitboxes.find((n) => n.measureIndex === measureIndex && n.clef === c && n.noteIndex === i);
            if (hb) {
              if (Math.abs(beat - targetBeat) < EPS) return hb.centerX;
              onsets.push({ beat, x: hb.centerX });
            }
            beat += noteBeats(clefNotes[i]);
          }
        }
        if (onsets.length === 0) return null;
        onsets.sort((a, b) => a.beat - b.beat);
        // Plain for-loop (not .forEach) so the running before/after picks
        // stay in this function's own scope rather than a nested closure —
        // TS can't carry narrowing on a `let` mutated from inside a callback,
        // which turned the later `before && after` check into a `never` type.
        let before: { beat: number; x: number } | null = null;
        let after: { beat: number; x: number } | null = null;
        for (const o of onsets) {
          if (o.beat < targetBeat && (!before || o.beat > before.beat)) before = o;
          if (o.beat > targetBeat && (!after || o.beat < after.beat)) after = o;
        }
        if (before && after) {
          const t = (targetBeat - before.beat) / (after.beat - before.beat);
          return before.x + t * (after.x - before.x);
        }
        return (before ?? after)?.x ?? null;
      };
      measure.chords.forEach((chord: ChordSymbol) => {
        const cx = xForBeat(chord.offset * measureDuration) ?? chordLeftBoundX + chord.offset * chordNoteAreaWidth;
        chordHitboxes.push({ measureIndex, chordId: chord.id, x: cx, y: chordY, halfWidth: 20 });
      });
      chordBandHitboxes.push({
        measureIndex,
        // The clickable "click here to add a chord" region still spans the
        // whole band (including the space above the clef) — only the
        // offset<->pixel mapping used for existing chords' positions changes.
        x0: x,
        x1: x + measureWidth,
        y0: chordY - 14,
        // Kept just above the staff's ledger-line click region even though the
        // chord now sits lower (CHORD_BAND_Y), so tapping just above the staff
        // to place a high note isn't swallowed by the chord band.
        y1: chordY + 3,
        measureX: chordLeftBoundX,
        measureWidth: chordNoteAreaWidth,
      });

      // Lyric syllables: below the standalone melody staff in lead-sheet
      // layout, or in the band between the two piano staves otherwise.
      // getYForLine(4) is the melody staff's own bottom line — computed from
      // the real Stave geometry (like midY below), not a hardcoded offset
      // from its constructor Y, since that Y sits up near the clef glyph's
      // top rather than the actual staff lines.
      //
      // In lead-sheet layout there's a wide dead zone between the melody
      // staff's own click region (which ends at its bottom line + margin)
      // and the piano treble staff's click region below (which starts at its
      // top line - margin) — MELODY_BLOCK_HEIGHT carves out room for it. The
      // band's clickable area spans that ENTIRE zone (not just a thin strip
      // around the text) so a click anywhere in the visually-empty gap opens
      // the lyric editor — a thin strip was too easy to miss entirely.
      const lyricBandTop = leadSheet && melodyStave ? melodyStave.getYForLine(4) + STAVE_TOP_MARGIN : midY - 5;
      const lyricBandBottom = leadSheet ? trebleStave.getYForLine(0) - STAVE_TOP_MARGIN : midY + 15;
      // Pushed further down from the melody staff's bottom line than before
      // (was +20, which sat close enough to catch descending stems/ledger
      // lines from low melody notes) — now centered in the gap carved out by
      // MELODY_BLOCK_HEIGHT so it clears the notes above without crowding
      // the piano treble staff below.
      const lyricY = leadSheet && melodyStave ? melodyStave.getYForLine(4) + 55 : midY + 5;
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
        y0: lyricBandTop,
        y1: lyricBandBottom,
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
  ALL_PARTS.forEach((clef) => {
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
    drawOttavaMarks(svg, ALL_PARTS.flatMap((part) => collectOttavaMarks(ottavaChains[part])));
    drawMeasureNumbers(svg, measureNumberMarks);
    drawAccidentalMarks(svg, accidentalMarks);
    drawGraceSlurs(svg, graceSlurMarks);
    drawFingeringMarks(svg, fingeringMarks);
    drawConnectStubs(svg, connectStubs);
    drawRestMarks(svg, restMarkHitboxes, restMarkHandleHitboxes);
    // 도수 입력 모드: push everything drawn so far (staves, noteheads, beams,
    // chord/lyric text, ...) into one dimmed group, THEN draw the degree
    // marks on top at full opacity/enlarged (see drawDegreeMarks' emphasize
    // param) — degreeMarks is intentionally excluded from the group since it
    // isn't appended until after this wrap.
    if (degreeInputMode) {
      const dimGroup = document.createElementNS(SVG_NS, 'g');
      dimGroup.setAttribute('class', 'degree-mode-dim');
      while (svg.firstChild) dimGroup.appendChild(svg.firstChild);
      svg.appendChild(dimGroup);
    }
    drawDegreeMarks(svg, degreeMarks, degreeInputMode);
  }

  return {
    noteHitboxes,
    staffHitboxes,
    chordHitboxes,
    chordBandHitboxes,
    graceNoteHitboxes,
    degreeMarkHitboxes,
    restMarkHitboxes,
    restMarkHandleHitboxes,
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


/** One note's contribution to an 옥타브 표시 bracket (see NoteEvent.ottava),
 * collected in play order so consecutive entries can be grouped into spans. */
interface OttavaChainEntry {
  /** undefined = this note carries no 옥타브 표시, so it ends any run. */
  kind: OttavaKind | undefined;
  rowIndex: number;
  /** Horizontal extent the bracket should cover for this note. */
  x0: number;
  x1: number;
  /** Top/bottom of the whole drawn note — stem and flag included — so the bracket clears it. */
  minY: number;
  maxY: number;
  topLineY: number;
  bottomLineY: number;
}

interface OttavaMark {
  kind: OttavaKind;
  x0: number;
  x1: number;
  /** Baseline of the "8va"/"8vb" text, and the height the dashed line runs at. */
  y: number;
}

/** Vertical clearance between the notes a bracket covers and the bracket itself. */
const OTTAVA_CLEARANCE = 16;
const OTTAVA_FONT_SIZE = 13;

/**
 * Groups a part's notes into 옥타브 표시 spans: consecutive notes carrying the
 * same kind become one bracket. A span is also cut at a row break, since a
 * bracket can't be drawn across the gap between two systems — each row gets
 * its own piece, which is what printed music does too.
 */
function collectOttavaMarks(chain: OttavaChainEntry[]): OttavaMark[] {
  const marks: OttavaMark[] = [];
  let run: OttavaChainEntry[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const kind = run[0].kind as OttavaKind;
    const above = kind === '8va';
    // Clear both the staff and whatever notes actually stick out of it.
    const y = above
      ? Math.min(...run.map((e) => Math.min(e.minY, e.topLineY))) - OTTAVA_CLEARANCE
      : Math.max(...run.map((e) => Math.max(e.maxY, e.bottomLineY))) + OTTAVA_CLEARANCE + OTTAVA_FONT_SIZE * 0.4;
    marks.push({ kind, x0: Math.min(...run.map((e) => e.x0)), x1: Math.max(...run.map((e) => e.x1)), y });
    run = [];
  };
  chain.forEach((entry) => {
    const continues = run.length > 0 && run[0].kind === entry.kind && run[run.length - 1].rowIndex === entry.rowIndex;
    if (!entry.kind) {
      flush();
      return;
    }
    if (!continues) flush();
    run.push(entry);
  });
  flush();
  return marks;
}

/**
 * The dashed 8va/8vb bracket: the label, a dashed line running from it to the
 * end of the span, and a short hook turning toward the staff to close it —
 * pointing down for 8va (which sits above) and up for 8vb (below).
 */
function drawOttavaMarks(svg: SVGSVGElement, marks: OttavaMark[]): void {
  marks.forEach((mark) => {
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', String(mark.x0));
    label.setAttribute('y', String(mark.y));
    label.setAttribute('font-size', String(OTTAVA_FONT_SIZE));
    label.setAttribute('font-family', CREDIT_FONT);
    label.setAttribute('font-style', 'italic');
    label.setAttribute('stroke', 'none');
    label.setAttribute('fill', '#333');
    label.textContent = mark.kind;
    svg.appendChild(label);

    // The dashed run starts clear of the label and stops at the span's end.
    const lineY = mark.y - OTTAVA_FONT_SIZE * 0.33;
    const lineStart = mark.x0 + OTTAVA_FONT_SIZE * 2.1;
    if (mark.x1 <= lineStart) return;
    const hookDir = mark.kind === '8va' ? 1 : -1;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', `M ${lineStart} ${lineY} H ${mark.x1} V ${lineY + hookDir * 6}`);
    path.setAttribute('stroke', '#333');
    path.setAttribute('stroke-width', '1.1');
    path.setAttribute('stroke-dasharray', '4 3');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);
  });
}

interface MeasureNumberMark {
  x: number;
  y: number;
  text: string;
}

/**
 * The bar number over each measure's left edge. Drawn small and pale (see
 * MEASURE_NUMBER_COLOR) — it is a place-finding aid, not something to read
 * while playing.
 *
 * A 못갖춘마디 (pickup) is left unnumbered and counting starts at 1 from the
 * first full measure, which is what printed music does: the pickup is an
 * upbeat into bar 1, not a bar of its own.
 */
function drawMeasureNumbers(svg: SVGSVGElement, marks: MeasureNumberMark[]): void {
  marks.forEach((mark) => {
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(mark.x));
    text.setAttribute('y', String(mark.y));
    text.setAttribute('font-size', String(MEASURE_NUMBER_FONT_SIZE));
    text.setAttribute('font-family', CREDIT_FONT);
    text.setAttribute('stroke', 'none');
    text.setAttribute('fill', MEASURE_NUMBER_COLOR);
    text.textContent = mark.text;
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
  clef: PartId;
  noteIndex: number;
}

export interface ClickResultAdd {
  type: 'add';
  measureIndex: number;
  clef: PartId;
  line: number;
}

export type ClickResult = ClickResultSelect | ClickResultAdd | null;

export function findStaffAt(result: RenderResult, x: number, y: number): StaffHitbox | null {
  return result.staffHitboxes.find((s) => x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1) ?? null;
}

function resolveClickOn(staff: StaffHitbox, noteHitboxes: NoteHitbox[], x: number, y: number): ClickResult {
  // A note is "hit" only near one of its noteheads (pitch-aware), so that
  // clicking clearly above or below a note falls through to an add preview.
  const yRadius = staff.spacing * 0.45;
  const hitNote = noteHitboxes.find(
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

export function resolveClick(result: RenderResult, x: number, y: number): ClickResult {
  const staff = findStaffAt(result, x, y);
  return staff ? resolveClickOn(staff, result.noteHitboxes, x, y) : null;
}

export function lineAt(staff: StaffHitbox, y: number): number {
  return (staff.refY0 - y) / staff.spacing;
}

/** Fractional (0..1) horizontal position of an X within a staff's free-placement note area. */
export function xFractionAt(staff: StaffHitbox, x: number): number {
  return Math.min(1, Math.max(0, (x - staff.noteStartX) / staff.noteAreaWidth));
}

/** Where a new note should be spliced into the staff's note list for a given click X. */
export function findInsertIndex(result: RenderResult, measureIndex: number, clef: PartId, x: number): number {
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

/** Click target for a grace note's own small notehead (see GraceNoteHitbox) —
 * checked before the host note's own hitbox so a click precisely on the
 * grace glyph selects IT, not its host. */
export function findGraceNoteAt(result: RenderResult, x: number, y: number): GraceNoteHitbox | null {
  // x-tolerance kept below GRACE_HOST_GAP_PX (see vexflowRenderer's grace-note
  // nudge) so this radius never reaches all the way to the host note's own
  // center — otherwise a click dead-center on the HOST would still fall
  // inside the grace note's zone and silently steal the click again.
  return result.graceNoteHitboxes.find((g) => Math.abs(g.x - x) < 5 && Math.abs(g.y - y) < 12) ?? null;
}

/**
 * Click target for an emphasized scale-degree digit in 도수 입력 모드 (see
 * DegreeMarkHitbox), so a click on one resolves to the exact note/pitch it
 * labels instead of falling through to whatever note is nearest underneath.
 *
 * A stacked chord's digits sit only ~10px apart vertically, so this has to be
 * precise on two counts (#246 — every click was landing on the digit BELOW
 * the one aimed at). The box is centered on where the digit is actually
 * drawn: `x + 6` is the middle of a start-anchored 1-2 character label, and
 * `y` is the notehead's own baseline that drawDegreeMarks draws against — the
 * old box sat 4px above that. And overlapping candidates are resolved by
 * distance rather than by array order, which is pitch order (lowest first)
 * and therefore always answered with the bottom-most digit of the stack.
 */
export function findDegreeMarkAt(result: RenderResult, x: number, y: number): DegreeMarkHitbox | null {
  let best: DegreeMarkHitbox | null = null;
  let bestDistance = Infinity;
  for (const d of result.degreeMarkHitboxes) {
    const dx = x - (d.x + 6);
    const dy = y - d.y;
    if (Math.abs(dx) > 11 || Math.abs(dy) > 6) continue;
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      best = d;
      bestDistance = distance;
    }
  }
  return best;
}

/** Click target for a visual-only rest mark (see RestMarkHitbox / #187) — select, drag-to-move, or right-click-delete. Tolerance scales with the mark's own visual size. */
export function findRestMarkAt(result: RenderResult, x: number, y: number): RestMarkHitbox | null {
  return result.restMarkHitboxes.find((r) => Math.abs(r.x - x) < 12 * r.scale && Math.abs(r.y - y) < 14 * r.scale) ?? null;
}

/** Click target for one of a selected rest mark's 4 corner drag handles (see RestMarkHandleHitbox). */
export function findRestMarkHandleAt(result: RenderResult, x: number, y: number): RestMarkHandleHitbox | null {
  return result.restMarkHandleHitboxes.find((h) => Math.abs(h.x - x) < 8 && Math.abs(h.y - y) < 8) ?? null;
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

/** All notes within a generous radius of a point, nearest first — used by note-select mode to pick the closest existing note to a tap. Searches both the real staves and the lead-sheet melody staff (see Score.showMelodyStaff), since either can be tapped. */
export function findNearbyNotesAt(result: RenderResult, x: number, y: number, radius: number): NoteHitbox[] {
  return result.noteHitboxes
    .map((n) => ({ n, d: Math.min(...n.ys.map((ny, i) => Math.hypot((n.xs[i] ?? n.centerX) - x, ny - y))) }))
    .filter(({ d }) => d < radius)
    .sort((a, b) => a.d - b.d)
    .map(({ n }) => n);
}
