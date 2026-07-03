import { useEffect, useRef, useState } from 'react';
import type { Accidental, DurationValue, Score } from '../types/score';
import { DURATION_LABELS } from '../lib/scoreUtils';

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
];

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
  connectActive: boolean;
  canConnect: boolean;
  onToggleConnect: () => void;
}

export function Toolbar({
  score,
  onScoreMetaChange,
  editTool,
  onEditToolChange,
  hasSelection,
  onDeleteSelected,
  onDeselectNote,
  connectActive,
  canConnect,
  onToggleConnect,
}: ToolbarProps) {
  const longPressTimerRef = useRef<number | null>(null);
  const longPressAdvancedRef = useRef(false);

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
    onEditToolChange({ duration });
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
            className={`tool-icon-btn ${editTool.duration === d ? 'active' : ''}`}
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
        <label className="tool-checkbox" title="쉼표">
          <input
            type="checkbox"
            checked={editTool.isRest}
            onChange={(e) => onEditToolChange({ isRest: e.target.checked })}
          />
          쉼표
        </label>
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
        <button className="tool-compact" onClick={onDeleteSelected} disabled={!hasSelection} title="선택한 음표 삭제">
          🗑 삭제
        </button>
        <button
          className={`tool-compact ${connectActive ? 'active' : ''}`}
          onClick={onToggleConnect}
          disabled={!canConnect}
          title="선택한 음표를 다음 음표와 연결 (같은 음=붙임줄, 다른 음=이음줄)"
        >
          이음줄/붙임줄
        </button>
      </div>
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
