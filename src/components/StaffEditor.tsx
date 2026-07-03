import { useEffect, useRef, useState } from 'react';
import type { Accidental, Clef, DurationValue, NoteLocation, Score } from '../types/score';
import {
  findChordAt,
  findChordBandAt,
  findInsertIndex,
  findLineBreakAt,
  findStaffAt,
  lineAt,
  renderScore,
  resolveClick,
  xFractionAt,
  type DraggingNote,
  type RenderResult,
  type StaffHitbox,
} from '../lib/vexflowRenderer';
import { chordLabel, cycleDurationLonger, lineToPitch, pitchToLine, stemPointsUp } from '../lib/scoreUtils';
import { clearGhost, ledgerLinePositions, renderGhost } from '../lib/ghostOverlay';
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
  onDeselectNote: () => void;
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
  | {
      kind: 'chordSymbol';
      measureIndex: number;
      chordId: string;
      startX: number;
      moved: boolean;
      pendingOffset: number;
    }
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
  | { kind: 'newPreview'; cycled: boolean }
  | { kind: 'confirmPreview' }
  | {
      kind: 'note';
      location: NoteLocation;
      startX: number;
      startY: number;
      mode: 'undetermined' | 'drag' | 'durationCycle';
      cycleDuration: DurationValue;
    }
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
  onDeselectNote,
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

  // --- Mouse (desktop) interactions -------------------------------------------

  const handleDocumentMouseMove = (event: MouseEvent) => {
    const gesture = mouseGestureRef.current;
    const result = renderResultRef.current;
    if (!gesture || !result) return;
    const point = eventPoint(event);
    if (!point) return;

    if (gesture.kind === 'chordSymbol') {
      const dx = point.x - gesture.startX;
      if (!gesture.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      gesture.moved = true;
      const band = result.chordBandHitboxes.find((b) => b.measureIndex === gesture.measureIndex);
      const chordHitbox = result.chordHitboxes.find(
        (c) => c.measureIndex === gesture.measureIndex && c.chordId === gesture.chordId,
      );
      if (!band) return;
      const offset = Math.min(0.95, Math.max(0.05, (point.x - band.measureX) / band.measureWidth));
      gesture.pendingOffset = offset;
      const chord = score.measures[gesture.measureIndex].chords.find((c) => c.id === gesture.chordId);
      if (!chord) return;
      renderGhost(overlayRef.current, {
        kind: 'chord',
        x: band.measureX + offset * band.measureWidth,
        y: chordHitbox?.y ?? band.y0 + 14,
        label: chordLabel(chord),
        opacity: 0.7,
        color: '#2f3a8f',
      });
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

    if (gesture.kind === 'chordSymbol') {
      if (gesture.moved) onMoveChord(gesture.measureIndex, gesture.chordId, gesture.pendingOffset);
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

    // note gesture
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
      mouseGestureRef.current = {
        kind: 'chordSymbol',
        measureIndex: chordHit.measureIndex,
        chordId: chordHit.chordId,
        startX: point.x,
        moved: false,
        pendingOffset: 0,
      };
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
      if (touchGestureRef.current && touchGestureRef.current.kind === 'newPreview') touchGestureRef.current.cycled = true;
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

    const chordHit = findChordAt(result, point.x, point.y);
    if (chordHit) {
      event.preventDefault();
      onFocusMeasure(chordHit.measureIndex);
      return;
    }

    const band = findChordBandAt(result, point.x, point.y);
    if (band) {
      event.preventDefault();
      onFocusMeasure(band.measureIndex);
      return;
    }

    event.preventDefault();

    // Second tap confirming a pending preview?
    const preview = pendingPreviewRef.current;
    if (preview) {
      const near =
        Math.abs(point.x - preview.x) < TOUCH_PREVIEW_RADIUS && Math.abs(point.y - preview.y) < TOUCH_PREVIEW_RADIUS;
      if (near) {
        touchGestureRef.current = { kind: 'confirmPreview' };
        startPendingHoldCycle();
        return;
      }
      pendingPreviewRef.current = null;
      clearGhost(overlayRef.current);
    }

    const click = resolveClick(result, point.x, point.y);
    if (click?.type === 'select') {
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
      const staff = findStaffAt(result, point.x, point.y);
      if (!staff) return;
      const snappedLine = Math.round(click.line * 2) / 2;
      pendingPreviewRef.current = {
        measureIndex: click.measureIndex,
        clef: click.clef,
        x: point.x,
        y: staff.refY0 - snappedLine * staff.spacing,
        line: snappedLine,
        duration: editTool.duration,
        chordTarget: chordMergeTargetAt(click.measureIndex, click.clef, point.x),
      };
      renderPendingGhost();
      touchGestureRef.current = { kind: 'newPreview', cycled: false };
      startPendingHoldCycle();
      return;
    }

    onDeselectNote();
  };

  const handleTouchMove = (event: TouchEvent) => {
    const gesture = touchGestureRef.current;
    if (!gesture || gesture.kind !== 'note' || gesture.mode === 'durationCycle') return;
    const touch = event.touches[0];
    const point = touch && eventPoint(touch);
    const result = renderResultRef.current;
    if (!point || !result) return;

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
    event.preventDefault();
    touchGestureRef.current = null;

    const result = renderResultRef.current;
    const touch = event.changedTouches[0];
    const point = touch && eventPoint(touch);

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

    if (gesture.kind === 'newPreview') {
      // A quick tap leaves the preview waiting for a confirming tap; a hold that
      // cycled the duration places immediately on release.
      if (gesture.cycled) commitPending();
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
