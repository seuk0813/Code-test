import { useEffect, useRef, useState } from 'react';
import type { Accidental, Clef, NoteLocation, Score } from '../types/score';
import {
  findChordAt,
  findChordBandAt,
  findInsertIndex,
  findLineBreakAt,
  findStaffAt,
  lineAt,
  renderScore,
  resolveClick,
  type DraggingNote,
  type RenderResult,
} from '../lib/vexflowRenderer';
import { chordLabel, lineToPitch, stemPointsUp } from '../lib/scoreUtils';
import { clearGhost, ledgerLinePositions, renderGhost } from '../lib/ghostOverlay';
import type { EditTool } from './Toolbar';

const DRAG_THRESHOLD_PX = 4;

interface StaffEditorProps {
  score: Score;
  selected: NoteLocation | null;
  editTool: EditTool;
  onSelectNote: (location: NoteLocation) => void;
  onAddNote: (measureIndex: number, clef: Clef, letter: string, octave: number, insertIndex: number) => void;
  onDeleteNote: (location: NoteLocation) => void;
  onMoveNote: (location: NoteLocation, letter: string, octave: number) => void;
  onTogglePitch: (location: NoteLocation, letter: string, octave: number) => void;
  onFocusMeasure: (measureIndex: number) => void;
  onAddLineBreak: (afterMeasureIndex: number) => void;
  onMoveChord: (measureIndex: number, chordId: string, offset: number) => void;
  onDeleteChord: (measureIndex: number, chordId: string) => void;
  onDeselectNote: () => void;
}

type DragState =
  | {
      type: 'note';
      measureIndex: number;
      clef: Clef;
      noteIndex: number;
      startX: number;
      startY: number;
      moved: boolean;
    }
  | {
      type: 'chord';
      measureIndex: number;
      chordId: string;
      startX: number;
      moved: boolean;
      pendingOffset: number;
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
  onFocusMeasure,
  onAddLineBreak,
  onMoveChord,
  onDeleteChord,
  onDeselectNote,
}: StaffEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const renderResultRef = useRef<RenderResult | null>(null);
  const dragRef = useRef<DragState>(null);
  const suppressClickRef = useRef(false);
  const [draggingNote, setDraggingNote] = useState<DraggingNote | null>(null);

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

  const endDrag = () => {
    document.removeEventListener('mousemove', handleDocumentMouseMove);
  };

  const handleDocumentMouseMove = (event: MouseEvent) => {
    const drag = dragRef.current;
    const result = renderResultRef.current;
    if (!drag || !result) return;
    const point = eventPoint(event);
    if (!point) return;

    if (drag.type === 'note') {
      const dx = point.x - drag.startX;
      const dy = point.y - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      if (!drag.moved) {
        drag.moved = true;
        setDraggingNote({ measureIndex: drag.measureIndex, clef: drag.clef, noteIndex: drag.noteIndex });
      }
      const staff = result.staffHitboxes.find((s) => s.measureIndex === drag.measureIndex && s.clef === drag.clef);
      const noteHitbox = result.noteHitboxes.find(
        (n) => n.measureIndex === drag.measureIndex && n.clef === drag.clef && n.noteIndex === drag.noteIndex,
      );
      if (!staff) return;
      const rawLine = lineAt(staff, point.y);
      const snappedLine = Math.round(rawLine * 2) / 2;
      const note = score.measures[drag.measureIndex][drag.clef].notes[drag.noteIndex];
      const ghostX = noteHitbox?.centerX ?? point.x;
      const ghostY = staff.refY0 - snappedLine * staff.spacing;
      renderGhost(overlayRef.current, {
        kind: 'note',
        x: ghostX,
        y: ghostY,
        duration: note.duration,
        isRest: false,
        stemUp: stemPointsUp(snappedLine),
        accidental: (note.pitches[0]?.accidental ?? '') as Accidental,
        ledgerLineYs: ledgerLinePositions(snappedLine).map((l) => staff.refY0 - l * staff.spacing),
        opacity: 0.65,
        color: '#d6432b',
      });
    } else if (drag.type === 'chord') {
      const dx = point.x - drag.startX;
      if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      const band = result.chordBandHitboxes.find((b) => b.measureIndex === drag.measureIndex);
      const chordHitbox = result.chordHitboxes.find(
        (c) => c.measureIndex === drag.measureIndex && c.chordId === drag.chordId,
      );
      if (!band) return;
      const offset = Math.min(0.95, Math.max(0.05, (point.x - band.measureX) / band.measureWidth));
      drag.pendingOffset = offset;
      const chord = score.measures[drag.measureIndex].chords.find((c) => c.id === drag.chordId);
      if (!chord) return;
      renderGhost(overlayRef.current, {
        kind: 'chord',
        x: band.measureX + offset * band.measureWidth,
        y: chordHitbox?.y ?? band.y0 + 14,
        label: chordLabel(chord),
        opacity: 0.7,
        color: '#2f3a8f',
      });
    }
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const result = renderResultRef.current;
    const point = eventPoint(event);
    if (!result || !point) return;
    event.preventDefault();

    const chordHit = findChordAt(result, point.x, point.y);
    if (chordHit) {
      dragRef.current = {
        type: 'chord',
        measureIndex: chordHit.measureIndex,
        chordId: chordHit.chordId,
        startX: point.x,
        moved: false,
        pendingOffset: 0,
      };
      document.addEventListener('mousemove', handleDocumentMouseMove);
      document.addEventListener('mouseup', handleChordMouseUp);
      return;
    }

    const click = resolveClick(result, point.x, point.y);
    if (click?.type === 'select') {
      const note = score.measures[click.measureIndex][click.clef].notes[click.noteIndex];
      if (note.isRest) return; // rests have no pitch to drag
      dragRef.current = {
        type: 'note',
        measureIndex: click.measureIndex,
        clef: click.clef,
        noteIndex: click.noteIndex,
        startX: point.x,
        startY: point.y,
        moved: false,
      };
      document.addEventListener('mousemove', handleDocumentMouseMove);
      document.addEventListener('mouseup', handleNoteMouseUp);
    }
  };

  const handleNoteMouseUp = (event: MouseEvent) => {
    const drag = dragRef.current;
    const result = renderResultRef.current;
    if (drag?.type === 'note' && drag.moved && result) {
      const point = eventPoint(event);
      const staff = result.staffHitboxes.find((s) => s.measureIndex === drag.measureIndex && s.clef === drag.clef);
      if (point && staff) {
        const rawLine = lineAt(staff, point.y);
        const snappedLine = Math.round(rawLine * 2) / 2;
        const { letter, octave } = lineToPitch(drag.clef, snappedLine);
        onMoveNote({ measureIndex: drag.measureIndex, clef: drag.clef, noteIndex: drag.noteIndex }, letter, octave);
      }
    }
    suppressClickRef.current = Boolean(drag?.moved);
    setDraggingNote(null);
    clearGhost(overlayRef.current);
    dragRef.current = null;
    endDrag();
    document.removeEventListener('mouseup', handleNoteMouseUp);
  };

  const handleChordMouseUp = () => {
    const drag = dragRef.current;
    if (drag?.type === 'chord' && drag.moved) {
      onMoveChord(drag.measureIndex, drag.chordId, drag.pendingOffset);
    }
    suppressClickRef.current = Boolean(drag?.moved);
    clearGhost(overlayRef.current);
    dragRef.current = null;
    endDrag();
    document.removeEventListener('mouseup', handleChordMouseUp);
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (dragRef.current) return; // handled by document-level listeners
    const result = renderResultRef.current;
    const point = eventPoint(event);
    if (!result || !point) {
      clearGhost(overlayRef.current);
      return;
    }
    const click = resolveClick(result, point.x, point.y);
    if (click?.type === 'add') {
      const snappedLine = Math.round(click.line * 2) / 2;
      const staff = findStaffAt(result, point.x, point.y);
      if (!staff) {
        clearGhost(overlayRef.current);
        return;
      }
      const ghostY = staff.refY0 - snappedLine * staff.spacing;
      renderGhost(overlayRef.current, {
        kind: 'note',
        x: point.x,
        y: ghostY,
        duration: editTool.duration,
        isRest: editTool.isRest,
        stemUp: stemPointsUp(snappedLine),
        accidental: editTool.accidental,
        ledgerLineYs: ledgerLinePositions(snappedLine).map((l) => staff.refY0 - l * staff.spacing),
        opacity: 0.35,
        color: '#7a5cff',
      });
    } else {
      clearGhost(overlayRef.current);
    }
  };

  const handleMouseLeave = () => {
    if (!dragRef.current) clearGhost(overlayRef.current);
  };

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const result = renderResultRef.current;
    const point = eventPoint(event);
    if (!result || !point) return;
    // The next render (triggered by the resulting score/selection change) will
    // rebuild the real note; clear the hover ghost so it doesn't linger on top.
    clearGhost(overlayRef.current);

    const lineBreak = findLineBreakAt(result, point.x, point.y);
    if (lineBreak) {
      onAddLineBreak(lineBreak.afterMeasureIndex);
      return;
    }

    const chordHit = findChordAt(result, point.x, point.y);
    if (chordHit) {
      onFocusMeasure(chordHit.measureIndex);
      return;
    }

    const band = findChordBandAt(result, point.x, point.y);
    if (band) {
      onFocusMeasure(band.measureIndex);
      return;
    }

    const click = resolveClick(result, point.x, point.y);
    if (!click) {
      onDeselectNote();
      return;
    }
    if (click.type === 'select') {
      const location = { measureIndex: click.measureIndex, clef: click.clef, noteIndex: click.noteIndex };
      const alreadySelected =
        selected &&
        selected.measureIndex === location.measureIndex &&
        selected.clef === location.clef &&
        selected.noteIndex === location.noteIndex;
      if (alreadySelected) {
        // Clicking the already-selected note again at a different pitch adds
        // (or removes) that pitch, building/editing a chord in place.
        const staff = findStaffAt(result, point.x, point.y);
        if (staff) {
          const snappedLine = Math.round(lineAt(staff, point.y) * 2) / 2;
          const { letter, octave } = lineToPitch(click.clef, snappedLine);
          onTogglePitch(location, letter, octave);
        }
      } else {
        onSelectNote(location);
      }
      onFocusMeasure(click.measureIndex);
    } else {
      const snappedLine = Math.round(click.line * 2) / 2;
      const { letter, octave } = lineToPitch(click.clef, snappedLine);
      const insertIndex = findInsertIndex(result, click.measureIndex, click.clef, point.x);
      onAddNote(click.measureIndex, click.clef, letter, octave, insertIndex);
      onFocusMeasure(click.measureIndex);
    }
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
