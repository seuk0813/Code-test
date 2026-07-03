import { useEffect, useRef, useState } from 'react';
import { hasNativeSavePicker } from '../lib/fileIO';

export type SaveFormat = 'pdf' | 'json';

interface SaveDialogProps {
  defaultName: string;
  onCancel: () => void;
  onSave: (filename: string, format: SaveFormat) => void;
}

/** Modal asking for a filename and a format (PDF or JSON) before saving. */
export function SaveDialog({ defaultName, onCancel, onSave }: SaveDialogProps) {
  const [name, setName] = useState(defaultName || '제목 없는 악보');
  const [format, setFormat] = useState<SaveFormat>('pdf');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = () => {
    const trimmed = name.trim() || '제목 없는 악보';
    onSave(trimmed, format);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal-title">악보 저장</h2>

        <label className="modal-field">
          <span>파일 이름</span>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder="파일 이름을 입력하세요"
          />
        </label>

        <div className="modal-field">
          <span>형식</span>
          <div className="modal-formats">
            <label className={format === 'pdf' ? 'format-option active' : 'format-option'}>
              <input type="radio" name="save-format" checked={format === 'pdf'} onChange={() => setFormat('pdf')} />
              <strong>PDF</strong>
              <em>인쇄·공유용 이미지</em>
            </label>
            <label className={format === 'json' ? 'format-option active' : 'format-option'}>
              <input type="radio" name="save-format" checked={format === 'json'} onChange={() => setFormat('json')} />
              <strong>JSON</strong>
              <em>편집용 저장 파일</em>
            </label>
          </div>
        </div>

        {format === 'json' && hasNativeSavePicker() && (
          <p className="modal-hint">저장 위치를 직접 고를 수 있는 창이 뜹니다.</p>
        )}

        <div className="modal-actions">
          <button onClick={onCancel}>취소</button>
          <button className="modal-primary" onClick={submit}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
