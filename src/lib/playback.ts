import * as Tone from 'tone';
import type { Score } from '../types/score';
import { measureCapacityBeats, noteBeats, pitchToToneNote } from './scoreUtils';

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

/**
 * A warm, resonant "grand piano" voice built entirely from synthesis (no
 * sampled audio to download), so it works offline and on restricted
 * networks. Piano-like fast attack / quick initial decay to a lower sustain
 * (string energy dying off) / long release (sympathetic string resonance),
 * a lightly inharmonic AM-triangle oscillator for bell-like overtones, and a
 * shared reverb + chorus + EQ bus for the "grand hall" sweetness.
 */
function createPianoVoice(effectsBus: Tone.ToneAudioNode, register: 'treble' | 'bass'): Tone.PolySynth {
  const isBass = register === 'bass';
  return new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'amtriangle', harmonicity: isBass ? 0.75 : 1.25, modulationType: 'sine' },
    envelope: {
      attack: isBass ? 0.006 : 0.004,
      decay: isBass ? 0.65 : 0.45,
      sustain: isBass ? 0.2 : 0.12,
      release: isBass ? 1.7 : 1.3,
    },
  }).connect(effectsBus);
}

async function createEffectsBus(): Promise<{ input: Tone.ToneAudioNode; dispose: () => void }> {
  const eq = new Tone.EQ3({ low: 2, mid: -1, high: -3 });
  const chorus = new Tone.Chorus({ frequency: 0.6, delayTime: 3.5, depth: 0.4, wet: 0.15 }).start();
  const reverb = new Tone.Reverb({ decay: 2.4, wet: 0.24 });
  const compressor = new Tone.Compressor({ threshold: -18, ratio: 3 });
  await reverb.generate();
  eq.chain(chorus, reverb, compressor, Tone.getDestination());
  return {
    input: eq,
    dispose: () => {
      eq.dispose();
      chorus.dispose();
      reverb.dispose();
      compressor.dispose();
    },
  };
}

export async function playScore(
  score: Score,
  onMeasure: (measureIndex: number) => void,
  onEnd: () => void,
): Promise<PlaybackHandle> {
  await Tone.start();

  const bus = await createEffectsBus();
  const trebleSynth = createPianoVoice(bus.input, 'treble');
  const bassSynth = createPianoVoice(bus.input, 'bass');

  Tone.getTransport().stop();
  Tone.getTransport().cancel();
  Tone.getTransport().bpm.value = score.tempo;

  const secondsPerBeat = 60 / score.tempo;
  const measureBeats = measureCapacityBeats(score.timeSignature);
  const events: ScheduledEvent[] = [];

  score.measures.forEach((measure, measureIndex) => {
    const measureStartBeats = measureIndex * measureBeats;

    let trebleTime = measureStartBeats;
    measure.treble.notes.forEach((note) => {
      const beats = noteBeats(note);
      if (!note.isRest && note.pitches.length > 0) {
        events.push({
          timeBeats: trebleTime,
          durationSeconds: beats * secondsPerBeat * 0.92,
          notes: note.pitches.map(pitchToToneNote),
          synth: trebleSynth,
        });
      }
      trebleTime += beats;
    });

    let bassTime = measureStartBeats;
    measure.bass.notes.forEach((note) => {
      const beats = noteBeats(note);
      if (!note.isRest && note.pitches.length > 0) {
        events.push({
          timeBeats: bassTime,
          durationSeconds: beats * secondsPerBeat * 0.92,
          notes: note.pitches.map(pitchToToneNote),
          synth: bassSynth,
        });
      }
      bassTime += beats;
    });

    Tone.getTransport().schedule((time) => {
      Tone.getDraw().schedule(() => onMeasure(measureIndex), time);
    }, measureStartBeats * secondsPerBeat);
  });

  events.forEach((ev) => {
    Tone.getTransport().schedule((time) => {
      ev.synth.triggerAttackRelease(ev.notes, ev.durationSeconds, time);
    }, ev.timeBeats * secondsPerBeat);
  });

  const totalSeconds = score.measures.length * measureBeats * secondsPerBeat;

  const cleanup = () => {
    trebleSynth.releaseAll();
    bassSynth.releaseAll();
    Tone.getTransport().stop();
    Tone.getTransport().cancel();
    trebleSynth.dispose();
    bassSynth.dispose();
    bus.dispose();
  };

  Tone.getTransport().schedule((time) => {
    Tone.getDraw().schedule(() => {
      onEnd();
      cleanup();
    }, time);
  }, totalSeconds + 0.1);

  Tone.getTransport().start();

  return {
    stop: () => {
      cleanup();
    },
    getSeconds: () => Tone.getTransport().seconds,
  };
}
