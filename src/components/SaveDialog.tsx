import { useEffect, useState } from 'react';

export type SaveFormat = 'pdf' | 'json';

interface SaveDialogProps {
  onCancel: () => void;
  onSave: (format: SaveFormat) => void;
}

/** Modal asking only for a format (PDF or JSON) before saving — the filename comes from the score's own title, not a separate prompt. */
export function SaveDialog({ onCancel, onSave }: SaveDialogProps) {
  const [format, setFormat] = useState<SaveFormat>('pdf');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal-title">악보 저장</h2>

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

        <div className="modal-actions">
          <button onClick={onCancel}>취소</button>
          <button className="modal-primary" onClick={() => onSave(format)}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
