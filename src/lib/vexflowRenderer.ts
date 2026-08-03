import {
  Accidental as VexAccidental,
  Beam,
  Curve,
  Dot,
  Formatter,
  GraceNote,
  GraceNoteGroup,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  StaveTie,
  Stem,
  Tuplet,
  Voice,
} from 'vexflow';
import type { Accidental, ChordSymbol, Clef, DurationValue, LyricSyllable, Measure, NoteEvent, NoteLocation, Score, TimeSignature } from '../types/score';
import {
  chordLabel,
  computeScaleDegreeLabels,
  computeScoreRows,
  deriveMelodyNotes,
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
/** Horizontal gap between an accidental glyph's right edge and the notehead's left edge. */
const ACCIDENTAL_GAP = 2;
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
 * `emphasize` (도수 입력 모드 — see renderScore's degreeInputMode) draws them
 * a bit larger with a pill background, since everything else on the staff
 * has just been dimmed behind them (see the dim-group wrap in renderScore)
 * and they're now the primary thing being edited — kept modest (not the
 * original 22px/15px-radius pass) so the pill doesn't balloon into a
 * neighboring note's own click area (see DegreeMarkHitbox / findDegreeMarkAt,
 * which now claims clicks in this radius explicitly regardless). */
function drawDegreeMarks(svg: SVGSVGElement, marks: DegreeMark[], emphasize = false): void {
  const fontSize = emphasize ? 15 : 12;
  marks.forEach((mark) => {
    const showSelected = emphasize && mark.selected;
    if (emphasize) {
      const bg = document.createElementNS(SVG_NS, 'circle');
      bg.setAttribute('cx', String(mark.x + 6));
      bg.setAttribute('cy', String(mark.y - 4));
      bg.setAttribute('r', '10');
      // A clicked/selected digit fills solid blue with white text instead of
      // the usual light-green outline pill — a click on the note itself gets
      // recolored red too, but that styling lands on the (dimmed-out) note,
      // not the digit, so it reads as almost nothing; the digit needs its
      // own unmistakable "this is the one I clicked" look.
      bg.setAttribute('fill', showSelected ? '#2563eb' : '#eafbea');
      bg.setAttribute('stroke', showSelected ? '#1d4ed8' : '#2f9e44');
      bg.setAttribute('stroke-width', showSelected ? '2' : '1.5');
      svg.appendChild(bg);
    }
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(mark.x));
    text.setAttribute('y', String(mark.y + 4));
    text.setAttribute('text-anchor', 'start');
    text.setAttribute('font-size', String(fontSize));
    text.setAttribute('font-family', "'Nanum Gothic', 'Malgun Gothic', sans-serif");
    text.setAttribute('font-weight', '700');
    text.setAttribute('stroke', 'none');
    text.setAttribute('fill', showSelected ? '#ffffff' : '#2f9e44');
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
const LEADING_GAP_FRACTION = 0.15;
const LEADING_GAP_MAX_PX = 40;
function leadingGapFor(noteAreaWidth: number): number {
  return Math.min(LEADING_GAP_MAX_PX, noteAreaWidth * LEADING_GAP_FRACTION);
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

  const weights = row.map((measureIndex, localIndex) => {
    if (localIndex === partialLocalIndex) return 0;
    const measure = score.measures[measureIndex];
    const timeSignature = measureTimeSignature(score, measureIndex);
    return measure ? measureContentWeight(measure, timeSignature) : fullMeasureWeight(timeSignature);
  });
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
    const scale = Math.min(1, weights[localIndex] / fullMeasureWeight(timeSignature));
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
/** How much closer (px) to pull a grace notehead toward its host than
 * VexFlow's own GraceNoteGroup spacing places it (see the graceNotes.forEach
 * XShift pass) — measured empirically against VexFlow's ~14px default gap to
 * land around 8px, tight but not touching. Must leave findGraceNoteAt's own
 * x-tolerance (see there) still smaller than the resulting gap. */
const GRACE_NUDGE_PX = 6;
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

/** Click target for the small grace-note head attached to a host note (see
 * NoteEvent.graceNote and attachGraceNote) — lets it be selected independently
 * of its host, for pitch/position edits and deletion (see StaffEditor). */
export interface GraceNoteHitbox {
  measureIndex: number;
  clef: Clef;
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
  clef: Clef;
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
  /**
   * The lead-sheet melody staff's own note hitboxes (see Score.showMelodyStaff)
   * — same identity (measureIndex/clef:'treble'/noteIndex) as the matching
   * entries in `noteHitboxes` since they're the same underlying treble notes,
   * just positioned at the melody staff's own on-screen geometry. Kept in a
   * separate array (rather than merged into noteHitboxes/staffHitboxes) so
   * every existing (measureIndex, clef) lookup elsewhere keeps resolving to
   * the real piano staff unambiguously; only the spatial click/hover
   * resolution in StaffEditor consults this one specifically. Empty when
   * showMelodyStaff is off.
   */
  melodyNoteHitboxes: NoteHitbox[];
  /** Mirrors melodyNoteHitboxes for the melody staff's own stave hit-region. */
  melodyStaffHitboxes: StaffHitbox[];
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

const REST_KEY: Record<Clef, string> = {
  treble: 'b/4',
  bass: 'd/3',
};

/** Attaches `note.graceNote` (see NoteEvent.graceNote) as a slashed,
 * slurred acciaccatura to `staveNote` — always engraved immediately to its
 * LEFT, matching how printed sheet music always shows a grace note leading
 * into the note it decorates (regardless of `position`, which only affects
 * playback timing — see playback.ts's isAfter — not which side it's drawn
 * on; VexFlow's own RIGHT placement for `position: 'after'` packed the grace
 * note within a couple pixels of its host, which both looked like an
 * overlapping smear and stole clicks meant for the host note, since the
 * grace-note hitbox is checked before the host's own). `isSelected` recolors
 * it red like a selected main note (see StaffEditor's grace-note selection).
 * Returns the created GraceNote so the caller can compute its hitbox once
 * the voice is drawn (its position isn't resolved until then), or null if
 * there was none. */
function attachGraceNote(staveNote: StaveNote, note: NoteEvent, clef: Clef, isSelected: boolean): GraceNote | null {
  if (!note.graceNote || note.isRest) return null;
  const g = note.graceNote;
  const graceStaveNote = new GraceNote({
    clef,
    keys: [pitchToVexKey({ letter: g.letter, accidental: g.accidental ?? '', octave: g.octave })],
    duration: g.duration ?? '8',
    slash: true,
  });
  if (g.accidental) graceStaveNote.addModifier(new VexAccidental(g.accidental), 0);
  if (isSelected) {
    graceStaveNote.setStyle({ fillStyle: '#d6432b', strokeStyle: '#d6432b' });
    graceStaveNote.setLedgerLineStyle({ fillStyle: '#d6432b', strokeStyle: '#d6432b' });
  }
  // showSlur=true draws VexFlow's own curve from the grace note to its host —
  // real engraving, always on, matching the standard convention that a grace
  // note is always slurred to the note it decorates. Position is left at
  // GraceNoteGroup's own default (Modifier.Position.LEFT) — see the doc
  // comment above for why 'after' no longer moves it to the right.
  const group = new GraceNoteGroup([graceStaveNote], true).beamNotes();
  staveNote.addModifier(group, 0);
  return graceStaveNote;
}

function buildStaveNotes(
  clef: Clef,
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
      clef,
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
    graceNotes.push(attachGraceNote(staveNote, note, clef, isGraceSelected));

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

/**
 * Builds StaveNotes for the lead-sheet melody staff (see Score.showMelodyStaff
 * / deriveMelodyNotes) — a simplified version of buildStaveNotes without
 * playback/selection styling (the melody staff never plays back or holds an
 * independent selection — edits always target the treble staff's own note),
 * but it DOES support hiding the note currently being dragged, since a click
 * on this staff can now start that same drag (see StaffEditor's melody-staff
 * interaction handling). Accidentals are attached as real VexFlow modifiers
 * here (unlike the treble/bass staves' manual text-based accidentals)
 * because there's no free-X dragging on this staff to keep stable — VexFlow's
 * own modifier layout is simpler and fine.
 */
function buildMelodyStaveNotes(notes: NoteEvent[], hiddenNoteIndex: number | null): StaveNote[] {
  return notes.map((note, noteIndex) => {
    const keys = note.isRest ? [REST_KEY.treble] : note.pitches.map(pitchToVexKey);
    const staveNote = new StaveNote({ clef: 'treble', keys, duration: vexDurationString(note), autoStem: true });
    if (note.dotted) Dot.buildAndAttach([staveNote], note.isRest ? { index: 0 } : { all: true });
    if (!note.isRest && note.pitches[0]?.accidental) {
      staveNote.addModifier(new VexAccidental(note.pitches[0].accidental), 0);
    }
    attachGraceNote(staveNote, note, 'treble', false);
    if (hiddenNoteIndex === noteIndex) {
      staveNote.setStyle({ fillStyle: 'transparent', strokeStyle: 'transparent' });
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
  playingLocations?: { treble: NoteLocation | null; bass: NoteLocation | null } | null,
  selectedPitchIndex?: number | null,
  selectedGrace?: NoteLocation | null,
  /** Currently-selected rest mark (see RestMark / #187) — draws its 4 corner handles. */
  selectedRestMark?: { measureIndex: number; restMarkId: string } | null,
  /** 도수 입력 모드 (see App's degreeInputMode): dims every other rendered
   * element and enlarges the scale-degree marks so they read as the primary
   * focus while entering/deleting them (see the dim-group wrap below and
   * drawDegreeMarks' `emphasize` param). */
  degreeInputMode?: boolean,
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
  const melodyNoteHitboxes: NoteHitbox[] = [];
  const melodyStaffHitboxes: StaffHitbox[] = [];
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
  const fingeringMarks: FingeringMark[] = [];
  const degreeMarks: DegreeMark[] = [];
  const degreeLabels = computeScaleDegreeLabels(score);
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
      // A grace note (꾸밈음) attached to the FIRST note of a measure has
      // nowhere to sit but immediately at noteStartX — VexFlow's own stave
      // width calc reserves room for the clef/key/time glyphs but not for a
      // leading grace note squeezed in right after them, so it rendered
      // flush against (sometimes overlapping) those glyphs. Give it its own
      // breathing room whenever either staff's first note carries one. Grace
      // notes always draw on the left of their host now (see attachGraceNote),
      // so this applies regardless of the note's `position` field.
      const hasLeadingGraceNote = (['treble', 'bass'] as Clef[]).some((c) => !!measure[c].notes[0]?.graceNote);
      // A grace note's GraceNoteGroup modifier is positioned relative to its
      // host's tick-context X, computed once during the initial joinVoices
      // format() pass below — it does NOT track any further per-note
      // setXShift override applied afterward (see the beat-proportional
      // override further down, for #224). Overriding a grace-bearing note's
      // X without also being able to reliably relocate its grace note left
      // it detached/overlapping its host, so measures with any grace note
      // skip that override entirely and keep VexFlow's own joinVoices
      // layout, which already keeps a grace note correctly glued to its host.
      const measureHasGrace = (['treble', 'bass'] as Clef[]).some((c) => measure[c].notes.some((n) => !!n.graceNote));
      // Shared by BOTH clefs' beat-weighted positioning below (see
      // buildBeatWeightMap) so a treble note and a simultaneous bass note
      // land at the identical X regardless of how many rests either clef
      // has elsewhere in the measure.
      const grandStaffBeatMap = buildBeatWeightMap([measure.treble.notes, measure.bass.notes]);
      const sharedNoteStartX = Math.max(trebleStave.getNoteStartX(), bassStave.getNoteStartX()) + (hasLeadingGraceNote ? 18 : 0);
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
        // Mirrors the same leading-grace-note breathing room as the piano
        // staves above (see hasLeadingGraceNote) — the melody staff shows the
        // same treble notes (see deriveMelodyNotes), so it needs the same fix.
        if (hasLeadingGraceNote) melodyStave.setNoteStartX(melodyStave.getNoteStartX() + 18);
        melodyStave.setContext(context).draw();

        // The melody staff mirrors measure.treble.notes index-for-index (see
        // deriveMelodyNotes), so its own note/staff hitboxes carry the SAME
        // (measureIndex, clef:'treble', noteIndex) identity as the real
        // treble hitboxes below — clicking/dragging here (see StaffEditor)
        // resolves through these first and writes back to that same treble
        // data, keeping both staves in sync without a separate data model.
        const melodyNotes = deriveMelodyNotes(measure.treble.notes);
        const melodyHiddenNoteIndex =
          draggingNote && draggingNote.measureIndex === measureIndex && draggingNote.clef === 'treble'
            ? draggingNote.noteIndex
            : null;
        const melodyStaveNotes = buildMelodyStaveNotes(melodyNotes, melodyHiddenNoteIndex);
        const melodyRefY0 = melodyStave.getYForNote(0);
        const melodySpacing = melodyRefY0 - melodyStave.getYForNote(1);
        const melodyNoteStartX = melodyStave.getNoteStartX();
        const melodyNoteAreaWidth = Math.max(40, melodyStave.getX() + melodyStave.getWidth() - NOTE_AREA_RIGHT_PAD - melodyNoteStartX);
        const melodyFull = isStaffMeasureFull({ notes: measure.treble.notes }, effectiveTimeSignature);

        if (melodyStaveNotes.length > 0) {
          const melodyVoice = new Voice({ numBeats: capacity, beatValue: 4 }).setStrict(false);
          melodyVoice.addTickables(melodyStaveNotes);
          new Formatter().joinVoices([melodyVoice]).format([melodyVoice], measureWidth - (isRowStart ? 108 : 28));

          melodyStaveNotes.forEach((sn) => sn.setStave(melodyStave!));
          // Mirrors the treble staff's free-X placement below (melodyNotes[i].x
          // carries over from the treble note it was derived from), so the two
          // staves' X positions — and thus chord-merge/insert-index detection,
          // which reads the treble noteHitboxes by X — line up for a click on
          // either staff.
          const melodyCenterXs: number[] = melodyStaveNotes.map((sn) => sn.getAbsoluteX());
          if (!melodyFull) {
            melodyStaveNotes.forEach((sn, i) => {
              const fx = melodyNotes[i].x;
              if (fx === undefined) return;
              const desiredX = melodyNoteStartX + clamp01(fx) * melodyNoteAreaWidth;
              sn.setXShift(desiredX - sn.getAbsoluteX());
              melodyCenterXs[i] = desiredX;
            });
          } else {
            // Same beat-weighted override as the treble/bass staves below
            // (see #224, #230) — keeps note spacing proportional to duration
            // (stretched across the whole written content, with rests
            // compressed) instead of VexFlow's own uneven tick-context widths.
            const melodyMap = buildBeatWeightMap([melodyNotes]);
            const melodyLeadingGap = leadingGapFor(melodyNoteAreaWidth);
            const melodyWeightedAreaWidth = Math.max(0, melodyNoteAreaWidth - melodyLeadingGap - TRAILING_GAP_PX);
            let melodyCumBeat = 0;
            melodyStaveNotes.forEach((sn, i) => {
              const desiredX =
                melodyNoteStartX +
                melodyLeadingGap +
                clamp01(melodyMap.total > 0 ? melodyMap.weightAt(melodyCumBeat) / melodyMap.total : 0) * melodyWeightedAreaWidth;
              sn.setXShift(desiredX - sn.getAbsoluteX());
              melodyCenterXs[i] = desiredX;
              melodyCumBeat += noteBeats(melodyNotes[i]);
            });
          }

          // Beams must be built BEFORE the voice is drawn — same reasoning as
          // the treble/bass staves below: creating a Beam marks its notes so
          // they skip drawing their own individual flag. Building it after
          // voice.draw() left every note showing its own flag (the beam
          // can't retroactively suppress glyphs already drawn) — the melody
          // staff's 16th/8th-note runs never looked beamed at all. Only beam
          // once the measure is full (free-placed notes' arbitrary X spacing
          // would produce misshapen beams) — same gating as the treble/bass
          // staves below.
          let melodyBeams: Beam[] = [];
          if (melodyFull) {
            try {
              const defaultGroups = Beam.getDefaultBeamGroups(`${effectiveTimeSignature.numerator}/${effectiveTimeSignature.denominator}`);
              const pulseBeats = (defaultGroups[0]?.value() ?? 0.25) * 4;
              const beamGroups = computeBeamNoteGroups(melodyNotes, melodyStaveNotes, pulseBeats, chordChangeBeats);
              melodyBeams = beamGroups.map((group) => new Beam(group, true));
            } catch {
              // Beaming is a visual nicety; ignore failures on unusual groupings.
            }
          }
          // Triplet brackets aren't gated by `full` the way auto-beaming is —
          // a tupleted note's reduced beat cost (see noteBeats) is correct
          // whether or not the measure happens to be exactly full.
          const melodyTuplets = computeTupletGroups(melodyNotes, melodyStaveNotes).map((g) => {
            const stemsDown = g[0]?.getStemDirection() === Stem.DOWN;
            return new Tuplet(g, stemsDown ? { location: Tuplet.LOCATION_BOTTOM } : undefined);
          });
          melodyVoice.draw(context, melodyStave);
          melodyBeams.forEach((b) => b.setContext(context).draw());
          melodyTuplets.forEach((t) => t.setContext(context).draw());

          melodyStaveNotes.forEach((sn, noteIndex) => {
            const note = melodyNotes[noteIndex];
            const ys = note.isRest
              ? [melodyRefY0 - 3 * melodySpacing]
              : note.pitches.map((p) => melodyRefY0 - pitchToLine('treble', p.letter, p.octave) * melodySpacing);
            let stemX = melodyCenterXs[noteIndex];
            if (!note.isRest) {
              try {
                stemX = sn.getStemX();
              } catch {
                // Some note shapes (e.g. single whole notes) have no stem; fall back to centerX.
              }
            }
            const xs = ys.map((_, pitchIndex) => {
              try {
                return sn.noteHeads[pitchIndex]?.getAbsoluteX() ?? melodyCenterXs[noteIndex];
              } catch {
                return melodyCenterXs[noteIndex];
              }
            });
            melodyNoteHitboxes.push({
              measureIndex,
              clef: 'treble',
              noteIndex,
              centerX: melodyCenterXs[noteIndex],
              stemX,
              ys,
              xs,
            });
          });
        }

        const melodyContentStartOffset = isRowStart ? 100 : 20;
        melodyStaffHitboxes.push({
          measureIndex,
          clef: 'treble',
          x0: x,
          x1: x + measureWidth,
          y0: melodyStave.getYForLine(0) - STAVE_TOP_MARGIN,
          y1: melodyStave.getYForLine(4) + STAVE_TOP_MARGIN,
          refY0: melodyRefY0,
          spacing: melodySpacing,
          contentX0: x + melodyContentStartOffset,
          contentWidth: measureWidth - melodyContentStartOffset,
          noteStartX: melodyNoteStartX,
          noteAreaWidth: melodyNoteAreaWidth,
          full: melodyFull,
        });
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

      const clefEntries = ([
        ['treble', trebleStave, measure.treble.notes, trebleStave.getYForLine(0) - STAVE_TOP_MARGIN, midY],
        ['bass', bassStave, measure.bass.notes, midY, bassStave.getYForLine(4) + STAVE_TOP_MARGIN],
      ] as const).map(([clef, stave, notes, y0, y1]) => {
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
        // Once a measure is full it auto-formats (free X positions ignored) so
        // the score tidies itself; until then notes sit where they were placed.
        const full = isStaffMeasureFull({ notes }, effectiveTimeSignature);

        (measure.restMarks ?? []).filter((r) => r.clef === clef).forEach((r) => {
          const scale = r.scale ?? 1;
          const isSelected = !!selectedRestMark && selectedRestMark.measureIndex === measureIndex && selectedRestMark.restMarkId === r.id;
          const markX = x + r.offset * measureWidth;
          const markY = refY0 - r.line * spacing;
          restMarkHitboxes.push({
            measureIndex,
            clef,
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
                clef,
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

        return { clef, stave, notes, y0, y1, staveNotes, graceNotes, hiddenNoteIndex, playingNoteIndex, hiddenPitchIndex, selectedPitchIndexForClef, refY0, spacing, noteStartX, noteAreaWidth, full, voice };
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

      clefEntries.forEach(({ clef, stave, notes, y0, y1, staveNotes, graceNotes, hiddenNoteIndex, playingNoteIndex, hiddenPitchIndex, selectedPitchIndexForClef, refY0, spacing, noteStartX, noteAreaWidth, full, voice }) => {
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
          // How far each note was pushed by the overrides below — a grace
          // note's own X is computed from its host's PRE-override tick
          // context position (not the host's final getAbsoluteX()), so
          // moving the host without also moving its grace note by the same
          // amount leaves the grace note behind at its old spot, sometimes
          // landing to the RIGHT of the host that moved past it. Applied to
          // the grace note's own xShift below (in addition to GRACE_NUDGE_PX).
          const hostShiftDeltas: number[] = staveNotes.map(() => 0);
          if (measureHasGrace) {
            // Measures with a grace note anywhere keep the OLD behavior
            // (manual free-X drag honored, otherwise VexFlow's own natural
            // position left untouched) instead of the beat-proportional
            // override below: a GraceNoteGroup's position is computed once,
            // relative to its host's PRE-override tick-context X, during the
            // initial joinVoices format() call above — pushing its host note
            // any further than a small nudge (see GRACE_NUDGE_PX) leaves the
            // grace note behind at its old spot, even detached to the RIGHT
            // of a host that moved past it (confirmed empirically: even
            // re-applying the exact same shift to the grace note's own
            // xShift afterward did not track a large host move — VexFlow
            // silently ignores/clamps it, unlike the small fixed nudge which
            // does work). Correct grand-staff alignment for a grace-bearing
            // note (#220) is worth more than perfectly even spacing here.
            if (!full) {
              staveNotes.forEach((sn, i) => {
                const fx = notes[i].x;
                if (fx === undefined) return;
                const target = noteStartX + clamp01(fx) * noteAreaWidth;
                const shift = target - sn.getAbsoluteX();
                sn.setXShift(shift);
                centerXs[i] = target;
                hostShiftDeltas[i] = shift;
              });
            }
          } else {
            // VexFlow's own formatted/joinVoices spacing is NOT proportional
            // to duration (see #224 — a beat shared with the other clef's
            // longer note gets pulled much wider than one that isn't, a
            // visibly uneven "zigzag"). Override with a beat-weighted X
            // instead, using the SAME shared map both clefs consult (see
            // grandStaffBeatMap/buildBeatWeightMap) so a treble note and a
            // simultaneous bass note still land at the identical X. The map
            // only spans the furthest content written in EITHER clef (not
            // necessarily the full measure capacity), so a partially-written
            // measure's notes stretch across the whole available width
            // instead of being confined to a fraction of it — and rests are
            // compressed relative to real notes (see REST_WEIGHT) so a long
            // rest sitting between two short notes doesn't crowd them (see
            // #230). A note the user has explicitly dragged (free-X, only
            // possible while the measure isn't full — see notes[i].x) keeps
            // that manual position instead.
            const leadingGap = leadingGapFor(noteAreaWidth);
            const weightedAreaWidth = Math.max(0, noteAreaWidth - leadingGap - TRAILING_GAP_PX);
            let cumBeat = 0;
            staveNotes.forEach((sn, i) => {
              const fx = !full ? notes[i].x : undefined;
              const target =
                fx !== undefined
                  ? noteStartX + clamp01(fx) * noteAreaWidth
                  : noteStartX +
                    leadingGap +
                    clamp01(grandStaffBeatMap.total > 0 ? grandStaffBeatMap.weightAt(cumBeat) / grandStaffBeatMap.total : 0) * weightedAreaWidth;
              const shift = target - sn.getAbsoluteX();
              sn.setXShift(shift);
              centerXs[i] = target;
              hostShiftDeltas[i] = shift;
              cumBeat += noteBeats(notes[i]);
            });
          }

          // VexFlow's own GraceNoteGroup spacing leaves a wider gap (~14px)
          // than how a grace note usually engraves — nearly touching its
          // host. Pull it in by a fixed amount rather than fight VexFlow's
          // internal metrics directly. This has to be a FIXED nudge, not one
          // computed from the grace note's current getAbsoluteX(): the grace
          // note's position isn't actually resolved yet at this point (it's
          // set during the GraceNoteGroup modifier's own draw, inside
          // voice.draw() below) — reading it now returned a stale/unrelated
          // value and shifted grace notes wildly off, next to entirely
          // different notes. GRACE_NUDGE_PX must leave the final gap bigger
          // than findGraceNoteAt's own x-tolerance (see there) so a click
          // dead-center on the HOST note still falls outside the grace
          // note's hit radius — shrinking the gap without also shrinking
          // that radius is exactly what caused the grace note to silently
          // steal host clicks last time.
          graceNotes.forEach((gn, i) => {
            if (!gn) return;
            // A GraceNoteGroup positions itself from its host's PRE-override
            // tick-context X, not the host's final getAbsoluteX() — so it
            // doesn't automatically follow the host/free-X and beat-proportional
            // overrides above. Without re-applying the same delta here, the
            // grace note stays glued to where the host WOULD have been,
            // which can even land it to the right of the host after a large
            // override (see #224's beat-proportional rewrite). Grace notes
            // sit to the LEFT of their host (smaller x) — moving one CLOSER
            // to its host means increasing its x (adding, not subtracting).
            gn.setXShift(gn.getXShift() + hostShiftDeltas[i] + GRACE_NUDGE_PX);
          });

          voice.draw(context, stave);
          beams.forEach((b) => b.setContext(context).draw());
          tuplets.forEach((t) => t.setContext(context).draw());

          // Grace note hitboxes: only resolvable now that the host note (and
          // therefore its attached GraceNoteGroup modifier) has an actual
          // drawn position — see attachGraceNote/StaffEditor's grace-note
          // selection.
          graceNotes.forEach((gn, noteIndex) => {
            if (!gn) return;
            const g = notes[noteIndex].graceNote;
            let gx = centerXs[noteIndex];
            try {
              gx = gn.getAbsoluteX();
            } catch {
              // Fall back to the host note's own position if geometry isn't measurable.
            }
            const gy = g ? refY0 - pitchToLine(clef, g.letter, g.octave) * spacing : refY0;
            graceNoteHitboxes.push({ measureIndex, clef, noteIndex, x: gx, y: gy });
          });

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
      const chordNoteAreaWidth = Math.max(40, x + measureWidth - NOTE_AREA_RIGHT_PAD - sharedNoteStartX);
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
      // (pooled across both clefs) proportional to the beat gap between
      // them — this tracks VexFlow's own (non-linear, duration-aware)
      // spacing far more closely than a single measure-wide straight line,
      // since it only ever extrapolates across the one local gap the chord
      // actually falls within.
      const measureDuration = measureDurationBeats(score, measureIndex);
      const xForBeat = (targetBeat: number): number | null => {
        const EPS = 1e-3;
        const onsets: { beat: number; x: number }[] = [];
        for (const c of ['treble', 'bass'] as Clef[]) {
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
        const cx = xForBeat(chord.offset * measureDuration) ?? sharedNoteStartX + chord.offset * chordNoteAreaWidth;
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
        measureX: sharedNoteStartX,
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
    melodyNoteHitboxes,
    melodyStaffHitboxes,
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

/** Like findStaffAt, but also matches the lead-sheet melody staff (see Score.showMelodyStaff) — for click/hover resolution, which should work on either staff. Kept separate from findStaffAt itself so its many other (measureIndex, clef) callers keep resolving to the real piano staff unambiguously. */
export function findAnyStaffAt(result: RenderResult, x: number, y: number): StaffHitbox | null {
  return findStaffAt(result, x, y) ?? result.melodyStaffHitboxes.find((s) => x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1) ?? null;
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
  if (staff) return resolveClickOn(staff, result.noteHitboxes, x, y);

  const melodyStaff = result.melodyStaffHitboxes.find((s) => x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1);
  if (melodyStaff) return resolveClickOn(melodyStaff, result.melodyNoteHitboxes, x, y);

  return null;
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

/** Click target for an emphasized scale-degree digit in 도수 입력 모드 (see
 * DegreeMarkHitbox) — matches the enlarged pill's own on-screen circle
 * (centered a bit right/up of the mark's anchor, see drawDegreeMarks), so a
 * click on the digit resolves to the exact note/pitch it labels instead of
 * falling through to whatever note happens to be nearest underneath. */
export function findDegreeMarkAt(result: RenderResult, x: number, y: number): DegreeMarkHitbox | null {
  return result.degreeMarkHitboxes.find((d) => Math.hypot(d.x + 6 - x, d.y - 4 - y) < 13) ?? null;
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
  return [...result.noteHitboxes, ...result.melodyNoteHitboxes]
    .map((n) => ({ n, d: Math.min(...n.ys.map((ny, i) => Math.hypot((n.xs[i] ?? n.centerX) - x, ny - y))) }))
    .filter(({ d }) => d < radius)
    .sort((a, b) => a.d - b.d)
    .map(({ n }) => n);
}
