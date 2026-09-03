import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ForwardedRef } from 'react';
import type { Accidental, ChordSymbol, Clef, DurationValue, NoteLocation, PartId, Score } from '../types/score';
import {
  findChordAt,
  findChordBandAt,
  findComposerAt,
  findDegreeMarkAt,
  findGraceNoteAt,
  findInsertIndex,
  findLineBreakAt,
  findLyricAt,
  findLyricBandAt,
  findNearbyNotesAt,
  findRestMarkAt,
  findRestMarkHandleAt,
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
  activeParts,
  alternateDegreeSpelling,
  chordLabel,
  cycleDurationLonger,
  cycleDurationShorter,
  incompleteClefsIn,
  isStaffMeasureFull,
  isStaffMeasureOverflow,
  lineToPitch,
  measureCapacityBeats,
  measureDurationBeats,
  measureStartBeat,
  measureTimeSignature,
  noteBeats,
  pitchToLine,
  scaleDegreeKey,
  stemPointsUp,
} from '../lib/scoreUtils';
import {
  clearGhost,
  clearPlayback,
  clearTooltip,
  ledgerLinePositions,
  renderChordSnapGuide,
  renderGhost,
  renderMarqueeBox,
  renderMarqueeHighlights,
  renderMeasureCompleteFlashes,
  renderMeasureTools,
  renderMeasureWarnings,
  renderPickupHandles,
  renderPlayback,
  renderSeekBar,
} from '../lib/ghostOverlay';
import type { EditTool } from './Toolbar';

const DRAG_THRESHOLD_PX = 4;
/** Extra half-line-units of resistance a note drag's raw Y must clear beyond
 * the normal snap boundary before the pitch actually flips to a new line —
 * keeps a mostly-horizontal drag from accidentally nudging pitch on tiny
 * vertical jitter, while still tracking a deliberate vertical move fine. */
const STICKY_LINE_MARGIN = 0.12;
/** A chord symbol drag within this many px of an existing note's onset snaps to it (see chordSnapCandidates) — keeps a chord's stored offset exactly matching a real beat, so scale-degree labeling (which keys a note's chord off beat boundaries) can't land on the wrong side by a hair's-width drag. */
const CHORD_SNAP_THRESHOLD_PX = 24;
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
  /** Lyric syllables multi-selected via the same shift+drag rubber-band (for batch delete). */
  marqueeLyrics: { measureIndex: number; lyricId: string }[];
  /** Commits a rubber-band multi-selection of lyric syllables (empty array clears it). */
  onMarqueeLyricSelect: (items: { measureIndex: number; lyricId: string }[]) => void;
  /** Reports whether a placement preview is currently locked, so App's own
   * keyboard handler yields arrow/space to the preview while it is. */
  onPreviewLockChange: (locked: boolean) => void;
  /** Toggled by re-clicking the active duration button while nothing is selected (Toolbar). While true and nothing is selected, a staff click prefers selecting the nearest existing note over adding a new one. */
  noteSelectMode: boolean;
  editTool: EditTool;
  onSelectNote: (location: NoteLocation, pitchIndex?: number) => void;
  onAddNote: (
    measureIndex: number,
    clef: PartId,
    letter: string,
    octave: number,
    insertIndex: number,
    durationOverride?: DurationValue,
    x?: number,
    /** False for a keyboard-driven commit (spacebar chaining) — the new note stays unselected. Defaults to true. */
    selectAfterAdd?: boolean,
  ) => void;
  onDeleteNote: (location: NoteLocation) => void;
  /** Right-click deletes a visual-only rest mark (see RestMark / #187). */
  onDeleteRestMark: (measureIndex: number, restMarkId: string) => void;
  /** Hovering above/below an existing note with the 쉼표 tool armed sketches a rest mark there (see RestMark / #187). */
  onAddRestMark: (measureIndex: number, clef: Clef, offset: number, line: number, duration: DurationValue) => void;
  /** Currently-selected rest mark (see RestMark / #187) — click its glyph to select, click empty space to deselect. */
  selectedRestMark: { measureIndex: number; restMarkId: string } | null;
  onSelectRestMark: (location: { measureIndex: number; restMarkId: string } | null) => void;
  /** 도수 입력 모드 (see App): dims everything except the (enlarged) scale-degree marks. */
  degreeInputMode: boolean;
  /** Sets a per-note manual scale-degree label override (see setManualScaleDegreeLabel) — used when the user confirms switching a degree mark to its alternate spelling (e.g. b5 → #11). */
  onSetManualScaleDegree: (key: string, text: string) => void;
  /** Drag one of the selected mark's 4 corner handles to change its on-screen visual size (RestMark.scale). */
  onResizeRestMarkScale: (measureIndex: number, restMarkId: string, scale: number) => void;
  /** Drag the mark's own glyph to reposition it elsewhere on the score. */
  onMoveRestMark: (measureIndex: number, restMarkId: string, offset: number, line: number) => void;
  onMoveNote: (location: NoteLocation, deltaLine: number, x?: number, pitchIndex?: number | null) => void;
  /** Dragging a whole note onto another existing note in the same staff merges them into one chord. */
  onMergeNoteIntoChord: (location: NoteLocation, targetNoteIndex: number, deltaLine: number) => void;
  onTogglePitch: (location: NoteLocation, letter: string, octave: number) => void;
  /** Toggles a grace note (see 꾸밈음 toolbar button / editTool.graceNoteMode) on the note at `location`, at the given pitch. */
  onToggleGraceNote: (location: NoteLocation, letter: string, octave: number) => void;
  /** The host note (see NoteEvent.graceNote) whose grace note is currently selected — mutually exclusive with the normal note `selected`. */
  selectedGrace: NoteLocation | null;
  /** Selects (or, with null, deselects) a note's grace note — clicking directly on its small notehead. */
  onSelectGrace: (location: NoteLocation | null) => void;
  onChangeDuration: (location: NoteLocation, duration: DurationValue) => void;
  onFocusMeasure: (measureIndex: number) => void;
  /** The measure currently being worked in (App's focusedMeasureIndex) — kept at
   * full width regardless of how little is written yet, so adding a measure's
   * first note doesn't immediately cramp the room to add the next one. */
  focusedMeasureIndex: number | null;
  /** Hand-sizes one measure by dragging its right barline (see Measure.widthScale). */
  onResizeMeasure: (measureIndex: number, widthScale: number) => void;
  /** 자동정렬 button on a measure's barline: drops that measure's hand-dragged note Xs and width. */
  onAutoAlignMeasure: (measureIndex: number) => void;
  /** Red "!" badge on an under-filled measure: pads its short clefs out with rests. */
  onFillMeasureRests: (measureIndex: number) => void;
  onAddLineBreak: (afterMeasureIndex: number) => void;
  onMoveChord: (measureIndex: number, chordId: string, offset: number, toMeasureIndex: number) => void;
  /** Sets which melody note (see ChordSymbol.startNoteIndex) a chord starts harmonically applying from — chosen via its "적용 시작 음표 선택" UI, separate from dragging its label (onMoveChord, purely cosmetic). */
  onSetChordStartNote: (measureIndex: number, chordId: string, clef: PartId, noteIndex: number) => void;
  onDeleteChord: (measureIndex: number, chordId: string) => void;
  onMoveLyric: (fromMeasureIndex: number, lyricId: string, offset: number, toMeasureIndex: number) => void;
  onDeleteLyric: (measureIndex: number, lyricId: string) => void;
  onDeselectNote: () => void;
  /** When playing, a clock returning elapsed transport seconds (drives the playhead). */
  playbackClock: { get: () => number } | null;
  /** Beat position of the draggable "start playback here" bar. */
  seekBeat: number;
  onSeekBeat: (beat: number) => void;
  /** Drags the boundary between the 못갖춘마디(pickup) and the measure after it, resizing the pickup to end at the given beat. Only meaningful while score.pickupBeats is set. */
  onResizePickupMeasure: (newPickupBeats: number) => void;
  /** Mirrors onResizePickupMeasure for the boundary before the trailing partial closing measure — `splitBeat` is measured the same way as when the trailing measure was first created (see splitTrailingMeasure). Only meaningful while score.trailingBeats is set. */
  onResizeTrailingMeasure: (splitBeat: number) => void;
  /** Right-clicking the seek bar handle calls this to create/clear a 못갖춘마디(pickup) or trailing partial measure at the seek bar's current position (replaces the old always-visible toolbar toggle). */
  onTogglePickupOrTrailing: () => void;
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
  /** Pixel X the chord is currently snapped to (see chordSnapCandidates) — null while unsnapped/free, and always null for lyric drags. Drives the live guide line. */
  snappedX?: number | null;
}

// --- Additive (Ctrl/Cmd) multi-selection helpers -----------------------------
// A selected note/chord/lyric is identified by value, not by object identity,
// so toggling one in or out of a selection means comparing these keys.

const noteKey = (n: NoteLocation) => `${n.measureIndex}:${n.clef}:${n.noteIndex}`;
const chordKey = (c: { measureIndex: number; chordId: string }) => `${c.measureIndex}:${c.chordId}`;
const lyricKey = (l: { measureIndex: number; lyricId: string }) => `${l.measureIndex}:${l.lyricId}`;

/** `current` plus every entry of `added` it doesn't already hold — an additive
 * (Ctrl+drag) rubber-band never double-adds what it sweeps over twice. */
function mergeUnique<T>(current: T[], added: T[], key: (item: T) => string): T[] {
  const seen = new Set(current.map(key));
  return [...current, ...added.filter((item) => !seen.has(key(item)))];
}

/** `list` with `item` removed if it was there, appended if it wasn't — one Ctrl+click. */
function toggleEntry<T>(list: T[], item: T, key: (item: T) => string): T[] {
  const k = key(item);
  return list.some((existing) => key(existing) === k) ? list.filter((existing) => key(existing) !== k) : [...list, item];
}

/** Mouse press gesture in progress on the staff. */
type MouseGesture =
  | {
      kind: 'add';
      measureIndex: number;
      clef: PartId;
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
      /** The line currently "locked in" for the drag — starts equal to startLine and only updates once the pointer clears the sticky threshold (see stickyLineAt) so a mostly-horizontal drag doesn't flip pitch on tiny vertical jitter. */
      lastLine: number;
      /** How far the press landed from the notehead's own line, in line units — subtracted back out so a purely sideways drag keeps the pitch it started on no matter where inside the notehead it was grabbed (see stickyPitchAt). */
      grabLineOffset: number;
      /** Set when this gesture re-clicks/re-drags an already-selected chord's specific notehead (see G9/G10) — narrows both selection and move to just that one pitch. */
      narrowedPitchIndex?: number;
      mode: 'undetermined' | 'drag' | 'durationCycle';
      cycleDuration: DurationValue;
    }
  | {
      /** Shift+drag (or Ctrl/Cmd+drag) rubber-band that multi-selects every notehead inside it. */
      kind: 'marquee';
      startX: number;
      startY: number;
      curX: number;
      curY: number;
      /** Ctrl/Cmd instead of Shift: the box ADDS to whatever is already
       * selected rather than replacing it, and a Ctrl+click that never
       * dragged toggles just the one item under the pointer. */
      additive: boolean;
    }
  | {
      /** Drag one of a selected rest mark's 4 corner handles (see RestMark / #187) to change its visual scale. */
      kind: 'resizeRestMarkScale';
      measureIndex: number;
      restMarkId: string;
      /** The mark's own anchor point — distance from this drives the scale factor. */
      centerX: number;
      centerY: number;
      startDist: number;
      startScale: number;
    }
  | {
      /** Drag an existing rest mark's own glyph (see RestMark / #187) to reposition it. */
      kind: 'moveRestMark';
      measureIndex: number;
      clef: PartId;
      restMarkId: string;
      /** The mark's staff geometry, captured at drag-start so the math stays correct even if the cursor wanders outside the staff area mid-drag. */
      staffRefY0: number;
      staffSpacing: number;
      staffNoteStartX: number;
      staffNoteAreaWidth: number;
    }
  | SymbolDrag
  | null;

/** A touch tap-to-preview placement waiting for a confirming second tap. */
interface PendingPreview {
  measureIndex: number;
  clef: PartId;
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
      clef: PartId;
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
      lastLine: number;
      grabLineOffset: number;
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
  marqueeLyrics,
  onMarqueeLyricSelect,
  onPreviewLockChange,
  noteSelectMode,
  editTool,
  onSelectNote,
  onAddNote,
  onDeleteNote,
  onDeleteRestMark,
  onAddRestMark,
  selectedRestMark,
  onSelectRestMark,
  onResizeRestMarkScale,
  onMoveRestMark,
  degreeInputMode,
  onSetManualScaleDegree,
  onMoveNote,
  onMergeNoteIntoChord,
  onTogglePitch,
  onToggleGraceNote,
  selectedGrace,
  onSelectGrace,
  onChangeDuration,
  onFocusMeasure,
  focusedMeasureIndex,
  onResizeMeasure,
  onAutoAlignMeasure,
  onFillMeasureRests,
  onAddLineBreak,
  onMoveChord,
  onSetChordStartNote,
  onDeleteChord,
  onMoveLyric,
  onDeleteLyric,
  onDeselectNote,
  playbackClock,
  seekBeat,
  onSeekBeat,
  onResizePickupMeasure,
  onResizeTrailingMeasure,
  onTogglePickupOrTrailing,
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
  /** The scrollable viewport itself (.staff-scroll's parent of stackRef) — kept as
   * its own ref (rather than stackRef.current?.parentElement each time) so the
   * playback auto-follow below (see the playhead rAF loop) can read/set its
   * scroll position directly. */
  const staffScrollRef = useRef<HTMLDivElement>(null);
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
  /** While set, the next click on a melody note sets that chord's harmonic
   * start point (see onSetChordStartNote) instead of its usual action —
   * entered via the "적용 시작 음표 선택" button in a chord's edit popup. */
  const [pickingChordStart, setPickingChordStart] = useState<{ measureIndex: number; chordId: string } | null>(null);

  useEffect(() => {
    if (!pickingChordStart) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickingChordStart(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pickingChordStart]);

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
    [inlineEditor, score, editTool],
  );

  const mouseGestureRef = useRef<MouseGesture>(null);
  const mouseHoldRef = useRef<number | null>(null);
  // Right-mouse hold-to-shorten on an existing note (mirrors the left
  // mouse's hold-to-cycle-LONGER): held down, it steps the note's duration
  // one notch shorter once per HOLD_CYCLE_MS tick. A quick right click (the
  // hold never fires) still deletes the note as before — see handleContextMenu.
  const rightHoldLocationRef = useRef<NoteLocation | null>(null);
  const rightHoldFiredRef = useRef(false);
  const rightHoldIntervalRef = useRef<number | null>(null);
  /** The duration being cycled down through on this right-mouse hold — tracked locally (not re-read from score) so each tick reliably steps one further notch shorter than the last. */
  const rightHoldDurationRef = useRef<DurationValue | null>(null);

  const pendingPreviewRef = useRef<PendingPreview | null>(null);
  const touchGestureRef = useRef<TouchGesture>(null);
  const touchHoldRef = useRef<number | null>(null);
  const playbackRafRef = useRef<number | null>(null);
  const seekDraggingRef = useRef(false);
  /** Which boundary handle (if any) is currently being dragged to resize the pickup/trailing partial measure, and the drag's starting reference point (see startBoundaryResize). */
  const boundaryResizeRef = useRef<{ which: 'pickup' | 'trailing'; startX: number; startBeat: number; pxPerBeat: number } | null>(null);

  // The currently-sounding note per staff during playback (null when playing
  // a rest, or when not playing at all). Recoloring the real VexFlow note via
  // this — rather than a separately-computed overlay position — is what
  // guarantees the highlight is always pixel-perfectly aligned with the note.
  const [playingLocations, setPlayingLocations] = useState<Partial<Record<PartId, NoteLocation | null>> | null>(
    null,
  );

  // Click-to-lock placement: the first click on empty staff LOCKS a preview
  // here (instead of placing immediately); arrow keys nudge it, and a second
  // click or spacebar commits it. Held in a ref too so the keydown listener and
  // mouse handlers read the current value without stale closures.
  /**
   * The blue "next note goes here" preview.
   *
   * Its horizontal position is stored as a FRACTION of its measure's note
   * area, never as an absolute X. Measure widths are content-scaled and the
   * measure being worked in is held at full width (see the renderer's
   * computeRowMeasureWidths), so the moment focus moves — which is exactly
   * what Tab and a measure-crossing chain step do — the previous measure
   * shrinks and every measure after it slides sideways. An absolute X
   * captured a moment earlier is stale the instant that happens: it was
   * pinned to the START of the next measure and ended up two thirds of the
   * way into it, leaving room for only a few more notes.
   *
   * A fraction re-resolves against whatever the layout currently is, so the
   * preview stays where it was aimed no matter how the measures reflow.
   */
  /** One ←/→ nudge of the locked preview: an eighth of the measure's note area. */
  const PREVIEW_STEP_FRAC = 1 / 8;

  const [lockedPreview, setLockedPreview] = useState<{
    measureIndex: number;
    clef: PartId;
    line: number;
    /** 0 = the measure's note-area start, 1 = its end. See above. */
    xFrac: number;
    duration: DurationValue;
  } | null>(null);
  const lockedPreviewRef = useRef<typeof lockedPreview>(null);
  lockedPreviewRef.current = lockedPreview;
  /**
   * Set by commitAdd right after a locked-preview commit (plain note or
   * chord-tone stack) lands in the score — consumed by the effect below,
   * once the NEXT render has refreshed renderResultRef.current with the new
   * note's real geometry, to immediately open the next placement preview
   * right after it. This chains continuous note entry off a single
   * spacebar press (commit + advance) instead of needing a second keypress.
   */
  const pendingChainRef = useRef<NoteLocation | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const result = renderScore(containerRef.current, score, selected, draggingNote, playingLocations, selectedPitchIndex, selectedGrace, selectedRestMark, degreeInputMode, focusedMeasureIndex);
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
  }, [score, selected, draggingNote, playingLocations, selectedPitchIndex, selectedGrace, selectedRestMark, degreeInputMode, focusedMeasureIndex]);

  // Consumes pendingChainRef (see its declaration) the moment the render
  // above has refreshed renderResultRef.current for the just-committed note
  // — opening the next placement preview right after it, so a single
  // spacebar press both commits a note (or chord tone) AND advances to the
  // next slot, no second keypress needed.
  useEffect(() => {
    const loc = pendingChainRef.current;
    if (!loc) return;
    pendingChainRef.current = null;
    openAdjacentPreview(loc, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score]);

  // Green checkmark that flashes over a STAFF (treble or bass independently)
  // the instant its own beat count exactly fills the time signature (editing
  // further past that, or back out of it, doesn't re-trigger it — only the
  // false→true transition does). Tracked per (measureIndex, clef) rather
  // than per measure so a bass-only completion gets its own checkmark right
  // over the bass staff, not just a shared one anchored to the treble staff.
  const prevCompleteStavesRef = useRef<Set<string>>(new Set());
  const [measureFlashes, setMeasureFlashes] = useState<{ id: number; measureIndex: number; clef: PartId }[]>([]);
  const flashIdRef = useRef(0);

  useEffect(() => {
    const current = new Set<string>();
    score.measures.forEach((measure, measureIndex) => {
      const ts = measureTimeSignature(score, measureIndex);
      activeParts(score).forEach((clef) => {
        const sm = measure[clef];
        if (isStaffMeasureFull(sm, ts) && !isStaffMeasureOverflow(sm, ts)) {
          current.add(`${measureIndex}:${clef}`);
        }
      });
    });
    const prev = prevCompleteStavesRef.current;
    const newlyCompleted = [...current].filter((key) => !prev.has(key));
    prevCompleteStavesRef.current = current;
    if (newlyCompleted.length === 0) return;
    const additions = newlyCompleted.map((key) => {
      const [measureIndex, clef] = key.split(':');
      return { id: flashIdRef.current++, measureIndex: Number(measureIndex), clef: clef as PartId };
    });
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
      .map(({ id, measureIndex, clef }) => {
        const staff = result.staffHitboxes.find((s) => s.measureIndex === measureIndex && s.clef === clef);
        // staff.y0 is the click-region's top edge, which for the bass staff
        // sits at the shared midpoint between the two staves (not near the
        // bass staff itself) — refY0 (the staff's own top-line reference,
        // used for pitch math) anchors correctly to whichever staff actually
        // completed, treble or bass.
        return staff ? { id, x: staff.x1 - 12, y: staff.refY0 - 54 } : null;
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
      marqueeLyrics.forEach((sel) => {
        const hb = result.lyricHitboxes.find((l) => l.measureIndex === sel.measureIndex && l.lyricId === sel.lyricId);
        if (hb) spots.push({ x: hb.x, y: hb.y - 4, rx: hb.halfWidth, ry: 10 });
      });
    }
    renderMarqueeHighlights(overlayRef.current, spots);
  }, [marquee, marqueeChords, marqueeLyrics, score, selected, draggingNote, playingLocations, selectedPitchIndex]);

  // Keep the locked-preview ghost drawn (and tell App the lock state so it
  // yields arrow/space to the preview) whenever it or the active tool changes.
  useEffect(() => {
    onPreviewLockChange(lockedPreview !== null);
    if (lockedPreview) renderLockedGhost(lockedPreview);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedPreview, editTool, score]);

  // A locked preview's duration is normally frozen at whatever was armed
  // when it was created (see commitLockedPreview's comment — needed so a
  // mouse hold-cycle's chosen duration survives the commit). But a preview
  // can also sit open for a while afterward (auto-chained after the last
  // commit, or opened by Space off a selected note) while the user picks a
  // different duration in the toolbar — that later choice should win, so a
  // subsequent Space press places what the toolbar currently shows, not a
  // stale duration from before the toggle was touched (see #233).
  useEffect(() => {
    setLockedPreview((prev) => (prev && prev.duration !== editTool.duration ? { ...prev, duration: editTool.duration } : prev));
  }, [editTool.duration]);

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
      const staff = staffGeometryFor(result, lp.measureIndex, lp.clef);
      if (!staff) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        setLockedPreview({ ...lp, line: lp.line + (e.key === 'ArrowUp' ? 0.5 : -0.5) });
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const next = lp.xFrac + (e.key === 'ArrowRight' ? PREVIEW_STEP_FRAC : -PREVIEW_STEP_FRAC);
        setLockedPreview({ ...lp, xFrac: Math.min(1, Math.max(0, next)) });
      } else if (e.code === 'Space' || e.key === 'Enter') {
        e.preventDefault();
        commitLockedPreview();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
          // Select the note this preview was chained off of (immediately
          // before it, same measure/clef — or the previous measure's last
          // note if the preview sits at this one's very start), closing the
          // preview — the "edit what I just typed" move (item 5).
          const insertIdx = findInsertIndex(result, lp.measureIndex, lp.clef, previewXOn(staff, lp.xFrac));
          let prevLoc: NoteLocation | null = null;
          if (insertIdx > 0) {
            prevLoc = { measureIndex: lp.measureIndex, clef: lp.clef, noteIndex: insertIdx - 1 };
          } else {
            for (let mi = lp.measureIndex - 1; mi >= 0; mi--) {
              const notes = score.measures[mi]?.[lp.clef].notes ?? [];
              if (notes.length > 0) {
                prevLoc = { measureIndex: mi, clef: lp.clef, noteIndex: notes.length - 1 };
                break;
              }
            }
          }
          setLockedPreview(null);
          clearGhost(overlayRef.current);
          if (prevLoc) onSelectNote(prevLoc);
        } else {
          // A second Tab, while the preview is already open — jump it to the
          // start of the next measure instead of just nudging it (item 7).
          const nextStaff = result.staffHitboxes.find((s) => s.measureIndex === lp.measureIndex + 1 && s.clef === lp.clef);
          if (nextStaff) {
            onFocusMeasure(lp.measureIndex + 1);
            setLockedPreview({ ...lp, measureIndex: lp.measureIndex + 1, xFrac: 0 });
          }
        }
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
    const buildTimeline = (clef: PartId): Seg[] => {
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
    const timelines = Object.fromEntries(activeParts(score).map((part) => [part, buildTimeline(part)])) as Record<PartId, Seg[]>;
    const lastLocRef: { current: Partial<Record<PartId, NoteLocation | null>> } = { current: {} };

    /** Keeps the currently-sounding note in view during playback — called
     * every tick (see below), so it takes effect on the very first frame
     * after pressing play (jumping straight to wherever the seek bar sits,
     * even mid-piece) and keeps re-centering as the playhead advances.
     * Horizontal position is recentered every frame (a smooth "camera
     * follow") via .staff-scroll's own overflow-x scrollbar. Vertical is
     * different: .staff-scroll has no overflow-y (it grows with content;
     * the PAGE itself scrolls between rows), so that's a window scroll
     * instead, converting the row's logical Y span to viewport coordinates
     * off the staff container's current on-screen position — only nudged
     * when the row actually falls outside the viewport, so it doesn't
     * fight a manual scroll every frame while still on the same row. */
    const followPlayhead = (bars: { x: number; y0: number; y1: number }[]) => {
      const scrollEl = staffScrollRef.current;
      const staffEl = containerRef.current;
      if (!scrollEl || !staffEl || bars.length === 0) return;
      const zoom = zoomRef.current;
      const x = bars[0].x * zoom;
      const yTop = Math.min(...bars.map((b) => b.y0)) * zoom;
      const yBottom = Math.max(...bars.map((b) => b.y1)) * zoom;

      const targetLeft = x - scrollEl.clientWidth * 0.3;
      const maxLeft = scrollEl.scrollWidth - scrollEl.clientWidth;
      scrollEl.scrollLeft = Math.max(0, Math.min(maxLeft, targetLeft));

      const rect = staffEl.getBoundingClientRect();
      const viewTop = rect.top + yTop;
      const viewBottom = rect.top + yBottom;
      const margin = 24;
      if (viewTop < margin || viewBottom > window.innerHeight - margin) {
        window.scrollBy({ top: viewTop - margin, behavior: 'auto' });
      }
    };

    const tick = () => {
      const result = renderResultRef.current;
      const beats = playbackClock.get() / secondsPerBeat;
      const bars: { x: number; y0: number; y1: number }[] = [];
      const nextLoc: Partial<Record<PartId, NoteLocation | null>> = {};
      activeParts(score).forEach((clef) => {
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
      followPlayhead(bars);

      const changed = activeParts(score).some(
        (part) =>
          nextLoc[part]?.noteIndex !== lastLocRef.current[part]?.noteIndex ||
          nextLoc[part]?.measureIndex !== lastLocRef.current[part]?.measureIndex,
      );
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

  /** Row-relative raw beat (no onset snapping) under a pointer position — shared by the seek bar and the pickup/trailing resize handles below. */
  const xyToRawBeat = (x: number, y: number): { measureIndex: number; beat: number } | null => {
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
    return { measureIndex: hb.measureIndex, beat: rawBeat };
  };

  /** Maps a pointer position to a beat, snapped to the nearest note onset (or downbeat) in the measure under it. */
  const xyToSeekBeat = (x: number, y: number): number | null => {
    const raw = xyToRawBeat(x, y);
    if (!raw) return null;
    const measureStart = measureStartBeat(score, raw.measureIndex);
    // Candidate onsets: the downbeat plus each note's cumulative onset. An
    // empty measure has no note onset to snap to besides the downbeat itself
    // — snapping to it there would pin every drag to beat 0 (defeating, e.g.,
    // freely dragging the seek bar to set a 못갖춘마디 length before any notes
    // exist), so fall back to the raw unsnapped position in that case.
    // Onsets come from the treble staff — the seek bar is a single position in
    // the piece, and one staff's rhythm has to be picked to snap it to.
    const onsets: number[] = [];
    let b = measureStart;
    score.measures[raw.measureIndex].treble.notes.forEach((note) => {
      onsets.push(b);
      b += noteBeats(note);
    });
    if (onsets.length === 0) return raw.beat;
    return onsets.reduce((best, o) => (Math.abs(o - raw.beat) < Math.abs(best - raw.beat) ? o : best), onsets[0]);
  };

  // Render the seek bar whenever its position or the score layout changes
  // (hidden while playing — the red playhead takes over then).
  useEffect(() => {
    renderSeekBar(overlayRef.current, playbackClock ? null : seekBarSpec());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekBeat, score, selected, draggingNote, playingLocations, selectedPitchIndex, playbackClock]);

  // --- 못갖춘마디/trailing measure resize handles -------------------------------

  /** Draggable-boundary geometry at the barline right after the pickup measure (index 0→1), or null if there's no pickup. */
  const pickupBoundarySpec = () => {
    const result = renderResultRef.current;
    if (!result || score.pickupBeats === undefined || score.measures.length < 2) return null;
    const treble = result.staffHitboxes.find((s) => s.measureIndex === 0 && s.clef === 'treble');
    const bass = result.staffHitboxes.find((s) => s.measureIndex === 0 && s.clef === 'bass');
    if (!treble || !bass) return null;
    const overhang = treble.spacing * 1.2;
    return {
      x: treble.x1,
      y0: treble.refY0 - treble.spacing * 5 - overhang,
      y1: bass.refY0 - bass.spacing * 1 + overhang,
    };
  };

  /** Mirrors pickupBoundarySpec for the barline right before the trailing measure, or null if there's no trailing measure. */
  const trailingBoundarySpec = () => {
    const result = renderResultRef.current;
    if (!result || score.trailingBeats === undefined || score.measures.length < 2) return null;
    const lastIndex = score.measures.length - 1;
    const treble = result.staffHitboxes.find((s) => s.measureIndex === lastIndex - 1 && s.clef === 'treble');
    const bass = result.staffHitboxes.find((s) => s.measureIndex === lastIndex - 1 && s.clef === 'bass');
    if (!treble || !bass) return null;
    const overhang = treble.spacing * 1.2;
    return {
      x: treble.x1,
      y0: treble.refY0 - treble.spacing * 5 - overhang,
      y1: bass.refY0 - bass.spacing * 1 + overhang,
    };
  };

  const nearBoundaryHandle = (point: { x: number; y: number }, spec: { x: number; y0: number; y1: number } | null) => {
    if (!spec) return false;
    return Math.abs(point.x - spec.x) <= 10 && point.y >= spec.y0 - 6 && point.y <= spec.y1 + 6;
  };

  /** The pickup measure's own rectangle (its full column, not just the boundary line) — hovering anywhere in it reveals the resize handle. */
  const pickupHoverZone = () => {
    const result = renderResultRef.current;
    if (!result || score.pickupBeats === undefined || score.measures.length < 2) return null;
    const treble = result.staffHitboxes.find((s) => s.measureIndex === 0 && s.clef === 'treble');
    const bass = result.staffHitboxes.find((s) => s.measureIndex === 0 && s.clef === 'bass');
    if (!treble || !bass) return null;
    const overhang = treble.spacing * 1.2;
    return {
      x0: treble.x0 - 4,
      x1: treble.x1 + 10,
      y0: treble.refY0 - treble.spacing * 5 - overhang,
      y1: bass.refY0 - bass.spacing * 1 + overhang,
    };
  };

  /** Mirrors pickupHoverZone for the trailing measure. */
  const trailingHoverZone = () => {
    const result = renderResultRef.current;
    if (!result || score.trailingBeats === undefined || score.measures.length < 2) return null;
    const lastIndex = score.measures.length - 1;
    const treble = result.staffHitboxes.find((s) => s.measureIndex === lastIndex && s.clef === 'treble');
    const bass = result.staffHitboxes.find((s) => s.measureIndex === lastIndex && s.clef === 'bass');
    if (!treble || !bass) return null;
    const overhang = treble.spacing * 1.2;
    return {
      x0: treble.x0 - 10,
      x1: treble.x1 + 4,
      y0: treble.refY0 - treble.spacing * 5 - overhang,
      y1: bass.refY0 - bass.spacing * 1 + overhang,
    };
  };

  const inHoverZone = (point: { x: number; y: number }, zone: { x0: number; x1: number; y0: number; y1: number } | null) =>
    !!zone && point.x >= zone.x0 && point.x <= zone.x1 && point.y >= zone.y0 && point.y <= zone.y1;

  /** Which boundary handle is currently visible on hover (kept separate from boundaryResizeRef so an in-progress drag can force visibility even if the pointer strays outside the hover zone). */
  const hoverBoundaryRef = useRef<'pickup' | 'trailing' | null>(null);

  /** Redraws the pickup/trailing handles for whichever one is hovered or being dragged — hidden otherwise, so they don't clutter the score when not needed. */
  const refreshPickupHandles = () => {
    const active = boundaryResizeRef.current?.which ?? hoverBoundaryRef.current;
    renderPickupHandles(
      overlayRef.current,
      active === 'pickup' ? pickupBoundarySpec() : null,
      active === 'trailing' ? trailingBoundarySpec() : null,
    );
  };

  /**
   * Hit-tests every measure's own start barline (its stave's left edge,
   * spanning the full grand staff top-to-bottom) — clicking one jumps the
   * seek bar straight to that measure's start beat. Kept to a tight x
   * tolerance so it doesn't compete with normal note placement/selection
   * clicks a few pixels away.
   */
  const findMeasureStartAt = (x: number, y: number): number | null => {
    const result = renderResultRef.current;
    if (!result) return null;
    const TOL = 6;
    for (const treble of result.staffHitboxes) {
      if (treble.clef !== 'treble' || Math.abs(x - treble.x0) > TOL) continue;
      const bass = result.staffHitboxes.find((s) => s.measureIndex === treble.measureIndex && s.clef === 'bass');
      if (!bass) continue;
      const overhang = treble.spacing * 1.2;
      const y0 = treble.refY0 - treble.spacing * 5 - overhang;
      const y1 = bass.refY0 - bass.spacing * 1 + overhang;
      if (y >= y0 && y <= y1) return treble.measureIndex;
    }
    return null;
  };

  /**
   * Starts a boundary-resize drag. The pickup/trailing measures can render
   * much narrower than their beat share (row-width normalization shrinks and
   * floors partial-measure slots — see computeRowMeasureWidths), so mapping
   * the pointer's absolute position straight through a stave's own rendered
   * width the way xyToRawBeat does would make the handle jump the instant a
   * drag starts (rest position wouldn't map back to the current split beat).
   * Instead this tracks the pixel delta from where the drag began and
   * applies it to the CURRENT split beat using a fixed, non-redistributed
   * px-per-beat estimate, so "no movement yet" always means "no change yet".
   */
  const startBoundaryResize = (which: 'pickup' | 'trailing', point: { x: number; y: number }) => {
    const capacity = measureCapacityBeats(score.timeSignature);
    const startBeat = which === 'pickup' ? score.pickupBeats ?? 0 : capacity - (score.trailingBeats ?? capacity);
    // MEASURE_WIDTH's nominal (non-redistributed) pixel width for one full measure — a stable conversion factor independent of any particular row's current layout.
    const pxPerBeat = 220 / capacity;
    boundaryResizeRef.current = { which, startX: point.x, startBeat, pxPerBeat };
    refreshPickupHandles();
  };

  // Keep the pickup/trailing handles' geometry in sync with the score layout
  // (still respecting whatever the current hover/drag visibility is).
  useEffect(() => {
    refreshPickupHandles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score]);

  // --- Per-measure barline tools (hand-resize + 자동정렬) ----------------------

  /** Full-grand-staff vertical span of one measure's column, plus the x of its
   * own RIGHT barline — the anchor every per-measure tool below hangs off. */
  const measureBarGeometry = (measureIndex: number) => {
    const result = renderResultRef.current;
    const treble = result?.staffHitboxes.find((s) => s.measureIndex === measureIndex && s.clef === 'treble');
    const bass = result?.staffHitboxes.find((s) => s.measureIndex === measureIndex && s.clef === 'bass');
    if (!treble || !bass) return null;
    const overhang = treble.spacing * 1.2;
    return {
      x: treble.x1,
      x0: treble.x0,
      y0: treble.refY0 - treble.spacing * 5 - overhang,
      y1: bass.refY0 - bass.spacing * 1 + overhang,
      spacing: treble.spacing,
    };
  };

  /** Where the 자동정렬 button sits for a given barline: just below the bass
   * staff, clear of both staves' own click regions and of the next row's
   * chord band, with the drag arrows flanking it (see renderMeasureTools). */
  const autoAlignButtonPos = (geo: { x: number; y1: number }) => ({ x: geo.x, y: geo.y1 + 16 });

  const AUTO_ALIGN_BUTTON_RADIUS = 14;
  const BARLINE_GRAB_TOL = 7;
  /** Half-height of the drag arrows flanking the 자동정렬 button, plus a little
   * slack — they are drawn ±6px around the button's own centre line (see
   * renderMeasureTools' arrow paths). */
  const ARROW_GRAB_HALF_HEIGHT = 10;
  /** How far the arrows reach out from the button's centre: the arrow line
   * starts at 22px and its head ends at 36px (see renderMeasureTools). */
  const ARROW_GRAB_REACH = 38;

  /** Which measure's right barline the pointer is near enough for its tools to
   * SHOW, or null. Deliberately generous — it has to span the whole trip from
   * the barline down to the button, or the tools would blink out from under
   * the pointer on the way there. Searched right-edge-first so the shared pixel
   * between measure N's end and measure N+1's start resolves to N — the
   * measure the tools actually act on.
   *
   * Showing the tools is ALL this governs. Deciding what a press does is a
   * different question with a much smaller answer — see findMeasureBarPressAt.
   */
  const findMeasureBarAt = (point: { x: number; y: number }): number | null => {
    const result = renderResultRef.current;
    if (!result) return null;
    for (const treble of result.staffHitboxes) {
      if (treble.clef !== 'treble') continue;
      const geo = measureBarGeometry(treble.measureIndex);
      if (!geo) continue;
      const btn = autoAlignButtonPos(geo);
      const onBar = Math.abs(point.x - geo.x) <= BARLINE_GRAB_TOL && point.y >= geo.y0 && point.y <= geo.y1;
      const onCluster =
        Math.abs(point.x - geo.x) <= 44 && point.y > geo.y1 && point.y <= btn.y + AUTO_ALIGN_BUTTON_RADIUS + 4;
      if (onBar || onCluster) return treble.measureIndex;
    }
    return null;
  };

  /**
   * Which measure's barline tools a PRESS actually lands on, and which part —
   * or null, which means the press belongs to whatever is underneath instead.
   *
   * Only the controls that are really drawn count: the grip band on the
   * barline itself, the round 자동정렬 button, and the two drag arrows beside
   * it. Presses used to be taken by the same generous region that merely
   * SHOWS the tools (see findMeasureBarAt) — a ~88x34px rectangle hanging
   * below the staff, nearly all of it empty space. That rectangle sits exactly
   * where ledger-line notes under the bass staff are written, and because the
   * barline branch runs before note handling, those notes could not be
   * clicked at all: every press near them started a measure resize instead.
   */
  const findMeasureBarPressAt = (point: { x: number; y: number }): { measureIndex: number; part: 'grip' | 'button' | 'arrow' } | null => {
    const result = renderResultRef.current;
    if (!result) return null;
    for (const treble of result.staffHitboxes) {
      if (treble.clef !== 'treble') continue;
      const geo = measureBarGeometry(treble.measureIndex);
      if (!geo) continue;
      const btn = autoAlignButtonPos(geo);
      if (Math.hypot(point.x - btn.x, point.y - btn.y) <= AUTO_ALIGN_BUTTON_RADIUS) {
        return { measureIndex: treble.measureIndex, part: 'button' };
      }
      const dx = Math.abs(point.x - btn.x);
      if (dx <= ARROW_GRAB_REACH && Math.abs(point.y - btn.y) <= ARROW_GRAB_HALF_HEIGHT) {
        return { measureIndex: treble.measureIndex, part: 'arrow' };
      }
      if (Math.abs(point.x - geo.x) <= BARLINE_GRAB_TOL && point.y >= geo.y0 && point.y <= geo.y1) {
        return { measureIndex: treble.measureIndex, part: 'grip' };
      }
    }
    return null;
  };

  /** True when the point is inside the 자동정렬 button of the given measure's barline. */
  const overAutoAlignButton = (measureIndex: number, point: { x: number; y: number }): boolean => {
    const geo = measureBarGeometry(measureIndex);
    if (!geo) return false;
    const btn = autoAlignButtonPos(geo);
    return Math.hypot(point.x - btn.x, point.y - btn.y) <= AUTO_ALIGN_BUTTON_RADIUS;
  };

  /** Which measure's barline tools are currently showing, and whether the pointer is on its button. */
  const hoverBarRef = useRef<{ measureIndex: number; buttonHot: boolean } | null>(null);
  /** In-progress hand-resize of a measure (see Measure.widthScale): its starting rendered width and scale, so the drag maps pixels back to a scale without compounding. `moved` stays false for a press that never became a drag, which releases the click back to the seek-bar jump the barline normally does. */
  const measureResizeRef = useRef<{
    measureIndex: number;
    startX: number;
    startY: number;
    startWidth: number;
    /** Total width of the row this measure sits in — the pool its share is drawn from. */
    rowWidth: number;
    startScale: number;
    moved: boolean;
  } | null>(null);

  const refreshMeasureTools = () => {
    const drag = measureResizeRef.current;
    const hover = hoverBarRef.current;
    const measureIndex = drag?.measureIndex ?? hover?.measureIndex ?? null;
    const geo = measureIndex === null ? null : measureBarGeometry(measureIndex);
    if (!geo) {
      renderMeasureTools(overlayRef.current, null);
      return;
    }
    const btn = autoAlignButtonPos(geo);
    renderMeasureTools(overlayRef.current, {
      x: geo.x,
      y0: geo.y0,
      y1: geo.y1,
      buttonX: btn.x,
      buttonY: btn.y,
      dragging: !!drag,
      buttonHot: !drag && !!hover?.buttonHot,
    });
  };

  /**
   * Maps the drag's pixel delta back onto the measure's width share, so the
   * barline actually keeps up with the pointer. A measure's rendered width
   * isn't proportional to its scale: every measure in the row splits one
   * fixed total (see computeRowMeasureWidths), so growing this one shrinks
   * the rest and the barline only travels a fraction of the extra weight.
   * Inverting that — from the measure's FRACTION of its row (`a` now, `f`
   * wanted) back to the weight fraction that produces it — cancels the
   * pushback out. Always measured from the drag's ORIGINAL width/scale
   * rather than accumulated per frame, so it can't drift as the neighbours
   * resize underneath it.
   */
  const updateMeasureResize = (point: { x: number; y: number }) => {
    const drag = measureResizeRef.current;
    if (!drag) return;
    const dx = point.x - drag.startX;
    if (!drag.moved && Math.hypot(dx, point.y - drag.startY) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    const a = drag.startWidth / drag.rowWidth;
    // Capped short of the whole row: at f = 1 the inversion below divides by
    // zero, and a measure that ate its entire system has nothing left to grab.
    const f = Math.max(0.05, Math.min(0.85, (drag.startWidth + dx) / drag.rowWidth));
    const multiplier = (f * (1 - a)) / ((1 - f) * a);
    onResizeMeasure(drag.measureIndex, Math.max(0.35, Math.min(3, drag.startScale * multiplier)));
  };

  const handleMeasureResizeDocMouseMove = (event: MouseEvent) => {
    const point = eventPoint(event);
    if (point) updateMeasureResize(point);
  };

  const handleMeasureResizeDocMouseUp = () => {
    const drag = measureResizeRef.current;
    measureResizeRef.current = null;
    document.removeEventListener('mousemove', handleMeasureResizeDocMouseMove);
    document.removeEventListener('mouseup', handleMeasureResizeDocMouseUp);
    // A press that never turned into a drag keeps the barline's own
    // long-standing behaviour: jump the seek bar to that barline.
    if (drag && !drag.moved) {
      const seekTarget = findMeasureStartAt(drag.startX, drag.startY);
      if (seekTarget !== null) onSeekBeat(measureStartBeat(score, seekTarget));
    }
    suppressClickRef.current = true;
    refreshMeasureTools();
  };

  const startMeasureResize = (measureIndex: number, point: { x: number; y: number }) => {
    const geo = measureBarGeometry(measureIndex);
    const result = renderResultRef.current;
    if (!geo || !result) return;
    const startWidth = Math.max(40, geo.x - geo.x0);
    // The measure's own row, identified by the staves sharing its baseline —
    // its total width is what the drag redistributes within (see updateMeasureResize).
    const self = result.staffHitboxes.find((s) => s.measureIndex === measureIndex && s.clef === 'treble');
    const rowWidth = result.staffHitboxes
      .filter((s) => s.clef === 'treble' && s.refY0 === self?.refY0)
      .reduce((sum, s) => sum + (s.x1 - s.x0), 0);
    measureResizeRef.current = {
      measureIndex,
      startX: point.x,
      startY: point.y,
      startWidth,
      rowWidth: Math.max(startWidth + 40, rowWidth),
      startScale: score.measures[measureIndex]?.widthScale ?? 1,
      moved: false,
    };
    refreshMeasureTools();
  };

  // --- Under-filled measure warnings ------------------------------------------

  /** Every measure that's been started but left short of its time signature,
   * with the screen position of its red "!" badge — pinned just inside the
   * measure's own right edge, above the treble staff. */
  const measureWarnings = (): { measureIndex: number; x: number; y: number }[] => {
    const result = renderResultRef.current;
    if (!result) return [];
    const spots: { measureIndex: number; x: number; y: number }[] = [];
    score.measures.forEach((_measure, measureIndex) => {
      // A pickup/trailing measure is deliberately short — never a mistake.
      if (measureIndex === 0 && score.pickupBeats !== undefined) return;
      if (measureIndex === score.measures.length - 1 && score.trailingBeats !== undefined) return;
      if (incompleteClefsIn(score, measureIndex).length === 0) return;
      const treble = result.staffHitboxes.find((s) => s.measureIndex === measureIndex && s.clef === 'treble');
      if (!treble) return;
      spots.push({ measureIndex, x: treble.x1 - 13, y: treble.refY0 - treble.spacing * 5 - 20 });
    });
    return spots;
  };

  /** Which warning badge the pointer is currently hovering, so it can grow slightly. */
  const hotWarningRef = useRef<number | null>(null);

  const findMeasureWarningAt = (point: { x: number; y: number }): number | null =>
    measureWarnings().find((s) => Math.hypot(point.x - s.x, point.y - s.y) <= 11)?.measureIndex ?? null;

  const refreshMeasureWarnings = () => {
    renderMeasureWarnings(
      overlayRef.current,
      measureWarnings().map((s) => ({ x: s.x, y: s.y, hot: s.measureIndex === hotWarningRef.current })),
    );
  };

  // Both sets of badges are positioned from the rendered layout, so they have
  // to be redrawn whenever anything that moves a measure does — which
  // includes focus, since the focused measure keeps a wider slot.
  useEffect(() => {
    refreshMeasureWarnings();
    refreshMeasureTools();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score, focusedMeasureIndex]);

  // --- Shared placement helpers -----------------------------------------------

  /**
   * On-screen geometry (line spacing, note area, ...) of the staff a note
   * lives on — what a 'note' gesture's ongoing Y→pitch math reads, for the
   * whole life of the gesture, since the mouse stays in that one staff's
   * pixel space throughout.
   *
   * The part identifies the staff on its own, melody included. Gestures used
   * to have to carry a separate 'staff' | 'melody' origin tag alongside the
   * clef, because back when the melody staff was a view of the treble staff
   * both resolved to clef:'treble' and only that tag could tell them apart.
   */
  const staffGeometryFor = (result: RenderResult, measureIndex: number, clef: PartId): StaffHitbox | undefined =>
    result.staffHitboxes.find((s) => s.measureIndex === measureIndex && s.clef === clef);

  const pitchAt = (clef: PartId, staff: StaffHitbox, y: number) => {
    const snappedLine = Math.round(lineAt(staff, y) * 2) / 2;
    const { letter, octave } = lineToPitch(clef, snappedLine);
    return { snappedLine, letter, octave };
  };

  /** Like pitchAt, but sticky around `lastLine` (the line currently locked in
   * for an in-progress note drag — see MouseGesture/TouchGesture's `lastLine`):
   * the raw Y has to clear the normal half-line boundary by a bit more
   * (STICKY_LINE_MARGIN) before the line actually changes, so small vertical
   * jitter during an otherwise-horizontal drag doesn't flip the pitch. */
  const stickyPitchAt = (clef: PartId, staff: StaffHitbox, y: number, lastLine: number, grabLineOffset = 0) => {
    // `grabLineOffset` cancels out WHERE INSIDE the notehead the drag started
    // (see the note gesture's own field). A notehead is a full line-unit tall,
    // so pressing near its top or bottom edge already puts the raw pointer
    // line half a unit off the note's real line — past the threshold below,
    // which made a purely sideways drag jump the note a step up or down
    // before it had moved vertically at all (#250).
    const raw = lineAt(staff, y) - grabLineOffset;
    const snappedLine = Math.abs(raw - lastLine) > 0.25 + STICKY_LINE_MARGIN ? Math.round(raw * 2) / 2 : lastLine;
    const { letter, octave } = lineToPitch(clef, snappedLine);
    return { snappedLine, letter, octave };
  };

  /**
   * A press that lands on a chord's specific notehead while that SAME chord
   * is already selected narrows the gesture to just that one pitch (G9/G10)
   * — clicking again selects only it, dragging moves only it. A press on a
   * not-yet-selected note (or a single-pitch note) applies to the whole note.
   */
  const resolveNarrowedPitchIndex = (location: NoteLocation, pressX: number, pressY: number): number | undefined => {
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
    return hb ? nearestPitchIndexAt(hb, pressX, pressY) : undefined;
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
  const chordMergeTargetAt = (measureIndex: number, clef: PartId, x: number, exclude?: number): number | null => {
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

  /** Place a note at the given staff position — stacking onto a near note as a chord, or a new note.
   * `select` controls whether the newly placed note becomes the selected
   * (red) note: true for a deliberate mouse/touch tap (see item 2 — a click
   * should visibly select what it just created), false for a keyboard-driven
   * commit (spacebar chaining — see item 3, those stay unselected/black so a
   * run of typed notes doesn't flash red one after another). */
  const commitAdd = (measureIndex: number, clef: PartId, staff: StaffHitbox, snappedLine: number, x: number, duration: DurationValue, select: boolean) => {
    const result = renderResultRef.current;
    if (!result) return;
    const { letter, octave } = lineToPitch(clef, snappedLine);
    const chordTarget = chordMergeTargetAt(measureIndex, clef, x);
    if (chordTarget !== null && editTool.isRest && clef !== 'melody') {
      // Hovering above/below an existing note with the 쉼표 tool armed sketches
      // a rest mark right there instead of adding a chord tone (#187) — a rest
      // can be layered onto any note this way, not only when its measure is
      // already full. Piano staves only: rest marks are an overlay on those
      // (RestMark.clef), and the single-line melody staff has no use for one —
      // there it falls through and writes a real rest instead.
      onAddRestMark(measureIndex, clef, xFractionAt(staff, x), snappedLine, duration);
      onFocusMeasure(measureIndex);
      return;
    }
    let noteIndex: number;
    if (chordTarget !== null) {
      noteIndex = chordTarget;
      onTogglePitch({ measureIndex, clef, noteIndex: chordTarget }, letter, octave);
    } else {
      noteIndex = findInsertIndex(result, measureIndex, clef, x);
      onAddNote(measureIndex, clef, letter, octave, noteIndex, duration, xFractionAt(staff, x), select);
    }
    onFocusMeasure(measureIndex);
    // Chains continuous note entry: once the next render has this note's
    // real geometry (see the effect that reads this ref), immediately open
    // a placement preview right after it — no second keypress needed.
    pendingChainRef.current = { measureIndex, clef, noteIndex };
  };

  /** Absolute X of a preview fraction against a staff's CURRENT geometry (see lockedPreview). */
  const previewXOn = (staff: StaffHitbox, xFrac: number) =>
    staff.noteStartX + Math.min(1, Math.max(0, xFrac)) * staff.noteAreaWidth;

  /** Draws the locked placement preview (a stronger, more opaque ghost than the
   * hover preview) at a locked position. */
  const renderLockedGhost = (lp: { measureIndex: number; clef: PartId; line: number; xFrac: number; duration: DurationValue }) => {
    const result = renderResultRef.current;
    if (!result) return;
    const staff = staffGeometryFor(result, lp.measureIndex, lp.clef);
    if (!staff) return;
    const x = previewXOn(staff, lp.xFrac);
    const isChord = chordMergeTargetAt(lp.measureIndex, lp.clef, x) !== null;
    renderGhost(overlayRef.current, {
      kind: 'note',
      x,
      y: staff.refY0 - lp.line * staff.spacing,
      duration: lp.duration,
      isRest: editTool.isRest && !isChord,
      stemUp: stemPointsUp(lp.line),
      accidental: editTool.accidental,
      ledgerLineYs: ledgerLinePositions(lp.line).map((l) => staff.refY0 - l * staff.spacing),
      opacity: 0.85,
      color: '#7a5cff',
    });
  };

  /** Commits the locked preview into a real note, using the preview's own
   * duration — frozen at whatever it was when the preview was locked (either
   * the toolbar's armed duration for a quick click, or the longer duration
   * reached by a hold — see renderLockedGhost / the mousedown 'add' hold
   * cycle), not necessarily today's toolbar duration. */
  const commitLockedPreview = () => {
    const lp = lockedPreviewRef.current;
    const result = renderResultRef.current;
    if (!lp || !result) {
      setLockedPreview(null);
      return;
    }
    const staff = staffGeometryFor(result, lp.measureIndex, lp.clef);
    // Keyboard-driven commit (spacebar/Enter) — the new note stays
    // unselected/black (see item 3) instead of taking over `selected`.
    if (staff) commitAdd(lp.measureIndex, lp.clef, staff, lp.line, previewXOn(staff, lp.xFrac), lp.duration, false);
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
    onFocusMeasure(measureIndex);
    setLockedPreview({
      measureIndex,
      clef: location.clef,
      line,
      xFrac: xFractionAt(targetStaff, nx),
      duration: editTool.duration,
    });
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
    setLockedPreview({ measureIndex: targetMeasureIndex, clef: location.clef, line, xFrac: 0, duration: editTool.duration });
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

  // The dragged item still physically lives in its origin measure's data
  // until the drag commits (crossing into another measure only moves the
  // ghost, not the score yet) — look it up there even while the ghost is
  // hovering over a different measure, or the label would blank out mid-drag.
  const symbolLabel = (drag: SymbolDrag): string => {
    const measure = score.measures[drag.originMeasureIndex];
    if (drag.kind === 'chordSymbol') {
      const chord = measure.chords.find((c) => c.id === drag.id);
      return chord ? chordLabel(chord) : '';
    }
    return (measure.lyrics ?? []).find((l) => l.id === drag.id)?.text ?? '';
  };

  /**
   * Every note's onset within `measureIndex` (both clefs), as an
   * {offset-within-measure, on-screen x} pair — offset computed the same way
   * flattenChords derives a non-first chord's beat (accumulated beat /
   * measureDurationBeats), so snapping a chord drag to one of these makes its
   * STORED offset land on an exact beat boundary, not just visually close to
   * one. Used to snap chord-symbol drags (see updateSymbolDrag) so
   * scale-degree labeling's beat comparison can't be thrown off by a
   * few-pixel drag imprecision.
   */
  const chordSnapCandidates = (measureIndex: number): { offset: number; x: number }[] => {
    const result = renderResultRef.current;
    const measure = score.measures[measureIndex];
    if (!result || !measure) return [];
    const duration = measureDurationBeats(score, measureIndex);
    const candidates: { offset: number; x: number }[] = [];
    activeParts(score).forEach((clef) => {
      let beat = 0;
      measure[clef].notes.forEach((note, noteIndex) => {
        const hb = result.noteHitboxes.find((n) => n.measureIndex === measureIndex && n.clef === clef && n.noteIndex === noteIndex);
        if (hb) candidates.push({ offset: Math.min(0.97, Math.max(0.03, beat / duration)), x: hb.centerX });
        beat += noteBeats(note);
      });
    });
    return candidates;
  };

  const updateSymbolDrag = (drag: SymbolDrag, point: { x: number; y: number }) => {
    if (!drag.moved && Math.abs(point.x - drag.startX) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;

    // Both chord symbols and lyrics can cross into whichever measure the
    // finger/cursor is CURRENTLY over — including a measure in a different
    // row above/below (not just sideways within the origin row) — so
    // detection reads the live pointer Y, not a Y fixed at drag-start.
    // findStaffAt needs a y strictly inside a staff's hitbox range, but the
    // chord band's own y sits just 2px above the treble hitbox's y0 (they're
    // computed independently, see CHORD_BAND_Y vs TREBLE_Y) — nudge down a
    // few px so it reliably lands inside the treble (chords) or bass
    // (lyrics, which already sit safely mid-band) hitbox instead of missing
    // every measure's y-range and silently never crossing.
    const result = renderResultRef.current;
    const staff = result && findStaffAt(result, point.x, point.y + 5);
    if (staff && staff.measureIndex !== drag.measureIndex) {
      drag.measureIndex = staff.measureIndex;
      if (drag.kind === 'chordSymbol') {
        // A chord's offset is in the same coordinate space as its
        // chordBandHitbox (measureX/measureWidth — see vexflowRenderer),
        // NOT the treble staff's own note area, so a beat-precise snap
        // target lines up with where the chord itself is actually drawn
        // (see chordSnapCandidates) — and so the BASS clef's own content can
        // extend the chord's usable left bound too, matching how a fresh
        // drag picks it up (see chordDragFrom).
        const band = result.chordBandHitboxes.find((b) => b.measureIndex === staff.measureIndex);
        drag.measureX = band?.measureX ?? staff.noteStartX;
        drag.measureWidth = band?.measureWidth ?? staff.noteAreaWidth;
        // Only relocate the ghost's Y when the row itself actually changed
        // (crossing sideways within the same row keeps the original Y, so a
        // mostly-horizontal drag doesn't jitter vertically).
        if (band) drag.y = band.y0 + 14;
      } else {
        drag.measureX = staff.x0;
        drag.measureWidth = staff.x1 - staff.x0;
        drag.y = staff.y0 - 5;
      }
    }

    let offset = Math.min(0.97, Math.max(0.03, (point.x - drag.measureX) / drag.measureWidth));
    let ghostX = drag.measureX + offset * drag.measureWidth;
    drag.snappedX = null;

    // Only chord symbols carry harmonic meaning (scale-degree labeling reads
    // their beat position) — lyrics stay freely, continuously positioned.
    if (drag.kind === 'chordSymbol') {
      let nearest: { offset: number; x: number } | null = null;
      let nearestDist = CHORD_SNAP_THRESHOLD_PX;
      for (const c of chordSnapCandidates(drag.measureIndex)) {
        const dist = Math.abs(c.x - point.x);
        if (dist < nearestDist) {
          nearest = c;
          nearestDist = dist;
        }
      }
      if (nearest) {
        offset = nearest.offset;
        ghostX = nearest.x;
        drag.snappedX = ghostX;
      }
    }

    drag.pendingOffset = offset;
    renderGhost(overlayRef.current, {
      kind: 'chord',
      x: ghostX,
      y: drag.y,
      label: symbolLabel(drag),
      opacity: 0.7,
      color: drag.kind === 'chordSymbol' ? '#2f3a8f' : '#333',
    });

    if (drag.kind === 'chordSymbol' && drag.snappedX != null && result) {
      const band = result.chordBandHitboxes.find((b) => b.measureIndex === drag.measureIndex);
      const bassStaff = result.staffHitboxes.find((s) => s.measureIndex === drag.measureIndex && s.clef === 'bass');
      if (band && bassStaff) renderChordSnapGuide(overlayRef.current, { x: drag.snappedX, y0: band.y0, y1: bassStaff.y1 });
      else renderChordSnapGuide(overlayRef.current, null);
    } else {
      renderChordSnapGuide(overlayRef.current, null);
    }
  };

  const commitSymbolDrag = (drag: SymbolDrag) => {
    if (!drag.moved) return;
    if (drag.kind === 'chordSymbol') onMoveChord(drag.originMeasureIndex, drag.id, drag.pendingOffset, drag.measureIndex);
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

      // Shift+Tab mirrors the forward logic below, just walking backwards —
      // an existing chord before this position if there is one, else a fresh
      // empty slot one step back, so a run of chords can be reviewed in
      // either direction with just Tab/Shift+Tab. Skipped in 멜로디+가사
      // (lead-sheet) mode — see the forward branch below for why.
      if (event.shiftKey) {
        let prevExisting: { measureIndex: number; chord: ChordSymbol } | null = null;
        if (!score.showMelodyStaff) {
          for (let mi = currentMeasureIndex; mi >= 0; mi--) {
            const chords = [...(score.measures[mi]?.chords ?? [])].sort((a, b) => a.offset - b.offset);
            const candidates = mi === currentMeasureIndex ? chords.filter((c) => c.offset < currentOffset - 1e-6) : chords;
            if (candidates.length > 0) {
              prevExisting = { measureIndex: mi, chord: candidates[candidates.length - 1] };
              break;
            }
          }
        }
        if (prevExisting) {
          const band = result.chordBandHitboxes.find((b) => b.measureIndex === prevExisting!.measureIndex);
          if (!band) return;
          setInlineEditor({
            kind: 'chordEdit',
            measureIndex: prevExisting.measureIndex,
            chordId: prevExisting.chord.id,
            left: band.measureX + prevExisting.chord.offset * band.measureWidth - 45,
            top: (band.y0 + band.y1) / 2 - 8,
            width: 90,
            align: 'center',
            value: chordLabel(prevExisting.chord),
          });
          return;
        }
        const step = 0.18;
        let prevMeasureIndex = currentMeasureIndex;
        let prevOffset = currentOffset - step;
        if (prevOffset < 0.05) {
          prevMeasureIndex -= 1;
          prevOffset = 0.95;
        }
        if (prevMeasureIndex < 0) return;
        const band = result.chordBandHitboxes.find((b) => b.measureIndex === prevMeasureIndex);
        if (!band) return;
        setInlineEditor({
          kind: 'chordAdd',
          measureIndex: prevMeasureIndex,
          offset: prevOffset,
          left: band.measureX + prevOffset * band.measureWidth - 45,
          top: (band.y0 + band.y1) / 2 - 8,
          width: 90,
          align: 'center',
          value: '',
        });
        return;
      }

      // Cycling through already-filled chords with plain Tab is handy for
      // reviewing/fixing a progression on the grand staff, but it gets in
      // the way in 멜로디+가사 (lead-sheet) mode, where chords are usually
      // typed out fresh across many still-empty measures in one pass — Tab
      // there always advances straight to the next empty slot instead.
      let nextExisting: { measureIndex: number; chord: ChordSymbol } | null = null;
      if (!score.showMelodyStaff) {
        for (let mi = currentMeasureIndex; mi < score.measures.length; mi++) {
          const chords = [...(score.measures[mi]?.chords ?? [])].sort((a, b) => a.offset - b.offset);
          const candidates = mi === currentMeasureIndex ? chords.filter((c) => c.offset > currentOffset + 1e-6) : chords;
          if (candidates.length > 0) {
            nextExisting = { measureIndex: mi, chord: candidates[0] };
            break;
          }
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

  const handleBoundaryResizeDocMouseMove = (event: MouseEvent) => {
    const drag = boundaryResizeRef.current;
    if (!drag) return;
    const point = eventPoint(event);
    if (!point) return;
    const capacity = measureCapacityBeats(score.timeSignature);
    const newSplitBeat = Math.min(capacity - 0.05, Math.max(0.05, drag.startBeat + (point.x - drag.startX) / drag.pxPerBeat));
    if (drag.which === 'pickup') {
      onResizePickupMeasure(newSplitBeat);
    } else {
      onResizeTrailingMeasure(newSplitBeat);
    }
    refreshPickupHandles();
  };

  const handleBoundaryResizeDocMouseUp = (event: MouseEvent) => {
    boundaryResizeRef.current = null;
    document.removeEventListener('mousemove', handleBoundaryResizeDocMouseMove);
    document.removeEventListener('mouseup', handleBoundaryResizeDocMouseUp);
    const point = eventPoint(event);
    hoverBoundaryRef.current = point && inHoverZone(point, pickupHoverZone()) ? 'pickup' : point && inHoverZone(point, trailingHoverZone()) ? 'trailing' : null;
    refreshPickupHandles();
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

    if (gesture.kind === 'resizeRestMarkScale') {
      // Dragging a corner handle away from the mark's own center enlarges it,
      // dragging toward the center shrinks it — a direct distance ratio, not
      // a step-through-durations gesture (that's unrelated to visual size).
      const dist = Math.hypot(point.x - gesture.centerX, point.y - gesture.centerY);
      const ratio = gesture.startDist > 4 ? dist / gesture.startDist : 1;
      onResizeRestMarkScale(gesture.measureIndex, gesture.restMarkId, gesture.startScale * ratio);
      return;
    }

    if (gesture.kind === 'moveRestMark') {
      // Follows the cursor directly (same feel as chord/lyric symbol drag)
      // rather than a delta from the press point.
      const offset = Math.min(1, Math.max(0, (point.x - gesture.staffNoteStartX) / gesture.staffNoteAreaWidth));
      const line = (gesture.staffRefY0 - point.y) / gesture.staffSpacing;
      onMoveRestMark(gesture.measureIndex, gesture.restMarkId, offset, line);
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
      const staff = staffGeometryFor(result, gesture.location.measureIndex, gesture.location.clef);
      if (!staff) return;
      const note = score.measures[gesture.location.measureIndex][gesture.location.clef].notes[gesture.location.noteIndex];
      const { snappedLine } = stickyPitchAt(gesture.location.clef, staff, point.y, gesture.lastLine, gesture.grabLineOffset);
      gesture.lastLine = snappedLine;
      // A manual drag is honored even once the measure is full (see #241),
      // so the ghost always just follows the cursor's X.
      renderDragGhost(staff, point.x, snappedLine, note.duration, (note.pitches[gesture.narrowedPitchIndex ?? 0]?.accidental ?? '') as Accidental);
    }
  };

  /**
   * One Ctrl/Cmd+click: flips whatever is under the pointer in or out of the
   * multi-selection, leaving everything else selected. Resolved in the same
   * order a plain click would (chord symbol, then lyric, then note), so
   * Ctrl+clicking something always toggles the item a normal click would have
   * acted on — never a different one hiding underneath. Clicking empty space
   * deliberately does nothing rather than clearing: with Ctrl held the user is
   * building a selection up, and a slightly-missed click shouldn't discard it.
   */
  const toggleSelectionAt = (result: RenderResult, point: { x: number; y: number }) => {
    const chordHit = findChordAt(result, point.x, point.y);
    if (chordHit) {
      onMarqueeChordSelect(toggleEntry(marqueeChords, { measureIndex: chordHit.measureIndex, chordId: chordHit.chordId }, chordKey));
      return;
    }
    const lyricHit = findLyricAt(result, point.x, point.y);
    if (lyricHit) {
      onMarqueeLyricSelect(toggleEntry(marqueeLyrics, { measureIndex: lyricHit.measureIndex, lyricId: lyricHit.lyricId }, lyricKey));
      return;
    }
    // Falls back to the nearest note within the usual click radius when the
    // press didn't land dead-on a notehead, matching how plain clicking picks
    // a note out of a cluster (see resolveClickPreferSelect).
    const click = resolveClick(result, point.x, point.y);
    const target =
      click?.type === 'select'
        ? { measureIndex: click.measureIndex, clef: click.clef, noteIndex: click.noteIndex }
        : findNearbyNotesAt(result, point.x, point.y, SELECT_MODE_RADIUS)[0] ?? null;
    if (!target) return;
    onMarqueeSelect(toggleEntry(marquee, { measureIndex: target.measureIndex, clef: target.clef, noteIndex: target.noteIndex }, noteKey));
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
      const dragged = Math.hypot(gesture.curX - gesture.startX, gesture.curY - gesture.startY) >= DRAG_THRESHOLD_PX;

      // Ctrl+click with no drag: toggle just the one thing under the pointer,
      // so a scattered selection can be assembled (or trimmed) click by
      // click. Falls through to the box logic below when the pointer did
      // move, which is then treated as an additive rubber-band.
      if (gesture.additive && !dragged) {
        toggleSelectionAt(result, { x: gesture.startX, y: gesture.startY });
        suppressClickRef.current = true;
        return;
      }

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
      onMarqueeSelect(gesture.additive ? mergeUnique(marquee, picked, noteKey) : picked);
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
      onMarqueeChordSelect(gesture.additive ? mergeUnique(marqueeChords, pickedChords, chordKey) : pickedChords);
      // A lyric syllable counts as selected the same way (same box used for
      // click hit-testing, see findLyricAt).
      const pickedLyrics: { measureIndex: number; lyricId: string }[] = [];
      result.lyricHitboxes.forEach((hb) => {
        const lx0 = hb.x - hb.halfWidth;
        const lx1 = hb.x + hb.halfWidth;
        const ly0 = hb.y - 12;
        const ly1 = hb.y + 12;
        if (lx1 < x0 || lx0 > x1 || ly1 < y0 || ly0 > y1) return;
        pickedLyrics.push({ measureIndex: hb.measureIndex, lyricId: hb.lyricId });
      });
      onMarqueeLyricSelect(gesture.additive ? mergeUnique(marqueeLyrics, pickedLyrics, lyricKey) : pickedLyrics);
      suppressClickRef.current = true;
      return;
    }

    if (gesture.kind === 'chordSymbol' || gesture.kind === 'lyric') {
      commitSymbolDrag(gesture);
      if (!gesture.moved) openSymbolEditor(gesture);
      suppressClickRef.current = gesture.moved;
      clearGhost(overlayRef.current);
      renderChordSnapGuide(overlayRef.current, null);
      return;
    }

    if (gesture.kind === 'add') {
      // Click-to-lock: a click on empty staff locks a preview there. Clicking
      // again ON THAT SAME PREVIEW commits it (spacebar/arrow keys handle it
      // in between); clicking anywhere else instead MOVES the lock there —
      // so the preview always follows the most recent click, and only a
      // deliberate second click on the same spot places the note. Holding
      // (instead of a quick click) cycles gesture.duration once per tick (see
      // the mousedown 'add' hold interval) — that held duration, not
      // whatever's armed in the toolbar, is what gets locked/committed here.
      const lp = lockedPreviewRef.current;
      const gestureStaff = staffGeometryFor(result, gesture.measureIndex, gesture.clef);
      const sameSpot =
        !!lp &&
        !!gestureStaff &&
        lp.measureIndex === gesture.measureIndex &&
        lp.clef === gesture.clef &&
        lp.line === gesture.line &&
        Math.abs(previewXOn(gestureStaff, lp.xFrac) - gesture.x) < TOUCH_PREVIEW_RADIUS;
      // Focus moves to this measure on every such click, not just on commit —
      // so a plain click marks "paste starts here" even before any note is placed.
      onFocusMeasure(gesture.measureIndex);
      if (sameSpot) {
        const staff = staffGeometryFor(result, gesture.measureIndex, gesture.clef);
        // A deliberate mouse click commit selects the note it just created (see item 2).
        if (staff) commitAdd(gesture.measureIndex, gesture.clef, staff, gesture.line, gesture.x, gesture.duration, true);
        setLockedPreview(null);
        clearGhost(overlayRef.current);
      } else {
        setLockedPreview({
          measureIndex: gesture.measureIndex,
          clef: gesture.clef,
          line: gesture.line,
          xFrac: gestureStaff ? xFractionAt(gestureStaff, gesture.x) : 0,
          duration: gesture.duration,
        });
      }
      suppressClickRef.current = true;
      return;
    }

    if (gesture.kind !== 'note') return;
    if (gesture.mode === 'drag') {
      const staff = point ? staffGeometryFor(result, gesture.location.measureIndex, gesture.location.clef) : undefined;
      if (point && staff) {
        const { snappedLine } = stickyPitchAt(gesture.location.clef, staff, point.y, gesture.lastLine, gesture.grabLineOffset);
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
          // A manual drag is honored even once the measure is full (#241).
          onMoveNote(gesture.location, deltaLine, xFractionAt(staff, point.x), gesture.narrowedPitchIndex ?? null);
        }
      }
      suppressClickRef.current = true;
      setDraggingNote(null);
      clearGhost(overlayRef.current);
    } else if (gesture.mode === 'durationCycle') {
      // Already applied directly to the note on every hold tick (see
      // startNoteHoldCycle) — nothing left to commit here.
      suppressClickRef.current = true;
      clearGhost(overlayRef.current);
    } else {
      onSelectNote(gesture.location, gesture.narrowedPitchIndex);
      onFocusMeasure(gesture.location.measureIndex);
      clearGhost(overlayRef.current);
    }
  };

  /** Hold on a selected note: cycle its duration once per second. Mouse applies
   * each tick directly to the real note (same immediate motion as the
   * right-click-hold shortening) — no separate preview layout. Touch still
   * previews in a red ghost and only commits on release (no separate
   * "confirm" gesture exists there, so a stray hold shouldn't mutate the
   * score until the finger lifts). */
  const startNoteHoldCycle = (isTouch: boolean) => {
    const tick = () => {
      const g = isTouch ? touchGestureRef.current : mouseGestureRef.current;
      const result = renderResultRef.current;
      if (!g || g.kind !== 'note' || g.mode === 'drag' || !result) return;
      g.mode = 'durationCycle';
      g.cycleDuration = cycleDurationLonger(g.cycleDuration);
      if (!isTouch) {
        onChangeDuration(g.location, g.cycleDuration);
        return;
      }
      const staff = staffGeometryFor(result, g.location.measureIndex, g.location.clef);
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

  /**
   * Takes keyboard focus off whatever toolbar control still holds it, so the
   * next keypress belongs to the score.
   *
   * Pressing on the staff normally moves focus by itself, but every press
   * handler here calls preventDefault() (to stop text selection and the
   * browser's own drag), and that suppresses the focus change along with it.
   * So after picking a key signature the <select> stayed focused, and the
   * spacebar meant "open this dropdown" to the browser instead of "place the
   * note" — the score never saw the key at all, and the dropdown had to be
   * dismissed by hand before typing could continue. Same trap for a toolbar
   * <button>, where the spacebar re-presses it.
   *
   * Anything inside the score container is left alone: the chord/lyric inline
   * editors are real inputs living in there, and they own the keyboard for as
   * long as they are open.
   */
  const releaseToolbarFocus = () => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return;
    if (containerRef.current?.contains(active)) return;
    if (!['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(active.tagName)) return;
    active.blur();
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button === 2) {
      const result = renderResultRef.current;
      const point = eventPoint(event);
      if (!result || !point) return;
      event.preventDefault();
      // Right-clicking the seek bar handle creates/clears a 못갖춘마디 (or
      // trailing partial measure) at wherever it currently sits — see
      // onTogglePickupOrTrailing (replaces the old always-visible toolbar toggle).
      if (nearSeekHandle(point)) {
        onTogglePickupOrTrailing();
        return;
      }
      const click = resolveClick(result, point.x, point.y);
      if (click?.type !== 'select') return;
      const location: NoteLocation = { measureIndex: click.measureIndex, clef: click.clef, noteIndex: click.noteIndex };
      const note = score.measures[location.measureIndex][location.clef].notes[location.noteIndex];
      if (!note || note.isRest || note.pitches.length === 0) return;
      rightHoldLocationRef.current = location;
      rightHoldFiredRef.current = false;
      rightHoldDurationRef.current = note.duration;
      rightHoldIntervalRef.current = window.setInterval(() => {
        rightHoldFiredRef.current = true;
        const next = cycleDurationShorter(rightHoldDurationRef.current ?? note.duration);
        rightHoldDurationRef.current = next;
        onChangeDuration(location, next);
      }, HOLD_CYCLE_MS);
      document.addEventListener('mouseup', handleRightMouseUp);
      return;
    }
    if (event.button !== 0) return;
    const result = renderResultRef.current;
    const point = eventPoint(event);
    if (!result || !point) return;
    event.preventDefault();
    releaseToolbarFocus();
    clearGhost(overlayRef.current);
    if (inlineEditor) commitInlineEditor();

    // 코드 적용 시작 음표 선택 모드: the next click anywhere resolves against
    // a note instead of its usual action. A hit on a real note (in the same
    // measure the chord lives in) commits the pick; anything else (empty
    // staff space, a different measure, another chord) just cancels the
    // mode without side effects, so it's easy to back out of.
    if (pickingChordStart) {
      const click = resolveClick(result, point.x, point.y);
      if (click?.type === 'select' && click.measureIndex === pickingChordStart.measureIndex) {
        onSetChordStartNote(pickingChordStart.measureIndex, pickingChordStart.chordId, click.clef, click.noteIndex);
      }
      setPickingChordStart(null);
      suppressClickRef.current = true;
      return;
    }

    // Shift+drag anywhere on the staff draws a rubber-band that multi-selects
    // every notehead inside it (for batch copy/paste). Takes priority over
    // note placement/selection so it works even when starting over a note.
    // Ctrl/Cmd does the same but ADDS to the current selection instead of
    // replacing it — and Ctrl+click without dragging toggles the single item
    // under the pointer, so a scattered selection can be built up one note at
    // a time (see the marquee branch of handleDocumentMouseUp).
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      mouseGestureRef.current = {
        kind: 'marquee',
        startX: point.x,
        startY: point.y,
        curX: point.x,
        curY: point.y,
        additive: event.ctrlKey || event.metaKey,
      };
      document.addEventListener('mousemove', handleDocumentMouseMove);
      document.addEventListener('mouseup', handleDocumentMouseUp);
      return;
    }

    if (nearBoundaryHandle(point, pickupBoundarySpec())) {
      startBoundaryResize('pickup', point);
      document.addEventListener('mousemove', handleBoundaryResizeDocMouseMove);
      document.addEventListener('mouseup', handleBoundaryResizeDocMouseUp);
      return;
    }

    if (nearBoundaryHandle(point, trailingBoundarySpec())) {
      startBoundaryResize('trailing', point);
      document.addEventListener('mousemove', handleBoundaryResizeDocMouseMove);
      document.addEventListener('mouseup', handleBoundaryResizeDocMouseUp);
      return;
    }

    if (nearSeekHandle(point)) {
      seekDraggingRef.current = true;
      document.addEventListener('mousemove', handleSeekDocMouseMove);
      document.addEventListener('mouseup', handleSeekDocMouseUp);
      return;
    }

    // Red "!" on an under-filled measure — pads it out with rests. Checked
    // ahead of the chord band it overlaps, which would otherwise swallow it.
    const warnMeasureIndex = findMeasureWarningAt(point);
    if (warnMeasureIndex !== null) {
      onFillMeasureRests(warnMeasureIndex);
      suppressClickRef.current = true;
      return;
    }

    // A measure's own right barline: press the 자동정렬 button hanging under
    // it, or drag the bar (or its arrows) sideways to hand-size the measure. A
    // press that never moves still falls through to the seek-to-this-barline
    // behaviour below (see handleMeasureResizeDocMouseUp).
    // A note the user can actually see always outranks the barline tools'
    // invisible drag affordances. The 자동정렬 button is the exception — it is
    // a real, visible button, so it keeps its own press.
    const barPress = findMeasureBarPressAt(point);
    if (barPress && (barPress.part === 'button' || resolveClick(result, point.x, point.y)?.type !== 'select')) {
      if (barPress.part === 'button') {
        onAutoAlignMeasure(barPress.measureIndex);
        suppressClickRef.current = true;
        return;
      }
      startMeasureResize(barPress.measureIndex, point);
      document.addEventListener('mousemove', handleMeasureResizeDocMouseMove);
      document.addEventListener('mouseup', handleMeasureResizeDocMouseUp);
      return;
    }

    const barlineMeasureIndex = findMeasureStartAt(point.x, point.y);
    if (barlineMeasureIndex !== null) {
      onSeekBeat(measureStartBeat(score, barlineMeasureIndex));
      suppressClickRef.current = true;
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
      // A press directly on an existing chord (to drag it, or to open its
      // inline editor if it turns out not to have moved) marks this as the
      // focused measure too, just like every other click type here — so
      // "click a chord to point the paste at its measure" (see App's
      // handlePasteChords) works even when the click lands on the chord's
      // own label instead of empty staff space nearby.
      onFocusMeasure(chordHit.measureIndex);
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

    // A press on one of a selected rest mark's 4 corner handles (see RestMark
    // / #187) starts a resize-the-visual-scale drag — checked before the
    // mark's own body hit-test so the tiny handle reliably wins when both
    // overlap near the glyph's edge.
    const restMarkHandleHit = findRestMarkHandleAt(result, point.x, point.y);
    if (restMarkHandleHit) {
      const mark = result.restMarkHitboxes.find((r) => r.restMarkId === restMarkHandleHit.restMarkId);
      mouseGestureRef.current = {
        kind: 'resizeRestMarkScale',
        measureIndex: restMarkHandleHit.measureIndex,
        restMarkId: restMarkHandleHit.restMarkId,
        centerX: restMarkHandleHit.centerX,
        centerY: restMarkHandleHit.centerY,
        startDist: Math.hypot(point.x - restMarkHandleHit.centerX, point.y - restMarkHandleHit.centerY),
        startScale: mark?.scale ?? 1,
      };
      document.addEventListener('mousemove', handleDocumentMouseMove);
      document.addEventListener('mouseup', handleDocumentMouseUp);
      return;
    }

    // A press directly on an existing rest mark's own glyph selects it (so
    // its corner handles appear) and starts a click-and-drag reposition —
    // checked early so the small glyph reliably wins over whatever
    // note/staff region happens to sit underneath it.
    const restMarkHit = findRestMarkAt(result, point.x, point.y);
    if (restMarkHit) {
      onSelectRestMark({ measureIndex: restMarkHit.measureIndex, restMarkId: restMarkHit.restMarkId });
      const staff = result.staffHitboxes.find((s) => s.measureIndex === restMarkHit.measureIndex && s.clef === restMarkHit.clef);
      if (staff) {
        mouseGestureRef.current = {
          kind: 'moveRestMark',
          measureIndex: restMarkHit.measureIndex,
          clef: restMarkHit.clef,
          restMarkId: restMarkHit.restMarkId,
          staffRefY0: staff.refY0,
          staffSpacing: staff.spacing,
          staffNoteStartX: staff.noteStartX,
          staffNoteAreaWidth: staff.noteAreaWidth,
        };
        document.addEventListener('mousemove', handleDocumentMouseMove);
        document.addEventListener('mouseup', handleDocumentMouseUp);
      }
      suppressClickRef.current = true;
      return;
    }

    // Neither the handles nor the body of any rest mark were hit this press —
    // any currently-selected one loses its selection (and corner handles).
    if (selectedRestMark) onSelectRestMark(null);

    // A click precisely on a grace note's own small notehead selects IT
    // (see selectedGrace) instead of its host note — checked before the
    // host's own click resolution below so the smaller glyph wins.
    const graceHit = findGraceNoteAt(result, point.x, point.y);
    if (graceHit && !editTool.graceNoteMode) {
      // onDeselectNote also clears selectedGrace (see App's
      // handleDeselectNote) — called first so the onSelectGrace right after
      // is the one whose state update actually sticks, instead of being
      // immediately clobbered back to null by the batched deselect.
      onDeselectNote();
      onSelectGrace({ measureIndex: graceHit.measureIndex, clef: graceHit.clef, noteIndex: graceHit.noteIndex });
      suppressClickRef.current = true;
      return;
    }

    // In 도수 입력 모드, a click on the enlarged degree digit itself selects
    // the exact note/pitch it labels (a plain select, no drag) — checked
    // before the generic click resolution below so a click on the digit
    // reliably lands on ITS note, not whichever note the pointer happens to
    // be nearest by the usual radius search (the pill can visually sit close
    // to a neighboring note).
    if (degreeInputMode) {
      const degreeHit = findDegreeMarkAt(result, point.x, point.y);
      if (degreeHit) {
        const alt = alternateDegreeSpelling(degreeHit.text);
        if (alt && window.confirm(`이 음을 ${alt}(으)로 표시할까요?`)) {
          onSetManualScaleDegree(
            scaleDegreeKey(degreeHit.clef, degreeHit.measureIndex, degreeHit.noteIndex, degreeHit.pitchIndex),
            alt,
          );
        }
        onSelectGrace(null);
        onSelectNote({ measureIndex: degreeHit.measureIndex, clef: degreeHit.clef, noteIndex: degreeHit.noteIndex }, degreeHit.pitchIndex);
        suppressClickRef.current = true;
        return;
      }
    }

    const click = resolveClickPreferSelect(result, point.x, point.y);
    if (!click) {
      if (lockedPreviewRef.current) {
        setLockedPreview(null);
        clearGhost(overlayRef.current);
      }
      onSelectGrace(null);
      onDeselectNote();
      return;
    }

    // 꾸밈음 mode: a click on an existing note toggles a grace note on it
    // (at the clicked pitch) instead of the usual select/place behavior;
    // a click on empty staff is simply ignored (grace notes need a host note).
    if (editTool.graceNoteMode) {
      if (click.type === 'select') {
        const staff = findStaffAt(result, point.x, point.y);
        if (staff) {
          const { snappedLine } = pitchAt(click.clef, staff, point.y);
          const { letter, octave } = lineToPitch(click.clef, snappedLine);
          onToggleGraceNote({ measureIndex: click.measureIndex, clef: click.clef, noteIndex: click.noteIndex }, letter, octave);
        }
      }
      suppressClickRef.current = true;
      return;
    }

    if (click.type === 'select') {
      // Selecting an existing note cancels any locked placement preview
      // (and any grace-note selection — the two are mutually exclusive).
      if (lockedPreviewRef.current) {
        setLockedPreview(null);
        clearGhost(overlayRef.current);
      }
      onSelectGrace(null);
      const location: NoteLocation = { measureIndex: click.measureIndex, clef: click.clef, noteIndex: click.noteIndex };
      const note = score.measures[location.measureIndex][location.clef].notes[location.noteIndex];
      // The melody staff used to be special-cased here to always narrow to a
      // chord's top pitch, since that was the only pitch it could show. It
      // holds its own notes now (see Measure.melody) — including chords of
      // its own — so it narrows by which notehead was actually clicked, like
      // any other staff.
      const narrowedPitchIndex = resolveNarrowedPitchIndex(location, point.x, point.y);
      const primaryPitch = narrowedPitchIndex !== undefined ? note.pitches[narrowedPitchIndex] : note.pitches[0];
      const gestureStartLine = primaryPitch ? pitchToLine(location.clef, primaryPitch.letter, primaryPitch.octave) : 0;
      const pressStaff = staffGeometryFor(result, location.measureIndex, location.clef);
      const gesture: Extract<MouseGesture, { kind: 'note' }> = {
        kind: 'note',
        location,
        startX: point.x,
        startY: point.y,
        startLine: gestureStartLine,
        lastLine: gestureStartLine,
        grabLineOffset: pressStaff ? lineAt(pressStaff, point.y) - gestureStartLine : 0,
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
    onSelectGrace(null);
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
    // Pickup/trailing resize handles stay hidden until the pointer hovers
    // that measure, so they don't clutter the score otherwise — this runs
    // unconditionally (even during other gestures) except mid-drag, where
    // the drag itself already forces the dragged handle visible.
    if (!boundaryResizeRef.current) {
      const hoverPoint = eventPoint(event);
      const nextHover = hoverPoint
        ? inHoverZone(hoverPoint, pickupHoverZone())
          ? 'pickup'
          : inHoverZone(hoverPoint, trailingHoverZone())
            ? 'trailing'
            : null
        : null;
      if (nextHover !== hoverBoundaryRef.current) {
        hoverBoundaryRef.current = nextHover;
        refreshPickupHandles();
      }
    }

    // Per-measure barline tools (hand-resize grip + 자동정렬 button) appear
    // only while the pointer is actually on that barline, and the red "!"
    // badges grow slightly under the pointer — both purely visual, so they
    // run even while another gesture owns the press.
    if (!measureResizeRef.current) {
      const hoverPoint = eventPoint(event);
      const barIndex = hoverPoint ? findMeasureBarAt(hoverPoint) : null;
      const next = barIndex === null ? null : { measureIndex: barIndex, buttonHot: overAutoAlignButton(barIndex, hoverPoint!) };
      const prev = hoverBarRef.current;
      if (next?.measureIndex !== prev?.measureIndex || next?.buttonHot !== prev?.buttonHot) {
        hoverBarRef.current = next;
        refreshMeasureTools();
      }

      const nextWarning = hoverPoint ? findMeasureWarningAt(hoverPoint) : null;
      if (nextWarning !== hotWarningRef.current) {
        hotWarningRef.current = nextWarning;
        refreshMeasureWarnings();
      }

      // The barline tools own this spot — showing an "you'd add a note here"
      // ghost under them would promise something the click won't do.
      const onTool = !!next || nextWarning !== null;
      if (containerRef.current) {
        containerRef.current.style.cursor = !onTool ? '' : next && !next.buttonHot && nextWarning === null ? 'ew-resize' : 'pointer';
      }
      if (onTool) {
        clearGhost(overlayRef.current);
        clearTooltip(overlayRef.current);
        return;
      }
    }

    if (mouseGestureRef.current) return; // active press handled by document listeners
    if (lockedPreviewRef.current) return; // a locked preview owns the ghost; don't hover-draw over it
    const result = renderResultRef.current;
    const point = eventPoint(event);
    if (!result || !point) {
      clearGhost(overlayRef.current);
      clearTooltip(overlayRef.current);
      if (containerRef.current) containerRef.current.style.cursor = '';
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
    // A locked preview (blue) is a committed placement-in-progress, not a
    // hover hint — it must stay on screen even once the pointer leaves the
    // staff (e.g. to click a toolbar button or the mouse leaves the page
    // entirely) until the user explicitly commits or cancels it.
    if (!mouseGestureRef.current && !lockedPreviewRef.current) {
      clearGhost(overlayRef.current);
      clearTooltip(overlayRef.current);
    }
    if (!boundaryResizeRef.current && hoverBoundaryRef.current !== null) {
      hoverBoundaryRef.current = null;
      refreshPickupHandles();
    }
    if (!measureResizeRef.current && hoverBarRef.current !== null) {
      hoverBarRef.current = null;
      refreshMeasureTools();
    }
    if (hotWarningRef.current !== null) {
      hotWarningRef.current = null;
      refreshMeasureWarnings();
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
    // macOS fires contextmenu for Ctrl+click, which is our additive
    // multi-select gesture — deleting the chord/lyric under the pointer
    // instead would be a nasty surprise. The mousedown handler has already
    // claimed this press; just swallow the menu.
    if (event.ctrlKey || event.metaKey) return;
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

    const restMarkHit = findRestMarkAt(result, point.x, point.y);
    if (restMarkHit) {
      onDeleteRestMark(restMarkHit.measureIndex, restMarkHit.restMarkId);
      if (selectedRestMark?.restMarkId === restMarkHit.restMarkId) onSelectRestMark(null);
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
    const staff = staffGeometryFor(result, preview.measureIndex, preview.clef);
    if (!staff) return;
    renderAddGhost(staff, preview.x, preview.line, preview.duration, preview.chordTarget !== null);
  };

  const commitPending = () => {
    const preview = pendingPreviewRef.current;
    const result = renderResultRef.current;
    if (!preview || !result) return;
    const staff = staffGeometryFor(result, preview.measureIndex, preview.clef);
    // A deliberate tap commit selects the note it just created (mirrors the mouse click case — item 2).
    if (staff) commitAdd(preview.measureIndex, preview.clef, staff, preview.line, preview.x, preview.duration, true);
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
    releaseToolbarFocus();
    if (inlineEditor) commitInlineEditor();

    if (nearBoundaryHandle(point, pickupBoundarySpec())) {
      event.preventDefault();
      startBoundaryResize('pickup', point);
      return;
    }

    if (nearBoundaryHandle(point, trailingBoundarySpec())) {
      event.preventDefault();
      startBoundaryResize('trailing', point);
      return;
    }

    if (nearSeekHandle(point)) {
      event.preventDefault();
      seekDraggingRef.current = true;
      return;
    }

    // Red "!" on an under-filled measure — always on screen (no hover needed),
    // so it taps the same as it clicks.
    const warnMeasureIndex = findMeasureWarningAt(point);
    if (warnMeasureIndex !== null) {
      event.preventDefault();
      onFillMeasureRests(warnMeasureIndex);
      return;
    }

    // Touch has no hover to reveal the barline tools, so a touch that lands on
    // one goes straight into a resize drag; releasing without moving still
    // falls through to the seek jump (see handleTouchEnd).
    // A note the user can actually see always outranks the barline tools'
    // invisible drag affordances. The 자동정렬 button is the exception — it is
    // a real, visible button, so it keeps its own press.
    const barPress = findMeasureBarPressAt(point);
    if (barPress && (barPress.part === 'button' || resolveClick(result, point.x, point.y)?.type !== 'select')) {
      event.preventDefault();
      if (barPress.part === 'button') {
        onAutoAlignMeasure(barPress.measureIndex);
        return;
      }
      startMeasureResize(barPress.measureIndex, point);
      return;
    }

    const barlineMeasureIndex = findMeasureStartAt(point.x, point.y);
    if (barlineMeasureIndex !== null) {
      event.preventDefault();
      onSeekBeat(measureStartBeat(score, barlineMeasureIndex));
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

    // Chord symbols and lyrics are grabbable: a stationary tap focuses/does
    // nothing, a move drags them. Deliberate, so we claim the touch.
    const chordHit = findChordAt(result, point.x, point.y);
    if (chordHit) {
      event.preventDefault();
      onFocusMeasure(chordHit.measureIndex);
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

    if (editTool.graceNoteMode) {
      if (click?.type === 'select') {
        event.preventDefault();
        const staff = findStaffAt(result, point.x, point.y);
        if (staff) {
          const { snappedLine } = pitchAt(click.clef, staff, point.y);
          const { letter, octave } = lineToPitch(click.clef, snappedLine);
          onToggleGraceNote({ measureIndex: click.measureIndex, clef: click.clef, noteIndex: click.noteIndex }, letter, octave);
        }
      }
      return;
    }

    if (click?.type === 'select') {
      event.preventDefault();
      const location: NoteLocation = { measureIndex: click.measureIndex, clef: click.clef, noteIndex: click.noteIndex };
      const note = score.measures[location.measureIndex][location.clef].notes[location.noteIndex];
      const narrowedPitchIndex = resolveNarrowedPitchIndex(location, point.x, point.y);
      const primaryPitch = narrowedPitchIndex !== undefined ? note.pitches[narrowedPitchIndex] : note.pitches[0];
      const gestureStartLine = primaryPitch ? pitchToLine(location.clef, primaryPitch.letter, primaryPitch.octave) : 0;
      const pressStaff = staffGeometryFor(result, location.measureIndex, location.clef);
      const gesture: Extract<TouchGesture, { kind: 'note' }> = {
        kind: 'note',
        location,
        startX: point.x,
        startY: point.y,
        startLine: gestureStartLine,
        lastLine: gestureStartLine,
        grabLineOffset: pressStaff ? lineAt(pressStaff, point.y) - gestureStartLine : 0,
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

    if (boundaryResizeRef.current) {
      event.preventDefault();
      const drag = boundaryResizeRef.current;
      const point = event.touches[0] && eventPoint(event.touches[0]);
      if (point) {
        const capacity = measureCapacityBeats(score.timeSignature);
        const newSplitBeat = Math.min(capacity - 0.05, Math.max(0.05, drag.startBeat + (point.x - drag.startX) / drag.pxPerBeat));
        if (drag.which === 'pickup') {
          onResizePickupMeasure(newSplitBeat);
        } else {
          onResizeTrailingMeasure(newSplitBeat);
        }
      }
      return;
    }

    if (measureResizeRef.current) {
      event.preventDefault();
      const point = event.touches[0] && eventPoint(event.touches[0]);
      if (point) updateMeasureResize(point);
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
    const staff = staffGeometryFor(result, gesture.location.measureIndex, gesture.location.clef);
    if (!staff) return;
    const note = score.measures[gesture.location.measureIndex][gesture.location.clef].notes[gesture.location.noteIndex];
    const { snappedLine } = stickyPitchAt(gesture.location.clef, staff, point.y, gesture.lastLine, gesture.grabLineOffset);
    gesture.lastLine = snappedLine;
    // A manual drag is honored even once the measure is full (#241).
    renderDragGhost(staff, point.x, snappedLine, note.duration, (note.pitches[gesture.narrowedPitchIndex ?? 0]?.accidental ?? '') as Accidental);
  };

  const handleTouchEnd = (event: TouchEvent) => {
    if (event.touches.length < 2) pinchRef.current = null;
    if (pinchRef.current) return;
    if (boundaryResizeRef.current) {
      boundaryResizeRef.current = null;
      return;
    }
    if (measureResizeRef.current) {
      const drag = measureResizeRef.current;
      measureResizeRef.current = null;
      // A tap that never became a drag keeps the barline's own seek jump.
      if (!drag.moved) {
        const seekTarget = findMeasureStartAt(drag.startX, drag.startY);
        if (seekTarget !== null) onSeekBeat(measureStartBeat(score, seekTarget));
      }
      refreshMeasureTools();
      return;
    }
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
        const staff = staffGeometryFor(result, gesture.measureIndex, gesture.clef);
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
      renderChordSnapGuide(overlayRef.current, null);
      return;
    }

    if (gesture.kind === 'note') {
      if (gesture.mode === 'drag') {
        if (point && result) {
          const staff = staffGeometryFor(result, gesture.location.measureIndex, gesture.location.clef);
          if (staff) {
            const { snappedLine } = stickyPitchAt(gesture.location.clef, staff, point.y, gesture.lastLine, gesture.grabLineOffset);
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
              // A manual drag is honored even once the measure is full (#241).
              onMoveNote(gesture.location, deltaLine, xFractionAt(staff, point.x), gesture.narrowedPitchIndex ?? null);
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
    <div className="staff-scroll" ref={staffScrollRef}>
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
              {inlineEditor.kind === 'chordEdit' && (
                <button
                  type="button"
                  className="chord-start-note-btn"
                  style={{ left: inlineEditor.left, top: inlineEditor.top + 22, width: inlineEditor.width }}
                  title="이 코드를 적용할 멜로디 음표를 선택합니다"
                  // Clicking this button shifts focus away from the text
                  // input, which fires its onBlur → commitInlineEditor() →
                  // setInlineEditor(null) — that unmounts this very button
                  // (it only exists inside {inlineEditor && ...}) BEFORE the
                  // click event has a chance to fire on it. preventDefault
                  // on mousedown stops the focus change (and thus the blur)
                  // from happening at all, so the button survives to fire
                  // its own handler; commit the text manually here instead.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    const ed = inlineEditor;
                    if (!ed || ed.kind !== 'chordEdit') return;
                    commitInlineEditor();
                    setPickingChordStart({ measureIndex: ed.measureIndex, chordId: ed.chordId });
                  }}
                >
                  적용 시작 음표 선택
                </button>
              )}
            </div>
          )}
          {pickingChordStart && (
            <div className="chord-start-note-hint">
              적용을 시작할 멜로디 음표를 클릭하세요 (Esc로 취소)
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const StaffEditor = forwardRef(StaffEditorInner);
