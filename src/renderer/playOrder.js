// Expands a score's measures into the linear sequence they should actually be
// played in, honoring repeat start/end barlines and D.C./D.S./Fine/Segno
// markers. Used identically by live playback, MIDI export and WAV export so
// all three always agree on timing.
//
// Simplifications (documented, not bugs): once a D.C./D.S. jump has fired,
// further repeat signs and further D.C./D.S. markers are ignored — this
// matches the common convention that inner repeats aren't re-taken on the
// "second time through". A pickup (anacrusis) measure at index 0 is treated
// as a normal measure if D.C./D.S. loops back to it, i.e. it may replay.
export function buildPlayOrder(score) {
  const measures = score.measures;
  const n = measures.length;
  if (n === 0) return [];

  const segnoIndex = measures.findIndex((m) => m.marker === 'Segno');
  const order = [];
  const repeated = new Set();
  let afterJump = false;
  let i = 0;
  const MAX_STEPS = 2000;
  let steps = 0;

  while (i < n && steps < MAX_STEPS) {
    steps++;
    order.push(i);
    const m = measures[i];

    if (m.marker === 'Fine' && afterJump) break;

    if (!afterJump && m.repeatEnd && !repeated.has(i)) {
      repeated.add(i);
      let start = 0;
      for (let j = i; j >= 0; j--) {
        if (measures[j].repeatStart) { start = j; break; }
      }
      i = start;
      continue;
    }

    if (m.marker === 'D.C.' && !afterJump) {
      afterJump = true;
      i = 0;
      continue;
    }

    if (m.marker === 'D.S.' && !afterJump) {
      afterJump = true;
      i = segnoIndex >= 0 ? segnoIndex : 0;
      continue;
    }

    i += 1;
  }

  return order;
}
