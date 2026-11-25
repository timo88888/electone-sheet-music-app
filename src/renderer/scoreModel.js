export const PARTS = ['upper', 'lower', 'pedal'];

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

export const DURATION_LABELS = {
  w: '全音符',
  h: '2分音符',
  q: '4分音符',
  '8': '8分音符',
  '16': '16分音符',
};

export const DURATION_BEATS = {
  w: 4,
  h: 2,
  q: 1,
  '8': 0.5,
  '16': 0.25,
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

// Rest glyphs (and rendered position) don't move with clef the way pitched
// notes do — this is the "sits on the middle line" anchor key per clef.
export const REST_ANCHOR_KEY = {
  treble: 'b/4',
  bass: 'd/3',
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
    // n番括弧(volta/repeat-ending bracket) — { number: 1-5 } on the one
    // measure the bracket covers, null everywhere else. Drawn as a 鉤括弧
    // (open on the right, see drawVoltaBrackets) and always exactly one
    // measure wide.
    volta: null,
  };
}

// 強弱記号の一覧。LilyPond が持つもの
// (https://lilypond.org/doc/v2.24/Documentation/notation/expressive-marks-attached-to-notes)
// のうち、鍵盤楽譜で実際に使うものに絞ってある。ppp〜fff の段階に加えて、
// 一音だけ強く出す sf/sfz/rfz、その場で弱める fp/sp、消え入る n(niente)。
// 値はそのまま音楽フォントのダイナミクス字形に置き換えて描かれる
// (staffRenderer の DYNAMIC_GLYPHS)。
export const DYNAMIC_OPTIONS = [
  { value: '', label: '強弱なし' },
  { value: 'ppp', label: 'ppp(きわめて弱く)' },
  { value: 'pp', label: 'pp(とても弱く)' },
  { value: 'p', label: 'p(弱く)' },
  { value: 'mp', label: 'mp(やや弱く)' },
  { value: 'mf', label: 'mf(やや強く)' },
  { value: 'f', label: 'f(強く)' },
  { value: 'ff', label: 'ff(とても強く)' },
  { value: 'fff', label: 'fff(きわめて強く)' },
  { value: 'fp', label: 'fp(強くしてすぐ弱く)' },
  { value: 'sp', label: 'sp(急に弱く)' },
  { value: 'sf', label: 'sf(その音だけ強く)' },
  { value: 'sfz', label: 'sfz(その音を鋭く強く)' },
  { value: 'rfz', label: 'rfz(その音を張り出して)' },
  { value: 'n', label: 'n(消え入るように)' },
];

// 運指(どの指で弾くか)。鍵盤楽譜では 1(親指)〜5(小指)。
export const FINGERING_OPTIONS = ['', '1', '2', '3', '4', '5'];

// Fields every note carries in addition to its pitch/duration data — コード
// is a per-note annotation (see chordPitchClassesForLowerNote) rather than
// per-measure, so a brand-new note needs blank defaults for it the same way
// it does for dynamic/articulation/lyric.
export function noteAnnotationDefaults() {
  return {
    // 運指 — 音符に添える指番号と、それを符頭の上下どちらに置くか。
    // LilyPond の Fingering は fingeringOrientations の既定が '(up down) で
    // まず上を試すので、こちらも既定は上。
    fingering: '',
    fingeringBelow: false,
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
    // 譜表と譜表の間隔にかかる倍率(形式タブの縦のスライダー)。小さくするほど
    // 3段セットが縦に縮み、1ページに入る段数が増える。1ページあたりの段数は
    // これと加線の長さから毎回計算される(staffRenderer の renderScore)。
    systemHeightScale: 1,
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

// How much music one full measure holds, in the quarter-note units the rest
// of the app measures durations in (see DURATION_BEATS, where q = 1).
//
// The time signature's *denominator* is what a beat is counted in, so it has
// to be converted: 6/8 is six eighth notes = 3 quarter notes, 2/2 is two half
// notes = 4 quarter notes. Reading only the numerator (as this used to) made
// every signature whose denominator isn't 4 hold the wrong amount — a 6/8
// measure accepted six *quarter* notes, a 2/2 measure filled up after one
// half note — which then propagated into rendering and playback timing.
export function beatsPerMeasure(score) {
  const [beats, unit] = String((score && score.timeSig) || '4/4').split('/').map(Number);
  if (!beats || !unit) return 4;
  return beats * (4 / unit);
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

// コードの根音の書きかたは調号によって変わる。ヘ長調の「シ♭」を A# とは書かず
// Bb と書く — 同じ高さでも、その調で使う音名で書くのが読みやすい。
//
// 調号に♭が付く調(と、♯も♭も付かないハ長調/イ短調)では♭で、♯が付く調では♯で
// 綴る。ハ長調だけは慣習に合わせてファ♯だけ F# とする(ポピュラー音楽で
// Gb と書くことはまずない)。
const SHARP_ROOT_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_ROOT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const NATURAL_ROOT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export function chordRootNames(keySignature) {
  const entry = KEY_SIGNATURES.find((k) => k.value === keySignature);
  if (!entry || !entry.type) return NATURAL_ROOT_NAMES;
  return entry.type === 'flat' ? FLAT_ROOT_NAMES : SHARP_ROOT_NAMES;
}

// 綴りの違う同じ根音(A# と Bb など)を同じものとして扱うための番号。
export function chordRootPitchClass(name) {
  const m = /^([A-G])(#|b)?$/.exec(name || '');
  if (!m) return null;
  const offset = { '#': 1, b: -1 }[m[2]] || 0;
  return ((CHORD_ROOT_SEMITONE[m[1]] + offset) % 12 + 12) % 12;
}

// 分数コード(オンコード)の区切り。保存はこの形で持ち、読むときは
// スラッシュ("C/E")も受け付ける — 手で書き換えたファイルでも読めるように。
export const BASS_SEPARATOR = ' on ';

// "Cm7 on G" を { chord: 'Cm7', bass: 'G' } に割る。ベース音がなければ bass は ''。
export function splitBassNote(text) {
  const m = /^(.*?)(?:\s+on\s+|\s*\/\s*)([A-Ga-g][#b]?)\s*$/.exec((text || '').trim());
  if (!m) return { chord: (text || '').trim(), bass: '' };
  return { chord: m[1].trim(), bass: `${m[2][0].toUpperCase()}${m[2].slice(1)}` };
}

// 和音名にベース音を書き添える。ベース音が根音と同じなら分数コードにはしない
// (C の一番下がドなら、ただの C であって C on C ではない)。
export function withBassNote(chordName, bassPitchClass, keySignature) {
  if (!chordName || bassPitchClass === null || bassPitchClass === undefined) return chordName;
  const { chord } = splitBassNote(chordName);
  const m = /^([A-G][#b]?)/.exec(chord);
  if (!m) return chordName;
  if (chordRootPitchClass(m[1]) === bassPitchClass) return chord;
  return `${chord}${BASS_SEPARATOR}${chordRootNames(keySignature)[bassPitchClass]}`;
}

// 譜面に書くときのコード名。保存されている綴りが何であれ、その楽譜の調号での
// 綴りに直して返す(ヘ長調なら "A#m7" は "Bbm7")。分数コードはベース音のほうも
// 同じように読み替える。読み取れない文字列はそのまま。
export function displayChordSymbol(text, keySignature) {
  if (!text) return text;
  const { chord, bass } = splitBassNote(text);
  const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(chord);
  if (!m) return text;
  const pc = chordRootPitchClass(`${m[1].toUpperCase()}${m[2]}`);
  if (pc === null) return text;
  const names = chordRootNames(keySignature);
  const head = `${names[pc]}${m[3]}`;
  if (!bass) return head;
  const bassPc = chordRootPitchClass(bass);
  if (bassPc === null) return head;
  return `${head}${BASS_SEPARATOR}${names[bassPc]}`;
}

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

// 反復記号(演奏順を決めるマーカー)。1つの小節に1つだけ付く。
//
// LilyPond の Long repeats に倣い、「戻れ」という指示(D.C./D.S.)と「戻った先で
// どこへ飛ぶか」の指示(To Coda)と「その飛び先」(Coda)、それに終止(Fine)を
// それぞれ別の記号として扱う。とくにコーダは To Coda と Coda の対で初めて
// 意味を持つ — 「ここまで来たらコーダへ飛べ」と「そのコーダはここ」の2点が
// そろわないと演奏順が決まらない。
//
// 譜面での書きかた(staffRenderer の drawRepeatMarker):
//   Segno   … 𝄋            小節の頭(戻ってくる先だから)
//   Coda    … 𝄌 Coda       小節の頭(飛んでくる先だから)
//   To Coda … to 𝄌         小節の終わり(そこまで来たら飛ぶ、という指示だから)
//   D.C. / D.S. / Fine … イタリックの語、小節の終わり
export const MARKER_OPTIONS = [
  { value: '', label: 'なし' },
  { value: 'Segno', label: 'セーニョ 𝄋' },
  { value: 'To Coda', label: 'トゥ・コーダ（コーダへ飛ぶ地点）' },
  { value: 'Coda', label: 'コーダ（飛び先。To Codaと対で使う）' },
  { value: 'D.C.', label: 'D.C.（ダ・カーポ／曲頭へ戻る）' },
  { value: 'D.S.', label: 'D.S.（ダル・セーニョ／セーニョへ戻る）' },
  { value: 'Fine', label: 'Fine（フィーネ／ここで終わる）' },
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

const ACCIDENTAL_SEMITONES = {
  '': 0, '#': 1, '##': 2, b: -1, bb: -2, n: 0,
};

// "c#/4" を文字・変化記号・オクターヴに割る。pitchMap.js の parseKey と同じ
// 仕事だが、scoreModel は pitchMap に依存していないのでここに持つ。
function parseKeyParts(key) {
  const m = /^([a-gA-G])(#{1,2}|b{1,2}|n)?\/(-?\d+)$/.exec(key || '');
  if (!m) return { letter: null, accidental: '', octave: 0 };
  return { letter: m[1].toUpperCase(), accidental: m[2] || '', octave: Number(m[3]) };
}

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

// What one specific 下鍵盤 note sounds together with — its own keys, plus
// whichever ペダル note(s) overlap its time window in the same measure. This
// is the raw material per-note chord detection reads (コード is attached to
// the 下鍵盤 note it belongs above, not to the whole measure).
//
// 分数コード(オンコード)を判定するには「和音を作っている音の集まり」だけでなく
// 「いちばん低く鳴っている音」も要る。C on E と E on C は同じ音の集まりでも
// 別のコードなので、集合にまとめてしまうと区別がつかない。
//
// 返すもの:
//   classes    … その瞬間に鳴っている音名の集まり(下鍵盤 + 重なるペダル)
//   lowerOnly  … 下鍵盤だけの音名の集まり。ペダルが和音の構成音でないとき
//                (C on D など)、和音そのものは下鍵盤だけから決める
//   bass       … いちばん低く鳴っている音の音名。エレクトーンならふつうペダル、
//                ペダルが休みなら下鍵盤のいちばん下の音
export function chordContextForLowerNote(measure, noteIndex) {
  const classes = new Set();
  const lowerOnly = new Set();
  const note = (measure.lower || [])[noteIndex];
  if (!note || note.isRest) return { classes, lowerOnly, bass: null };

  // 「低い」の比較は音名(0-11)ではなく実際の高さでないといけない。
  // 音名だけで比べると、オクターヴ下のシがドより高いことになってしまう。
  let lowestPitch = Infinity;
  let bass = null;
  const consider = (key) => {
    const pc = pitchClassOf(key);
    if (pc === null) return null;
    const { letter, accidental, octave } = parseKeyParts(key);
    if (letter === null) return pc;
    const pitch = octave * 12 + CHORD_ROOT_SEMITONE[letter] + (ACCIDENTAL_SEMITONES[accidental] || 0);
    if (pitch < lowestPitch) {
      lowestPitch = pitch;
      bass = pc;
    }
    return pc;
  };

  note.keys.forEach((tone) => {
    const pc = consider(tone.key);
    if (pc !== null) { classes.add(pc); lowerOnly.add(pc); }
  });

  const { start, end } = noteBeatWindow(measure, 'lower', noteIndex);
  let cursor = 0;
  (measure.pedal || []).forEach((pn) => {
    const pStart = cursor;
    const pEnd = cursor + noteBeats(pn);
    cursor = pEnd;
    if (pn.isRest || pStart >= end || pEnd <= start) return;
    pn.keys.forEach((tone) => {
      const pc = consider(tone.key);
      if (pc !== null) classes.add(pc);
    });
  });
  return { classes, lowerOnly, bass };
}

// Finds every (root, quality) combination from CHORD_QUALITY_OPTIONS whose
// notes are *exactly* the given pitch-class set (order/octave/doubling
// don't matter). Symmetric chords (dim7, aug) legitimately match from
// several roots — that's the "more than one candidate" case callers show as
// a tentative guess. Fewer than 3 distinct pitches can't match anything (the
// shortest quality is a triad) and returns no candidates.
export function detectChordCandidates(pitchClasses, keySignature = 'C') {
  if (!pitchClasses || pitchClasses.size < 2) return [];
  const rootNames = chordRootNames(keySignature);
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
      if (matches) exact.push(`${rootNames[root]}${opt.value}`);
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
      if (contains) partial.push(`${rootNames[root]}${opt.value}`);
    }
  });
  return partial;
}

// 分数コード(オンコード)まで含めたコード名の候補。
//
// エレクトーンでは下鍵盤が和音、ペダルがベース音を受け持つので、その形のまま
// 読む。判定は当てはまりの良い順に3段階:
//
//   1. 鳴っている音ぜんぶで和音として読めるか
//      — ドミソをミで支えれば {ド,ミ,ソ} のままなので、これで転回形が拾える
//   2. 読めなければ、下鍵盤の音だけで和音として読めるか
//      — ペダルが和音の構成音でない場合(C on D など)。ベース音を混ぜたままだと
//        どの和音にも当てはまらなくなる
//   3. それでも読めなければ、従来どおり2音だけの当て推量にかける
//
// どの段でも、いちばん低い音が根音と違えば "○ on △" にする。
export function detectChordSymbols(context, keySignature = 'C') {
  const { classes, lowerOnly, bass } = context || {};
  if (!classes || classes.size === 0) return [];
  const withBass = (names) => names.map((n) => withBassNote(n, bass, keySignature));

  const whole = detectChordCandidates(classes, keySignature);
  // 2音しかないときの当て推量(段階3)は最後に回したいので、ここでは
  // ぴったり当てはまったものだけを採る。
  const exactWhole = classes.size >= 3 ? whole : [];
  if (exactWhole.length > 0) return withBass(exactWhole);

  if (lowerOnly && lowerOnly.size >= 3 && lowerOnly.size < classes.size) {
    const fromLower = detectChordCandidates(lowerOnly, keySignature);
    if (fromLower.length > 0) return withBass(fromLower);
  }

  return withBass(whole);
}
