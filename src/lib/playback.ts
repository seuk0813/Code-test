import * as Tone from 'tone';
import type { Clef, NoteEvent, Score } from '../types/score';
import { measureStartBeat, noteBeats, pitchToToneNote, pitchToVexKey } from './scoreUtils';

export interface PlaybackHandle {
  stop: () => void;
  /** Elapsed transport time in seconds, for syncing the visual playhead. */
  getSeconds: () => number;
}

interface ScheduledEvent {
  timeBeats: number;
  durationSeconds: number;
  notes: string[];
  synth: Tone.PolySynth;
}

interface FlatNote {
  note: NoteEvent;
  timeBeats: number;
}

/** Every note in a staff, across all measures, with its absolute beat offset — ties can span barlines. */
function flattenStaffNotes(score: Score, clef: Clef): FlatNote[] {
  const flat: FlatNote[] = [];
  score.measures.forEach((measure, measureIndex) => {
    let t = measureStartBeat(score, measureIndex);
    measure[clef].notes.forEach((note) => {
      flat.push({ note, timeBeats: t });
      t += noteBeats(note);
    });
  });
  return flat;
}

/**
 * Which pitch index in `next` the pitch `cur.pitches[curPitchIdx]` ties into,
 * or -1 if this pitch is not tied onward.
 *
 * A tie (붙임줄) joins the SAME pitch across two notes: the tied pitch keeps
 * ringing (its duration extends) and must NOT be re-attacked in the next note.
 * A slur (이음줄) is phrasing only — it re-articulates every note normally, so
 * it never ties a pitch. Ties are anchored at one specific pitch (the user's
 * chosen `connectPitchIndex`), so a chord tie only carries that one pitch over;
 * the chord's other pitches still play (and re-attack) on their own.
 */
function tiedPitchIndex(cur: NoteEvent, curPitchIdx: number, next: NoteEvent): number {
  if (!cur.connectToNext || next.isRest) return -1;
  const curKey = pitchToVexKey(cur.pitches[curPitchIdx]);
  const match = next.pitches.findIndex((p) => pitchToVexKey(p) === curKey);
  if (match < 0) return -1;
  if (cur.connectKind === 'slur') return -1;
  if (cur.connectKind === 'tie') {
    // Only the anchored pitch is tied; the rest of a chord re-attacks.
    return (cur.connectPitchIndex ?? 0) === curPitchIdx ? match : -1;
  }
  // Legacy data (no connectKind): treat as a tie only when the whole chord
  // matches, matching how the renderer used to auto-detect tie-vs-slur.
  const sameChord =
    cur.pitches.length === next.pitches.length &&
    cur.pitches.every((p, pi) => pitchToVexKey(p) === pitchToVexKey(next.pitches[pi]));
  return sameChord ? match : -1;
}

/**
 * Builds one Tone event per SOUNDING PITCH (not per note): every pitch of a
 * chord gets its own attack so a chord always plays in full. A pitch that is
 * the continuation of a tie is suppressed (already ringing from the earlier
 * note), and the earlier pitch's duration is extended to cover it — following
 * the tie chain across notes and barlines. Slurs add no duration and suppress
 * nothing, so both notes of a slur re-articulate as expected.
 */
function buildStaffEvents(flat: FlatNote[], synth: Tone.PolySynth, keySignature: string, secondsPerBeat: number): ScheduledEvent[] {
  const events: ScheduledEvent[] = [];
  // suppressed[noteIndex] = set of pitch indices that are tie continuations and
  // must not start their own attack (their sound already began earlier).
  const suppressed: Set<number>[] = flat.map(() => new Set<number>());

  flat.forEach(({ note, timeBeats }, i) => {
    if (note.graceNote) {
      // "Crushed" against the beat — takes essentially no time from either
      // note it sits between. `position: 'before'` (the default,
      // acciaccatura) fires just before this note's onset, stealing a
      // sliver of the PREVIOUS beat; `position: 'after'` (nachschlag) fires
      // just before this note's own end instead, leaning into the NEXT
      // note. Clamped so it can't go negative on the very first note.
      const graceBeats = 0.15;
      const isAfter = note.graceNote.position === 'after';
      const graceTimeBeats = isAfter ? timeBeats + noteBeats(note) - graceBeats : timeBeats - graceBeats;
      events.push({
        timeBeats: Math.max(0, graceTimeBeats),
        durationSeconds: graceBeats * secondsPerBeat * 0.92,
        notes: [pitchToToneNote({ letter: note.graceNote.letter, octave: note.graceNote.octave, accidental: note.graceNote.accidental ?? '' }, keySignature)],
        synth,
      });
    }
    if (note.isRest || note.pitches.length === 0) return;
    note.pitches.forEach((pitch, pi) => {
      if (suppressed[i].has(pi)) return;
      let totalBeats = noteBeats(note);
      // Walk the tie chain forward, extending this pitch and muting each next
      // note's matching pitch, until the chain (for this specific pitch) ends.
      let chainNote = i;
      let chainPitch = pi;
      while (chainNote + 1 < flat.length) {
        const nextIdx = tiedPitchIndex(flat[chainNote].note, chainPitch, flat[chainNote + 1].note);
        if (nextIdx < 0) break;
        totalBeats += noteBeats(flat[chainNote + 1].note);
        suppressed[chainNote + 1].add(nextIdx);
        chainNote += 1;
        chainPitch = nextIdx;
      }
      events.push({
        timeBeats,
        durationSeconds: totalBeats * secondsPerBeat * 0.92,
        notes: [pitchToToneNote(pitch, keySignature)],
        synth,
      });
    });
  });
  return events;
}

export async function playScore(
  score: Score,
  onMeasure: (measureIndex: number) => void,
  onEnd: () => void,
  /** Beats from the very start to begin playback from (the draggable seek bar). */
  startBeat = 0,
): Promise<PlaybackHandle> {
  await Tone.start();

  const trebleSynth = new Tone.PolySynth(Tone.Synth).toDestination();
  const bassSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
  }).toDestination();

  Tone.getTransport().stop();
  Tone.getTransport().cancel();
  Tone.getTransport().bpm.value = score.tempo;

  const secondsPerBeat = 60 / score.tempo;
  const events: ScheduledEvent[] = [
    ...buildStaffEvents(flattenStaffNotes(score, 'treble'), trebleSynth, score.keySignature, secondsPerBeat),
    ...buildStaffEvents(flattenStaffNotes(score, 'bass'), bassSynth, score.keySignature, secondsPerBeat),
  ];

  score.measures.forEach((_, measureIndex) => {
    Tone.getTransport().schedule((time) => {
      Tone.getDraw().schedule(() => onMeasure(measureIndex), time);
    }, measureStartBeat(score, measureIndex) * secondsPerBeat);
  });

  events.forEach((ev) => {
    Tone.getTransport().schedule((time) => {
      ev.synth.triggerAttackRelease(ev.notes, ev.durationSeconds, time);
    }, ev.timeBeats * secondsPerBeat);
  });

  const totalSeconds = measureStartBeat(score, score.measures.length) * secondsPerBeat;

  const cleanup = () => {
    trebleSynth.releaseAll();
    bassSynth.releaseAll();
    Tone.getTransport().stop();
    Tone.getTransport().cancel();
    trebleSynth.dispose();
    bassSynth.dispose();
  };

  Tone.getTransport().schedule((time) => {
    Tone.getDraw().schedule(() => {
      onEnd();
      cleanup();
    }, time);
  }, totalSeconds + 0.1);

  // Start the transport at the seek offset: events are all scheduled at their
  // absolute times, so jumping the transport to startBeat both skips earlier
  // notes and keeps transport.seconds reporting the true absolute position
  // (so the visual playhead stays correct without any extra offset math).
  Tone.getTransport().start(undefined, startBeat * secondsPerBeat);

  return {
    stop: () => {
      cleanup();
    },
    getSeconds: () => Tone.getTransport().seconds,
  };
}
