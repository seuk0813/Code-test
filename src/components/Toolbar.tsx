import { useRef } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import type { Accidental, DurationValue, Score } from '../types/score';
import { DURATION_LABELS } from '../lib/scoreUtils';

const DURATIONS: DurationValue[] = ['w', 'h', 'q', '8', '16'];
const LONG_PRESS_STEP_MS = 1000;
const ACCIDENTALS: { value: Accidental; label: string }[] = [
  { value: '', label: '없음' },
  { value: '#', label: '♯' },
  { value: 'b', label: '♭' },
  { value: 'n', label: '♮' },
];
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
  onAddMeasure: () => void;
  tieActive: boolean;
  slurActive: boolean;
  canConnect: boolean;
  onToggleTie: () => void;
  onToggleSlur: () => void;
  isPlaying: boolean;
  onPlay: () => void;
  onStop: () => void;
  onExportMusicXml: () => void;
  onExportMidi: () => void;
  onSaveJson: () => void;
  onLoadJson: (file: File) => void;
  chordTool: ChordTool;
  onChordToolChange: (patch: Partial<ChordTool>) => void;
  focusedMeasureIndex: number | null;
  focusedMeasureChordCount: number;
  onAddChord: () => void;
}

const CHORD_PLACEHOLDER = '예: C, Am, G7, Fmaj7, Bm7b5';

export function Toolbar({
  score,
  onScoreMetaChange,
  editTool,
  onEditToolChange,
  hasSelection,
  onDeleteSelected,
  onAddMeasure,
  tieActive,
  slurActive,
  canConnect,
  onToggleTie,
  onToggleSlur,
  isPlaying,
  onPlay,
  onStop,
  onExportMusicXml,
  onExportMidi,
  onSaveJson,
  onLoadJson,
  chordTool,
  onChordToolChange,
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
        <input
          className="composer-input"
          value={score.composer}
          onChange={(e) => onScoreMetaChange({ composer: e.target.value })}
          placeholder="작곡가"
        />
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
        <label>
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

      <div className="toolbar-row">
        <span className="group-label">{hasSelection ? '선택한 음표 편집' : '입력 도구'}</span>
        {DURATIONS.map((d) => (
          <button
            key={d}
            className={editTool.duration === d ? 'active' : ''}
            onClick={() => handleDurationClick(d)}
            onMouseDown={() => startLongPress(d)}
            onMouseUp={clearLongPress}
            onMouseLeave={clearLongPress}
            onTouchStart={() => startLongPress(d)}
            onTouchEnd={clearLongPress}
            title={`${DURATION_LABELS[d]} (길게 누르면 더 긴 음표로 전환)`}
          >
            {DURATION_LABELS[d]}
          </button>
        ))}
        <button
          className={editTool.dotted ? 'active' : ''}
          onClick={() => onEditToolChange({ dotted: !editTool.dotted })}
        >
          점음표
        </button>
        <button
          className={editTool.isRest ? 'active' : ''}
          onClick={() => onEditToolChange({ isRest: !editTool.isRest })}
        >
          쉼표
        </button>
        {ACCIDENTALS.map((a) => (
          <button
            key={a.value || 'none'}
            className={editTool.accidental === a.value ? 'active' : ''}
            onClick={() => onEditToolChange({ accidental: a.value })}
          >
            {a.label}
          </button>
        ))}
        <button onClick={onDeleteSelected} disabled={!hasSelection}>
          선택 삭제
        </button>
        <button className={tieActive ? 'active' : ''} onClick={onToggleTie} disabled={!canConnect} title="같은 음을 다음 음표와 타이로 연결">
          타이
        </button>
        <button className={slurActive ? 'active' : ''} onClick={onToggleSlur} disabled={!canConnect} title="다음 음표와 슬러로 연결">
          슬러
        </button>
        <button onClick={onAddMeasure}>마디 추가</button>
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
        {isPlaying ? (
          <button onClick={onStop}>⏹ 정지</button>
        ) : (
          <button onClick={onPlay}>▶ 재생</button>
        )}
        <button onClick={onExportMusicXml}>MusicXML 내보내기</button>
        <button onClick={onExportMidi}>MIDI 내보내기</button>
        <button className="save-file-button" onClick={onSaveJson} title="현재 악보를 파일(.json)로 저장합니다">
          💾 파일 저장
        </button>
        <label className="file-input-label save-file-button" title="저장했던 악보 파일(.json)을 불러옵니다">
          📂 파일 불러오기
          <input type="file" accept="application/json" onChange={handleLoadFile} />
        </label>
      </div>
    </div>
  );
}
