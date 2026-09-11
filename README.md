# 피아노 악보 편집기

브라우저에서 그랜드 스태프(양손) 악보를 그리고, 재생하고, MusicXML/MIDI로 내보낼 수 있는 웹 앱입니다.

## 주요 기능

- 오선보(높은음자리표 + 낮은음자리표) 클릭으로 음표/쉼표 입력 및 편집
- 음표 길이(온음표~16분음표), 점음표, 임시표(#/b/♮) 지정
- Web Audio 기반 재생 (Tone.js)
- MusicXML / MIDI 파일 내보내기
- 악보를 JSON으로 저장하고 불러오기 (자동 저장 포함)

## 개발

```bash
npm install
npm run dev      # 개발 서버
npm run build    # 프로덕션 빌드
npm run lint      # oxlint
```

## 기술 스택

- React + TypeScript + Vite
- [VexFlow](https://www.vexflow.com/) — 오선보 렌더링
- [Tone.js](https://tonejs.github.io/) — 오디오 재생
- [midi-writer-js](https://github.com/grimmdude/MidiWriterJS) — MIDI 내보내기
