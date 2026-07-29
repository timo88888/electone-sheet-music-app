const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

const CLEF_TOP_LINE = {
  treble: { letter: 'F', octave: 5 },
  bass: { letter: 'A', octave: 3 },
};

function stepDown({ letter, octave }) {
  const wraps = letter === 'C';
  const idx = (LETTERS.indexOf(letter) - 1 + 7) % 7;
  return { letter: LETTERS[idx], octave: wraps ? octave - 1 : octave };
}

function stepUp({ letter, octave }) {
  const wraps = letter === 'B';
  const idx = (LETTERS.indexOf(letter) + 1) % 7;
  return { letter: LETTERS[idx], octave: wraps ? octave + 1 : octave };
}

// index 0 = top staff line, positive = further down (lower pitch), negative = above (higher pitch)
// (accidentals don't affect the staff line/space a note sits on)
export function pitchForIndex(clef, index) {
  let cur = CLEF_TOP_LINE[clef];
  const steps = Math.round(index);
  if (steps >= 0) {
    for (let i = 0; i < steps; i++) cur = stepDown(cur);
  } else {
    for (let i = 0; i < -steps; i++) cur = stepUp(cur);
  }
  return `${cur.letter.toLowerCase()}/${cur.octave}`;
}

// Splits a VexFlow-style key ("c/4", "c#/4", "cb/5") into its parts.
export function parseKey(key) {
  const [notePart, octaveStr] = key.split('/');
  const match = /^([a-gA-G])(#{1,2}|b{1,2}|n)?$/.exec(notePart);
  return {
    letter: match[1].toUpperCase(),
    accidental: match[2] || '',
    octave: Number(octaveStr),
  };
}

export function buildKey(letter, accidental, octave) {
  return `${letter.toLowerCase()}${accidental || ''}/${octave}`;
}

// reverse of pitchForIndex, used to keep a dragged note's index in sync with its key
export function indexForPitch(clef, key) {
  const { letter, octave } = parseKey(key);
  let cur = CLEF_TOP_LINE[clef];
  let index = 0;
  const target = `${letter}${octave}`;
  for (let guard = 0; guard < 200; guard++) {
    if (`${cur.letter}${cur.octave}` === target) return index;
    cur = stepDown(cur);
    index++;
  }
  return 0;
}

export function indexForY(y, topY, stepPx) {
  return Math.round((y - topY) / stepPx);
}

// Shifts a key by `steps` diatonic scale degrees (letter names), keeping
// whatever accidental the note already had rather than recalculating it —
// the model has no key-signature concept, so accidentals are always explicit.
export function transposeKey(key, steps) {
  const { letter, accidental, octave } = parseKey(key);
  let cur = { letter, octave };
  const n = Math.round(steps);
  if (n >= 0) {
    for (let i = 0; i < n; i++) cur = stepUp(cur);
  } else {
    for (let i = 0; i < -n; i++) cur = stepDown(cur);
  }
  return buildKey(cur.letter, accidental, cur.octave);
}

const LETTER_SEMITONE = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};
const ACCIDENTAL_SEMITONE_OFFSET = {
  '': 0, '#': 1, '##': 2, b: -1, bb: -2, n: 0,
};
// Respells every chromatic step with a sharp (or a natural white key) —
// simple and predictable, same convention most notation software uses for a
// manual semitone nudge rather than trying to infer flat-vs-sharp intent
// from a key signature this model doesn't track.
const SEMITONE_TO_LETTER = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const SEMITONE_TO_ACCIDENTAL = ['', '#', '', '#', '', '', '#', '', '#', '', '#', ''];

// Shifts a key by `n` chromatic semitones (the ↑/↓ arrow-key pitch nudge —
// see app.js's keydown handler). Unlike transposeKey (diatonic, keeps
// whatever accidental was already there), this always recomputes both the
// letter and the accidental, since a semitone step frequently changes which
// one is correct (e.g. c/4 up a semitone is c#/4, not d bb /4).
export function shiftSemitone(key, n) {
  const { letter, accidental, octave } = parseKey(key);
  const absSemitone = (octave + 1) * 12 + LETTER_SEMITONE[letter]
    + (ACCIDENTAL_SEMITONE_OFFSET[accidental] || 0) + Math.round(n);
  const newOctave = Math.floor(absSemitone / 12) - 1;
  const pc = ((absSemitone % 12) + 12) % 12;
  return buildKey(SEMITONE_TO_LETTER[pc], SEMITONE_TO_ACCIDENTAL[pc], newOctave);
}
