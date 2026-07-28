import {
  PARTS, measureCapacity, noteBeats, keySignatureAccidentalForLetter,
} from './scoreModel.js';
import { buildPlayOrder } from './playOrder.js';
import { parseKey, buildKey } from './pitchMap.js';

const LETTER_SEMITONE = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

const ACCIDENTAL_OFFSET = {
  '': 0, '#': 1, '##': 2, b: -1, bb: -2, n: 0,
};

// Fixed head-start (seconds) before playback audio actually starts, giving
// the AudioContext/oscillators time to spin up. Exported so app.js can
// schedule the on-screen "currently playing" highlight on the same clock.
export const PLAYBACK_LEAD = 0.15;

export function pitchToMidi(key) {
  const { letter, accidental, octave } = parseKey(key);
  return (octave + 1) * 12 + LETTER_SEMITONE[letter] + ACCIDENTAL_OFFSET[accidental];
}

export function pitchToFrequency(key) {
  const midi = pitchToMidi(key);
  return 440 * 2 ** ((midi - 69) / 12);
}

// A note typed without an explicit accidental sounds whatever is currently
// "standing" for that exact line/space: an earlier explicit accidental on the
// same letter+octave *within this measure* (barlines cancel it), or failing
// that, whatever the key signature implies (e.g. F sounds F# in G major).
// `standingAccidentals` is a Map the caller resets once per measure.
function resolvePlaybackKey(key, keySignature, standingAccidentals) {
  const { letter, accidental, octave } = parseKey(key);
  const pid = `${letter}${octave}`;
  if (accidental) {
    standingAccidentals.set(pid, accidental);
    return key;
  }
  if (standingAccidentals.has(pid)) {
    const standing = standingAccidentals.get(pid);
    return buildKey(letter, standing === 'n' ? '' : standing, octave);
  }
  const implied = keySignatureAccidentalForLetter(keySignature, letter);
  return implied ? buildKey(letter, implied, octave) : key;
}

// Flattens the score into a list of absolute-time note events, expanding
// repeat signs / D.C. / D.S. / Fine via buildPlayOrder and merging tied
// tones into a single sustained event. All three parts share one measure
// timeline. Each chord tone becomes its own event (so tie continuation can
// be tracked per pitch — one tone of a chord can tie forward while another
// doesn't) carrying `ids` (the contributing note id(s)) so callers can
// highlight the notes currently sounding.
export function buildPlaybackEvents(score, bpm = 100) {
  const secondsPerBeat = 60 / bpm;
  const order = buildPlayOrder(score);
  const events = [];

  PARTS.forEach((part) => {
    let time = 0;
    let pendingByPitch = new Map(); // "letter+octave" (pre-accidental) -> still-open event
    order.forEach((measureIndex) => {
      const measure = score.measures[measureIndex];
      const capacity = measureCapacity(score, measureIndex);
      let beatCursor = 0;
      const standingAccidentals = new Map(); // reset every measure — barlines cancel accidentals
      measure[part].forEach((n) => {
        const beats = noteBeats(n);
        const noteStart = time + beatCursor * secondsPerBeat;
        const noteDur = beats * secondsPerBeat;
        if (n.isRest) {
          // A genuine rest can't be tied to/from — every pitch still open
          // for this part finalizes here. An unfilled N連符 placeholder is
          // the exception: it doesn't sound yet and doesn't interrupt any
          // tie in flight, so other pitches' pending ties are left untouched.
          if (!n.isPlaceholder) {
            pendingByPitch.forEach((ev) => events.push(ev));
            pendingByPitch = new Map();
          }
        } else {
          const nextPending = new Map();
          n.keys.forEach((tone) => {
            const { letter, octave } = parseKey(tone.key);
            const pid = `${letter}${octave}`;
            const resolved = resolvePlaybackKey(tone.key, score.keySignature, standingAccidentals);
            const prev = pendingByPitch.get(pid);
            if (prev) {
              pendingByPitch.delete(pid);
              prev.duration += noteDur;
              prev.ids.push(n.id);
              if (tone.tieToNext) nextPending.set(pid, prev); else events.push(prev);
            } else {
              const ev = {
                time: noteStart, duration: noteDur, keys: [resolved], part, ids: [n.id],
              };
              if (tone.tieToNext) nextPending.set(pid, ev); else events.push(ev);
            }
          });
          if (n.partialChordNote) {
            // This note was auto-inserted to land just one tone's タイ (see
            // applyTieToSelectedTone in app.js) when its chord's other tones
            // already tie elsewhere — any other pitch still pending isn't
            // this note's business; let it keep waiting for its own landing
            // spot instead of treating it as broken.
            pendingByPitch.forEach((ev, pid) => nextPending.set(pid, ev));
          } else {
            // Any pitch left over from before that this note's chord didn't
            // repeat had its tie broken (the chord shape changed) — finalize it.
            pendingByPitch.forEach((ev) => events.push(ev));
          }
          pendingByPitch = nextPending;
        }
        beatCursor += beats;
      });
      time += capacity * secondsPerBeat;
    });
    pendingByPitch.forEach((ev) => events.push(ev));
  });

  return events;
}

function scheduleVoice(ctx, destination, ev) {
  ev.keys.forEach((key) => {
    const freq = pitchToFrequency(key);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = ev.part === 'pedal' ? 'sine' : 'triangle';
    osc.frequency.value = freq;
    const peak = 0.25;
    const t0 = ev.time;
    const attackEnd = t0 + 0.015;
    const releaseLen = 0.03;
    const noteEnd = t0 + Math.max(ev.duration, 0.05);
    // Sustain at full volume for the note's whole length and only fade in
    // the final releaseLen — ramping straight from attack down to the note's
    // end (as a single linearRampToValueAtTime spanning the whole duration
    // used to do) made long notes audibly fade out well before they were
    // supposed to end, sounding like the volume randomly dipped mid-piece.
    const releaseStart = Math.max(attackEnd, noteEnd - releaseLen);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, attackEnd);
    gain.gain.setValueAtTime(peak, releaseStart);
    gain.gain.linearRampToValueAtTime(0.0001, noteEnd);
    osc.connect(gain).connect(destination);
    osc.start(t0);
    osc.stop(noteEnd + 0.02);
  });
}

export class Player {
  constructor() {
    this.ctx = null;
    this.timers = [];
    this.playing = false;
  }

  play(score, bpm, onDone) {
    this.stop();
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const events = buildPlaybackEvents(score, bpm);
    let maxEnd = 0;
    events.forEach((ev) => {
      scheduleVoice(this.ctx, this.ctx.destination, { ...ev, time: ev.time + PLAYBACK_LEAD });
      maxEnd = Math.max(maxEnd, ev.time + ev.duration);
    });
    this.playing = true;
    const doneTimer = setTimeout(() => {
      this.playing = false;
      if (onDone) onDone();
    }, (maxEnd + PLAYBACK_LEAD + 0.3) * 1000);
    this.timers.push(doneTimer);
  }

  stop() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
    this.playing = false;
  }
}

// Renders the score offline to a mono 16-bit PCM WAV file (ArrayBuffer).
export async function renderScoreToWavBuffer(score, bpm = 100) {
  const events = buildPlaybackEvents(score, bpm);
  const totalTime = events.reduce((max, ev) => Math.max(max, ev.time + ev.duration), 0) + 1;
  const sampleRate = 44100;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offlineCtx = new OfflineCtx(1, Math.ceil(totalTime * sampleRate), sampleRate);
  events.forEach((ev) => scheduleVoice(offlineCtx, offlineCtx.destination, ev));
  const rendered = await offlineCtx.startRendering();
  return audioBufferToWav(rendered);
}

function audioBufferToWav(buffer) {
  const numChannels = 1;
  const sampleRate = buffer.sampleRate;
  const samples = buffer.getChannelData(0);
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const bufferArr = new ArrayBuffer(44 + dataSize);
  const view = new DataView(bufferArr);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return bufferArr;
}
