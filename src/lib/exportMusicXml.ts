import type { Measure, NoteEvent, Pitch, Score } from '../types/score';

const DIVISIONS = 4; // ticks per quarter note

const NOTE_TYPE: Record<NoteEvent['duration'], string> = {
  w: 'whole',
  h: 'half',
  q: 'quarter',
  '8': 'eighth',
  '16': '16th',
};

const BASE_DURATION_TICKS: Record<NoteEvent['duration'], number> = {
  w: DIVISIONS * 4,
  h: DIVISIONS * 2,
  q: DIVISIONS,
  '8': DIVISIONS / 2,
  '16': DIVISIONS / 4,
};

const KEY_FIFTHS: Record<string, number> = {
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  F: -1,
  Bb: -2,
  Eb: -3,
  Ab: -4,
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pitchXml(pitch: Pitch): string {
  const alter = pitch.accidental === '#' ? 1 : pitch.accidental === 'b' ? -1 : 0;
  return `<pitch><step>${pitch.letter}</step>${alter !== 0 ? `<alter>${alter}</alter>` : ''}<octave>${pitch.octave}</octave></pitch>`;
}

function noteTicks(note: NoteEvent): number {
  const base = BASE_DURATION_TICKS[note.duration];
  return note.dotted ? base * 1.5 : base;
}

function noteXml(note: NoteEvent, staff: 1 | 2, isFirstOfChord: boolean): string {
  const duration = noteTicks(note);
  const type = NOTE_TYPE[note.duration];
  const dotXml = note.dotted ? '<dot/>' : '';
  const chordXml = !isFirstOfChord ? '<chord/>' : '';
  const body = note.isRest || note.pitches.length === 0 ? '<rest/>' : pitchXml(note.pitches[0]);
  return `<note>${chordXml}${body}<duration>${duration}</duration><voice>1</voice><type>${type}</type>${dotXml}<staff>${staff}</staff></note>`;
}

function staffMeasureXml(notes: NoteEvent[], staff: 1 | 2): string {
  return notes
    .flatMap((note) => {
      if (note.isRest || note.pitches.length <= 1) {
        return [noteXml(note, staff, true)];
      }
      // Chord: first pitch carries the duration, remaining pitches use <chord/>.
      return note.pitches.map((pitch, i) =>
        noteXml({ ...note, pitches: [pitch] }, staff, i === 0),
      );
    })
    .join('');
}

function measureDurationTicks(notes: NoteEvent[]): number {
  return notes.reduce((sum, n) => sum + noteTicks(n), 0);
}

function measureXml(measure: Measure, index: number, score: Score): string {
  const attributes =
    index === 0
      ? `<attributes><divisions>${DIVISIONS}</divisions><key><fifths>${KEY_FIFTHS[score.keySignature] ?? 0}</fifths></key><time><beats>${score.timeSignature.numerator}</beats><beat-type>${score.timeSignature.denominator}</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`
      : '';

  const trebleXml = staffMeasureXml(measure.treble.notes, 1);
  const trebleTicks = measureDurationTicks(measure.treble.notes);
  const backupXml = `<backup><duration>${trebleTicks}</duration></backup>`;
  const bassXml = staffMeasureXml(measure.bass.notes, 2);

  return `<measure number="${index + 1}">${attributes}${trebleXml}${backupXml}${bassXml}</measure>`;
}

export function exportMusicXml(score: Score): string {
  const measuresXml = score.measures.map((m, i) => measureXml(m, i, score)).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>${escapeXml(score.title)}</work-title></work>
  <identification><creator type="composer">${escapeXml(score.composer)}</creator></identification>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">${measuresXml}</part>
</score-partwise>`;
}
