import { useEffect, useRef, useState } from 'react';
import type { Accidental, ChordQuality, DurationValue, Pitch, Score } from '../types/score';
import { CHORD_QUALITY_LABELS, DURATION_LABELS, measureCapacityBeats } from '../lib/scoreUtils';
import type { RecentScoreEntry } from '../lib/fileIO';

const DURATIONS: DurationValue[] = ['w', 'h', 'q', '8', '16'];
const LONG_PRESS_STEP_MS = 1000;
const ACCIDENTALS: { value: Accidental; label: string }[] = [
  { value: '', label: '∅' },
  { value: '#', label: '♯' },
  { value: 'b', label: '♭' },
  { value: 'n', label: '♮' },
];

/** Note-shape parameters for each duration, drawn as a small inline SVG icon. */
const NOTE_ICON: Record<DurationValue, { filled: boolean; stem: boolean; flags: number }> = {
  w: { filled: false, stem: false, flags: 0 },
  h: { filled: false, stem: true, flags: 0 },
  q: { filled: true, stem: true, flags: 0 },
  '8': { filled: true, stem: true, flags: 1 },
  '16': { filled: true, stem: true, flags: 2 },
};

/** The standard quarter-rest squiggle, reused by the quarter-rest glyph and the dotted-rest toggle icon. */
const QUARTER_REST_PATH =
  'M6 4 C 9.5 7.5, 9.5 9, 6.5 11 L 12.5 15.5 C 8 13.5, 7 17, 10.5 21';

/**
 * Eighth/sixteenth rests are NOT the quarter-rest squiggle with extra dots —
 * they're a distinct shape: a diagonal stem with one filled "flag" blob per
 * subdivision (two for sixteenth), matching standard notation.
 */
function FlaggedRestGlyph({ flagCount }: { flagCount: 1 | 2 }) {
  return (
    <svg width="16" height="22" viewBox="0 0 20 24" aria-hidden="true" focusable="false">
      <path
        d="M13.5 7 C 15 9, 13 10.5, 10.5 11.5 C 8.5 12.5, 9.5 14.5, 11 16.5 C 8.5 15, 6.5 17.5, 5.5 21"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="14.3" cy="5.8" r="2.6" fill="currentColor" />
      {flagCount === 2 && <circle cx="10.8" cy="12" r="2.6" fill="currentColor" />}
    </svg>
  );
}

/** Rest glyph for a duration: filled blocks for whole/half, the standard squiggle for quarter, a flagged diagonal stem for eighth/sixteenth. */
function RestGlyph({ duration }: { duration: DurationValue }) {
  if (duration === 'w') {
    return (
      <svg width="16" height="22" viewBox="0 0 20 24" aria-hidden="true" focusable="false">
        <rect x="5" y="6" width="10" height="4" fill="currentColor" />
      </svg>
    );
  }
  if (duration === 'h') {
    return (
      <svg width="16" height="22" viewBox="0 0 20 24" aria-hidden="true" focusable="false">
        <rect x="5" y="14" width="10" height="4" fill="currentColor" />
      </svg>
    );
  }
  if (duration === '8') return <FlaggedRestGlyph flagCount={1} />;
  if (duration === '16') return <FlaggedRestGlyph flagCount={2} />;
  return (
    <svg width="16" height="22" viewBox="0 0 20 24" aria-hidden="true" focusable="false">
      <path
        d={QUARTER_REST_PATH}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Dotted-toggle button icon: a dotted quarter note when placing notes, a dotted quarter REST when the rest checkbox is on. */
function DottedToggleGlyph({ isRest }: { isRest: boolean }) {
  if (!isRest) return <span className="tool-glyph">♩.</span>;
  return (
    <svg width="16" height="22" viewBox="0 0 20 24" aria-hidden="true" focusable="false">
      <path
        d={QUARTER_REST_PATH}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="15.5" cy="18" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** Compact note (or, when isRest, rest) glyph used on the duration buttons — renders identically on every device. */
function DurationIcon({ duration, isRest }: { duration: DurationValue; isRest: boolean }) {
  if (isRest) return <RestGlyph duration={duration} />;
  const s = NOTE_ICON[duration];
  const headCx = 6.5;
  const headCy = 17;
  const stemX = 10.3;
  return (
    <svg width="18" height="22" viewBox="0 0 20 24" aria-hidden="true" focusable="false">
      <ellipse
        cx={headCx}
        cy={headCy}
        rx="4.3"
        ry="3.1"
        transform={`rotate(-20 ${headCx} ${headCy})`}
        fill={s.filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {s.stem && <line x1={stemX} y1={headCy - 2} x2={stemX} y2="3.5" stroke="currentColor" strokeWidth="1.5" />}
      {Array.from({ length: s.flags }).map((_, i) => (
        <path
          key={i}
          d={`M ${stemX} ${4 + i * 5} q 6 2 4.5 8`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
const KEY_SIGNATURES = ['C', 'G', 'D', 'A', 'E', 'F', 'Bb', 'Eb', 'Ab'];
const TIME_SIGNATURES: [number, number][] = [
  [4, 4],
  [3, 4],
  [2, 4],
  [6, 8],
];

/** All 12 chromatic roots, sharp spelling (C through B), for the chord-builder root dropdown. */
const CHORD_ROOTS: { letter: Pitch['letter']; accidental: Accidental; label: string }[] = [
  { letter: 'C', accidental: '', label: 'C' },
  { letter: 'C', accidental: '#', label: 'C♯' },
  { letter: 'D', accidental: '', label: 'D' },
  { letter: 'D', accidental: '#', label: 'D♯' },
  { letter: 'E', accidental: '', label: 'E' },
  { letter: 'F', accidental: '', label: 'F' },
  { letter: 'F', accidental: '#', label: 'F♯' },
  { letter: 'G', accidental: '', label: 'G' },
  { letter: 'G', accidental: '#', label: 'G♯' },
  { letter: 'A', accidental: '', label: 'A' },
  { letter: 'A', accidental: '#', label: 'A♯' },
  { letter: 'B', accidental: '', label: 'B' },
];

const CHORD_QUALITIES: ChordQuality[] = ['maj', 'min', '7', 'maj7', 'min7', 'dim', 'aug', 'sus2', 'sus4', 'm7b5', 'dim7'];

export interface EditTool {
  duration: DurationValue;
  dotted: boolean;
  isRest: boolean;
  accidental: Accidental;
}

interface ToolbarProps {
  score: Score;
  onScoreMetaChange: (patch: Partial<Score>) => void;
  editTool: EditTool;
  onEditToolChange: (patch: Partial<EditTool>) => void;
  hasSelection: boolean;
  onDeleteSelected: () => void;
  onDeselectNote: () => void;
  /** Data the connect (tie/slur) button needs about the selected note; null when nothing eligible is selected. */
  connectInfo: ConnectInfo | null;
  /** Commits a tie/slur connection from the selected note to the next, anchored at the given pitch index. */
  onSetConnection: (kind: 'tie' | 'slur', pitchIndex: number) => void;
  /** Removes the selected note's connection to the next note. */
  onClearConnection: () => void;
  /** Clicking the already-active duration button again in "new note" mode (no staff note selected) toggles this — see StaffEditor's noteSelectMode. */
  selectMode: boolean;
  onSetSelectMode: (value: boolean) => void;
  /** Builds a chord symbol from a root+quality pair and adds it to the current measure — the structured alternative to typing free text directly on the score. */
  onAddChord: (root: Pitch['letter'], accidental: Accidental, quality: ChordQuality) => void;
  /** When true, new notes never auto-inherit the key signature's implied accidental (as if the piece were in C major). */
  cKeyBasedAccidentals: boolean;
  onToggleCKeyBasedAccidentals: () => void;
  /** Current seek/playback bar position in beats from the start of the score — the "못갖춘마디" toggle captures this as the pickup measure's length when pressed. */
  seekBeat: number;
}

export function Toolbar({
  score,
  onScoreMetaChange,
  editTool,
  onEditToolChange,
  hasSelection,
  onDeleteSelected,
  onDeselectNote,
  connectInfo,
  onSetConnection,
  onClearConnection,
  selectMode,
  onSetSelectMode,
  onAddChord,
  cKeyBasedAccidentals,
  onToggleCKeyBasedAccidentals,
  seekBeat,
}: ToolbarProps) {
  const [chordRootIndex, setChordRootIndex] = useState(0);
  const [chordQuality, setChordQuality] = useState<ChordQuality>('maj');
  const [showKeyOptions, setShowKeyOptions] = useState(false);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressAdvancedRef = useRef(false);
  useEffect(() => {
    onSetSelectMode(false);
  }, [editTool.duration, hasSelection, onSetSelectMode]);

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearInterval(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const startLongPress = (duration: DurationValue) => {
    longPressAdvancedRef.current = false;
    let idx = DURATIONS.indexOf(duration);
    longPressTimerRef.current = window.setInterval(() => {
      if (idx <= 0) {
        clearLongPress();
        return;
      }
      idx -= 1;
      longPressAdvancedRef.current = true;
      onEditToolChange({ duration: DURATIONS[idx] });
    }, LONG_PRESS_STEP_MS);
  };

  const handleDurationClick = (duration: DurationValue) => {
    if (longPressAdvancedRef.current) {
      longPressAdvancedRef.current = false;
      return;
    }
    // While editing a selected note, clicking its own already-active duration
    // again deselects it (back to "new note" mode) instead of a no-op re-set.
    if (hasSelection && duration === editTool.duration) {
      onDeselectNote();
      return;
    }
    // In "new note" mode, clicking the already-active duration again toggles
    // into note-selection mode: the highlight hides, and clicking the staff
    // now prefers selecting the nearest existing note over adding a new one
    // (see StaffEditor's noteSelectMode).
    if (!hasSelection && duration === editTool.duration && !selectMode) {
      onSetSelectMode(true);
      return;
    }
    onSetSelectMode(false);
    onEditToolChange({ duration });
  };

  /**
   * 못갖춘마디 toggle: OFF→ON captures the CURRENT seek bar position (in
   * beats from the start) as the first measure's pickup length — drag the
   * seek bar to where the pickup content should end, then press this. ON→OFF
   * just clears it, restoring a normal full first measure.
   */
  const handleTogglePickupMeasure = () => {
    if (score.pickupBeats !== undefined) {
      onScoreMetaChange({ pickupBeats: undefined });
      return;
    }
    const capacity = measureCapacityBeats(score.timeSignature);
    if (seekBeat <= 1e-6 || seekBeat >= capacity - 1e-6) {
      window.alert('먼저 재생 바를 첫 마디 안의 원하는 위치로 옮긴 뒤 다시 눌러주세요.');
      return;
    }
    onScoreMetaChange({ pickupBeats: seekBeat });
  };

  return (
    <div className="toolbar">
      <div className="toolbar-row">
        <label>
          박자
          <select
            value={`${score.timeSignature.numerator}/${score.timeSignature.denominator}`}
            onChange={(e) => {
              const [numerator, denominator] = e.target.value.split('/').map(Number);
              onScoreMetaChange({ timeSignature: { numerator, denominator } });
            }}
          >
            {TIME_SIGNATURES.map(([n, d]) => (
              <option key={`${n}/${d}`} value={`${n}/${d}`}>
                {n}/{d}
              </option>
            ))}
          </select>
        </label>
        <button
          className={`tool-icon-btn ${score.pickupBeats !== undefined ? 'active' : ''}`}
          onClick={handleTogglePickupMeasure}
          aria-label="못갖춘마디"
          title={
            score.pickupBeats !== undefined
              ? '다시 누르면 못갖춘마디를 해제하고 첫 마디를 원래 길이로 되돌립니다'
              : '재생 바를 첫 마디 안의 원하는 위치로 옮긴 뒤 누르면, 그 위치까지가 못갖춘마디 길이로 고정됩니다'
          }
        >
          못갖춘마디
        </button>
        <label>
          조표
          <select
            value={score.keySignature}
            onChange={(e) => onScoreMetaChange({ keySignature: e.target.value })}
          >
            {KEY_SIGNATURES.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <button
          className={`tool-compact ${showKeyOptions ? 'active' : ''}`}
          onClick={() => setShowKeyOptions((v) => !v)}
          aria-label="조표 옵션 더보기"
          title="조표 관련 옵션 더보기"
        >
          +
        </button>
        {showKeyOptions && (
          <button
            className={`tool-icon-btn ${cKeyBasedAccidentals ? 'active' : ''}`}
            onClick={onToggleCKeyBasedAccidentals}
            aria-label="C키 기준 임시표"
            title="켜면 조표에 맞는 임시표가 자동으로 붙습니다 (예: F키에서는 시 음에 자동으로 플랫). 끄면 자동 임시표가 사라집니다 (직접 입력한 임시표는 유지)"
          >
            C키 기준 임시표
          </button>
        )}
        <label className="tempo-field">
          템포
          <input
            type="number"
            min={20}
            max={300}
            value={score.tempo}
            onChange={(e) => onScoreMetaChange({ tempo: Number(e.target.value) })}
          />
          BPM
        </label>
      </div>

      <div className="toolbar-row toolbar-row-compact">
        <span className="group-label tool-group-label" title={hasSelection ? '선택한 음표를 편집합니다' : '새로 입력할 음표를 설정합니다'}>
          🎵 {hasSelection ? '음표 편집' : '음표 도구'}
        </span>
        {DURATIONS.map((d) => (
          <button
            key={d}
            className={`tool-icon-btn ${editTool.duration === d && !(selectMode && !hasSelection) ? 'active' : ''}`}
            onClick={() => handleDurationClick(d)}
            onMouseDown={() => startLongPress(d)}
            onMouseUp={clearLongPress}
            onMouseLeave={clearLongPress}
            onTouchStart={() => startLongPress(d)}
            onTouchEnd={clearLongPress}
            aria-label={DURATION_LABELS[d]}
            title={`${DURATION_LABELS[d]} (길게 누르면 더 긴 음표로 전환)`}
          >
            <DurationIcon duration={d} isRest={editTool.isRest} />
          </button>
        ))}
        <button
          className={`tool-icon-btn ${editTool.dotted ? 'active' : ''}`}
          onClick={() => onEditToolChange({ dotted: !editTool.dotted })}
          aria-label={editTool.isRest ? '점쉼표' : '점음표'}
          title={editTool.isRest ? '점쉼표' : '점음표'}
        >
          <DottedToggleGlyph isRest={editTool.isRest} />
        </button>
        <button
          className={`tool-icon-btn ${editTool.isRest ? 'active' : ''}`}
          // Not a persistent mode: pressed with a note selected, it flips
          // just that note (rest <-> note) and un-presses right after;
          // pressed with nothing selected, it arms turning the very next
          // note it touches into a rest, one-shot (see onEditToolChange).
          onClick={() => onEditToolChange({ isRest: hasSelection ? !editTool.isRest : true })}
          aria-label="쉼표로 변환"
          title="선택한 음표를 같은 박자의 쉼표로 변환"
        >
          쉼표
        </button>
        {ACCIDENTALS.map((a) => (
          <button
            key={a.value || 'none'}
            className={`tool-icon-btn ${editTool.accidental === a.value ? 'active' : ''}`}
            onClick={() => onEditToolChange({ accidental: a.value })}
            aria-label={a.value === '' ? '임시표 없음' : a.value === '#' ? '샤프' : a.value === 'b' ? '플랫' : '내추럴'}
            title={a.value === '' ? '임시표 없음' : a.value === '#' ? '샤프' : a.value === 'b' ? '플랫' : '내추럴'}
          >
            <span className="tool-glyph">{a.label}</span>
          </button>
        ))}
        <ConnectButton
          info={connectInfo}
          disabled={!hasSelection}
          onSetConnection={onSetConnection}
          onClearConnection={onClearConnection}
        />
        <button className="tool-compact" onClick={onDeleteSelected} disabled={!hasSelection} title="선택한 음표 삭제">
          🗑 삭제
        </button>
      </div>

      <div className="toolbar-row toolbar-row-compact">
        <span className="group-label tool-group-label" title="근음과 종류를 골라 코드 기호를 추가합니다">
          🎸 코드 생성
        </span>
        <select value={chordRootIndex} onChange={(e) => setChordRootIndex(Number(e.target.value))} aria-label="코드 근음">
          {CHORD_ROOTS.map((r, i) => (
            <option key={r.label} value={i}>
              {r.label}
            </option>
          ))}
        </select>
        <select value={chordQuality} onChange={(e) => setChordQuality(e.target.value as ChordQuality)} aria-label="코드 종류">
          {CHORD_QUALITIES.map((q) => (
            <option key={q} value={q}>
              {CHORD_QUALITY_LABELS[q]}
            </option>
          ))}
        </select>
        <button
          className="tool-compact"
          // Clicking this button while a chord text box is open on the score
          // would otherwise blur that input (committing/closing it) before
          // this button's onClick even runs, since blur fires on mousedown,
          // before click — losing the open editor a moment too early for
          // onAddChord's "is one still open?" check. Preventing the default
          // mousedown behavior keeps the input focused so it's still open.
          onMouseDown={(e) => e.preventDefault()}
          onTouchStart={(e) => e.preventDefault()}
          onClick={() => {
            const root = CHORD_ROOTS[chordRootIndex];
            onAddChord(root.letter, root.accidental, chordQuality);
          }}
          title="선택한 근음·종류로 코드 기호 추가"
        >
          + 코드 추가
        </button>
      </div>
    </div>
  );
}

/** Data the connect (tie/slur) button needs about the currently selected note. */
export interface ConnectInfo {
  /** Whether the selected note is already connected to the next one. */
  active: boolean;
  /** The selected note's pitches — a slur can anchor to any of them. */
  pitches: Pitch[];
  /** Indices into `pitches` that also appear in the next note — the only valid tie anchors. */
  tieCandidates: number[];
}

const SOLFEGE: Record<Pitch['letter'], string> = { C: '도', D: '레', E: '미', F: '파', G: '솔', A: '라', B: '시' };
const ACCIDENTAL_SYMBOL: Record<Accidental, string> = { '#': '♯', b: '♭', n: '♮', '': '' };

function pitchLabel(p: Pitch): string {
  return `${SOLFEGE[p.letter]}${ACCIDENTAL_SYMBOL[p.accidental]}${p.octave}`;
}

/**
 * Tie/slur connect button: a clean single glyph that, on click, asks whether
 * to add a tie (붙임줄 — always the same pitch, so no choice needed unless a
 * chord has more than one matching pitch in the next note) or a slur (이음줄
 * — always asks which pitch in the chord to anchor). Clicking while already
 * connected clears the connection immediately instead of reopening the menu.
 */
function ConnectButton({
  info,
  disabled,
  onSetConnection,
  onClearConnection,
}: {
  info: ConnectInfo | null;
  disabled: boolean;
  onSetConnection: (kind: 'tie' | 'slur', pitchIndex: number) => void;
  onClearConnection: () => void;
}) {
  const [step, setStep] = useState<'closed' | 'kind' | 'pitch'>('closed');
  const [pendingKind, setPendingKind] = useState<'tie' | 'slur'>('tie');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (step === 'closed') return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setStep('closed');
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [step]);

  // The selection (or its connection state) changed from underneath an open menu — close it.
  useEffect(() => {
    setStep('closed');
  }, [info]);

  const chooseKind = (kind: 'tie' | 'slur') => {
    if (!info) return;
    if (kind === 'tie') {
      if (info.tieCandidates.length === 0) {
        window.alert('다음 음표에 같은 음이 없어 붙임줄로 연결할 수 없습니다.');
        setStep('closed');
        return;
      }
      if (info.tieCandidates.length === 1) {
        onSetConnection('tie', info.tieCandidates[0]);
        setStep('closed');
        return;
      }
      setPendingKind('tie');
      setStep('pitch');
      return;
    }
    if (info.pitches.length === 1) {
      onSetConnection('slur', 0);
      setStep('closed');
      return;
    }
    setPendingKind('slur');
    setStep('pitch');
  };

  const candidateIndices = info ? (pendingKind === 'tie' ? info.tieCandidates : info.pitches.map((_, i) => i)) : [];

  return (
    <div className="connect-button" ref={rootRef}>
      <button
        className={`tool-compact ${info?.active ? 'active' : ''}`}
        onClick={() => {
          if (!info) return;
          if (info.active) {
            onClearConnection();
            setStep('closed');
          } else {
            setStep('kind');
          }
        }}
        disabled={disabled}
        aria-label="붙임줄/이음줄 연결"
        title={info?.active ? '연결 해제' : '붙임줄(같은 음) 또는 이음줄(다른 음)로 다음 음표와 연결'}
      >
        <span className="tool-glyph">⌣</span>
      </button>
      {step === 'kind' && info && (
        <div className="connect-popover">
          <button onClick={() => chooseKind('tie')}>붙임줄 (타이)</button>
          <button onClick={() => chooseKind('slur')}>이음줄 (슬러)</button>
        </div>
      )}
      {step === 'pitch' && info && (
        <div className="connect-popover">
          <div className="connect-popover-label">연결할 음 선택</div>
          {candidateIndices.map((i) => (
            <button
              key={i}
              onClick={() => {
                onSetConnection(pendingKind, i);
                setStep('closed');
              }}
            >
              {pitchLabel(info.pitches[i])}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "⋯" popover holding rarely-used actions (MusicXML / MIDI export) out of the main toolbar. */
export function MoreMenu({ onExportMusicXml, onExportMidi }: { onExportMusicXml: () => void; onExportMidi: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div className="more-menu" ref={rootRef}>
      <button className="tool-compact" onClick={() => setOpen((v) => !v)} aria-label="더보기" title="더보기">
        ⋯
      </button>
      {open && (
        <div className="more-menu-popover">
          <button
            onClick={() => {
              onExportMusicXml();
              setOpen(false);
            }}
          >
            MusicXML 내보내기
          </button>
          <button
            onClick={() => {
              onExportMidi();
              setOpen(false);
            }}
          >
            MIDI 내보내기
          </button>
        </div>
      )}
    </div>
  );
}

/** "불러오기" button: opens either a native file picker or one of the 5 most recently saved/loaded scores. */
export function LoadMenu({
  recentScores,
  onLoadFile,
  onLoadRecent,
}: {
  recentScores: RecentScoreEntry[];
  onLoadFile: (file: File) => void;
  onLoadRecent: (entry: RecentScoreEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div className="more-menu" ref={rootRef}>
      <button className="quick-action-button" onClick={() => setOpen((v) => !v)} title="저장했던 악보 파일을 불러오거나, 최근 작업한 악보를 다시 엽니다">
        📂 불러오기
      </button>
      {open && (
        <div className="more-menu-popover">
          <button onClick={() => fileInputRef.current?.click()}>파일에서 불러오기...</button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onLoadFile(file);
              e.target.value = '';
              setOpen(false);
            }}
          />
          {recentScores.length > 0 && (
            <>
              <div className="more-menu-divider" />
              <div className="more-menu-label">최근 작업한 악보</div>
              {recentScores.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => {
                    onLoadRecent(entry);
                    setOpen(false);
                  }}
                >
                  {entry.title || '제목 없는 악보'}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
