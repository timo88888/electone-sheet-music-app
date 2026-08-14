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
