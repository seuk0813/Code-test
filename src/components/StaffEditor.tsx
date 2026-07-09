import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ForwardedRef } from 'react';
import type { Accidental, ChordSymbol, Clef, DurationValue, NoteLocation, Score } from '../types/score';
import {
  findChordAt,
  findChordBandAt,
  findComposerAt,
  findInsertIndex,
  findLineBreakAt,
  findLyricAt,
  findLyricBandAt,
  findNearbyNotesAt,
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
  isStaffMeasureFull,
  isStaffMeasureOverflow,
  lineToPitch,
  measureDurationBeats,
  measureStartBeat,
  noteBeats,
  pitchToLine,
  stemPointsUp,
} from '../lib/scoreUtils';
import {
  clearGhost,
  clearPlayback,
  clearTooltip,
  ledgerLinePositions,
  renderGhost,
  renderMarqueeBox,
  renderMarqueeHighlights,
  renderMeasureCompleteFlashes,
  renderPlayback,
  renderSeekBar,
  renderTooltip,
} from '../lib/ghostOverlay';
import type { EditTool } from './Toolbar';

const DRAG_THRESHOLD_PX = 4;
const HOLD_CYCLE_MS = 1000;
const TOUCH_PREVIEW_RADIUS = 22;
/** A new note placed within this many px of an existing note's X stacks onto it as a chord tone. */
const CHORD_MERGE_X = 16;
/** In note-select mode (see noteSelectMode), a staff click within this radius of an existing note selects it instead of adding a new one. */
const SELECT_MODE_RADIUS = 45;

const ZOOM_MIN = 1;
const ZOOM_MAX = 3;

const NEW_NOTE_COLOR = '#7a5cff';
const CHORD_COLOR = '#2f9e44';
const DRAG_COLOR = '#d6432b';

interface StaffEditorProps {
  score: Score;
  selected: NoteLocation | null;
  /** When the selected note is a chord, narrows the selection to one specific pitch (see App.tsx's handleSelectNote). */
  selectedPitchIndex: number | null;
  /** Notes multi-selected via a shift+drag rubber-band (for batch copy/paste). */
  marquee: NoteLocation[];
  /** Commits a rubber-band multi-selection (empty array clears it). */
  onMarqueeSelect: (locations: NoteLocation[]) => void;
  /** Chord symbols multi-selected via the same shift+drag rubber-band (for batch delete). */
  marqueeChords: { measureIndex: number; chordId: string }[];
  /** Commits a rubber-band multi-selection of chord symbols (empty array clears it). */
  onMarqueeChordSelect: (items: { measureIndex: number; chordId: string }[]) => void;
  /** Reports whether a placement preview is currently locked, so App's own
   * keyboard handler yields arrow/space to the preview while it is. */
  onPreviewLockChange: (locked: boolean) => void;
  /** Toggled by re-clicking the active duration button while nothing is selected (Toolbar). While true and nothing is selected, a staff click prefers selecting the nearest existing note over adding a new one. */
  noteSelectMode: boolean;
  editTool: EditTool;
  onSelectNote: (location: NoteLocation, pitchIndex?: number) => void;
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
  onMoveNote: (location: NoteLocation, deltaLine: number, x?: number, pitchIndex?: number | null) => void;
  /** Dragging a whole note onto another existing note in the same staff merges them into one chord. */
  onMergeNoteIntoChord: (location: NoteLocation, targetNoteIndex: number, deltaLine: number) => void;
  onTogglePitch: (location: NoteLocation, letter: string, octave: number) => void;
  onChangeDuration: (location: NoteLocation, duration: DurationValue) => void;
  onFocusMeasure: (measureIndex: number) => void;
  onAddLineBreak: (afterMeasureIndex: number) => void;
  onMoveChord: (measureIndex: number, chordId: string, offset: number) => void;
  onDeleteChord: (measureIndex: number, chordId: string) => void;
  onMoveLyric: (fromMeasureIndex: number, lyricId: string, offset: number, toMeasureIndex: number) => void;
  onDeleteLyric: (measureIndex: number, lyricId: string) => void;
  onDeselectNote: () => void;
  /** When playing, a clock returning elapsed transport seconds (drives the playhead). */
  playbackClock: { get: () => number } | null;
  /** Beat position of the draggable "start playback here" bar. */
  seekBeat: number;
  onSeekBeat: (beat: number) => void;
  /** Inline editing directly on the score: title, composer, and adding/editing chords & lyrics in place. */
  onSetTitle: (title: string) => void;
  onSetComposer: (composer: string) => void;
  onAddChordAt: (measureIndex: number, text: string, offset: number) => void;
  onEditChordText: (measureIndex: number, chordId: string, text: string) => void;
  onAddLyricAt: (measureIndex: number, text: string, offset: number) => void;
  onEditLyricText: (measureIndex: number, lyricId: string, text: string) => void;
}

/** Imperative API for the toolbar chord-builder: fill the currently-open chord text box in place, if one is open. */
export interface StaffEditorHandle {
  /** Replaces the value of the currently-open chord add/edit box with `text`. Returns false (no-op) if no chord editor is open. */
  fillActiveChordEditor(text: string): boolean;
  /** Opens a locked placement preview adjacent to `location` (see openAdjacentPreview). Returns false if there's nowhere to put it. */
  openAdjacentPreview(location: NoteLocation, direction: 1 | -1): boolean;
  /** Opens a locked placement preview at the start of `targetMeasureIndex` (see openMeasurePreview). Returns false if that measure/clef doesn't exist. */
  openMeasurePreview(location: NoteLocation, targetMeasureIndex: number): boolean;
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
      /** Set when this gesture re-clicks/re-drags an already-selected chord's specific notehead (see G9/G10) — narrows both selection and move to just that one pitch. */
      narrowedPitchIndex?: number;
      mode: 'undetermined' | 'drag' | 'durationCycle';
      cycleDuration: DurationValue;
    }
  | {
      /** Shift+drag rubber-band that multi-selects every notehead inside it. */
      kind: 'marquee';
      startX: number;
      startY: number;
      curX: number;
      curY: number;
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
      startLine: number;
      narrowedPitchIndex?: number;
      mode: 'undetermined' | 'drag' | 'durationCycle';
      cycleDuration: DurationValue;
    }
  | SymbolDrag
  | null;

function StaffEditorInner({
  score,
  selected,
  selectedPitchIndex,
  marquee,
  onMarqueeSelect,
  marqueeChords,
  onMarqueeChordSelect,
  onPreviewLockChange,
  noteSelectMode,
  editTool,
  onSelectNote,
  onAddNote,
  onDeleteNote,
  onMoveNote,
  onMergeNoteIntoChord,
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
  seekBeat,
  onSeekBeat,
  onSetTitle,
  onSetComposer,
  onAddChordAt,
  onEditChordText,
  onAddLyricAt,
  onEditLyricText,
}: StaffEditorProps, ref: ForwardedRef<StaffEditorHandle>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  // .staff-stack (spacer, real layout size = logical size × zoom, so
  // .staff-scroll's overflow-x scrollbar actually reaches the zoomed-in
  // content) wraps .staff-zoom-layer (the thing actually visually scaled via
  // CSS transform — a plain transform alone wouldn't grow the scrollable
  // area, since it doesn't affect layout size).
  const stackRef = useRef<HTMLDivElement>(null);
  const zoomLayerRef = useRef<HTMLDivElement>(null);
  const renderResultRef = useRef<RenderResult | null>(null);
  const suppressClickRef = useRef(false);

  // Mobile pinch-zoom, applied imperatively via the refs above — the same
  // pattern already used for ghost/preview overlays — so a continuous pinch
  // doesn't trigger a React re-render per touchmove. zoomRef is the single
  // source of truth; eventPoint divides by it so all hit-testing keeps
  // working in logical (unzoomed) SVG coordinates.
  //
  // (Double-tap-to-zoom was tried too, but a quick double-tap at the same
  // spot is indistinguishable from confirming a note preview or re-tapping
  // a tie/slur curve to select it — it silently ate those taps instead, so
  // it was removed. Pinch covers "확대/축소" without that conflict.)
  const zoomRef = useRef(1);
  const pinchRef = useRef<{ startDist: number; startZoom: number } | null>(null);

  /** Resizes the .staff-stack spacer to the current logical size × zoom, so the scroll area actually covers the zoomed-in content. */
  const syncZoomSpacerSize = () => {
    const result = renderResultRef.current;
    if (!stackRef.current || !result) return;
    stackRef.current.style.width = `${result.width * zoomRef.current}px`;
    stackRef.current.style.height = `${result.height * zoomRef.current}px`;
  };

  /** Scales to `zoom` (clamped) anchored at the given screen point — adjusts staff-scroll's scroll offset so that point stays under the finger. */
  const applyZoomAt = (zoom: number, clientX: number, clientY: number) => {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
    const scrollEl = stackRef.current?.parentElement;
    const ratio = clamped / zoomRef.current;
    zoomRef.current = clamped;
    if (zoomLayerRef.current) zoomLayerRef.current.style.transform = `scale(${clamped})`;
    syncZoomSpacerSize();
    if (scrollEl && ratio !== 1) {
      const rect = scrollEl.getBoundingClientRect();
      const offsetX = clientX - rect.left + scrollEl.scrollLeft;
      const offsetY = clientY - rect.top + scrollEl.scrollTop;
      scrollEl.scrollLeft = offsetX * ratio - (clientX - rect.left);
      scrollEl.scrollTop = offsetY * ratio - (clientY - rect.top);
    }
  };
  const [draggingNote, setDraggingNote] = useState<DraggingNote | null>(null);
  const [inlineEditor, setInlineEditor] = useState<InlineEditor | null>(null);
  const inlineCancelledRef = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      fillActiveChordEditor(text: string) {
        if (!inlineEditor || (inlineEditor.kind !== 'chordAdd' && inlineEditor.kind !== 'chordEdit')) return false;
        setInlineEditor({ ...inlineEditor, value: text });
        return true;
      },
      openAdjacentPreview(location: NoteLocation, direction: 1 | -1) {
        return openAdjacentPreview(location, direction);
      },
      openMeasurePreview(location: NoteLocation, targetMeasureIndex: number) {
        return openMeasurePreview(location, targetMeasureIndex);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inlineEditor, score],
  );

  const mouseGestureRef = useRef<MouseGesture>(null);
  const mouseHoldRef = useRef<number | null>(null);
  // Right-mouse hold-to-lower-pitch on an existing note (mirrors the left
  // mouse's hold-to-cycle-duration): held down, it steps the note's pitch
  // down once per HOLD_CYCLE_MS tick. A quick right click (the hold never
  // fires) still deletes the note as before — see handleContextMenu.
  const rightHoldLocationRef = useRef<NoteLocation | null>(null);
  const rightHoldFiredRef = useRef(false);
  const rightHoldIntervalRef = useRef<number | null>(null);

  const pendingPreviewRef = useRef<PendingPreview | null>(null);
  const touchGestureRef = useRef<TouchGesture>(null);
  const touchHoldRef = useRef<number | null>(null);
  const playbackRafRef = useRef<number | null>(null);
  const seekDraggingRef = useRef(false);

  // The currently-sounding note per staff during playback (null when playing
  // a rest, or when not playing at all). Recoloring the real VexFlow note via
  // this — rather than a separately-computed overlay position — is what
  // guarantees the highlight is always pixel-perfectly aligned with the note.
  const [playingLocations, setPlayingLocations] = useState<{ treble: NoteLocation | null; bass: NoteLocation | null } | null>(
    null,
  );

  // Click-to-lock placement: the first click on empty staff LOCKS a preview
  // here (instead of placing immediately); arrow keys nudge it, and a second
  // click or spacebar commits it. Held in a ref too so the keydown listener and
  // mouse handlers read the current value without stale closures.
  const [lockedPreview, setLockedPreview] = useState<{ measureIndex: number; clef: Clef; line: number; x: number } | null>(null);
  const lockedPreviewRef = useRef<typeof lockedPreview>(null);
  lockedPreviewRef.current = lockedPreview;

  useEffect(() => {
    if (!containerRef.current) return;
    const result = renderScore(containerRef.current, score, selected, draggingNote, playingLocations, selectedPitchIndex);
    renderResultRef.current = result;
    if (overlayRef.current) {
      overlayRef.current.setAttribute('width', String(result.width));
      overlayRef.current.setAttribute('height', String(result.height));
      overlayRef.current.setAttribute('viewBox', `0 0 ${result.width} ${result.height}`);
    }
    // Keep the zoom spacer's real (scrollable) size matching the score's
    // current content size at whatever zoom level is already active — e.g.
    // adding a measure while zoomed in should widen the scrollable area too.
    syncZoomSpacerSize();
  }, [score, selected, draggingNote, playingLocations, selectedPitchIndex]);

  // Green checkmark that flashes over a measure the instant its beat count
  // exactly fills the time signature (editing further past that, or back out
  // of it, doesn't re-trigger it — only the false→true transition does).
  const prevCompleteMeasuresRef = useRef<Set<number>>(new Set());
  const [measureFlashes, setMeasureFlashes] = useState<{ id: number; measureIndex: number }[]>([]);
  const flashIdRef = useRef(0);

  useEffect(() => {
    const current = new Set<number>();
    score.measures.forEach((measure, measureIndex) => {
      const staffComplete = (sm: typeof measure.treble) =>
        isStaffMeasureFull(sm, score.timeSignature) && !isStaffMeasureOverflow(sm, score.timeSignature);
      if (staffComplete(measure.treble) || staffComplete(measure.bass)) current.add(measureIndex);
    });
    const prev = prevCompleteMeasuresRef.current;
    const newlyCompleted = [...current].filter((mi) => !prev.has(mi));
    prevCompleteMeasuresRef.current = current;
    if (newlyCompleted.length === 0) return;
    const additions = newlyCompleted.map((measureIndex) => ({ id: flashIdRef.current++, measureIndex }));
    setMeasureFlashes((prevFlashes) => [...prevFlashes, ...additions]);
    additions.forEach(({ id }) => {
      window.setTimeout(() => {
        setMeasureFlashes((prevFlashes) => prevFlashes.filter((f) => f.id !== id));
      }, 3200);
    });
  }, [score]);

  useEffect(() => {
    const result = renderResultRef.current;
    if (!overlayRef.current || !result) return;
    const specs = measureFlashes
      .map(({ id, measureIndex }) => {
        const treble = result.staffHitboxes.find((s) => s.measureIndex === measureIndex && s.clef === 'treble');
        return treble ? { id, x: treble.x1 - 12, y: treble.y0 - 14 } : null;
      })
      .filter((s): s is { id: number; x: number; y: number } => s !== null);
    renderMeasureCompleteFlashes(overlayRef.current, specs);
  }, [measureFlashes, score, selected, draggingNote, playingLocations, selectedPitchIndex]);

  // Blue highlight blobs over each marquee-selected notehead. Redrawn whenever
  // the selection or the score layout changes (the overlay group persists by
  // id, so it survives the score's own re-renders).
  useEffect(() => {
    const result = renderResultRef.current;
    if (!overlayRef.current) return;
    const spots: { x: number; y: number; rx?: number; ry?: number }[] = [];
    if (result) {
      marquee.forEach((loc) => {
        const hb = result.noteHitboxes.find(
          (n) => n.measureIndex === loc.measureIndex && n.clef === loc.clef && n.noteIndex === loc.noteIndex,
        );
        if (hb) hb.ys.forEach((y) => spots.push({ x: hb.centerX, y }));
      });
      marqueeChords.forEach((sel) => {
        const hb = result.chordHitboxes.find((c) => c.measureIndex === sel.measureIndex && c.chordId === sel.chordId);
        if (hb) spots.push({ x: hb.x, y: hb.y - 6, rx: hb.halfWidth, ry: 12 });
      });
    }
    renderMarqueeHighlights(overlayRef.current, spots);
  }, [marquee, marqueeChords, score, selected, draggingNote, playingLocations, selectedPitchIndex]);

  // Keep the locked-preview ghost drawn (and tell App the lock state so it
  // yields arrow/space to the preview) whenever it or the active tool changes.
  useEffect(() => {
    onPreviewLockChange(lockedPreview !== null);
    if (lockedPreview) renderLockedGhost(lockedPreview);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedPreview, editTool, score]);

  // While a preview is locked, arrow keys nudge it (↑↓ pitch, ←→ horizontal),
  // spacebar/Enter commits it, and Escape cancels — see the click-to-lock model.
  useEffect(() => {
    if (!lockedPreview) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const lp = lockedPreviewRef.current;
      const result = renderResultRef.current;
      if (!lp || !result) return;
      const staff = result.staffHitboxes.find((s) => s.measureIndex === lp.measureIndex && s.clef === lp.clef);
      if (!staff) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        setLockedPreview({ ...lp, line: lp.line + (e.key === 'ArrowUp' ? 0.5 : -0.5) });
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = staff.noteAreaWidth / 8;
        const nx = lp.x + (e.key === 'ArrowRight' ? step : -step);
        setLockedPreview({ ...lp, x: Math.min(staff.noteStartX + staff.noteAreaWidth, Math.max(staff.noteStartX, nx)) });
      } else if (e.code === 'Space' || e.key === 'Enter') {
        e.preventDefault();
        commitLockedPreview();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setLockedPreview(null);
        clearGhost(overlayRef.current);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedPreview]);

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
        let beat = measureStartBeat(score, measureIndex);
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
        bars.push({ x: seg.x, y0: staff.refY0 - staff.spacing * 7.4, y1: staff.refY0 + staff.spacing * 1.4 });
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
    // rect is the on-screen (already-scaled) box when zoomed in on mobile —
    // divide back out so hit-testing keeps working in the logical SVG
    // coordinates every hitbox/handler already assumes, at any zoom level.
    return { x: (event.clientX - rect.left) / zoomRef.current, y: (event.clientY - rect.top) / zoomRef.current };
  };

  // --- Playback seek bar ------------------------------------------------------

  const seekBarSpec = () => {
    const result = renderResultRef.current;
    if (!result) return null;
    // Measures can have unequal beat-widths (a 못갖춘마디/pickup first measure
    // spans fewer beats than the time signature's capacity), so find which
    // measure seekBeat falls into by walking cumulative start times instead of
    // a single division.
    let mi = score.measures.length - 1;
    for (let i = 0; i < score.measures.length; i++) {
      if (seekBeat < measureStartBeat(score, i) + measureDurationBeats(score, i) - 1e-9) {
        mi = i;
        break;
      }
    }
    const frac = Math.min(1, Math.max(0, (seekBeat - measureStartBeat(score, mi)) / Math.max(1e-9, measureDurationBeats(score, mi))));
    const treble = result.staffHitboxes.find((s) => s.measureIndex === mi && s.clef === 'treble');
    const bass = result.staffHitboxes.find((s) => s.measureIndex === mi && s.clef === 'bass');
    if (!treble || !bass) return null;
    const x = treble.noteStartX + frac * treble.noteAreaWidth;
    // The bar overhangs the treble's top line and the bass's bottom line by the
    // SAME small amount, so it visually pokes out equally above and below the
    // grand staff. (Both clefs' top line = refY0 - spacing*5, bottom = refY0 -
    // spacing*1, verified against VexFlow's rendered lines.)
    const overhang = treble.spacing * 1.2;
    const y0 = treble.refY0 - treble.spacing * 5 - overhang;
    const y1 = bass.refY0 - bass.spacing * 1 + overhang;
    return { x, y0, y1 };
  };

  const nearSeekHandle = (point: { x: number; y: number }) => {
    const spec = seekBarSpec();
    if (!spec) return false;
    // Grab region is the knob just above the top of the bar, kept tight in x
    // so it rarely collides with note/chord placement at the same column.
    return Math.abs(point.x - spec.x) <= 10 && point.y >= spec.y0 - 16 && point.y <= spec.y0 + 12;
  };

  /** Maps a pointer position to a beat, snapped to the nearest note onset (or downbeat) in the measure under it. */
  const xyToSeekBeat = (x: number, y: number): number | null => {
    const result = renderResultRef.current;
    if (!result) return null;
    const trebles = result.staffHitboxes.filter((s) => s.clef === 'treble');
    // Row under the pointer: the treble whose x-range contains x, nearest in y.
    let hb = trebles
      .filter((s) => x >= s.x0 && x <= s.x1)
      .sort((a, b) => Math.abs(y - a.refY0) - Math.abs(y - b.refY0))[0];
    if (!hb) hb = trebles.sort((a, b) => Math.abs(x - (a.x0 + a.x1) / 2) - Math.abs(x - (b.x0 + b.x1) / 2))[0];
    if (!hb) return null;
    const frac = Math.min(1, Math.max(0, (x - hb.noteStartX) / hb.noteAreaWidth));
    const measureStart = measureStartBeat(score, hb.measureIndex);
    const rawBeat = measureStart + frac * measureDurationBeats(score, hb.measureIndex);
    // Candidate onsets: the downbeat plus each note's cumulative onset.
    const onsets = [measureStart];
    let b = measureStart;
    score.measures[hb.measureIndex].treble.notes.forEach((note) => {
      onsets.push(b);
      b += noteBeats(note);
    });
    return onsets.reduce((best, o) => (Math.abs(o - rawBeat) < Math.abs(best - rawBeat) ? o : best), onsets[0]);
  };

  // Render the seek bar whenever its position or the score layout changes
  // (hidden while playing — the red playhead takes over then).
  useEffect(() => {
    renderSeekBar(overlayRef.current, playbackClock ? null : seekBarSpec());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekBeat, score, selected, draggingNote, playingLocations, selectedPitchIndex, playbackClock]);

  // --- Shared placement helpers -----------------------------------------------

  const pitchAt = (clef: Clef, staff: StaffHitbox, y: number) => {
    const snappedLine = Math.round(lineAt(staff, y) * 2) / 2;
    const { letter, octave } = lineToPitch(clef, snappedLine);
    return { snappedLine, letter, octave };
  };

  /**
   * A press that lands on a chord's specific notehead while that SAME chord
   * is already selected narrows the gesture to just that one pitch (G9/G10)
   * — clicking again selects only it, dragging moves only it. A press on a
   * not-yet-selected note (or a single-pitch note) applies to the whole note.
   */
  const resolveNarrowedPitchIndex = (location: NoteLocation, pressY: number): number | undefined => {
    const isSameNoteAlreadySelected =
      selected &&
      selected.measureIndex === location.measureIndex &&
      selected.clef === location.clef &&
      selected.noteIndex === location.noteIndex;
    if (!isSameNoteAlreadySelected) return undefined;
    const note = score.measures[location.measureIndex][location.clef].notes[location.noteIndex];
    if (!note || note.pitches.length <= 1) return undefined;
    const hb = renderResultRef.current?.noteHitboxes.find(
      (n) => n.measureIndex === location.measureIndex && n.clef === location.clef && n.noteIndex === location.noteIndex,
    );
    return hb ? nearestPitchIndexAt(hb, pressY) : undefined;
  };

  /**
   * Resolves a staff click, but in note-select mode (with nothing already
   * selected) an "add" result is redirected to the nearest existing note
   * within SELECT_MODE_RADIUS instead — clicking the staff selects rather
   * than adding, so it's not so easy to place a stray note while just
   * trying to pick one out of a cluster. If nothing is nearby, the click is
   * simply ignored (still no new note placed).
   */
  const resolveClickPreferSelect = (result: RenderResult, x: number, y: number) => {
    const click = resolveClick(result, x, y);
    if (!noteSelectMode || selected || !click || click.type !== 'add') return click;
    const nearest = findNearbyNotesAt(result, x, y, SELECT_MODE_RADIUS)[0];
    if (!nearest) return null;
    return { type: 'select' as const, measureIndex: nearest.measureIndex, clef: nearest.clef, noteIndex: nearest.noteIndex };
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

  /** Draws the locked placement preview (a stronger, more opaque ghost than the
   * hover preview) at a locked position. */
  const renderLockedGhost = (lp: { measureIndex: number; clef: Clef; line: number; x: number }) => {
    const result = renderResultRef.current;
    if (!result) return;
    const staff = result.staffHitboxes.find((s) => s.measureIndex === lp.measureIndex && s.clef === lp.clef);
    if (!staff) return;
    const isChord = chordMergeTargetAt(lp.measureIndex, lp.clef, lp.x) !== null;
    renderGhost(overlayRef.current, {
      kind: 'note',
      x: lp.x,
      y: staff.refY0 - lp.line * staff.spacing,
      duration: editTool.duration,
      isRest: editTool.isRest && !isChord,
      stemUp: stemPointsUp(lp.line),
      accidental: editTool.accidental,
      ledgerLineYs: ledgerLinePositions(lp.line).map((l) => staff.refY0 - l * staff.spacing),
      opacity: 0.85,
      color: '#7a5cff',
    });
  };

  /** Commits the locked preview into a real note using the active toolbar tool. */
  const commitLockedPreview = () => {
    const lp = lockedPreviewRef.current;
    const result = renderResultRef.current;
    if (!lp || !result) {
      setLockedPreview(null);
      return;
    }
    const staff = result.staffHitboxes.find((s) => s.measureIndex === lp.measureIndex && s.clef === lp.clef);
    if (staff) commitAdd(lp.measureIndex, lp.clef, staff, lp.line, lp.x, editTool.duration);
    setLockedPreview(null);
    clearGhost(overlayRef.current);
  };

  /** Opens a locked placement preview right after (direction=1) or before
   * (direction=-1) the given note — lets continuous keyboard-only note entry
   * chain off a just-placed note (App calls this for Left/Right when the
   * selection is still the note it just committed). Crosses into the next/
   * previous measure when the step would run off this one's note area.
   * Returns false when there's nowhere sensible to place it (so the caller
   * can fall back to its normal arrow-key behavior). */
  const openAdjacentPreview = (location: NoteLocation, direction: 1 | -1): boolean => {
    const result = renderResultRef.current;
    const note = score.measures[location.measureIndex]?.[location.clef].notes[location.noteIndex];
    if (!result || !note) return false;
    const hitbox = result.noteHitboxes.find(
      (h) => h.measureIndex === location.measureIndex && h.clef === location.clef && h.noteIndex === location.noteIndex,
    );
    const staff = result.staffHitboxes.find((s) => s.measureIndex === location.measureIndex && s.clef === location.clef);
    if (!hitbox || !staff) return false;
    const line = note.pitches.length > 0 ? pitchToLine(location.clef, note.pitches[0].letter, note.pitches[0].octave) : 0;
    const step = staff.noteAreaWidth / 8;
    let nx = hitbox.centerX + step * direction;
    let measureIndex = location.measureIndex;
    let targetStaff = staff;
    if (direction > 0 && nx > staff.noteStartX + staff.noteAreaWidth) {
      const nextStaff = result.staffHitboxes.find((s) => s.measureIndex === measureIndex + 1 && s.clef === location.clef);
      if (nextStaff) {
        measureIndex += 1;
        targetStaff = nextStaff;
        nx = nextStaff.noteStartX + step;
      }
    } else if (direction < 0 && nx < staff.noteStartX) {
      const prevStaff = result.staffHitboxes.find((s) => s.measureIndex === measureIndex - 1 && s.clef === location.clef);
      if (prevStaff) {
        measureIndex -= 1;
        targetStaff = prevStaff;
        nx = prevStaff.noteStartX + prevStaff.noteAreaWidth - step;
      }
    }
    nx = Math.min(targetStaff.noteStartX + targetStaff.noteAreaWidth, Math.max(targetStaff.noteStartX, nx));
    onFocusMeasure(measureIndex);
    setLockedPreview({ measureIndex, clef: location.clef, line, x: nx });
    return true;
  };

  /** Opens a locked placement preview at the START of `targetMeasureIndex`
   * (same clef and pitch line as `location`'s note) — Tab/Shift+Tab jump
   * straight to the next/previous measure instead of arrow-stepping through
   * whatever's left of the current one. Returns false if that measure or
   * clef doesn't exist. */
  const openMeasurePreview = (location: NoteLocation, targetMeasureIndex: number): boolean => {
    const result = renderResultRef.current;
    const note = score.measures[location.measureIndex]?.[location.clef].notes[location.noteIndex];
    const targetStaff = result?.staffHitboxes.find((s) => s.measureIndex === targetMeasureIndex && s.clef === location.clef);
    if (!result || !note || !targetStaff) return false;
    const line = note.pitches.length > 0 ? pitchToLine(location.clef, note.pitches[0].letter, note.pitches[0].octave) : 0;
    onFocusMeasure(targetMeasureIndex);
    setLockedPreview({ measureIndex: targetMeasureIndex, clef: location.clef, line, x: targetStaff.noteStartX });
    return true;
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
    setInlineEditor({ kind: 'title', left: hb.x - width / 2, top: 10, width, align: 'center', value: score.title });
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
    } else if (event.key === 'Tab' && inlineEditor && (inlineEditor.kind === 'chordAdd' || inlineEditor.kind === 'chordEdit')) {
      // Commit the current chord (editing it, adding it, or — when cleared —
      // deleting it) and jump to the next chord. If one already exists ahead
      // of this position, open it for editing so a run of existing chords
      // can be reviewed/deleted one after another with just Tab. Otherwise
      // fall back to a fresh empty slot so a brand-new run can still be typed.
      event.preventDefault();
      const ed = inlineEditor;
      const currentMeasureIndex = ed.measureIndex;
      const currentOffset =
        ed.kind === 'chordAdd' ? ed.offset : (score.measures[ed.measureIndex]?.chords.find((c) => c.id === ed.chordId)?.offset ?? 0);
      commitInlineEditor();
      const result = renderResultRef.current;
      if (!result) return;

      let nextExisting: { measureIndex: number; chord: ChordSymbol } | null = null;
      for (let mi = currentMeasureIndex; mi < score.measures.length; mi++) {
        const chords = [...(score.measures[mi]?.chords ?? [])].sort((a, b) => a.offset - b.offset);
        const candidates = mi === currentMeasureIndex ? chords.filter((c) => c.offset > currentOffset + 1e-6) : chords;
        if (candidates.length > 0) {
          nextExisting = { measureIndex: mi, chord: candidates[0] };
          break;
        }
      }
      if (nextExisting) {
        const band = result.chordBandHitboxes.find((b) => b.measureIndex === nextExisting!.measureIndex);
        if (!band) return;
        setInlineEditor({
          kind: 'chordEdit',
          measureIndex: nextExisting.measureIndex,
          chordId: nextExisting.chord.id,
          left: band.measureX + nextExisting.chord.offset * band.measureWidth - 45,
          top: (band.y0 + band.y1) / 2 - 8,
          width: 90,
          align: 'center',
          value: chordLabel(nextExisting.chord),
        });
        return;
      }

      const step = 0.18;
      let nextMeasureIndex = currentMeasureIndex;
      let nextOffset = currentOffset + step;
      if (nextOffset > 0.95) {
        nextMeasureIndex += 1;
        nextOffset = 0.05;
      }
      const band = result.chordBandHitboxes.find((b) => b.measureIndex === nextMeasureIndex);
      if (!band) return;
      setInlineEditor({
        kind: 'chordAdd',
        measureIndex: nextMeasureIndex,
        offset: nextOffset,
        left: band.measureX + nextOffset * band.measureWidth - 45,
        top: (band.y0 + band.y1) / 2 - 8,
        width: 90,
        align: 'center',
        value: '',
      });
    }
  };

  // --- Mouse (desktop) interactions -------------------------------------------

  const handleSeekDocMouseMove = (event: MouseEvent) => {
    if (!seekDraggingRef.current) return;
    const point = eventPoint(event);
    if (!point) return;
    const beat = xyToSeekBeat(point.x, point.y);
    if (beat !== null) onSeekBeat(beat);
  };

  const handleSeekDocMouseUp = () => {
    seekDraggingRef.current = false;
    document.removeEventListener('mousemove', handleSeekDocMouseMove);
    document.removeEventListener('mouseup', handleSeekDocMouseUp);
  };

  const handleDocumentMouseMove = (event: MouseEvent) => {
    const gesture = mouseGestureRef.current;
    const result = renderResultRef.current;
    if (!gesture || !result) return;
    const point = eventPoint(event);
    if (!point) return;

    if (gesture.kind === 'marquee') {
      gesture.curX = point.x;
      gesture.curY = point.y;
      renderMarqueeBox(overlayRef.current, { x0: gesture.startX, y0: gesture.startY, x1: point.x, y1: point.y });
      return;
    }

    if (gesture.kind === 'chordSymbol' || gesture.kind === 'lyric') {
      updateSymbolDrag(gesture, point);
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
        setDraggingNote({ ...gesture.location, pitchIndex: gesture.narrowedPitchIndex ?? null });
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
      renderDragGhost(staff, ghostX, snappedLine, note.duration, (note.pitches[gesture.narrowedPitchIndex ?? 0]?.accidental ?? '') as Accidental);
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

    if (gesture.kind === 'marquee') {
      renderMarqueeBox(overlayRef.current, null);
      const x0 = Math.min(gesture.startX, gesture.curX);
      const x1 = Math.max(gesture.startX, gesture.curX);
      const y0 = Math.min(gesture.startY, gesture.curY);
      const y1 = Math.max(gesture.startY, gesture.curY);
      const picked: NoteLocation[] = [];
      // A notehead counts as selected when any of its noteheads falls in the box.
      result.noteHitboxes.forEach((hb) => {
        if (hb.centerX < x0 || hb.centerX > x1) return;
        if (!hb.ys.some((y) => y >= y0 && y <= y1)) return;
        picked.push({ measureIndex: hb.measureIndex, clef: hb.clef, noteIndex: hb.noteIndex });
      });
      onMarqueeSelect(picked);
      // A chord symbol counts as selected when its label box (same box used
      // for click hit-testing, see findChordAt) overlaps the rubber-band.
      const pickedChords: { measureIndex: number; chordId: string }[] = [];
      result.chordHitboxes.forEach((hb) => {
        const cx0 = hb.x - hb.halfWidth;
        const cx1 = hb.x + hb.halfWidth;
        const cy0 = hb.y - 14;
        const cy1 = hb.y + 14;
        if (cx1 < x0 || cx0 > x1 || cy1 < y0 || cy0 > y1) return;
        pickedChords.push({ measureIndex: hb.measureIndex, chordId: hb.chordId });
      });
      onMarqueeChordSelect(pickedChords);
      suppressClickRef.current = true;
      return;
    }

    if (gesture.kind === 'chordSymbol' || gesture.kind === 'lyric') {
      commitSymbolDrag(gesture);
      if (!gesture.moved) openSymbolEditor(gesture);
      suppressClickRef.current = gesture.moved;
      clearGhost(overlayRef.current);
      return;
    }

    if (gesture.kind === 'add') {
      // Click-to-lock: a click on empty staff locks a preview there. Clicking
      // again ON THAT SAME PREVIEW commits it (spacebar/arrow keys handle it
      // in between); clicking anywhere else instead MOVES the lock there —
      // so the preview always follows the most recent click, and only a
      // deliberate second click on the same spot places the note.
      const lp = lockedPreviewRef.current;
      const sameSpot =
        !!lp &&
        lp.measureIndex === gesture.measureIndex &&
        lp.clef === gesture.clef &&
        lp.line === gesture.line &&
        Math.abs(lp.x - gesture.x) < TOUCH_PREVIEW_RADIUS;
      // Focus moves to this measure on every such click, not just on commit —
      // so a plain click marks "paste starts here" even before any note is placed.
      onFocusMeasure(gesture.measureIndex);
      if (sameSpot) {
        commitLockedPreview();
      } else {
        setLockedPreview({ measureIndex: gesture.measureIndex, clef: gesture.clef, line: gesture.line, x: gesture.x });
      }
      suppressClickRef.current = true;
      return;
    }

    if (gesture.kind !== 'note') return;
    if (gesture.mode === 'drag') {
      const staff = point
        ? result.staffHitboxes.find((s) => s.measureIndex === gesture.location.measureIndex && s.clef === gesture.location.clef)
        : undefined;
      if (point && staff) {
        const { snappedLine } = pitchAt(gesture.location.clef, staff, point.y);
        const deltaLine = snappedLine - gesture.startLine;
        // Dragging a whole (not narrowed-to-one-pitch) note onto another
        // existing note merges the two into a single chord instead of just
        // repositioning — two separate NoteEvents landing at the same x
        // would otherwise still play sequentially, not together.
        const isNarrowed = gesture.narrowedPitchIndex !== undefined && gesture.narrowedPitchIndex !== null;
        const sourceNote = score.measures[gesture.location.measureIndex][gesture.location.clef].notes[gesture.location.noteIndex];
        const mergeTarget =
          !isNarrowed && sourceNote && !sourceNote.isRest
            ? chordMergeTargetAt(gesture.location.measureIndex, gesture.location.clef, point.x, gesture.location.noteIndex)
            : null;
        if (mergeTarget !== null) {
          onMergeNoteIntoChord(gesture.location, mergeTarget, deltaLine);
        } else {
          const x = staff.full ? undefined : xFractionAt(staff, point.x);
          onMoveNote(gesture.location, deltaLine, x, gesture.narrowedPitchIndex ?? null);
        }
      }
      suppressClickRef.current = true;
      setDraggingNote(null);
      clearGhost(overlayRef.current);
    } else if (gesture.mode === 'durationCycle') {
      onChangeDuration(gesture.location, gesture.cycleDuration);
      suppressClickRef.current = true;
      clearGhost(overlayRef.current);
    } else {
      onSelectNote(gesture.location, gesture.narrowedPitchIndex);
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

  // The browser's own `contextmenu` event fires right after mousedown (not
  // after mouseup, and not after however long the button was held) — too
  // early and unreliable to gate "quick click vs. hold" on. So that decision
  // is made here instead, on the right button's mouseup: if the hold
  // interval never ticked (rightHoldFiredRef still false), it was a quick
  // click and the note gets deleted (matching the old contextmenu-delete
  // behavior); otherwise the hold already lowered its pitch and there's
  // nothing more to do.
  const handleRightMouseUp = () => {
    if (rightHoldIntervalRef.current !== null) {
      window.clearInterval(rightHoldIntervalRef.current);
      rightHoldIntervalRef.current = null;
    }
    const location = rightHoldLocationRef.current;
    const fired = rightHoldFiredRef.current;
    rightHoldLocationRef.current = null;
    rightHoldFiredRef.current = false;
    document.removeEventListener('mouseup', handleRightMouseUp);
    if (location && !fired) onDeleteNote(location);
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button === 2) {
      const result = renderResultRef.current;
      const point = eventPoint(event);
      if (!result || !point) return;
      event.preventDefault();
      const click = resolveClick(result, point.x, point.y);
      if (click?.type !== 'select') return;
      const location: NoteLocation = { measureIndex: click.measureIndex, clef: click.clef, noteIndex: click.noteIndex };
      const note = score.measures[location.measureIndex][location.clef].notes[location.noteIndex];
      if (!note || note.isRest || note.pitches.length === 0) return;
      rightHoldLocationRef.current = location;
      rightHoldFiredRef.current = false;
      rightHoldIntervalRef.current = window.setInterval(() => {
        rightHoldFiredRef.current = true;
        onMoveNote(location, -0.5);
      }, HOLD_CYCLE_MS);
      document.addEventListener('mouseup', handleRightMouseUp);
      return;
    }
    if (event.button !== 0) return;
    const result = renderResultRef.current;
    const point = eventPoint(event);
    if (!result || !point) return;
    event.preventDefault();
    clearGhost(overlayRef.current);
    if (inlineEditor) commitInlineEditor();

    // Shift+drag anywhere on the staff draws a rubber-band that multi-selects
    // every notehead inside it (for batch copy/paste). Takes priority over
    // note placement/selection so it works even when starting over a note.
    if (event.shiftKey) {
      mouseGestureRef.current = { kind: 'marquee', startX: point.x, startY: point.y, curX: point.x, curY: point.y };
      document.addEventListener('mousemove', handleDocumentMouseMove);
      document.addEventListener('mouseup', handleDocumentMouseUp);
      return;
    }

    if (nearSeekHandle(point)) {
      seekDraggingRef.current = true;
      document.addEventListener('mousemove', handleSeekDocMouseMove);
      document.addEventListener('mouseup', handleSeekDocMouseUp);
      return;
    }

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

    const click = resolveClickPreferSelect(result, point.x, point.y);
    if (!click) {
      if (lockedPreviewRef.current) {
        setLockedPreview(null);
        clearGhost(overlayRef.current);
      }
      onDeselectNote();
      return;
    }

    if (click.type === 'select') {
      // Selecting an existing note cancels any locked placement preview.
      if (lockedPreviewRef.current) {
        setLockedPreview(null);
        clearGhost(overlayRef.current);
      }
      const location: NoteLocation = { measureIndex: click.measureIndex, clef: click.clef, noteIndex: click.noteIndex };
      const note = score.measures[location.measureIndex][location.clef].notes[location.noteIndex];
      const narrowedPitchIndex = resolveNarrowedPitchIndex(location, point.y);
      const primaryPitch = narrowedPitchIndex !== undefined ? note.pitches[narrowedPitchIndex] : note.pitches[0];
      const gesture: Extract<MouseGesture, { kind: 'note' }> = {
        kind: 'note',
        location,
        startX: point.x,
        startY: point.y,
        startLine: primaryPitch ? pitchToLine(location.clef, primaryPitch.letter, primaryPitch.octave) : 0,
        narrowedPitchIndex,
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
    // When a preview is already locked, this click is the "commit" press — keep
    // the locked ghost on screen (don't overwrite it with a fresh hover ghost or
    // start a duration long-press). Otherwise show the normal hover preview.
    if (!lockedPreviewRef.current) {
      renderAddGhost(staff, point.x, snappedLine, editTool.duration, isChord);
      mouseHoldRef.current = window.setInterval(() => {
        const g = mouseGestureRef.current;
        if (!g || g.kind !== 'add') return;
        g.duration = cycleDurationLonger(g.duration);
        const chord = chordMergeTargetAt(g.measureIndex, g.clef, g.x) !== null;
        renderAddGhost(staff, g.x, g.line, g.duration, chord);
      }, HOLD_CYCLE_MS);
    }
    document.addEventListener('mousemove', handleDocumentMouseMove);
    document.addEventListener('mouseup', handleDocumentMouseUp);
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (mouseGestureRef.current) return; // active press handled by document listeners
    if (lockedPreviewRef.current) return; // a locked preview owns the ghost; don't hover-draw over it
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

    const click = resolveClickPreferSelect(result, point.x, point.y);
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

  // Note deletion for a right click is handled on mouseup (handleRightMouseUp)
  // instead of here — see its comment for why. This only still handles
  // chord/lyric right-click deletion, and suppresses the native menu.
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
    // Two fingers: start a pinch-zoom gesture instead, canceling whatever
    // single-touch gesture/preview was in flight from the first finger.
    if (event.touches.length === 2) {
      event.preventDefault();
      clearTouchHold();
      touchGestureRef.current = null;
      pendingPreviewRef.current = null;
      clearGhost(overlayRef.current);
      const [t0, t1] = [event.touches[0], event.touches[1]];
      pinchRef.current = { startDist: Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY), startZoom: zoomRef.current };
      return;
    }
    if (event.touches.length > 1) return;

    const result = renderResultRef.current;
    const touch = event.touches[0];
    const point = touch && eventPoint(touch);
    if (!result || !point) return;
    if (inlineEditor) commitInlineEditor();

    if (nearSeekHandle(point)) {
      event.preventDefault();
      seekDraggingRef.current = true;
      return;
    }

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

    const click = resolveClickPreferSelect(result, point.x, point.y);
    if (click?.type === 'select') {
      event.preventDefault();
      const location: NoteLocation = { measureIndex: click.measureIndex, clef: click.clef, noteIndex: click.noteIndex };
      const note = score.measures[location.measureIndex][location.clef].notes[location.noteIndex];
      const narrowedPitchIndex = resolveNarrowedPitchIndex(location, point.y);
      const primaryPitch = narrowedPitchIndex !== undefined ? note.pitches[narrowedPitchIndex] : note.pitches[0];
      const gesture: Extract<TouchGesture, { kind: 'note' }> = {
        kind: 'note',
        location,
        startX: point.x,
        startY: point.y,
        startLine: primaryPitch ? pitchToLine(location.clef, primaryPitch.letter, primaryPitch.octave) : 0,
        narrowedPitchIndex,
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
    if (event.touches.length === 2 && pinchRef.current) {
      event.preventDefault();
      const [t0, t1] = [event.touches[0], event.touches[1]];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const midX = (t0.clientX + t1.clientX) / 2;
      const midY = (t0.clientY + t1.clientY) / 2;
      applyZoomAt((pinchRef.current.startZoom * dist) / pinchRef.current.startDist, midX, midY);
      return;
    }

    if (seekDraggingRef.current) {
      event.preventDefault();
      const point = event.touches[0] && eventPoint(event.touches[0]);
      if (point) {
        const beat = xyToSeekBeat(point.x, point.y);
        if (beat !== null) onSeekBeat(beat);
      }
      return;
    }

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

    if (gesture.kind !== 'note' || gesture.mode === 'durationCycle') return;

    const dx = point.x - gesture.startX;
    const dy = point.y - gesture.startY;
    if (gesture.mode === 'undetermined') {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      clearTouchHold();
      gesture.mode = 'drag';
      setDraggingNote({ ...gesture.location, pitchIndex: gesture.narrowedPitchIndex ?? null });
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
    renderDragGhost(staff, ghostX, snappedLine, note.duration, (note.pitches[gesture.narrowedPitchIndex ?? 0]?.accidental ?? '') as Accidental);
  };

  const handleTouchEnd = (event: TouchEvent) => {
    if (event.touches.length < 2) pinchRef.current = null;
    if (pinchRef.current) return;
    if (seekDraggingRef.current) {
      seekDraggingRef.current = false;
      return;
    }
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

    if (gesture.kind === 'note') {
      if (gesture.mode === 'drag') {
        if (point && result) {
          const staff = result.staffHitboxes.find((s) => s.measureIndex === gesture.location.measureIndex && s.clef === gesture.location.clef);
          if (staff) {
            const { snappedLine } = pitchAt(gesture.location.clef, staff, point.y);
            const deltaLine = snappedLine - gesture.startLine;
            const isNarrowed = gesture.narrowedPitchIndex !== undefined && gesture.narrowedPitchIndex !== null;
            const sourceNote = score.measures[gesture.location.measureIndex][gesture.location.clef].notes[gesture.location.noteIndex];
            const mergeTarget =
              !isNarrowed && sourceNote && !sourceNote.isRest
                ? chordMergeTargetAt(gesture.location.measureIndex, gesture.location.clef, point.x, gesture.location.noteIndex)
                : null;
            if (mergeTarget !== null) {
              onMergeNoteIntoChord(gesture.location, mergeTarget, deltaLine);
            } else {
              onMoveNote(gesture.location, deltaLine, staff.full ? undefined : xFractionAt(staff, point.x), gesture.narrowedPitchIndex ?? null);
            }
          }
        }
        setDraggingNote(null);
        clearGhost(overlayRef.current);
      } else if (gesture.mode === 'durationCycle') {
        onChangeDuration(gesture.location, gesture.cycleDuration);
        clearGhost(overlayRef.current);
      } else {
        onSelectNote(gesture.location, gesture.narrowedPitchIndex);
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
      <div className="staff-stack" ref={stackRef}>
        <div className="staff-zoom-layer" ref={zoomLayerRef}>
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
    </div>
  );
}

export const StaffEditor = forwardRef(StaffEditorInner);
