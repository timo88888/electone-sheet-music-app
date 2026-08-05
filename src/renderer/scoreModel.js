export const PARTS = ['upper', 'lower', 'pedal'];

export const PART_LABELS = {
  upper: '上鍵盤',
  lower: '下鍵盤',
  pedal: 'ペダル',
};

// default clefs for a brand-new score; each score can override per part via score.clefs
export const PART_CLEF = {
  upper: 'treble',
  lower: 'bass',
  pedal: 'bass',
};

export const CLEF_OPTIONS = ['treble', 'bass'];

export const CLEF_LABELS = {
  treble: 'ト音記号',
  bass: 'ヘ音記号',
};

export function getClef(score, part) {
  return (score.clefs && score.clefs[part]) || PART_CLEF[part];
}

export const DURATION_BEATS = {
  w: 4,
  h: 2,
  q: 1,
  '8': 0.5,
  '16': 0.25,
};

export const DURATION_LABELS = {
  w: '全音符',
  h: '2分音符',
  q: '4分音符',
  '8': '8分音符',
  '16': '16分音符',
};

// Tempo markings are given as "note value = BPM" (e.g. "quarter note = 100"),
// same as printed sheet music — these are the note choices for that value.
export const TEMPO_NOTE_VALUES = ['w', 'h', 'q', '8', '16'];

// Converts a "note value = bpm" tempo marking into the quarter-note-equivalent
// BPM that the rest of the app's timing math (durationBeats etc., all
// relative to a quarter-note beat) expects.
export function effectiveQuarterBpm(score) {
  const bpm = score.bpm || 100;
  const noteValue = score.bpmNoteValue || 'q';
  return bpm * (DURATION_BEATS[noteValue] || 1);
}

export const DYNAMICS = ['pp', 'p', 'mp', 'mf', 'f', 'ff'];

export const MARKERS = ['', 'Segno', 'D.C.', 'D.S.', 'Fine', 'Coda'];

export const ARTICULATIONS = ['', 'staccato', 'tenuto', 'accent', 'marcato'];

export const ARTICULATION_LABELS = {
  staccato: 'スタッカート',
  tenuto: 'テヌート',
  accent: 'アクセント',
  marcato: 'マルカート',
};

// Rest glyphs (and rendered position) don't move with clef the way pitched
// notes do — this is the "sits on the middle line" anchor key per clef.
export const REST_ANCHOR_KEY = {
  treble: 'b/4',
  bass: 'd/3',
};

export const BARLINE_OPTIONS = ['single', 'double', 'final'];

export const BARLINE_LABELS = {
  single: '通常線',
  double: '二重線',
  final: '終止線',
};

// Major-key signatures only (a minor key shares its relative major's
// signature, so this covers both) — value is the VexFlow key spec passed to
// Stave.addKeySignature().
// Each major key is immediately followed by its relative minor (same
// accidentals — a key signature doesn't distinguish them, only the tonic
// does) using VexFlow's own minor key specs ('Am', 'Em', ...), which
// Stave.addKeySignature() already recognizes directly.
export const KEY_SIGNATURES = [
  { value: 'C', label: 'ハ長調(♯♭なし)', accidentals: 0, type: null },
  { value: 'Am', label: 'イ短調(♯♭なし)', accidentals: 0, type: null },
  { value: 'G', label: 'ト長調(♯1)', accidentals: 1, type: 'sharp' },
  { value: 'Em', label: 'ホ短調(♯1)', accidentals: 1, type: 'sharp' },
  { value: 'D', label: 'ニ長調(♯2)', accidentals: 2, type: 'sharp' },
  { value: 'Bm', label: 'ロ短調(♯2)', accidentals: 2, type: 'sharp' },
  { value: 'A', label: 'イ長調(♯3)', accidentals: 3, type: 'sharp' },
  { value: 'F#m', label: '嬰ヘ短調(♯3)', accidentals: 3, type: 'sharp' },
  { value: 'E', label: 'ホ長調(♯4)', accidentals: 4, type: 'sharp' },
  { value: 'C#m', label: '嬰ハ短調(♯4)', accidentals: 4, type: 'sharp' },
  { value: 'B', label: 'ロ長調(♯5)', accidentals: 5, type: 'sharp' },
  { value: 'G#m', label: '嬰ト短調(♯5)', accidentals: 5, type: 'sharp' },
  { value: 'F#', label: '嬰ヘ長調(♯6)', accidentals: 6, type: 'sharp' },
  { value: 'D#m', label: '嬰ニ短調(♯6)', accidentals: 6, type: 'sharp' },
  { value: 'F', label: 'ヘ長調(♭1)', accidentals: 1, type: 'flat' },
  { value: 'Dm', label: 'ニ短調(♭1)', accidentals: 1, type: 'flat' },
  { value: 'Bb', label: '変ロ長調(♭2)', accidentals: 2, type: 'flat' },
  { value: 'Gm', label: 'ト短調(♭2)', accidentals: 2, type: 'flat' },
  { value: 'Eb', label: '変ホ長調(♭3)', accidentals: 3, type: 'flat' },
  { value: 'Cm', label: 'ハ短調(♭3)', accidentals: 3, type: 'flat' },
  { value: 'Ab', label: '変イ長調(♭4)', accidentals: 4, type: 'flat' },
  { value: 'Fm', label: 'ヘ短調(♭4)', accidentals: 4, type: 'flat' },
  { value: 'Db', label: '変ニ長調(♭5)', accidentals: 5, type: 'flat' },
  { value: 'Bbm', label: '変ロ短調(♭5)', accidentals: 5, type: 'flat' },
  { value: 'Gb', label: '変ト長調(♭6)', accidentals: 6, type: 'flat' },
  { value: 'Ebm', label: '変ホ短調(♭6)', accidentals: 6, type: 'flat' },
];

export function keySignatureAccidentalCount(key) {
  const found = KEY_SIGNATURES.find((k) => k.value === key);
  return found ? found.accidentals : 0;
}

// Standard order in which sharps/flats are added to a key signature (circle
// of fifths) — used to work out which letters a given key signature affects.
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

// Returns '#' / 'b' if `keySignature` implicitly raises or lowers `letter`
// (e.g. G major implies F#), or '' if that letter is unaffected. Used so
// notes typed without an explicit accidental still play back at the pitch
// the key signature implies.
export function keySignatureAccidentalForLetter(keySignature, letter) {
  const entry = KEY_SIGNATURES.find((k) => k.value === keySignature);
  if (!entry || !entry.type) return '';
  const order = entry.type === 'flat' ? FLAT_ORDER : SHARP_ORDER;
  if (!order.slice(0, entry.accidentals).includes(letter)) return '';
  return entry.type === 'flat' ? 'b' : '#';
}

let nextId = 1;
export function makeNoteId() {
  return `n${nextId++}`;
}

export function durationBeats(duration, dotted, tupletRatio = 1) {
  const base = DURATION_BEATS[duration];
  return base * (dotted ? 1.5 : 1) * tupletRatio;
}

// Tuplet options offered in the UI: N notes in the time of the nearest lower
// power of two (3-in-2, 5-in-4, 7-in-4) — the conventional grouping.
export const TUPLET_COUNTS = [3, 5, 7];

export function tupletNotesOccupied(count) {
  let occupied = 1;
  while (occupied * 2 < count) occupied *= 2;
  return occupied;
}

// A tuplet-grouped note takes notesOccupied/tupletCount of its written
// duration's normal beat value (e.g. a triplet eighth takes 2/3 of an eighth).
export function noteBeats(note) {
  if (!note.tupletId) return durationBeats(note.duration, note.dotted, 1);
  const count = note.tupletCount || 3;
  return durationBeats(note.duration, note.dotted, tupletNotesOccupied(count) / count);
}

export function createEmptyMeasure() {
  return {
    upper: [],
    lower: [],
    pedal: [],
    repeatStart: false,
    repeatEnd: false,
    marker: '',
    barlineEnd: 'single',
    // Forces a new system (line) to start right after this measure, even if
    // the line hasn't reached its normal measure-per-line cap yet.
    lineBreak: false,
    // リハーサル/レジストレーション — one entry per beat position that has
    // either set, shared across every part/chord-tone sounding at that
    // instant (see noteBeatWindow, findOrCreateMark in app.js). Keyed by
    // beat rather than by note so that setting it from ANY of the
    // simultaneous notes (a different part, or another tone of the same
    // chord) edits the same mark instead of stacking duplicates.
    marks: [],
    // 歌詞 — one line of text per system (段落) *per staff* (上鍵盤/下鍵盤/
    // ペダル each get their own line), not per note. Shown for whichever line
    // this measure currently belongs to (see staffRenderer's per-line lyric
    // rows) — set via targetMeasure()'s "対象小節" input plus the 歌詞 ribbon
    // group's staff select.
    lyrics: { upper: '', lower: '', pedal: '' },
    // n番括弧(volta/repeat-ending bracket) — set only on the FIRST measure
    // of the bracket's span; { number: 1-5, span: how many measures
    // (including this one) the bracket covers }. null everywhere else.
    volta: null,
  };
}

// Fields every note carries in addition to its pitch/duration data — コード
// is a per-note annotation (see chordPitchClassesForLowerNote) rather than
// per-measure, so a brand-new note needs blank defaults for it the same way
// it does for dynamic/articulation/lyric.
export function noteAnnotationDefaults() {
  return {
    chord: '',
    // true once the user has explicitly set/confirmed this note's chord (via
    // the ribbon editor or by picking a candidate) — auto-detection then
    // leaves it alone. Both start false so a brand-new note is fair game for
    // auto-detection as soon as it has pitch content.
    chordLocked: false,
    // true when chord was auto-filled from more than one equally-valid
    // reading (see detectChordCandidates) — rendered in orange; clicking it
    // offers the real candidates instead of editing free-form.
    chordTentative: false,
  };
}

// A reasonable number of measures for a brand-new score to start pre-filled
// with instead of empty (roughly one full first page at default width).
export const DEFAULT_PAGE_MEASURE_COUNT = 16;

export function createEmptyScore() {
  return {
    title: '無題の楽譜',
    composer: '',
    lyricist: '',
    timeSig: '4/4',
    // 'numeric' (digits, e.g. "4/4") or 'symbol' — only 4/4 and 2/2 actually
    // have a traditional symbol form (common time "C" / alla breve "C|"), so
    // this only changes anything when timeSig is one of those two (see
    // staffRenderer's timeSigGlyph). Toggled by clicking the rendered time
    // signature itself (see app.js's timeSigHitMap handling).
    timeSigDisplay: 'numeric',
    // Show/hide 下鍵盤's auto-detected chord symbols entirely (形式 tab) —
    // the underlying note.chord values are untouched, only the display.
    showChordSymbols: true,
    keySignature: 'C',
    bpm: 100,
    bpmNoteValue: 'q',
    // User-adjustable multiplier on each measure's "natural" width (wider =
    // fewer, more spacious measures per line; narrower = more, tighter ones)
    // — see the 形式 tab's drag slider and staffRenderer's computeLines.
    measureWidthScale: 1,
    pickupBeats: 0,
    clefs: { ...PART_CLEF },
    // Playback/WAV-export instrument per part (上鍵盤/下鍵盤/ペダル) — a
    // General MIDI soundfont name (see smplr's getSoundfontNames()).
    instruments: { upper: 'acoustic_grand_piano', lower: 'acoustic_grand_piano', pedal: 'acoustic_bass' },
    // Free-floating shapes/textboxes (see the 楽挿入 tab) — each anchored to
    // one specific page index (like the title/composer/lyricist fields
    // already were), not to a measure, so they stay put even as the score's
    // content reflows. { id, page, type: 'textbox'|'rect'|'ellipse'|'line'|
    // 'arrow', x, y, width, height, text, fontFamily, fontSize, fill, stroke,
    // strokeWidth } — see app.js's shape ribbon/format-tab handling.
    shapes: [],
    // タイトル/作詞/作曲 field styling (font only — see the 図形の書式 tab)
    // now editable the same way a shape's text is, without turning the
    // fields themselves into shapes (score.title etc. stay the plain
    // strings other code already depends on).
    titleStyle: { fontFamily: 'Hiragino Sans, Yu Gothic, serif', fontSize: 22 },
    composerStyle: { fontFamily: 'Hiragino Sans, Yu Gothic, serif', fontSize: 12 },
    lyricistStyle: { fontFamily: 'Hiragino Sans, Yu Gothic, serif', fontSize: 12 },
    measures: Array.from({ length: DEFAULT_PAGE_MEASURE_COUNT }, () => createEmptyMeasure()),
  };
}

export function isValidTimeSig(value) {
  return /^[1-9][0-9]?\/(1|2|4|8|16|32)$/.test(value);
}

export function beatsPerMeasure(score) {
  const [beats] = score.timeSig.split('/').map(Number);
  return beats;
}

// Measure 0 may be a shorter "pickup" (anacrusis) measure; every other
// measure uses the full time-signature capacity.
export function measureCapacity(score, measureIndex) {
  if (measureIndex === 0 && score.pickupBeats > 0) return score.pickupBeats;
  return beatsPerMeasure(score);
}

export function measureBeatsUsed(measure, part) {
  return measure[part].reduce((sum, n) => sum + noteBeats(n), 0);
}

// --- chord-symbol parsing (for reflecting a measure's "コード" text in playback) ---

const CHORD_ROOT_SEMITONE = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

// Checked as exact-match suffixes, so order doesn't matter for correctness.
// Covers the common lead-sheet chord qualities; anything fancier (9ths,
// slash chords, add-tones, …) just won't be recognized and is skipped.
const CHORD_QUALITIES = [
  { suffix: 'maj7', intervals: [0, 4, 7, 11] },
  { suffix: 'M7', intervals: [0, 4, 7, 11] },
  { suffix: 'm7b5', intervals: [0, 3, 6, 10] },
  { suffix: 'dim7', intervals: [0, 3, 6, 9] },
  { suffix: 'm7', intervals: [0, 3, 7, 10] },
  { suffix: 'min7', intervals: [0, 3, 7, 10] },
  { suffix: '7', intervals: [0, 4, 7, 10] },
  { suffix: 'sus4', intervals: [0, 5, 7] },
  { suffix: 'sus2', intervals: [0, 2, 7] },
  { suffix: 'dim', intervals: [0, 3, 6] },
  { suffix: 'aug', intervals: [0, 4, 8] },
  { suffix: 'min', intervals: [0, 3, 7] },
  { suffix: 'm', intervals: [0, 3, 7] },
  { suffix: '', intervals: [0, 4, 7] },
];

// Parses a lead-sheet chord symbol ("D", "F#m7", "Bbmaj7", …) into a root
// semitone (0-11, C=0) and the semitone intervals above it. Returns null for
// empty/unrecognized text so callers can just skip playback for that measure.
export function parseChordSymbol(text) {
  if (!text) return null;
  const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(text.trim());
  if (!m) return null;
  const [, letterRaw, accidental, rest] = m;
  const letter = letterRaw.toUpperCase();
  const quality = CHORD_QUALITIES.find((q) => q.suffix === rest.trim());
  if (!quality) return null;
  const accOffset = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0;
  const rootSemitone = ((CHORD_ROOT_SEMITONE[letter] + accOffset) % 12 + 12) % 12;
  return { rootSemitone, intervals: quality.intervals };
}

// Root note choices for the コード select UI (sharps only, to keep the list
// short — enharmonic spelling doesn't matter since the chord is audio-only).
export const CHORD_ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Quality choices for the コード select UI — value is appended straight to
// the root to form the stored chord symbol (e.g. root "F#" + value "m7" ->
// "F#m7"), so these must exactly match a CHORD_QUALITIES suffix above.
export const CHORD_QUALITY_OPTIONS = [
  { value: '', label: '(メジャー)' },
  { value: 'm', label: 'm(マイナー)' },
  { value: '7', label: '7' },
  { value: 'maj7', label: 'maj7' },
  { value: 'm7', label: 'm7' },
  { value: 'dim', label: 'dim' },
  { value: 'dim7', label: 'dim7' },
  { value: 'aug', label: 'aug' },
  { value: 'sus4', label: 'sus4' },
  { value: 'sus2', label: 'sus2' },
  { value: 'm7b5', label: 'm7-5' },
];

// リハーサル記号(区間ラベル) — a fixed preset list, selected (not typed) per
// note, shown as a boxed label above it. '' means "no mark".
export const REHEARSAL_OPTIONS = [
  '', 'Intro', 'A', 'B', 'C', 'D', 'Bridge', 'Interlude', 'Outro', 'Coda', 'Fine',
];

// レジストレーション memory numbers (M1〜M16) — selected per note, shown as a
// boxed "M1" label above it. '' means "no registration change here".
export const REGISTRATION_OPTIONS = ['', ...Array.from({ length: 16 }, (_, i) => `M${i + 1}`)];

// --- automatic chord detection from 下鍵盤/ペダル content ---

function pitchClassOf(key) {
  const m = /^([a-gA-G])(#{1,2}|b{1,2}|n)?\//.exec(key);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const acc = m[2] || '';
  const offset = { '#': 1, '##': 2, b: -1, bb: -2 }[acc] || 0;
  return ((CHORD_ROOT_SEMITONE[letter] + offset) % 12 + 12) % 12;
}

// The [start, end) beat offsets (within the measure) that `measure[part][noteIndex]`
// occupies — found by summing every earlier note/rest's beats in that part.
export function noteBeatWindow(measure, part, noteIndex) {
  const notes = measure[part] || [];
  let start = 0;
  for (let i = 0; i < noteIndex; i += 1) start += noteBeats(notes[i]);
  return { start, end: start + noteBeats(notes[noteIndex]) };
}

// The set of distinct pitch classes (0-11, ignoring octave) sounding at the
// moment one specific 下鍵盤 note is struck — its own keys, plus whichever
// ペダル note(s) overlap its time window in the same measure. This is the
// raw material per-note chord detection reads (コード is now attached to the
// 下鍵盤 note it belongs above, not to the whole measure).
export function chordPitchClassesForLowerNote(measure, noteIndex) {
  const classes = new Set();
  const note = (measure.lower || [])[noteIndex];
  if (!note || note.isRest) return classes;
  note.keys.forEach((tone) => {
    const pc = pitchClassOf(tone.key);
    if (pc !== null) classes.add(pc);
  });
  const { start, end } = noteBeatWindow(measure, 'lower', noteIndex);
  let cursor = 0;
  (measure.pedal || []).forEach((pn) => {
    const pStart = cursor;
    const pEnd = cursor + noteBeats(pn);
    cursor = pEnd;
    if (pn.isRest || pStart >= end || pEnd <= start) return;
    pn.keys.forEach((tone) => {
      const pc = pitchClassOf(tone.key);
      if (pc !== null) classes.add(pc);
    });
  });
  return classes;
}

// Finds every (root, quality) combination from CHORD_QUALITY_OPTIONS whose
// notes are *exactly* the given pitch-class set (order/octave/doubling
// don't matter). Symmetric chords (dim7, aug) legitimately match from
// several roots — that's the "more than one candidate" case callers show as
// a tentative guess. Fewer than 3 distinct pitches can't match anything (the
// shortest quality is a triad) and returns no candidates.
export function detectChordCandidates(pitchClasses) {
  if (!pitchClasses || pitchClasses.size < 2) return [];
  const exact = [];
  CHORD_QUALITY_OPTIONS.forEach((opt) => {
    const quality = CHORD_QUALITIES.find((q) => q.suffix === opt.value);
    if (!quality || quality.intervals.length !== pitchClasses.size) return;
    for (let root = 0; root < 12; root += 1) {
      const qSet = new Set(quality.intervals.map((iv) => (root + iv) % 12));
      let matches = qSet.size === pitchClasses.size;
      if (matches) {
        qSet.forEach((pc) => { if (!pitchClasses.has(pc)) matches = false; });
      }
      if (matches) exact.push(`${CHORD_ROOTS[root]}${opt.value}`);
    }
  });
  if (exact.length > 0 || pitchClasses.size !== 2) return exact;

  // Fallback for a thinned-out measure with only two sounding pitch classes
  // (e.g. a bare root+fifth, or a single sustained interval) — nothing above
  // matched exactly since real triads have three tones, but if the two notes
  // that ARE sounding are both members of some triad, surface that as a
  // (necessarily more ambiguous, hence chordTentative) candidate rather than
  // leaving the measure blank.
  const partial = [];
  CHORD_QUALITY_OPTIONS.forEach((opt) => {
    const quality = CHORD_QUALITIES.find((q) => q.suffix === opt.value);
    if (!quality || quality.intervals.length !== 3) return;
    for (let root = 0; root < 12; root += 1) {
      const qSet = new Set(quality.intervals.map((iv) => (root + iv) % 12));
      let contains = true;
      pitchClasses.forEach((pc) => { if (!qSet.has(pc)) contains = false; });
      if (contains) partial.push(`${CHORD_ROOTS[root]}${opt.value}`);
    }
  });
  return partial;
}
