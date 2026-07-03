import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
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

/** Simple inline quarter-rest glyph (SVG so it renders on every device, unlike the SMP 𝄽). */
function RestIcon() {
  return (
    <svg width="16" height="22" viewBox="0 0 20 24" aria-hidden="true" focusable="false">
      <path
        d="M6 4 C 9.5 7.5, 9.5 9, 6.5 11 L 12.5 15.5 C 8 13.5, 7 17, 10.5 21"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Note-shape parameters for each duration, drawn as a small inline SVG icon. */
const NOTE_ICON: Record<DurationValue, { filled: boolean; stem: boolean; flags: number }> = {
  w: { filled: false, stem: false, flags: 0 },
  h: { filled: false, stem: true, flags: 0 },
  q: { filled: true, stem: true, flags: 0 },
  '8': { filled: true, stem: true, flags: 1 },
  '16': { filled: true, stem: true, flags: 2 },
};

/** Compact note glyph used on the duration buttons (renders identically on every device). */
function DurationIcon({ duration }: { duration: DurationValue }) {
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

export interface ChordTool {
  text: string;
}

interface ToolbarProps {
  score: Score;
  onScoreMetaChange: (patch: Partial<Score>) => void;
  editTool: EditTool;
  onEditToolChange: (patch: Partial<EditTool>) => void;
  hasSelection: boolean;
  onDeleteSelected: () => void;
  connectActive: boolean;
  canConnect: boolean;
  onToggleConnect: () => void;
  isPlaying: boolean;
  onPlay: () => void;
  onStop: () => void;
  onExportMusicXml: () => void;
  onExportMidi: () => void;
  onSaveJson: () => void;
  onLoadJson: (file: File) => void;
  chordTool: ChordTool;
  onChordToolChange: (patch: Partial<ChordTool>) => void;
  lyricText: string;
  onLyricToolChange: (text: string) => void;
  onAddLyrics: () => void;
  focusedMeasureIndex: number | null;
  focusedMeasureChordCount: number;
  onAddChord: () => void;
}

const CHORD_PLACEHOLDER = '자유 입력 (예: Cadd9, 아무 텍스트나)';
const LYRIC_PLACEHOLDER = '가사 입력 후 추가 (글자별로 배치)';

export function Toolbar({
  score,
  onScoreMetaChange,
  editTool,
  onEditToolChange,
  hasSelection,
  onDeleteSelected,
  connectActive,
  canConnect,
  onToggleConnect,
  isPlaying,
  onPlay,
  onStop,
  onExportMusicXml,
  onExportMidi,
  onSaveJson,
  onLoadJson,
  chordTool,
  onChordToolChange,
  lyricText,
  onLyricToolChange,
  onAddLyrics,
  focusedMeasureIndex,
  focusedMeasureChordCount,
  onAddChord,
}: ToolbarProps) {
  const handleLoadFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onLoadJson(file);
    event.target.value = '';
  };

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
            <DurationIcon duration={d} />
          </button>
        ))}
        <button
          className={`tool-icon-btn ${editTool.dotted ? 'active' : ''}`}
          onClick={() => onEditToolChange({ dotted: !editTool.dotted })}
          aria-label="점음표"
          title="점음표"
        >
          <span className="tool-glyph">♩.</span>
        </button>
        <button
          className={`tool-icon-btn ${editTool.isRest ? 'active' : ''}`}
          onClick={() => onEditToolChange({ isRest: !editTool.isRest })}
          aria-label="쉼표"
          title="쉼표"
        >
          <RestIcon />
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

      <div className="toolbar-row">
        <span className="group-label">코드 기호</span>
        <input
          className="chord-input"
          value={chordTool.text}
          placeholder={CHORD_PLACEHOLDER}
          onChange={(e) => onChordToolChange({ text: e.target.value })}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') onAddChord();
          }}
          disabled={focusedMeasureIndex === null}
        />
        <button onClick={onAddChord} disabled={focusedMeasureIndex === null || !chordTool.text.trim()}>
          코드 추가
        </button>
        <span className="group-label">
          {focusedMeasureIndex === null
            ? '악보에서 마디를 클릭해 선택하세요'
            : `${focusedMeasureIndex + 1}번 마디 (${focusedMeasureChordCount}개) — 추가 후 드래그로 위치 조정, 우클릭으로 삭제`}
        </span>
      </div>

      <div className="toolbar-row">
        <span className="group-label">가사</span>
        <input
          className="chord-input"
          value={lyricText}
          placeholder={LYRIC_PLACEHOLDER}
          onChange={(e) => onLyricToolChange(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') onAddLyrics();
          }}
          disabled={focusedMeasureIndex === null}
        />
        <button onClick={onAddLyrics} disabled={focusedMeasureIndex === null || !lyricText.trim()}>
          가사 추가
        </button>
        <span className="group-label">두 보표 사이에 표시 · 글자별 드래그 이동, 우클릭 삭제</span>
      </div>

      <div className="toolbar-row">
        {isPlaying ? (
          <button className="play-button" onClick={onStop} aria-label="정지" title="정지">
            ⏹
          </button>
        ) : (
          <button className="play-button" onClick={onPlay} aria-label="재생" title="재생">
            ▶
          </button>
        )}
        <button className="save-file-button" onClick={onSaveJson} title="현재 악보를 파일(.json)로 저장합니다">
          💾 파일 저장
        </button>
        <label className="file-input-label save-file-button" title="저장했던 악보 파일(.json)을 불러옵니다">
          📂 파일 불러오기
          <input type="file" accept="application/json" onChange={handleLoadFile} />
        </label>
        <MoreMenu onExportMusicXml={onExportMusicXml} onExportMidi={onExportMidi} />
      </div>
    </div>
  );
}

/** "⋯" popover holding rarely-used actions (MusicXML / MIDI export) out of the main toolbar. */
function MoreMenu({ onExportMusicXml, onExportMidi }: { onExportMusicXml: () => void; onExportMidi: () => void }) {
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
