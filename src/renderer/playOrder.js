// Expands a score's measures into the linear sequence they should actually be
// played in, honoring repeat start/end barlines, n番括弧 (volta / repeat
// endings), and D.C./D.S./Fine/Segno/Coda markers. Used identically by live
// playback, MIDI export and WAV export so all three always agree on timing.
//
// Simplifications (documented, not bugs):
// - Once a D.C./D.S. jump has fired, further repeat signs and further D.C./
//   D.S. markers are ignored — this matches the common convention that inner
//   repeats aren't re-taken on the "second time through". Volta brackets are
//   then read at the *last* pass number, so a D.C. plays the final ending
//   rather than replaying the first one.
// - A pickup (anacrusis) measure at index 0 is treated as a normal measure if
//   D.C./D.S. loops back to it, i.e. it may replay.
// - "Coda" is one marker used twice: the first Coda-marked measure is the
//   To Coda jump point, the second is where the coda section begins. A score
//   with only one Coda marker has nothing to jump between, so it's ignored.
export function buildPlayOrder(score) {
  const measures = score.measures;
  const n = measures.length;
  if (n === 0) return [];

  const segnoIndex = measures.findIndex((m) => m.marker === 'Segno');

  const codaIndices = [];
  measures.forEach((m, i) => { if (m.marker === 'Coda') codaIndices.push(i); });
  const toCodaIndex = codaIndices.length >= 2 ? codaIndices[0] : -1;
  const codaStartIndex = codaIndices.length >= 2 ? codaIndices[1] : -1;

  // How many times through a repeated section the score expects: a passage
  // with 1番/2番 endings is played twice, one with 1番/2番/3番 three times.
  // No volta brackets at all means the classic "take each repeat once".
  const maxVolta = measures.reduce(
    (max, m) => (m.volta && m.volta.number > max ? m.volta.number : max),
    1,
  );
  const maxRepeatTakes = maxVolta > 1 ? maxVolta - 1 : 1;

  const order = [];
  const repeatTakes = new Map(); // repeatEnd measure index -> times already taken
  let pass = 1;
  let afterJump = false;
  let tookCoda = false;
  let i = 0;
  const MAX_STEPS = 4000;
  let steps = 0;

  while (i < n && steps < MAX_STEPS) {
    steps++;
    const m = measures[i];

    // n番括弧: a bracket belonging to a different pass is skipped, barline
    // and all — which is exactly how a 2周目 skips over the 1番 ending
    // (including its repeat barline) and lands on the 2番. One bracket is
    // always exactly one measure.
    if (m.volta && m.volta.number !== pass) {
      i += 1;
      continue;
    }

    order.push(i);

    if (m.marker === 'Fine' && afterJump) break;

    // To Coda — only live on the pass after a D.C./D.S. jump, which is what
    // makes "D.S. al Coda" play the passage through once before jumping.
    if (afterJump && !tookCoda && i === toCodaIndex && codaStartIndex >= 0) {
      tookCoda = true;
      i = codaStartIndex;
      continue;
    }

    if (!afterJump && m.repeatEnd) {
      const taken = repeatTakes.get(i) || 0;
      if (taken < maxRepeatTakes) {
        repeatTakes.set(i, taken + 1);
        let start = 0;
        for (let j = i; j >= 0; j--) {
          if (measures[j].repeatStart) { start = j; break; }
        }
        pass += 1;
        i = start;
        continue;
      }
    }

    if (m.marker === 'D.C.' && !afterJump) {
      afterJump = true;
      pass = maxVolta;
      i = 0;
      continue;
    }

    if (m.marker === 'D.S.' && !afterJump) {
      afterJump = true;
      pass = maxVolta;
      i = segnoIndex >= 0 ? segnoIndex : 0;
      continue;
    }

    i += 1;
  }

  return order;
}
