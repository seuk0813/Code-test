import type { Measure, NoteEvent, Pitch, Score } from '../types/score';
import { effectiveAccidental, measureTimeSignature } from './scoreUtils';

// 48 ticks/quarter note — divisible by both 8 (for 32nd notes) and 3 (for
// triplets), so every duration/dotted/tuplet combination below lands on a
// whole number of ticks instead of needing fractional <duration> values.
const DIVISIONS = 48;

const NOTE_TYPE: Record<NoteEvent['duration'], string> = {
  w: 'whole',
  h: 'half',
  q: 'quarter',
  '8': 'eighth',
  '16': '16th',
  '32': '32nd',
};

const BASE_DURATION_TICKS: Record<NoteEvent['duration'], number> = {
  w: DIVISIONS * 4,
  h: DIVISIONS * 2,
  q: DIVISIONS,
  '8': DIVISIONS / 2,
  '16': DIVISIONS / 4,
  '32': DIVISIONS / 8,
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

function pitchXml(pitch: Pitch, keySignature: string): string {
  const acc = effectiveAccidental(pitch, keySignature);
  const alter = acc === '#' ? 1 : acc === 'b' ? -1 : 0;
  return `<pitch><step>${pitch.letter}</step>${alter !== 0 ? `<alter>${alter}</alter>` : ''}<octave>${pitch.octave}</octave></pitch>`;
}

function noteTicks(note: NoteEvent): number {
  const base = BASE_DURATION_TICKS[note.duration];
  const dotted = note.dotted ? base * 1.5 : base;
  return note.tuplet ? (dotted * 2) / 3 : dotted;
}

function noteXml(note: NoteEvent, staff: 1 | 2, isFirstOfChord: boolean, keySignature: string): string {
  const duration = noteTicks(note);
  const type = NOTE_TYPE[note.duration];
  const dotXml = note.dotted ? '<dot/>' : '';
  const chordXml = !isFirstOfChord ? '<chord/>' : '';
  // 3-in-the-place-of-2 (standard triplet ratio — see scoreUtils' TUPLET_RATIO).
  const timeModXml = note.tuplet ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>' : '';
  const body = note.isRest || note.pitches.length === 0 ? '<rest/>' : pitchXml(note.pitches[0], keySignature);
  return `<note>${chordXml}${body}<duration>${duration}</duration><voice>1</voice><type>${type}</type>${dotXml}${timeModXml}<staff>${staff}</staff></note>`;
}

function staffMeasureXml(notes: NoteEvent[], staff: 1 | 2, keySignature: string): string {
  return notes
    .flatMap((note) => {
      if (note.isRest || note.pitches.length <= 1) {
        return [noteXml(note, staff, true, keySignature)];
      }
      // Chord: first pitch carries the duration, remaining pitches use <chord/>.
      return note.pitches.map((pitch, i) =>
        noteXml({ ...note, pitches: [pitch] }, staff, i === 0, keySignature),
      );
    })
    .join('');
}

function measureDurationTicks(notes: NoteEvent[]): number {
  return notes.reduce((sum, n) => sum + noteTicks(n), 0);
}

function measureXml(measure: Measure, index: number, score: Score): string {
  const ts = measureTimeSignature(score, index);
  const timeChanged = index > 0 && (ts.numerator !== measureTimeSignature(score, index - 1).numerator || ts.denominator !== measureTimeSignature(score, index - 1).denominator);
  const attributes =
    index === 0
      ? `<attributes><divisions>${DIVISIONS}</divisions><key><fifths>${KEY_FIFTHS[score.keySignature] ?? 0}</fifths></key><time><beats>${ts.numerator}</beats><beat-type>${ts.denominator}</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`
      : timeChanged
        ? `<attributes><time><beats>${ts.numerator}</beats><beat-type>${ts.denominator}</beat-type></time></attributes>`
        : '';

  const trebleXml = staffMeasureXml(measure.treble.notes, 1, score.keySignature);
  const trebleTicks = measureDurationTicks(measure.treble.notes);
  const backupXml = `<backup><duration>${trebleTicks}</duration></backup>`;
  const bassXml = staffMeasureXml(measure.bass.notes, 2, score.keySignature);

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
