import { buildPlaybackEvents, pitchToMidi } from './playback.js';

const TICKS_PER_BEAT = 480;
const PART_CHANNEL = {
  upper: 0, lower: 1, pedal: 2,
};

function encodeVarLen(value) {
  const bytes = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

// Builds a minimal Standard MIDI File (format 0, single track) as an ArrayBuffer.
export function buildMidiFile(score, bpm = 100) {
  const events = buildPlaybackEvents(score, bpm);
  const secondsPerBeat = 60 / bpm;

  const midiEvents = [];
  events.forEach((ev) => {
    const channel = PART_CHANNEL[ev.part] ?? 0;
    const onTick = Math.round((ev.time / secondsPerBeat) * TICKS_PER_BEAT);
    const offTick = Math.round(((ev.time + ev.duration) / secondsPerBeat) * TICKS_PER_BEAT);
    ev.keys.forEach((key) => {
      const note = pitchToMidi(key);
      midiEvents.push({ tick: onTick, type: 'on', note, channel });
      midiEvents.push({ tick: Math.max(offTick, onTick + 1), type: 'off', note, channel });
    });
  });
  midiEvents.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1));

  const trackBytes = [];
  const microsPerBeat = Math.round(60000000 / bpm);
  trackBytes.push(
    ...encodeVarLen(0), 0xff, 0x51, 0x03,
    (microsPerBeat >> 16) & 0xff, (microsPerBeat >> 8) & 0xff, microsPerBeat & 0xff,
  );

  let lastTick = 0;
  midiEvents.forEach((e) => {
    const delta = Math.max(0, e.tick - lastTick);
    lastTick = e.tick;
    const status = (e.type === 'on' ? 0x90 : 0x80) | (e.channel & 0x0f);
    const velocity = e.type === 'on' ? 100 : 0;
    trackBytes.push(...encodeVarLen(delta), status, e.note, velocity);
  });
  trackBytes.push(...encodeVarLen(0), 0xff, 0x2f, 0x00);

  const headerBytes = [
    0x4d, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x00,
    0x00, 0x01,
    (TICKS_PER_BEAT >> 8) & 0xff, TICKS_PER_BEAT & 0xff,
  ];
  const trackLen = trackBytes.length;
  const trackHeader = [
    0x4d, 0x54, 0x72, 0x6b,
    (trackLen >> 24) & 0xff, (trackLen >> 16) & 0xff, (trackLen >> 8) & 0xff, trackLen & 0xff,
  ];

  return new Uint8Array([...headerBytes, ...trackHeader, ...trackBytes]).buffer;
}
