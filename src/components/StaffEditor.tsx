import { useEffect, useRef, useState } from 'react';
import type { Accidental, Clef, DurationValue, NoteLocation, Score } from '../types/score';
import {
  findChordAt,
  findChordBandAt,
  findInsertIndex,
  findLineBreakAt,
  findLyricAt,
  findStaffAt,
  lineAt,
  renderScore,
  resolveClick,
  xFractionAt,
  type DraggingNote,
  type LyricHitbox,
  type RenderResult,
  type StaffHitbox,
} from '../lib/vexflowRenderer';
import {
  chordLabel,
  cycleDurationLonger,
  lineToPitch,
  measureCapacityBeats,
  noteBeats,
  pitchToLine,
  stemPointsUp,
} from '../lib/scoreUtils';
import { clearGhost, clearPlayback, ledgerLinePositions, renderGhost, renderPlayback } from '../lib/ghostOverlay';
import type { EditTool } from './Toolbar';

const DRAG_THRESHOLD_PX = 4;
const HOLD_CYCLE_MS = 1000;
const TOUCH_PREVIEW_RADIUS = 22;
/** A new note placed within this many px of an existing note's X stacks onto it as a chord tone. */
const CHORD_MERGE_X = 16;

const NEW_NOTE_COLOR = '#7a5cff';
const CHORD_COLOR = '#2f9e44';
const DRAG_COLOR = '#d6432b';

interface StaffEditorProps {
  score: Score;
  selected: NoteLocation | null;
  editTool: EditTool;
  onSelectNote: (location: NoteLocation) => void;
  onAddNote: (
    measureIndex: number,
    clef: Clef,
    letter: string,
    octave: number,
    insertIndex: number,
    durationOverride?: DurationValue,
    x?: number,
  ) => void;
  onDeleteNote: (location: NoteLocation) => void;
  onMoveNote: (location: NoteLocation, letter: string, octave: number, x?: number) => void;
  onTogglePitch: (location: NoteLocation, letter: string, octave: number) => void;
  onChangeDuration: (location: NoteLocation, duration: DurationValue) => void;
  onFocusMeasure: (measureIndex: number) => void;
  onAddLineBreak: (afterMeasureIndex: number) => void;
  onMoveChord: (measureIndex: number, chordId: string, offset: number) => void;
  onDeleteChord: (measureIndex: number, chordId: string) => void;
  onMoveLyric: (measureIndex: number, lyricId: string, offset: number) => void;
  onDeleteLyric: (measureIndex: number, lyricId: string) => void;
  onDeselectNote: () => void;
  /** When playing, a clock returning elapsed transport seconds (drives the playhead). */
  playbackClock: { get: () => number } | null;
}

/** A chord symbol or lyric syllable being dragged horizontally within its measure. */
interface SymbolDrag {
  kind: 'chordSymbol' | 'lyric';
  measureIndex: number;
  id: string;
  measureX: number;
  measureWidth: number;
  y: number;
  startX: number;
  moved: boolean;
  pendingOffset: number;
}

/** Mouse press gesture in progress on the staff. */
type MouseGesture =
  | {
      kind: 'add';
      measureIndex: number;
      clef: Clef;
      line: number;
      x: number; // pixel X of the press (fixed placement point)
      duration: DurationValue;
    }
  | {
      kind: 'note';
      location: NoteLocation;
      startX: number;
      startY: number;
      mode: 'undetermined' | 'drag' | 'durationCycle';
      cycleDuration: DurationValue;
    }
  | SymbolDrag
  | null;

/** A touch tap-to-preview placement waiting for a confirming second tap. */
interface PendingPreview {
  measureIndex: number;
  clef: Clef;
  x: number; // pixel
  y: number; // pixel
  line: number;
  duration: DurationValue;
  /** Index of an existing note this placement would stack onto (chord), else null. */
  chordTarget: number | null;
}

type TouchGesture =
  // First tap on empty space: deferred until touchend so a horizontal swipe
  // scrolls the score instead of dropping a preview. `scrolling` is set once
  // the finger moves enough to be a pan.
  | {
      kind: 'tapAdd';
      measureIndex: number;
      clef: Clef;
      line: number;
      x: number;
      startX: number;
      startY: number;
      scrolling: boolean;
    }
  | { kind: 'confirmPreview'; cycled: boolean }
  | {
      kind: 'note';
      location: NoteLocation;
      startX: number;
      startY: number;
      mode: 'undetermined' | 'drag' | 'durationCycle';
      cycleDuration: DurationValue;
    }
  | SymbolDrag
  | null;

export function StaffEditor({
  score,
  selected,
  editTool,
  onSelectNote,
  onAddNote,
  onDeleteNote,
  onMoveNote,
  onTogglePitch,
  onChangeDuration,
  onFocusMeasure,
  onAddLineBreak,
  onMoveChord,
  onDeleteChord,
  onMoveLyric,
  onDeleteLyric,
  onDeselectNote,
  playbackClock,
}: StaffEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const renderResultRef = useRef<RenderResult | null>(null);
  const suppressClickRef = useRef(false);
  const [draggingNote, setDraggingNote] = useState<DraggingNote | null>(null);

  const mouseGestureRef = useRef<MouseGesture>(null);
  const mouseHoldRef = useRef<number | null>(null);

  const pendingPreviewRef = useRef<PendingPreview | null>(null);
  const touchGestureRef = useRef<TouchGesture>(null);
  const touchHoldRef = useRef<number | null>(null);
  const playbackRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const result = renderScore(containerRef.current, score, selected, draggingNote);
    renderResultRef.current = result;
    if (overlayRef.current) {
      overlayRef.current.setAttribute('width', String(result.width));
      overlayRef.current.setAttribute('height', String(result.height));
      overlayRef.current.setAttribute('viewBox', `0 0 ${result.width} ${result.height}`);
    }
  }, [score, selected, draggingNote]);

  // Playback playhead: a red bar per staff sweeps across the notes in time, and
  // the note currently sounding in each staff is highlighted red.
  useEffect(() => {
    if (!playbackClock) {
      clearPlayback(overlayRef.current);
      return;
    }
    const secondsPerBeat = 60 / score.tempo;
    const measureBeats = measureCapacityBeats(score.timeSignature);

    interface Seg {
      startBeat: number;
      endBeat: number;
      x: number;
      ys: number[];
      isRest: boolean;
      measureIndex: number;
    }
    const buildTimeline = (clef: Clef): Seg[] => {
      const result = renderResultRef.current;
      if (!result) return [];
      const segs: Seg[] = [];
      score.measures.forEach((measure, measureIndex) => {
        let beat = measureIndex * measureBeats;
        measure[clef].notes.forEach((note, noteIndex) => {
          const dur = noteBeats(note);
          const hb = result.noteHitboxes.find(
            (n) => n.measureIndex === measureIndex && n.clef === clef && n.noteIndex === noteIndex,
          );
          if (hb) segs.push({ startBeat: beat, endBeat: beat + dur, x: hb.centerX, ys: hb.ys, isRest: note.isRest, measureIndex });
          beat += dur;
        });
      });
      return segs;
    };
    const timelines: Record<Clef, Seg[]> = { treble: buildTimeline('treble'), bass: buildTimeline('bass') };

    const tick = () => {
      const result = renderResultRef.current;
      const beats = playbackClock.get() / secondsPerBeat;
      const bars: { x: number; y0: number; y1: number }[] = [];
      const highlights: { cx: number; cy: number }[] = [];
      (['treble', 'bass'] as const).forEach((clef) => {
        const segs = timelines[clef];
        const idx = segs.findIndex((s) => beats >= s.startBeat && beats < s.endBeat);
        if (idx < 0 || !result) return;
        const seg = segs[idx];
        const staff = result.staffHitboxes.find((s) => s.measureIndex === seg.measureIndex && s.clef === clef);
        if (!staff) return;
        const next = segs[idx + 1];
        const progress = (beats - seg.startBeat) / Math.max(1e-6, seg.endBeat - seg.startBeat);
        // Sweep toward the next note only when it sits to the right in the same row.
        const barX = next && next.x > seg.x ? seg.x + (next.x - seg.x) * progress : seg.x;
        bars.push({ x: barX, y0: staff.refY0 - staff.spacing * 5.4, y1: staff.refY0 - staff.spacing * 0.6 });
        if (!seg.isRest) seg.ys.forEach((cy) => highlights.push({ cx: seg.x, cy }));
      });
      renderPlayback(overlayRef.current, { bars, highlights });
      playbackRafRef.current = requestAnimationFrame(tick);
    };
    playbackRafRef.current = requestAnimationFrame(tick);

    return () => {
      if (playbackRafRef.current !== null) cancelAnimationFrame(playbackRafRef.current);
      playbackRafRef.current = null;
      clearPlayback(overlayRef.current);
    };
  }, [playbackClock, score]);

  const eventPoint = (event: { clientX: number; clientY: number }) => {
    const svg = containerRef.current?.querySelector('svg');
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  // --- Shared placement helpers -----------------------------------------------

  const pitchAt = (clef: Clef, staff: StaffHitbox, y: number) => {
    const snappedLine = Math.round(lineAt(staff, y) * 2) / 2;
    const { letter, octave } = lineToPitch(clef, snappedLine);
    return { snappedLine, letter, octave };
  };

  /** Index of an existing non-rest note whose X is within merge distance, else null. */
  const chordMergeTargetAt = (measureIndex: number, clef: Clef, x: number, exclude?: number): number | null => {
    const result = renderResultRef.current;
    if (!result) return null;
    const hit = result.noteHitboxes.find(
      (n) =>
        n.measureIndex === measureIndex &&
        n.clef === clef &&
        (exclude === undefined || n.noteIndex !== exclude) &&
        Math.abs(n.centerX - x) < CHORD_MERGE_X,
    );
    if (!hit) return null;
    const note = score.measures[measureIndex][clef].notes[hit.noteIndex];
    return note && !note.isRest ? hit.noteIndex : null;
  };

  const renderAddGhost = (staff: StaffHitbox, x: number, line: number, duration: DurationValue, isChord: boolean) => {
    renderGhost(overlayRef.current, {
      kind: 'note',
      x,
      y: staff.refY0 - line * staff.spacing,
      duration,
      isRest: editTool.isRest && !isChord,
      stemUp: stemPointsUp(line),
      accidental: editTool.accidental,
      ledgerLineYs: ledgerLinePositions(line).map((l) => staff.refY0 - l * staff.spacing),
      opacity: isChord ? 0.6 : 0.45,
      color: isChord ? CHORD_COLOR : NEW_NOTE_COLOR,
    });
  };

  const renderDragGhost = (
    staff: StaffHitbox,
    x: number,
    line: number,
    duration: DurationValue,
    accidental: Accidental,
  ) => {
    renderGhost(overlayRef.current, {
      kind: 'note',
      x,
      y: staff.refY0 - line * staff.spacing,
      duration,
      isRest: false,
      stemUp: stemPointsUp(line),
      accidental,
      ledgerLineYs: ledgerLinePositions(line).map((l) => staff.refY0 - l * staff.spacing),
      opacity: 0.65,
      color: DRAG_COLOR,
    });
  };

  /** Place a note at the given staff position — stacking onto a near note as a chord, or a new note. */
  const commitAdd = (measureIndex: number, clef: Clef, staff: StaffHitbox, snappedLine: number, x: number, duration: DurationValue) => {
    const result = renderResultRef.current;
    if (!result) return;
    const { letter, octave } = lineToPitch(clef, snappedLine);
    const chordTarget = chordMergeTargetAt(measureIndex, clef, x);
    if (chordTarget !== null) {
      onTogglePitch({ measureIndex, clef, noteIndex: chordTarget }, letter, octave);
    } else {
      const insertIndex = findInsertIndex(result, measureIndex, clef, x);
      onAddNote(measureIndex, clef, letter, octave, insertIndex, duration, xFractionAt(staff, x));
    }
    onFocusMeasure(measureIndex);
  };

  const clearMouseHold = () => {
    if (mouseHoldRef.current !== null) {
      window.clearInterval(mouseHoldRef.current);
      mouseHoldRef.current = null;
    }
  };

  const clearTouchHold = () => {
    if (touchHoldRef.current !== null) {
      window.clearInterval(touchHoldRef.current);
      touchHoldRef.current = null;
    }
  };

  // --- Chord / lyric symbol dragging (shared by mouse and touch) --------------

  const symbolLabel = (drag: SymbolDrag): string => {
    const measure = score.measures[drag.measureIndex];
    if (drag.kind === 'chordSymbol') {
      const chord = measure.chords.find((c) => c.id === drag.id);
      return chord ? chordLabel(chord) : '';
    }
    return (measure.lyrics ?? []).find((l) => l.id === drag.id)?.text ?? '';
  };

  const updateSymbolDrag = (drag: SymbolDrag, pointX: number) => {
    if (!drag.moved && Math.abs(pointX - drag.startX) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    const offset = Math.min(0.97, Math.max(0.03, (pointX - drag.measureX) / drag.measureWidth));
    drag.pendingOffset = offset;
    renderGhost(overlayRef.current, {
      kind: 'chord',
      x: drag.measureX + offset * drag.measureWidth,
      y: drag.y,
      label: symbolLabel(drag),
      opacity: 0.7,
      color: drag.kind === 'chordSymbol' ? '#2f3a8f' : '#333',
    });
  };

  const commitSymbolDrag = (drag: SymbolDrag) => {
    if (!drag.moved) return;
    if (drag.kind === 'chordSymbol') onMoveChord(drag.measureIndex, drag.id, drag.pendingOffset);
    else onMoveLyric(drag.measureIndex, drag.id, drag.pendingOffset);
  };

  const chordDragFrom = (hit: { measureIndex: number; chordId: string; x: number; y: number }): SymbolDrag => {
    const result = renderResultRef.current!;
    const band = result.chordBandHitboxes.find((b) => b.measureIndex === hit.measureIndex);
    return {
      kind: 'chordSymbol',
      measureIndex: hit.measureIndex,
      id: hit.chordId,
      measureX: band?.measureX ?? hit.x,
      measureWidth: band?.measureWidth ?? 200,
      y: hit.y,
      startX: hit.x,
      moved: false,
      pendingOffset: 0,
    };
  };

  const lyricDragFrom = (hit: LyricHitbox): SymbolDrag => ({
    kind: 'lyric',
    measureIndex: hit.measureIndex,
    id: hit.lyricId,
    measureX: hit.measureX,
    measureWidth: hit.measureWidth,
    y: hit.y,
    startX: hit.x,
    moved: false,
    pendingOffset: 0,
  });

  // --- Mouse (desktop) interactions -------------------------------------------

  const handleDocumentMouseMove = (event: MouseEvent) => {
    const gesture = mouseGestureRef.current;
    const result = renderResultRef.current;
    if (!gesture || !result) return;
    const point = eventPoint(event);
    if (!point) return;

    if (gesture.kind === 'chordSymbol' || gesture.kind === 'lyric') {
      updateSymbolDrag(gesture, point.x);
      return;
    }

    if (gesture.kind === 'note') {
      if (gesture.mode === 'durationCycle') return;
      const dx = point.x - gesture.startX;
      const dy = point.y - gesture.startY;
      if (gesture.mode === 'undetermined') {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        clearMouseHold();
        gesture.mode = 'drag';
        setDraggingNote({ ...gesture.location });
      }
      const staff = result.staffHitboxes.find(
        (s) => s.measureIndex === gesture.location.measureIndex && s.clef === gesture.location.clef,
      );
      if (!staff) return;
      const note = score.measures[gesture.location.measureIndex][gesture.location.clef].notes[gesture.location.noteIndex];
      const { snappedLine } = pitchAt(gesture.location.clef, staff, point.y);
      // Full measures auto-align, so free X is only meaningful when not full.
      const ghostX = staff.full ? result.noteHitboxes.find(
        (n) => n.measureIndex === gesture.location.measureIndex && n.clef === gesture.location.clef && n.noteIndex === gesture.location.noteIndex,
      )?.centerX ?? point.x : point.x;
      renderDragGhost(staff, ghostX, snappedLine, note.duration, (note.pitches[0]?.accidental ?? '') as Accidental);
    }
  };

  const handleDocumentMouseUp = (event: MouseEvent) => {
    clearMouseHold();
    const gesture = mouseGestureRef.current;
    const result = renderResultRef.current;
    mouseGestureRef.current = null;
    document.removeEventListener('mousemove', handleDocumentMouseMove);
    document.removeEventListener('mouseup', handleDocumentMouseUp);
    if (!gesture || !result) return;
    const point = eventPoint(event);

    if (gesture.kind === 'chordSymbol' || gesture.kind === 'lyric') {
      commitSymbolDrag(gesture);
      suppressClickRef.current = gesture.moved;
      clearGhost(overlayRef.current);
      return;
    }

    if (gesture.kind === 'add') {
      const staff = result.staffHitboxes.find((s) => s.measureIndex === gesture.measureIndex && s.clef === gesture.clef);
      if (staff) commitAdd(gesture.measureIndex, gesture.clef, staff, gesture.line, gesture.x, gesture.duration);
      suppressClickRef.current = true;
      clearGhost(overlayRef.current);
      return;
    }

    if (gesture.kind !== 'note') return;
    if (gesture.mode === 'drag') {
      const staff = point
        ? result.staffHitboxes.find((s) => s.measureIndex === gesture.location.measureIndex && s.clef === gesture.location.clef)
        : undefined;
      if (point && staff) {
        const { letter, octave } = pitchAt(gesture.location.clef, staff, point.y);
        const x = staff.full ? undefined : xFractionAt(staff, point.x);
        onMoveNote(gesture.location, letter, octave, x);
      }
      suppressClickRef.current = true;
      setDraggingNote(null);
      clearGhost(overlayRef.current);
    } else if (gesture.mode === 'durationCycle') {
      onChangeDuration(gesture.location, gesture.cycleDuration);
      suppressClickRef.current = true;
      clearGhost(overlayRef.current);
    } else {
      onSelectNote(gesture.location);
      onFocusMeasure(gesture.location.measureIndex);
      clearGhost(overlayRef.current);
    }
  };

  /** Hold on a selected note: cycle its duration once per second, previewing in a red ghost. */
  const startNoteHoldCycle = (isTouch: boolean) => {
    const tick = () => {
      const g = isTouch ? touchGestureRef.current : mouseGestureRef.current;
      const result = renderResultRef.current;
      if (!g || g.kind !== 'note' || g.mode === 'drag' || !result) return;
      g.mode = 'durationCycle';
      g.cycleDuration = cycleDurationLonger(g.cycleDuration);
      const staff = result.staffHitboxes.find((s) => s.measureIndex === g.location.measureIndex && s.clef === g.location.clef);
      const note = score.measures[g.location.measureIndex][g.location.clef].notes[g.location.noteIndex];
      const noteHitbox = result.noteHitboxes.find(
        (n) => n.measureIndex === g.location.measureIndex && n.clef === g.location.clef && n.noteIndex === g.location.noteIndex,
      );
      if (!staff || !note || note.isRest || note.pitches.length === 0) return;
      const line = pitchToLine(g.location.clef, note.pitches[0].letter, note.pitches[0].octave);
      renderDragGhost(staff, noteHitbox?.centerX ?? staff.noteStartX, line, g.cycleDuration, (note.pitches[0]?.accidental ?? '') as Accidental);
    };
    const id = window.setInterval(tick, HOLD_CYCLE_MS);
    if (isTouch) touchHoldRef.current = id;
    else mouseHoldRef.current = id;
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const result = renderResultRef.current;
    const point = eventPoint(event);
    if (!result || !point) return;
    event.preventDefault();
    clearGhost(overlayRef.current);

    const lineBreak = findLineBreakAt(result, point.x, point.y);
    if (lineBreak) {
      onAddLineBreak(lineBreak.afterMeasureIndex);
      suppressClickRef.current = true;
      return;
    }

    const chordHit = findChordAt(result, point.x, point.y);
    if (chordHit) {
      mouseGestureRef.current = chordDragFrom(chordHit);
      document.addEventListener('mousemove', handleDocumentMouseMove);
      document.addEventListener('mouseup', handleDocumentMouseUp);
      return;
    }

    const lyricHit = findLyricAt(result, point.x, point.y);
    if (lyricHit) {
      mouseGestureRef.current = lyricDragFrom(lyricHit);
      document.addEventListener('mousemove', handleDocumentMouseMove);
      document.addEventListener('mouseup', handleDocumentMouseUp);
      return;
    }

    const band = findChordBandAt(result, point.x, point.y);
    if (band) {
      onFocusMeasure(band.measureIndex);
      suppressClickRef.current = true;
      return;
    }

    const click = resolveClick(result, point.x, point.y);
    if (!click) {
      onDeselectNote();
      return;
    }

    if (click.type === 'select') {
      const location: NoteLocation = { measureIndex: click.measureIndex, clef: click.clef, noteIndex: click.noteIndex };
      const note = score.measures[location.measureIndex][location.clef].notes[location.noteIndex];
      const gesture: Extract<MouseGesture, { kind: 'note' }> = {
        kind: 'note',
        location,
        startX: point.x,
        startY: point.y,
        mode: 'undetermined',
        cycleDuration: note.duration,
      };
      mouseGestureRef.current = gesture;
      if (!note.isRest) startNoteHoldCycle(false);
      document.addEventListener('mousemove', handleDocumentMouseMove);
      document.addEventListener('mouseup', handleDocumentMouseUp);
      return;
    }

    // add
    const staff = findStaffAt(result, point.x, point.y);
    if (!staff) return;
    const { snappedLine } = pitchAt(click.clef, staff, point.y);
    const isChord = chordMergeTargetAt(click.measureIndex, click.clef, point.x) !== null;
    mouseGestureRef.current = {
      kind: 'add',
      measureIndex: click.measureIndex,
      clef: click.clef,
      line: snappedLine,
      x: point.x,
      duration: editTool.duration,
    };
    renderAddGhost(staff, point.x, snappedLine, editTool.duration, isChord);
    mouseHoldRef.current = window.setInterval(() => {
      const g = mouseGestureRef.current;
      if (!g || g.kind !== 'add') return;
      g.duration = cycleDurationLonger(g.duration);
      const chord = chordMergeTargetAt(g.measureIndex, g.clef, g.x) !== null;
      renderAddGhost(staff, g.x, g.line, g.duration, chord);
    }, HOLD_CYCLE_MS);
    document.addEventListener('mousemove', handleDocumentMouseMove);
    document.addEventListener('mouseup', handleDocumentMouseUp);
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (mouseGestureRef.current) return; // active press handled by document listeners
    const result = renderResultRef.current;
    const point = eventPoint(event);
    if (!result || !point) {
      clearGhost(overlayRef.current);
      return;
    }
    const click = resolveClick(result, point.x, point.y);
    if (click?.type === 'add') {
      const staff = findStaffAt(result, point.x, point.y);
      if (!staff) {
        clearGhost(overlayRef.current);
        return;
      }
      const snappedLine = Math.round(click.line * 2) / 2;
      const isChord = chordMergeTargetAt(click.measureIndex, click.clef, point.x) !== null;
      renderAddGhost(staff, point.x, snappedLine, editTool.duration, isChord);
    } else {
      clearGhost(overlayRef.current);
    }
  };

  const handleMouseLeave = () => {
    if (!mouseGestureRef.current) clearGhost(overlayRef.current);
  };

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    // Placement/selection now happens on mousedown/mouseup; click only guards the suppress flag.
    if (suppressClickRef.current) suppressClickRef.current = false;
    void event;
  };

  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const result = renderResultRef.current;
    const point = eventPoint(event);
    if (!result || !point) return;

    const chordHit = findChordAt(result, point.x, point.y);
    if (chordHit) {
      onDeleteChord(chordHit.measureIndex, chordHit.chordId);
      return;
    }

    const lyricHit = findLyricAt(result, point.x, point.y);
    if (lyricHit) {
      onDeleteLyric(lyricHit.measureIndex, lyricHit.lyricId);
      return;
    }

    const click = resolveClick(result, point.x, point.y);
    if (click?.type === 'select') {
      onDeleteNote({ measureIndex: click.measureIndex, clef: click.clef, noteIndex: click.noteIndex });
    }
  };

  // --- Touch (mobile) interactions ---------------------------------------------
  //
  // Touch has no hover, so placement is a two-step "tap to preview, tap again to
  // confirm" flow. Holding (instead of a quick second tap) cycles the preview's
  // note duration once per second; lifting then places it at whatever duration
  // it landed on. Tapping directly above/below an existing note (same X) stacks
  // onto it as a chord tone. An existing note can be held to change its duration
  // or dragged (X + pitch) to move it freely within the clef.

  const renderPendingGhost = () => {
    const preview = pendingPreviewRef.current;
    const result = renderResultRef.current;
    if (!preview || !result) {
      clearGhost(overlayRef.current);
      return;
    }
    const staff = result.staffHitboxes.find((s) => s.measureIndex === preview.measureIndex && s.clef === preview.clef);
    if (!staff) return;
    renderAddGhost(staff, preview.x, preview.line, preview.duration, preview.chordTarget !== null);
  };

  const commitPending = () => {
    const preview = pendingPreviewRef.current;
    const result = renderResultRef.current;
    if (!preview || !result) return;
    const staff = result.staffHitboxes.find((s) => s.measureIndex === preview.measureIndex && s.clef === preview.clef);
    if (staff) commitAdd(preview.measureIndex, preview.clef, staff, preview.line, preview.x, preview.duration);
    pendingPreviewRef.current = null;
    clearGhost(overlayRef.current);
  };

  const startPendingHoldCycle = () => {
    touchHoldRef.current = window.setInterval(() => {
      const preview = pendingPreviewRef.current;
      if (!preview) return;
      preview.duration = cycleDurationLonger(preview.duration);
      if (touchGestureRef.current && touchGestureRef.current.kind === 'confirmPreview') {
        touchGestureRef.current.cycled = true;
      }
      renderPendingGhost();
    }, HOLD_CYCLE_MS);
  };

  const handleTouchStart = (event: TouchEvent) => {
    if (event.touches.length > 1) return;
    const result = renderResultRef.current;
    const touch = event.touches[0];
    const point = touch && eventPoint(touch);
    if (!result || !point) return;

    const lineBreak = findLineBreakAt(result, point.x, point.y);
    if (lineBreak) {
      event.preventDefault();
      pendingPreviewRef.current = null;
      clearGhost(overlayRef.current);
      onAddLineBreak(lineBreak.afterMeasureIndex);
      return;
    }

    // Chord symbols and lyrics are grabbable: a stationary tap focuses/does
    // nothing, a move drags them. Deliberate, so we claim the touch.
    const chordHit = findChordAt(result, point.x, point.y);
    if (chordHit) {
      event.preventDefault();
      touchGestureRef.current = chordDragFrom(chordHit);
      return;
    }
    const lyricHit = findLyricAt(result, point.x, point.y);
    if (lyricHit) {
      event.preventDefault();
      touchGestureRef.current = lyricDragFrom(lyricHit);
      return;
    }

    const band = findChordBandAt(result, point.x, point.y);
    if (band) {
      event.preventDefault();
      onFocusMeasure(band.measureIndex);
      return;
    }

    // Second tap confirming a pending preview? (deliberate — claim the touch)
    const preview = pendingPreviewRef.current;
    if (preview) {
      const near =
        Math.abs(point.x - preview.x) < TOUCH_PREVIEW_RADIUS && Math.abs(point.y - preview.y) < TOUCH_PREVIEW_RADIUS;
      if (near) {
        event.preventDefault();
        touchGestureRef.current = { kind: 'confirmPreview', cycled: false };
        startPendingHoldCycle();
        return;
      }
      pendingPreviewRef.current = null;
      clearGhost(overlayRef.current);
    }

    const click = resolveClick(result, point.x, point.y);
    if (click?.type === 'select') {
      event.preventDefault();
      const location: NoteLocation = { measureIndex: click.measureIndex, clef: click.clef, noteIndex: click.noteIndex };
      const note = score.measures[location.measureIndex][location.clef].notes[location.noteIndex];
      const gesture: Extract<TouchGesture, { kind: 'note' }> = {
        kind: 'note',
        location,
        startX: point.x,
        startY: point.y,
        mode: 'undetermined',
        cycleDuration: note.duration,
      };
      touchGestureRef.current = gesture;
      if (!note.isRest) startNoteHoldCycle(true);
      return;
    }

    if (click?.type === 'add') {
      // Do NOT preventDefault here: a horizontal swipe from empty space should
      // scroll the score. We defer creating the preview until touchend, and
      // cancel it if the finger moves (a pan) in handleTouchMove.
      const snappedLine = Math.round(click.line * 2) / 2;
      touchGestureRef.current = {
        kind: 'tapAdd',
        measureIndex: click.measureIndex,
        clef: click.clef,
        line: snappedLine,
        x: point.x,
        startX: point.x,
        startY: point.y,
        scrolling: false,
      };
      return;
    }

    // Empty area (no staff): let the browser scroll; don't claim the touch.
  };

  const handleTouchMove = (event: TouchEvent) => {
    const gesture = touchGestureRef.current;
    if (!gesture) return;
    const touch = event.touches[0];
    const point = touch && eventPoint(touch);
    const result = renderResultRef.current;
    if (!point || !result) return;

    // Deferred add-tap: any real movement means the user is panning — release
    // the touch to the browser so the score scrolls.
    if (gesture.kind === 'tapAdd') {
      if (Math.hypot(point.x - gesture.startX, point.y - gesture.startY) >= DRAG_THRESHOLD_PX) {
        touchGestureRef.current = null;
      }
      return;
    }

    if (gesture.kind === 'chordSymbol' || gesture.kind === 'lyric') {
      event.preventDefault();
      updateSymbolDrag(gesture, point.x);
      return;
    }

    if (gesture.kind !== 'note' || gesture.mode === 'durationCycle') return;

    const dx = point.x - gesture.startX;
    const dy = point.y - gesture.startY;
    if (gesture.mode === 'undetermined') {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      clearTouchHold();
      gesture.mode = 'drag';
      setDraggingNote({ ...gesture.location });
    }

    event.preventDefault();
    const staff = result.staffHitboxes.find((s) => s.measureIndex === gesture.location.measureIndex && s.clef === gesture.location.clef);
    if (!staff) return;
    const note = score.measures[gesture.location.measureIndex][gesture.location.clef].notes[gesture.location.noteIndex];
    const { snappedLine } = pitchAt(gesture.location.clef, staff, point.y);
    const ghostX = staff.full
      ? result.noteHitboxes.find(
          (n) => n.measureIndex === gesture.location.measureIndex && n.clef === gesture.location.clef && n.noteIndex === gesture.location.noteIndex,
        )?.centerX ?? point.x
      : point.x;
    renderDragGhost(staff, ghostX, snappedLine, note.duration, (note.pitches[0]?.accidental ?? '') as Accidental);
  };

  const handleTouchEnd = (event: TouchEvent) => {
    clearTouchHold();
    const gesture = touchGestureRef.current;
    if (!gesture) return;
    touchGestureRef.current = null;

    const result = renderResultRef.current;
    const touch = event.changedTouches[0];
    const point = touch && eventPoint(touch);

    if (gesture.kind === 'tapAdd') {
      // A clean tap (no pan) drops the preview at the tapped spot.
      event.preventDefault();
      if (result) {
        const staff = result.staffHitboxes.find((s) => s.measureIndex === gesture.measureIndex && s.clef === gesture.clef);
        if (staff) {
          pendingPreviewRef.current = {
            measureIndex: gesture.measureIndex,
            clef: gesture.clef,
            x: gesture.x,
            y: staff.refY0 - gesture.line * staff.spacing,
            line: gesture.line,
            duration: editTool.duration,
            chordTarget: chordMergeTargetAt(gesture.measureIndex, gesture.clef, gesture.x),
          };
          renderPendingGhost();
        }
      }
      return;
    }

    event.preventDefault();

    if (gesture.kind === 'chordSymbol' || gesture.kind === 'lyric') {
      commitSymbolDrag(gesture);
      if (!gesture.moved && gesture.kind === 'chordSymbol') onFocusMeasure(gesture.measureIndex);
      clearGhost(overlayRef.current);
      return;
    }

    if (gesture.kind === 'note') {
      if (gesture.mode === 'drag') {
        if (point && result) {
          const staff = result.staffHitboxes.find((s) => s.measureIndex === gesture.location.measureIndex && s.clef === gesture.location.clef);
          if (staff) {
            const { letter, octave } = pitchAt(gesture.location.clef, staff, point.y);
            onMoveNote(gesture.location, letter, octave, staff.full ? undefined : xFractionAt(staff, point.x));
          }
        }
        setDraggingNote(null);
        clearGhost(overlayRef.current);
      } else if (gesture.mode === 'durationCycle') {
        onChangeDuration(gesture.location, gesture.cycleDuration);
        clearGhost(overlayRef.current);
      } else {
        onSelectNote(gesture.location);
        onFocusMeasure(gesture.location.measureIndex);
      }
      return;
    }

    if (gesture.kind === 'confirmPreview') {
      commitPending();
    }
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('touchstart', handleTouchStart, { passive: false });
    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    el.addEventListener('touchend', handleTouchEnd, { passive: false });
    el.addEventListener('touchcancel', handleTouchEnd, { passive: false });
    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
      el.removeEventListener('touchcancel', handleTouchEnd);
    };
  });

  return (
    <div className="staff-scroll">
      <div className="staff-stack">
        <div
          ref={containerRef}
          className="staff-container"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
        />
        <svg ref={overlayRef} className="staff-ghost-overlay" />
      </div>
    </div>
  );
}
