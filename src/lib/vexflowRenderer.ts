import {
  Accidental as VexAccidental,
  Beam,
  Curve,
  Dot,
  Formatter,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  StaveTie,
  Voice,
} from 'vexflow';
import type { ChordSymbol, Clef, LyricSyllable, NoteEvent, NoteLocation, Score } from '../types/score';
import {
  chordLabel,
  computeRows,
  isStaffMeasureFull,
  isStaffMeasureOverflow,
  measureCapacityBeats,
  noteConnects,
  pitchToLine,
  pitchToVexKey,
  vexDurationString,
} from './scoreUtils';

/** Right-hand padding kept clear of notes inside a measure, for free-X mapping. */
const NOTE_AREA_RIGHT_PAD = 16;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const FIRST_MEASURE_WIDTH = 300;
const MEASURE_WIDTH = 220;
const ROW_HEIGHT = 320;
const CHORD_BAND_Y = 78;
const TREBLE_Y = 60;
const BASS_Y = 185;
const STAVE_TOP_MARGIN = 40;
const NOTE_HIT_RADIUS = 16;
export const MEASURES_PER_ROW = 4;
/** Vertical space reserved at the very top for the centered title, always shown (even a click-to-edit placeholder). */
const TITLE_BAND = 48;
/** Vertical space reserved at the bottom for the composer credit, right-aligned like the title. */
const COMPOSER_BAND = 34;
const OVERFLOW_MARK_RADIUS = 8;
/** Extra slack added to the overflow marker's hit-test so a small marker is still easy to hover/tap. */
const OVERFLOW_HIT_SLACK = 8;
const CONNECT_HANDLE_RADIUS = 7;
const CONNECT_HANDLE_HIT_SLACK = 8;
/** Offset of the connector handle from the selected note's topmost pitch. */
const CONNECT_HANDLE_DX = 15;
const CONNECT_HANDLE_DY = 16;

/** Font stacks for the printed-score text elements, matching a typical published lead sheet. */
const TITLE_FONT = "'Noto Serif KR', Batang, serif";
const CREDIT_FONT = "'Noto Sans KR', 'Malgun Gothic', sans-serif";
const CHORD_FONT = "'Times New Roman', Times, serif";
const LYRIC_FONT = "'Noto Sans KR', 'Malgun Gothic', sans-serif";
const PLACEHOLDER_COLOR = '#b8b8c2';

export interface NoteHitbox {
  measureIndex: number;
  clef: Clef;
  noteIndex: number;
  centerX: number;
  /** Y of each notehead (a chord has several), for pitch-aware click hit-testing. */
  ys: number[];
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

export interface OverflowHitbox {
  measureIndex: number;
  x: number;
  y: number;
  radius: number;
}

/** Small draggable handle shown on the selected note, for connecting it to an arbitrary other note. */
export interface ConnectHandle {
  measureIndex: number;
  clef: Clef;
  noteIndex: number;
  x: number;
  y: number;
  radius: number;
}

export interface RenderResult {
  noteHitboxes: NoteHitbox[];
  staffHitboxes: StaffHitbox[];
  chordHitboxes: ChordHitbox[];
  chordBandHitboxes: ChordBandHitbox[];
  lineBreakHitboxes: LineBreakHitbox[];
  lyricHitboxes: LyricHitbox[];
  lyricBandHitboxes: LyricBandHitbox[];
  overflowHitboxes: OverflowHitbox[];
  connectHandle: ConnectHandle | null;
  titleHitbox: TitleHitbox;
  composerHitbox: ComposerHitbox;
  width: number;
  height: number;
}

const REST_KEY: Record<Clef, string> = {
  treble: 'b/4',
  bass: 'd/3',
};

function pitchesMatch(a: NoteEvent, b: NoteEvent): boolean {
  if (a.pitches.length !== b.pitches.length) return false;
  const aKeys = a.pitches.map(pitchToVexKey).sort();
  const bKeys = b.pitches.map(pitchToVexKey).sort();
  return aKeys.every((k, i) => k === bKeys[i]);
}

function buildStaveNotes(
  clef: Clef,
  measureIndex: number,
  notes: NoteEvent[],
  selected: NoteLocation | null,
  hiddenNoteIndex: number | null,
  playingNoteIndex: number | null,
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

    if (!note.isRest) {
      note.pitches.forEach((pitch, i) => {
        if (pitch.accidental) {
          staveNote.addModifier(new VexAccidental(pitch.accidental), i);
        }
      });
    }

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
      staveNote.setStyle({ fillStyle: '#d6432b', strokeStyle: '#d6432b' });
    }
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
}

export function renderScore(
  container: HTMLDivElement,
  score: Score,
  selected: NoteLocation | null,
  draggingNote: DraggingNote | null,
  playingLocations?: { treble: NoteLocation | null; bass: NoteLocation | null } | null,
): RenderResult {
  // While playing, the sounding note is recolored instead of any selection —
  // so a prior selection doesn't also show red at the same time.
  const effectiveSelected = playingLocations ? null : selected;
  container.innerHTML = '';

  const rows = computeRows(score.measures.length, score.lineBreaks, MEASURES_PER_ROW);

  const rowWidths = rows.map((row) =>
    row.reduce((sum, _, localIndex) => sum + (localIndex === 0 ? FIRST_MEASURE_WIDTH : MEASURE_WIDTH), 20),
  );
  const width = Math.max(...rowWidths, FIRST_MEASURE_WIDTH + 20);
  const titleBand = TITLE_BAND;
  const height = rows.length * ROW_HEIGHT + titleBand + COMPOSER_BAND;

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
  const overflowHitboxes: OverflowHitbox[] = [];

  const capacity = measureCapacityBeats(score.timeSignature);

  // Flat, in-order chain of every rendered note per staff (spanning measures
  // and rows), used after the layout pass to connect ties/slurs between
  // consecutive notes — including across a barline or a line break.
  const noteChain: Record<Clef, { event: NoteEvent; staveNote: StaveNote }[]> = { treble: [], bass: [] };
  // Every note by id (any clef/measure), for connections dragged onto an
  // arbitrary target rather than just "the next note".
  const noteById = new Map<string, { event: NoteEvent; staveNote: StaveNote }>();

  rows.forEach((row, rowIndex) => {
    const rowY = rowIndex * ROW_HEIGHT + titleBand;
    const chordY = rowY + CHORD_BAND_Y;
    const trebleY = rowY + TREBLE_Y;
    const bassY = rowY + BASS_Y;

    let x = 10;
    row.forEach((measureIndex, localIndex) => {
      const measure = score.measures[measureIndex];
      const isRowStart = localIndex === 0;
      const isPieceStart = measureIndex === 0;
      const isLastMeasure = measureIndex === score.measures.length - 1;
      const measureWidth = isRowStart ? FIRST_MEASURE_WIDTH : MEASURE_WIDTH;

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
        const staveNotes = buildStaveNotes(clef, measureIndex, notes, effectiveSelected, hiddenNoteIndex, playingNoteIndex);

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
              const beamable = staveNotes.filter((n) => !n.isRest());
              beams = Beam.generateBeams(beamable);
            } catch {
              // Beaming is a visual nicety; ignore failures on unusual groupings.
            }
          }

          new Formatter().joinVoices([voice]).format([voice], measureWidth - (isRowStart ? 100 : 20));

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

          staveNotes.forEach((sn, noteIndex) => {
            const note = notes[noteIndex];
            const ys = note.isRest
              ? [refY0 - 3 * spacing]
              : note.pitches.map((p) => refY0 - pitchToLine(clef, p.letter, p.octave) * spacing);
            noteHitboxes.push({
              measureIndex,
              clef,
              noteIndex,
              centerX: centerXs[noteIndex],
              ys,
            });
            noteChain[clef].push({ event: note, staveNote: sn });
            noteById.set(note.id, { event: note, staveNote: sn });
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
        y1: chordY + 8,
        measureX: x,
        measureWidth,
      });

      // Lyric syllables in the band between the two staves.
      const lyricY = midY + 5;
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

      // Beat-overflow warning marker for either staff of this measure.
      if (
        isStaffMeasureOverflow(measure.treble, score.timeSignature) ||
        isStaffMeasureOverflow(measure.bass, score.timeSignature)
      ) {
        overflowHitboxes.push({ measureIndex, x: x + measureWidth - 12, y: trebleY - 14, radius: OVERFLOW_MARK_RADIUS });
      }

      // Rows now wrap automatically every MEASURES_PER_ROW measures (see
      // computeRows), so no manual "next line" marker is drawn.

      x += measureWidth;
    });
  });

  // A single "connect to next" flag becomes a tie when the pitches match, a
  // slur when they differ — so one toolbar button covers both.
  (['treble', 'bass'] as const).forEach((clef) => {
    const chain = noteChain[clef];
    for (let i = 0; i < chain.length - 1; i++) {
      const cur = chain[i];
      const next = chain[i + 1];
      if (cur.event.isRest || next.event.isRest || !noteConnects(cur.event)) continue;
      try {
        if (pitchesMatch(cur.event, next.event)) {
          new StaveTie({ firstNote: cur.staveNote, lastNote: next.staveNote }).setContext(context).draw();
        } else {
          new Curve(cur.staveNote, next.staveNote, {}).setContext(context).draw();
        }
      } catch {
        // Skip connections VexFlow can't render (e.g. mismatched key counts).
      }
    }
  });

  // Connections dragged onto an arbitrary target note (not necessarily "the
  // next note") — see the on-staff connector handle in StaffEditor.
  (['treble', 'bass'] as const).forEach((clef) => {
    noteChain[clef].forEach((cur) => {
      const targetId = cur.event.connectToId;
      if (!targetId || cur.event.isRest) return;
      const target = noteById.get(targetId);
      if (!target || target.event.isRest) return;
      try {
        if (pitchesMatch(cur.event, target.event)) {
          new StaveTie({ firstNote: cur.staveNote, lastNote: target.staveNote }).setContext(context).draw();
        } else {
          new Curve(cur.staveNote, target.staveNote, {}).setContext(context).draw();
        }
      } catch {
        // Skip connections VexFlow can't render.
      }
    });
  });

  // Connector handle on the selected note (hidden during playback, since
  // effectiveSelected is null then) — dragging it onto another note connects
  // the two with a tie/slur, regardless of their sequence order.
  let connectHandle: ConnectHandle | null = null;
  if (effectiveSelected) {
    const hb = noteHitboxes.find(
      (n) =>
        n.measureIndex === effectiveSelected.measureIndex &&
        n.clef === effectiveSelected.clef &&
        n.noteIndex === effectiveSelected.noteIndex,
    );
    const note = score.measures[effectiveSelected.measureIndex]?.[effectiveSelected.clef].notes[effectiveSelected.noteIndex];
    if (hb && note && !note.isRest) {
      connectHandle = {
        measureIndex: effectiveSelected.measureIndex,
        clef: effectiveSelected.clef,
        noteIndex: effectiveSelected.noteIndex,
        x: hb.centerX + CONNECT_HANDLE_DX,
        y: Math.min(...hb.ys) - CONNECT_HANDLE_DY,
        radius: CONNECT_HANDLE_RADIUS,
      };
    }
  }

  const titleHitbox: TitleHitbox = { x0: 0, x1: width, y0: 0, y1: titleBand, x: width / 2, y: 28 };
  const composerY = titleBand + rows.length * ROW_HEIGHT + 22;
  const composerHitbox: ComposerHitbox = {
    x0: Math.max(0, width - 240),
    x1: width - 4,
    y0: composerY - 16,
    y1: composerY + 8,
    x: width - 10,
    y: composerY,
  };

  const svg = container.querySelector('svg');
  if (svg) {
    drawHeading(svg, score, titleHitbox);
    drawComposer(svg, score, composerHitbox);
    drawChordLabels(svg, score, chordHitboxes);
    drawLyrics(svg, score, lyricHitboxes);
    drawLineBreakMarkers(svg, lineBreakHitboxes);
    drawOverflowMarks(svg, overflowHitboxes);
    if (connectHandle) drawConnectHandle(svg, connectHandle);
  }

  return {
    noteHitboxes,
    staffHitboxes,
    chordHitboxes,
    chordBandHitboxes,
    lineBreakHitboxes,
    overflowHitboxes,
    lyricHitboxes,
    lyricBandHitboxes,
    connectHandle,
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
  text.setAttribute('font-size', '24');
  text.setAttribute('font-weight', '800');
  text.setAttribute('fill', title ? '#1a1a1a' : PLACEHOLDER_COLOR);
  text.textContent = title || '제목을 입력하려면 클릭하세요';
  svg.appendChild(text);
}

/** Right-aligned credit line at the bottom of the score, mirroring the title. Click target to add/edit. */
function drawComposer(svg: SVGSVGElement, score: Score, hb: ComposerHitbox): void {
  const composer = score.composer?.trim();
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', String(hb.x));
  text.setAttribute('y', String(hb.y));
  text.setAttribute('text-anchor', 'end');
  text.setAttribute('font-family', CREDIT_FONT);
  text.setAttribute('font-style', 'italic');
  text.setAttribute('font-size', '13');
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
    text.setAttribute('fill', '#333');
    text.textContent = syllable.text;
    svg.appendChild(text);
  });
}

/** White marker (red outline + red "!") so it stands out clearly against the staff. */
function drawOverflowMarks(svg: SVGSVGElement, marks: OverflowHitbox[]): void {
  marks.forEach((m) => {
    const g = document.createElementNS(SVG_NS, 'g');
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = '마디가 가득 찼습니다 (박자 초과)';
    g.appendChild(title);
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', String(m.x));
    circle.setAttribute('cy', String(m.y));
    circle.setAttribute('r', String(m.radius));
    circle.setAttribute('fill', '#ffffff');
    circle.setAttribute('stroke', '#e03131');
    circle.setAttribute('stroke-width', '2');
    g.appendChild(circle);
    const bang = document.createElementNS(SVG_NS, 'text');
    bang.setAttribute('x', String(m.x));
    bang.setAttribute('y', String(m.y + 4));
    bang.setAttribute('text-anchor', 'middle');
    bang.setAttribute('font-size', '12');
    bang.setAttribute('font-weight', '800');
    bang.setAttribute('fill', '#e03131');
    bang.textContent = '!';
    g.appendChild(bang);
    svg.appendChild(g);
  });
}

/** Small filled handle on the selected note — drag it onto another note to tie/slur the two. */
function drawConnectHandle(svg: SVGSVGElement, handle: ConnectHandle): void {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('id', 'connect-handle');
  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = '드래그해서 다른 음표와 연결';
  g.appendChild(title);
  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', String(handle.x));
  circle.setAttribute('cy', String(handle.y));
  circle.setAttribute('r', String(handle.radius));
  circle.setAttribute('fill', '#2f9e44');
  circle.setAttribute('stroke', '#fff');
  circle.setAttribute('stroke-width', '1.5');
  g.appendChild(circle);
  svg.appendChild(g);
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
    text.setAttribute('font-size', '16');
    text.setAttribute('font-weight', '700');
    text.setAttribute('font-style', 'italic');
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
      Math.abs(n.centerX - x) < NOTE_HIT_RADIUS &&
      n.ys.some((ny) => Math.abs(ny - y) < yRadius),
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

export function findOverflowMarkAt(result: RenderResult, x: number, y: number): OverflowHitbox | null {
  return (
    result.overflowHitboxes.find((m) => Math.hypot(m.x - x, m.y - y) < m.radius + OVERFLOW_HIT_SLACK) ?? null
  );
}

export function findConnectHandleAt(result: RenderResult, x: number, y: number): ConnectHandle | null {
  const h = result.connectHandle;
  if (!h) return null;
  return Math.hypot(h.x - x, h.y - y) < h.radius + CONNECT_HANDLE_HIT_SLACK ? h : null;
}

/** Hit-test any note (including chord members), used to resolve a connect-drag drop target. */
export function findNoteAt(result: RenderResult, x: number, y: number): NoteHitbox | null {
  return (
    result.noteHitboxes.find((n) => Math.abs(n.centerX - x) < 14 && n.ys.some((ny) => Math.abs(ny - y) < 18)) ?? null
  );
}
