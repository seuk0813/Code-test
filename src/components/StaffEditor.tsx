import { useEffect, useRef, useState } from 'react';
import type { Accidental, Clef, DurationValue, NoteLocation, Score } from '../types/score';
import {
  findChordAt,
  findChordBandAt,
  findComposerAt,
  findConnectHandleAt,
  findInsertIndex,
  findLineBreakAt,
  findLyricAt,
  findLyricBandAt,
  findNearbyNotesAt,
  findNoteAt,
  findOverflowMarkAt,
  findStaffAt,
  findTitleAt,
  lineAt,
  nearestPitchIndexAt,
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
import {
  clearConnectCandidates,
  clearConnectPreview,
  clearGhost,
  clearPlayback,
  clearTooltip,
  ledgerLinePositions,
  renderConnectCandidates,
  renderConnectPreview,
  renderGhost,
  renderPlayback,
  renderTooltip,
} from '../lib/ghostOverlay';
import type { EditTool } from './Toolbar';

const DRAG_THRESHOLD_PX = 4;
const HOLD_CYCLE_MS = 1000;
const TOUCH_PREVIEW_RADIUS = 22;
/** A new note placed within this many px of an existing note's X stacks onto it as a chord tone. */
const CHORD_MERGE_X = 16;
/** While dragging the connect handle, notes within this radius show up as selectable candidates. */
const CONNECT_CANDIDATE_RADIUS = 55;

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
  onMoveNote: (location: NoteLocation, deltaLine: number, x?: number) => void;
  onTogglePitch: (location: NoteLocation, letter: string, octave: number) => void;
  onChangeDuration: (location: NoteLocation, duration: DurationValue) => void;
  onFocusMeasure: (measureIndex: number) => void;
  onAddLineBreak: (afterMeasureIndex: number) => void;
  onMoveChord: (measureIndex: number, chordId: string, offset: number) => void;
  onDeleteChord: (measureIndex: number, chordId: string) => void;
  onMoveLyric: (fromMeasureIndex: number, lyricId: string, offset: number, toMeasureIndex: number) => void;
  onDeleteLyric: (measureIndex: number, lyricId: string) => void;
  onDeselectNote: () => void;
  /** Dragging the connector handle onto another note connects them with a tie/slur, optionally pinned to specific chord pitches on either end. */
  onConnectNote: (source: NoteLocation, targetId: string, fromPitchIndex?: number, toPitchIndex?: number) => void;
  /** When playing, a clock returning elapsed transport seconds (drives the playhead). */
  playbackClock: { get: () => number } | null;
  /** Inline editing directly on the score: title, composer, and adding/editing chords & lyrics in place. */
  onSetTitle: (title: string) => void;
  onSetComposer: (composer: string) => void;
  onAddChordAt: (measureIndex: number, text: string, offset: number) => void;
  onEditChordText: (measureIndex: number, chordId: string, text: string) => void;
  onAddLyricAt: (measureIndex: number, text: string, offset: number) => void;
  onEditLyricText: (measureIndex: number, lyricId: string, text: string) => void;
}

/** A floating text input overlaid on the score for in-place editing of title, composer, chords, and lyrics. */
type InlineEditor =
  | { kind: 'title'; left: number; top: number; width: number; align: 'center'; value: string }
  | { kind: 'composer'; left: number; top: number; width: number; align: 'right'; value: string }
  | { kind: 'chordAdd'; left: number; top: number; width: number; align: 'center'; value: string; measureIndex: number; offset: number }
  | { kind: 'chordEdit'; left: number; top: number; width: number; align: 'center'; value: string; measureIndex: number; chordId: string }
  | { kind: 'lyricAdd'; left: number; top: number; width: number; align: 'center'; value: string; measureIndex: number; offset: number }
  | { kind: 'lyricEdit'; left: number; top: number; width: number; align: 'center'; value: string; measureIndex: number; lyricId: string };

/**
 * A chord symbol or lyric syllable being dragged horizontally. Chord symbols
 * stay within their origin measure; lyric syllables can cross into an
 * adjacent measure, so `measureIndex` tracks the currently-hovered measure
 * while `originMeasureIndex` remembers where the drag started (needed to
 * splice the syllable out of the right source array on commit).
 */
interface SymbolDrag {
  kind: 'chordSymbol' | 'lyric';
  measureIndex: number;
  originMeasureIndex: number;
  id: string;
  measureX: number;
  measureWidth: number;
  y: number;
  startX: number;
  moved: boolean;
  pendingOffset: number;
}

/** Dragging the small connector handle on a selected note onto another note to tie/slur them. */
interface ConnectDrag {
  kind: 'connectDrag';
  source: NoteLocation;
  /** Which pitch of a chord this specific handle belongs to (see ConnectHandle.pitchIndex). */
  sourcePitchIndex: number;
  x0: number;
  y0: number;
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
      /** The note's own pitch line at gesture start, for computing a drag's pitch delta (see F14: dragging a chord tone must shift every pitch by the same amount, not replace them). */
      startLine: number;
      mode: 'undetermined' | 'drag' | 'durationCycle';
      cycleDuration: DurationValue;
    }
  | SymbolDrag
  | ConnectDrag
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
      startLine: number;
      mode: 'undetermined' | 'drag' | 'durationCycle';
      cycleDuration: DurationValue;
    }
  | SymbolDrag
  | ConnectDrag
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
  onConnectNote,
  playbackClock,
  onSetTitle,
  onSetComposer,
  onAddChordAt,
  onEditChordText,
  onAddLyricAt,
  onEditLyricText,
}: StaffEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const renderResultRef = useRef<RenderResult | null>(null);
  const suppressClickRef = useRef(false);
  const [draggingNote, setDraggingNote] = useState<DraggingNote | null>(null);
  const [inlineEditor, setInlineEditor] = useState<InlineEditor | null>(null);
  const inlineCancelledRef = useRef(false);

  const mouseGestureRef = useRef<MouseGesture>(null);
  const mouseHoldRef = useRef<number | null>(null);

  const pendingPreviewRef = useRef<PendingPreview | null>(null);
  const touchGestureRef = useRef<TouchGesture>(null);
  const touchHoldRef = useRef<number | null>(null);
  const playbackRafRef = useRef<number | null>(null);

  // The currently-sounding note per staff during playback (null when playing
  // a rest, or when not playing at all). Recoloring the real VexFlow note via
  // this — rather than a separately-computed overlay position — is what
  // guarantees the highlight is always pixel-perfectly aligned with the note.
  const [playingLocations, setPlayingLocations] = useState<{ treble: NoteLocation | null; bass: NoteLocation | null } | null>(
    null,
  );

  useEffect(() => {
    if (!containerRef.current) return;
    const result = renderScore(containerRef.current, score, selected, draggingNote, playingLocations);
    renderResultRef.current = result;
    if (overlayRef.current) {
      overlayRef.current.setAttribute('width', String(result.width));
      overlayRef.current.setAttribute('height', String(result.height));
      overlayRef.current.setAttribute('viewBox', `0 0 ${result.width} ${result.height}`);
    }
  }, [score, selected, draggingNote, playingLocations]);

  // Playback playhead: a red bar per staff, snapped exactly to the real X of
  // the currently-sounding note (never interpolated — that's what previously
  // let the bar drift out of alignment). The note-recolor state only updates
  // when the sounding note actually changes, so this rAF loop stays cheap.
  useEffect(() => {
    if (!playbackClock) {
      clearPlayback(overlayRef.current);
      setPlayingLocations(null);
      return;
    }
    const secondsPerBeat = 60 / score.tempo;
    const measureBeats = measureCapacityBeats(score.timeSignature);

    interface Seg {
      startBeat: number;
      endBeat: number;
      x: number;
      isRest: boolean;
      measureIndex: number;
      noteIndex: number;
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
          if (hb) segs.push({ startBeat: beat, endBeat: beat + dur, x: hb.stemX, isRest: note.isRest, measureIndex, noteIndex });
          beat += dur;
        });
      });
      return segs;
    };
    const timelines: Record<Clef, Seg[]> = { treble: buildTimeline('treble'), bass: buildTimeline('bass') };
    const lastLocRef: { current: { treble: NoteLocation | null; bass: NoteLocation | null } } = {
      current: { treble: null, bass: null },
    };

    const tick = () => {
      const result = renderResultRef.current;
      const beats = playbackClock.get() / secondsPerBeat;
      const bars: { x: number; y0: number; y1: number }[] = [];
      const nextLoc: { treble: NoteLocation | null; bass: NoteLocation | null } = { treble: null, bass: null };
      (['treble', 'bass'] as const).forEach((clef) => {
        const segs = timelines[clef];
        const idx = segs.findIndex((s) => beats >= s.startBeat && beats < s.endBeat);
        if (idx < 0 || !result) return;
        const seg = segs[idx];
        const staff = result.staffHitboxes.find((s) => s.measureIndex === seg.measureIndex && s.clef === clef);
        if (!staff) return;
        bars.push({ x: seg.x, y0: staff.refY0 - staff.spacing * 5.4, y1: staff.refY0 - staff.spacing * 0.6 });
        if (!seg.isRest) nextLoc[clef] = { measureIndex: seg.measureIndex, clef, noteIndex: seg.noteIndex };
      });
      renderPlayback(overlayRef.current, { bars });

      const changed =
        nextLoc.treble?.noteIndex !== lastLocRef.current.treble?.noteIndex ||
        nextLoc.treble?.measureIndex !== lastLocRef.current.treble?.measureIndex ||
        nextLoc.bass?.noteIndex !== lastLocRef.current.bass?.noteIndex ||
        nextLoc.bass?.measureIndex !== lastLocRef.current.bass?.measureIndex;
      if (changed) {
        lastLocRef.current = nextLoc;
        setPlayingLocations(nextLoc);
      }
      playbackRafRef.current = requestAnimationFrame(tick);
    };
    playbackRafRef.current = requestAnimationFrame(tick);

    return () => {
      if (playbackRafRef.current !== null) cancelAnimationFrame(playbackRafRef.current);
      playbackRafRef.current = null;
      clearPlayback(overlayRef.current);
      setPlayingLocations(null);
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

  /** Resolve a valid tie/slur drop target (a different, non-rest note) under a point, else null. */
  const connectTargetAt = (result: RenderResult, source: NoteLocation, x: number, y: number) => {
    const hit = findNoteAt(result, x, y);
    if (!hit) return null;
    if (hit.measureIndex === source.measureIndex && hit.clef === source.clef && hit.noteIndex === source.noteIndex) {
      return null;
    }
    const note = score.measures[hit.measureIndex]?.[hit.clef]?.notes[hit.noteIndex];
    if (!note || note.isRest) return null;
    return {
      location: { measureIndex: hit.measureIndex, clef: hit.clef, noteIndex: hit.noteIndex } as NoteLocation,
      id: note.id,
      // Which of the target's pitches (top/bottom of a chord) the drop point landed nearest to.
      pitchIndex: nearestPitchIndexAt(hit, y),
    };
  };

  /**
   * Shows every valid connect target near the cursor while dragging, not
   * just whichever one is exactly under it — the layout the user asked for
   * to pick a note when several sit close together. The nearest valid one
   * (the one connectTargetAt would actually pick) is highlighted active.
   */
  const renderNearbyConnectCandidates = (result: RenderResult, source: NoteLocation, x: number, y: number) => {
    const nearby = findNearbyNotesAt(result, x, y, CONNECT_CANDIDATE_RADIUS).filter((n) => {
      if (n.measureIndex === source.measureIndex && n.clef === source.clef && n.noteIndex === source.noteIndex) {
        return false;
      }
      const note = score.measures[n.measureIndex]?.[n.clef]?.notes[n.noteIndex];
      return note && !note.isRest;
    });
    const activeId = connectTargetAt(result, source, x, y);
    renderConnectCandidates(
      overlayRef.current,
      nearby.map((n) => ({
        x: n.centerX,
        y: n.ys[0],
        active: !!activeId && n.measureIndex === activeId.location.measureIndex && n.clef === activeId.location.clef && n.noteIndex === activeId.location.noteIndex,
      })),
    );
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

  const updateSymbolDrag = (drag: SymbolDrag, point: { x: number; y: number }) => {
    if (!drag.moved && Math.abs(point.x - drag.startX) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;

    // Lyrics can cross into whichever measure the finger/cursor is currently
    // over; chord symbols stay confined to their origin measure.
    if (drag.kind === 'lyric') {
      const result = renderResultRef.current;
      const staff = result && findStaffAt(result, point.x, drag.y);
      if (staff && staff.measureIndex !== drag.measureIndex) {
        drag.measureIndex = staff.measureIndex;
        drag.measureX = staff.x0;
        drag.measureWidth = staff.x1 - staff.x0;
      }
    }

    const offset = Math.min(0.97, Math.max(0.03, (point.x - drag.measureX) / drag.measureWidth));
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
    else onMoveLyric(drag.originMeasureIndex, drag.id, drag.pendingOffset, drag.measureIndex);
  };

  const chordDragFrom = (hit: { measureIndex: number; chordId: string; x: number; y: number }): SymbolDrag => {
    const result = renderResultRef.current!;
    const band = result.chordBandHitboxes.find((b) => b.measureIndex === hit.measureIndex);
    return {
      kind: 'chordSymbol',
      measureIndex: hit.measureIndex,
      originMeasureIndex: hit.measureIndex,
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
    originMeasureIndex: hit.measureIndex,
    id: hit.lyricId,
    measureX: hit.measureX,
    measureWidth: hit.measureWidth,
    y: hit.y,
    startX: hit.x,
    moved: false,
    pendingOffset: 0,
  });

  // --- Inline editing directly on the score (title/composer/chord/lyric) -----

  const openTitleEditor = () => {
    const result = renderResultRef.current;
    if (!result) return;
    const hb = result.titleHitbox;
    const width = Math.min(480, result.width * 0.9);
    setInlineEditor({ kind: 'title', left: hb.x - width / 2, top: 4, width, align: 'center', value: score.title });
  };

  const openComposerEditor = () => {
    const result = renderResultRef.current;
    if (!result) return;
    const hb = result.composerHitbox;
    const width = 220;
    setInlineEditor({ kind: 'composer', left: hb.x - width, top: hb.y - 17, width, align: 'right', value: score.composer });
  };

  /** Opens the edit box for an existing chord/lyric symbol after a non-dragging click on it. */
  const openSymbolEditor = (drag: SymbolDrag) => {
    const measure = score.measures[drag.measureIndex];
    if (drag.kind === 'chordSymbol') {
      const chord = measure.chords.find((c) => c.id === drag.id);
      if (!chord) return;
      const x = drag.measureX + chord.offset * drag.measureWidth;
      setInlineEditor({
        kind: 'chordEdit',
        measureIndex: drag.measureIndex,
        chordId: drag.id,
        left: x - 45,
        top: drag.y - 14,
        width: 90,
        align: 'center',
        value: chordLabel(chord),
      });
    } else {
      const syllable = (measure.lyrics ?? []).find((l) => l.id === drag.id);
      if (!syllable) return;
      const x = drag.measureX + syllable.offset * drag.measureWidth;
      setInlineEditor({
        kind: 'lyricEdit',
        measureIndex: drag.measureIndex,
        lyricId: drag.id,
        left: x - 30,
        top: drag.y - 12,
        width: 60,
        align: 'center',
        value: syllable.text,
      });
    }
  };

  /** Opens an empty edit box to add a new chord at the clicked position in the chord band. */
  const openChordAddEditor = (band: { measureIndex: number; x0: number; x1: number; y0: number; y1: number; measureX: number; measureWidth: number }, x: number) => {
    const offset = Math.min(0.95, Math.max(0.05, (x - band.measureX) / band.measureWidth));
    setInlineEditor({
      kind: 'chordAdd',
      measureIndex: band.measureIndex,
      offset,
      left: x - 45,
      top: (band.y0 + band.y1) / 2 - 8,
      width: 90,
      align: 'center',
      value: '',
    });
  };

  /** Opens an empty edit box to add new lyric text at the clicked position in the lyric band. */
  const openLyricAddEditor = (band: { measureIndex: number; y: number; measureX: number; measureWidth: number }, x: number) => {
    const offset = Math.min(0.97, Math.max(0.03, (x - band.measureX) / band.measureWidth));
    setInlineEditor({
      kind: 'lyricAdd',
      measureIndex: band.measureIndex,
      offset,
      left: x - 30,
      top: band.y - 12,
      width: 60,
      align: 'center',
      value: '',
    });
  };

  const commitInlineEditor = () => {
    const ed = inlineEditor;
    setInlineEditor(null);
    if (!ed) return;
    if (ed.kind === 'title') onSetTitle(ed.value);
    else if (ed.kind === 'composer') onSetComposer(ed.value);
    else if (ed.kind === 'chordAdd') onAddChordAt(ed.measureIndex, ed.value, ed.offset);
    else if (ed.kind === 'chordEdit') onEditChordText(ed.measureIndex, ed.chordId, ed.value);
    else if (ed.kind === 'lyricAdd') onAddLyricAt(ed.measureIndex, ed.value, ed.offset);
    else if (ed.kind === 'lyricEdit') onEditLyricText(ed.measureIndex, ed.lyricId, ed.value);
  };

  const handleInlineBlur = () => {
    if (inlineCancelledRef.current) {
      inlineCancelledRef.current = false;
      setInlineEditor(null);
      return;
    }
    commitInlineEditor();
  };

  const handleInlineKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      inlineCancelledRef.current = true;
      event.currentTarget.blur();
    }
  };

  // --- Mouse (desktop) interactions -------------------------------------------

  const handleDocumentMouseMove = (event: MouseEvent) => {
    const gesture = mouseGestureRef.current;
    const result = renderResultRef.current;
    if (!gesture || !result) return;
    const point = eventPoint(event);
    if (!point) return;

    if (gesture.kind === 'chordSymbol' || gesture.kind === 'lyric') {
      updateSymbolDrag(gesture, point);
      return;
    }

    if (gesture.kind === 'connectDrag') {
      const target = connectTargetAt(result, gesture.source, point.x, point.y);
      renderConnectPreview(overlayRef.current, { x0: gesture.x0, y0: gesture.y0, x1: point.x, y1: point.y, snapped: !!target });
      renderNearbyConnectCandidates(result, gesture.source, point.x, point.y);
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
      if (!gesture.moved) openSymbolEditor(gesture);
      suppressClickRef.current = gesture.moved;
      clearGhost(overlayRef.current);
      return;
    }

    if (gesture.kind === 'connectDrag') {
      clearConnectPreview(overlayRef.current);
      clearConnectCandidates(overlayRef.current);
      suppressClickRef.current = true;
      if (point) {
        const target = connectTargetAt(result, gesture.source, point.x, point.y);
        if (target) onConnectNote(gesture.source, target.id, gesture.sourcePitchIndex, target.pitchIndex);
      }
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
        const { snappedLine } = pitchAt(gesture.location.clef, staff, point.y);
        const x = staff.full ? undefined : xFractionAt(staff, point.x);
        onMoveNote(gesture.location, snappedLine - gesture.startLine, x);
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
    if (inlineEditor) commitInlineEditor();

    if (findTitleAt(result, point.x, point.y)) {
      openTitleEditor();
      suppressClickRef.current = true;
      return;
    }

    if (findComposerAt(result, point.x, point.y)) {
      openComposerEditor();
      suppressClickRef.current = true;
      return;
    }

    const lineBreak = findLineBreakAt(result, point.x, point.y);
    if (lineBreak) {
      onAddLineBreak(lineBreak.afterMeasureIndex);
      suppressClickRef.current = true;
      return;
    }

    const connectHandle = findConnectHandleAt(result, point.x, point.y);
    if (connectHandle) {
      mouseGestureRef.current = {
        kind: 'connectDrag',
        source: { measureIndex: connectHandle.measureIndex, clef: connectHandle.clef, noteIndex: connectHandle.noteIndex },
        sourcePitchIndex: connectHandle.pitchIndex,
        x0: connectHandle.x,
        y0: connectHandle.y,
      };
      document.addEventListener('mousemove', handleDocumentMouseMove);
      document.addEventListener('mouseup', handleDocumentMouseUp);
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
      openChordAddEditor(band, point.x);
      suppressClickRef.current = true;
      return;
    }

    const lyricBand = findLyricBandAt(result, point.x, point.y);
    if (lyricBand) {
      openLyricAddEditor(lyricBand, point.x);
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
      const primaryPitch = note.pitches[0];
      const gesture: Extract<MouseGesture, { kind: 'note' }> = {
        kind: 'note',
        location,
        startX: point.x,
        startY: point.y,
        startLine: primaryPitch ? pitchToLine(location.clef, primaryPitch.letter, primaryPitch.octave) : 0,
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
      clearTooltip(overlayRef.current);
      return;
    }

    const overflowHit = findOverflowMarkAt(result, point.x, point.y);
    if (overflowHit) {
      clearGhost(overlayRef.current);
      renderTooltip(overlayRef.current, { x: overflowHit.x, y: overflowHit.y, text: '마디가 가득 찼습니다' });
      return;
    }
    clearTooltip(overlayRef.current);

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
    if (!mouseGestureRef.current) {
      clearGhost(overlayRef.current);
      clearTooltip(overlayRef.current);
    }
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
    if (inlineEditor) commitInlineEditor();

    if (findTitleAt(result, point.x, point.y)) {
      event.preventDefault();
      openTitleEditor();
      return;
    }

    if (findComposerAt(result, point.x, point.y)) {
      event.preventDefault();
      openComposerEditor();
      return;
    }

    const lineBreak = findLineBreakAt(result, point.x, point.y);
    if (lineBreak) {
      event.preventDefault();
      pendingPreviewRef.current = null;
      clearGhost(overlayRef.current);
      onAddLineBreak(lineBreak.afterMeasureIndex);
      return;
    }

    const overflowHit = findOverflowMarkAt(result, point.x, point.y);
    if (overflowHit) {
      event.preventDefault();
      renderTooltip(overlayRef.current, { x: overflowHit.x, y: overflowHit.y, text: '마디가 가득 찼습니다' });
      window.setTimeout(() => clearTooltip(overlayRef.current), 2000);
      return;
    }

    const connectHandle = findConnectHandleAt(result, point.x, point.y);
    if (connectHandle) {
      event.preventDefault();
      touchGestureRef.current = {
        kind: 'connectDrag',
        source: { measureIndex: connectHandle.measureIndex, clef: connectHandle.clef, noteIndex: connectHandle.noteIndex },
        sourcePitchIndex: connectHandle.pitchIndex,
        x0: connectHandle.x,
        y0: connectHandle.y,
      };
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
      openChordAddEditor(band, point.x);
      return;
    }

    const lyricBand = findLyricBandAt(result, point.x, point.y);
    if (lyricBand) {
      event.preventDefault();
      openLyricAddEditor(lyricBand, point.x);
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
      const primaryPitch = note.pitches[0];
      const gesture: Extract<TouchGesture, { kind: 'note' }> = {
        kind: 'note',
        location,
        startX: point.x,
        startY: point.y,
        startLine: primaryPitch ? pitchToLine(location.clef, primaryPitch.letter, primaryPitch.octave) : 0,
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
      updateSymbolDrag(gesture, point);
      return;
    }

    if (gesture.kind === 'connectDrag') {
      event.preventDefault();
      const target = connectTargetAt(result, gesture.source, point.x, point.y);
      renderConnectPreview(overlayRef.current, { x0: gesture.x0, y0: gesture.y0, x1: point.x, y1: point.y, snapped: !!target });
      renderNearbyConnectCandidates(result, gesture.source, point.x, point.y);
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
      if (!gesture.moved) openSymbolEditor(gesture);
      clearGhost(overlayRef.current);
      return;
    }

    if (gesture.kind === 'connectDrag') {
      clearConnectPreview(overlayRef.current);
      clearConnectCandidates(overlayRef.current);
      if (point && result) {
        const target = connectTargetAt(result, gesture.source, point.x, point.y);
        if (target) onConnectNote(gesture.source, target.id, gesture.sourcePitchIndex, target.pitchIndex);
      }
      return;
    }

    if (gesture.kind === 'note') {
      if (gesture.mode === 'drag') {
        if (point && result) {
          const staff = result.staffHitboxes.find((s) => s.measureIndex === gesture.location.measureIndex && s.clef === gesture.location.clef);
          if (staff) {
            const { snappedLine } = pitchAt(gesture.location.clef, staff, point.y);
            onMoveNote(gesture.location, snappedLine - gesture.startLine, staff.full ? undefined : xFractionAt(staff, point.x));
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
        {inlineEditor && (
          <div className="staff-input-layer">
            <input
              key={inlineEditor.kind}
              className={`inline-score-input inline-score-input-${inlineEditor.kind} inline-score-input-${inlineEditor.align}`}
              style={{ left: inlineEditor.left, top: inlineEditor.top, width: inlineEditor.width }}
              value={inlineEditor.value}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setInlineEditor((prev) => (prev ? { ...prev, value: e.target.value } : prev))}
              onKeyDown={handleInlineKeyDown}
              onBlur={handleInlineBlur}
            />
          </div>
        )}
      </div>
    </div>
  );
}
