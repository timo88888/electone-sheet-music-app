import {
  Renderer, Stave, StaveNote, StaveConnector, Voice, Formatter, Dot, Beam,
  BarlineType, StaveTie, Curve, StaveHairpin, Accidental, Annotation, AnnotationVerticalJustify,
  Articulation, Tuplet, Ornament, Stroke, TextBracket, Modifier, Stem, Metrics,
} from '../../node_modules/vexflow/build/esm/entry/vexflow.js';
import {
  PARTS, measureCapacity, getClef, REST_ANCHOR_KEY, noteBeats, keySignatureAccidentalCount,
  keySignatureAccidentalForLetter, tupletNotesOccupied, displayChordSymbol,
} from './scoreModel.js';
import { parseKey } from './pitchMap.js';
import { beamGroupsForMeasure } from './beamGroups.js';

// 単音の音符に付く「アーティキュレーション」記号(note.articulation) —
// VexFlowのArticulation(音符に直接付くグリフ)/Ornament(装飾音)/Stroke(和音の
// アルペジオ)のうち、どれで描画するかをコード表から振り分ける(下の
// addArticulationModifier参照)。ピアノ・エレクトーンで一般的に使うものだけに
// 絞ってある。
const ARTICULATION_CODES = {
  staccato: 'a.',
  staccatissimo: 'av',
  tenuto: 'a-',
  accent: 'a>',
  marcato: 'a^',
  fermata: 'a@a',
};
const ORNAMENT_CODES = {
  trill: 'tr',
  turn: 'turn',
  mordent: 'mordent',
};
const ARPEGGIO_ARTICULATION = 'arpeggio';

// 配置方向の規則は LilyPond の scm/script.scm をそのまま写したもの
// (https://lilypond.org/doc/v2.24/Documentation/notation/direction-and-placement)。
//
// スタッカート/スタッカーティッシモ/テヌート/アクセント/マルカートは
// side-relative-direction = DOWN、つまり「符尾と反対側」＝符頭側に置く記号で、
// 符尾が上向きなら音符の下、下向きなら音符の上に来る。VexFlow の Articulation は
// 既定で常に ABOVE(上)に置いてしまうので、ここで符尾から明示的に決める。
const STEM_OPPOSITE_ARTICULATIONS = new Set([
  'staccato', 'staccatissimo', 'tenuto', 'accent', 'marcato',
]);
// フェルマータは script.scm で direction = UP(script-priority 4000)、
// つまり符尾の向きに関係なく必ず譜表の上。
const ALWAYS_ABOVE_ARTICULATIONS = new Set(['fermata']);

// Attaches note.articulation to vfNote, picking whichever VexFlow modifier
// class actually renders that code — a plain articulation glyph (staccato,
// fermata, ...), a stem-attached ornament (trill, turn, mordent), or an
// arpeggio wavy line across the whole chord (Stroke, not tied to one key).
//
// Ornament(トリル/ターン/モルデント) is left at VexFlow's own default of
// ABOVE, which already matches script.scm's direction = UP for all three.
function addArticulationModifier(vfNote, articulation) {
  if (ARTICULATION_CODES[articulation]) {
    const artic = new Articulation(ARTICULATION_CODES[articulation]);
    if (ALWAYS_ABOVE_ARTICULATIONS.has(articulation)) {
      artic.setPosition(Modifier.Position.ABOVE);
    } else if (STEM_OPPOSITE_ARTICULATIONS.has(articulation)) {
      artic.setPosition(
        vfNote.getStemDirection() === Stem.UP ? Modifier.Position.BELOW : Modifier.Position.ABOVE,
      );
    }
    vfNote.addModifier(artic, 0);
  } else if (ORNAMENT_CODES[articulation]) {
    vfNote.addModifier(new Ornament(ORNAMENT_CODES[articulation]), 0);
  } else if (articulation === ARPEGGIO_ARTICULATION) {
    vfNote.addModifier(new Stroke(Stroke.Type.ARPEGGIO_DIRECTIONLESS), 0);
  }
}

// 強弱記号(p, mf, sfz, …)は本来テキストではなく音楽フォントのグリフ。
// LilyPond も Emmentaler のダイナミクス字形を使う。VexFlow は SMuFL の
// U+E520〜 を持っているので、1文字ずつグリフに置き換えて描く
// (VexFlow 自身の TextDynamics と同じ対応表)。
const DYNAMIC_GLYPHS = {
  p: '\uE520', // dynamicPiano
  m: '\uE521', // dynamicMezzo
  f: '\uE522', // dynamicForte
  r: '\uE523', // dynamicRinforzando
  s: '\uE524', // dynamicSforzando
  z: '\uE525', // dynamicZ
  n: '\uE526', // dynamicNiente
};

// 反復記号のグリフ(SMuFL)。D.C./D.S./Fine は語なのでイタリック文字列のままだが、
// セーニョとコーダは記号であって文字ではないので専用の字形で描く。
const SEGNO_GLYPH = '\uE047';
const CODA_GLYPH = '\uE048';

function dynamicGlyphText(text) {
  let out = '';
  for (const ch of String(text)) {
    const glyph = DYNAMIC_GLYPHS[ch.toLowerCase()];
    if (!glyph) return null; // 未知の文字が混ざったらグリフ化をあきらめて素のテキストで描く
    out += glyph;
  }
  return out;
}

// Placeholder rests auto-inserted by the N連符 ribbon flow (see app.js's
// insertNote) render in this color so they're obviously "fill me in",
// distinct from ordinary rests.
const PLACEHOLDER_COLOR = '#e08a1e';

// A4 portrait ratio (210:297mm) — printing targets A4 (one page per sheet)
// or A3 (two consecutive pages as one landscape spread), both of which need
// each page itself to be A4-shaped.
const A4_RATIO = 297 / 210;

export const LAYOUT = {
  // Upper bound for page 1 only — the actual count is worked out per score
  // from how tall its systems turn out to be (see renderScore).
  // 暴走よけの上限で、ふつうはこれより先に紙の高さで決まる。縦スライダーで
  // 譜表を詰めたときにここで頭打ちにならないよう、余裕を持たせてある。
  linesPerPage: 8,
  // 2ページ目以降は曲名の欄がないぶん縦に余裕があるので、段間を詰めて
  // もう1段(上鍵盤・下鍵盤・ペダルの3段セット)入れる。詰めても入らない楽譜
  // (加線が長くて譜表の間隔が広がっている等)では自動的に1ページ目と同じ数に
  // 戻る — renderScore の laterPageLines 参照。
  extraLinesAfterFirstPage: 1,
  pageWidth: 1050,
  pageHeight: Math.round(1050 * A4_RATIO),
  pageMargin: 40,
  // 用紙の上端から段の一番上まで。曲名欄のある1ページ目はさらに
  // titleHeaderHeight だけ下がる。
  topMargin: 80,
  // 3段セットの中の譜表と譜表の間隔(上線から次の譜表の上線まで)。2ページ目
  // 以降にもう1セット入れられるだけの縦の余白を作るために、以前の100pxから
  // 詰めてある。譜線の間隔を1単位とすると7.2単位で、LilyPond の PianoStaff の
  // 下限(StaffGrouper.staff-staff-spacing の minimum-distance = 7)より広い。
  staveGap: 72,
  // 段と段の間隔 — ペダル譜表の下線から、次の段の一番上(マーク帯の上端)まで。
  // ここに小節番号・ペダルの強弱記号・ペダルの歌詞が入る。
  // 上限値であり、ページごとに、そのページに入る段数で縦の余白を配り直す
  // (renderScore の pageSystemGap)。最後の段ではこの間隔がそのままページ下端の
  // 余白になるので、ページ番号と重ならないための余裕でもある。
  systemGap: 66,
  // Band holding コード text and リハーサル/レジストレーション boxes, one line
  // above the stave (see renderScore's per-note mark drawing). Sized so the
  // band's own bottom edge clears the treble clef's tip instead of sitting
  // right against the staff — a clef's swirl reaches noticeably above the
  // top line, and a tall upper-staff note's ledger lines can reach up nearly
  // as far, so drawPerNoteMarks also treats those ledger-line notes as
  // obstacles the same way it treats a neighboring mark (see
  // upperNoteObstacles). Priority when marks would collide is コード, then
  // リハーサル, then レジストレーション — later ones shift right.
  // 譜表そのものが持つ上の余白(STAVE_HEADROOM_PX = 40px)に *加えて* この帯の
  // ぶんだけ場所を取る。ト音記号の渦は上線より26pxほど上まで伸びるので、
  // 譜表自身の40pxの余白の中にこの帯の下端が収まっていれば記号とはぶつからない。
  rehearsalBandHeight: 12,
  // Now below the pedal stave (moved off the top of the system) — see
  // renderMeasureNumbers in app.js.
  measureNumberHeight: 14,
  clefExtraWidth: 32,
  timeSigExtraWidth: 30,
  keySigWidthPerAccidental: 9,
  keySigBaseWidth: 14,
  // reserved space at the top of page 1 only, for the title/composer/lyricist
  // text overlay app.js renders on top of the score.
  // テンポ表示(♩=100)もこの帯の下端に置かれるので、1段目のマーク帯
  // (セーニョやコーダが入る)と重ならないだけの高さを取ってある。
  titleHeaderHeight: 88,
};

// Extra horizontal room to reserve for the key signature glyph, sized to its
// accidental count so a key with many sharps/flats doesn't crowd measure 1's
// notes off the right edge.
function keySignatureExtraWidth(score, layout) {
  const key = score.keySignature;
  if (!key || key === 'C') return 0;
  return layout.keySigBaseWidth + keySignatureAccidentalCount(key) * layout.keySigWidthPerAccidental;
}

// A measure's "how crowded does this look" signal for width purposes — the
// busiest part's real (non-placeholder) note count. Clamped to at least 1 so
// a totally empty measure still gets a sane nominal width instead of 0.
function measureNoteCount(measure) {
  const counts = PARTS.map((part) => (measure[part] || []).filter((n) => !n.isPlaceholder).length);
  return Math.max(1, ...counts);
}

function averageNoteCount(score) {
  const counts = score.measures.map(measureNoteCount);
  const sum = counts.reduce((a, b) => a + b, 0);
  return sum / counts.length || 1;
}

// Reference width (px, at scale 1 and average note density) used as the
// baseline every measure's nominal width scales from.
const REFERENCE_MEASURE_WIDTH = 220;

// A measure's "natural" width before line-fitting/justification: scales with
// the user's drag-adjustable measureWidthScale and with how many notes this
// measure holds relative to the score's average — using sqrt (not a linear
// ratio) and clamping the result so a very dense or very sparse measure
// still lands within a bounded range of its neighbors, per the "don't let
// widths get too wildly different from each other" requirement.
function measureNominalWidth(measure, avgCount, scale) {
  const density = Math.sqrt(measureNoteCount(measure) / avgCount);
  const factor = Math.max(0.72, Math.min(1.4, 0.5 + 0.5 * density));
  return REFERENCE_MEASURE_WIDTH * scale * factor;
}

// A staff is 4 line-to-line gaps tall (10px each, VexFlow's default), and
// indexForPitch's index units are half of that (one diatonic step per unit —
// a note on the bottom line sits at index 8, one in the space above the top
// line at index -1, and so on).
const STAVE_HEIGHT_PX = 40;
// VexFlow の Stave は渡した y のすぐそこに線を引くのではなく、4間ぶんの余白
// (spaceAboveStaffLn)を空けてから第1線を引く。つまり譜表が紙を占める高さは
// この余白 + 五線の高さ。段の高さを数えるときここを落とすと、最後の段が下の
// 余白へせり出してページ番号と重なる。
const STAVE_HEADROOM_PX = 40;
// Stave.getBottomLineY() が返すのは下線そのものではなく、その1間下。
// 譜表の下に何かを置くコードはこの分だけ余計に下がることを見込んでいる。
const BOTTOM_LINE_Y_OFFSET = 10;
const INDEX_STEP_PX = 5;
// A little extra room beyond the bare minimum so a ledger line doesn't sit
// pixel-adjacent to the next staff's own top/bottom line.
const STAVE_GAP_SAFETY_INDEX_UNITS = 2;

// Diatonic index (0 = the stave's top line, +1 per half-step down) for any
// pitch, above or below the stave — unlike pitchMap.js's own indexForPitch,
// which only searches downward from the clef's top line and so can't
// resolve a pitch ABOVE it (exactly what 下鍵盤/ペダル's high notes need
// here). LETTER_ORDER matches pitchMap.js's own LETTERS cycle (C..B).
const LETTER_ORDER = {
  C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6,
};
const CLEF_TOP_LINE = {
  treble: { letter: 'F', octave: 5 },
  bass: { letter: 'A', octave: 3 },
};
function diatonicIndex(clef, key) {
  const { letter, octave } = parseKey(key);
  const top = CLEF_TOP_LINE[clef];
  const topPos = top.octave * 7 + LETTER_ORDER[top.letter];
  const pos = octave * 7 + LETTER_ORDER[letter.toUpperCase()];
  return topPos - pos;
}

// How far below (positive) or above (positive) the stave a pitch's ledger
// lines reach, in diatonicIndex's index units (0 at the relevant line).
function ledgerReachBelow(clef, key) {
  return Math.max(0, diatonicIndex(clef, key) - 8);
}
function ledgerReachAbove(clef, key) {
  return Math.max(0, -diatonicIndex(clef, key));
}

// Scans every note in the score once to find the tallest mutual intrusion
// between adjacent staves — 上鍵盤's lowest ledger lines reaching down vs.
// 下鍵盤's highest reaching up, and the same for 下鍵盤/ペダル — and widens
// staveGap just enough to clear the worse of the two, uniformly for every
// system in the piece (never narrower than the layout's own default, and the
// same single gap is used for both stave pairs — see the caller in
// renderScore, which shares one `staveGap` for every idx*staveGap offset).
// 歌詞 (see the per-line lyric rows further down) prints at
// getBottomLineY() + 14 for 上鍵盤/下鍵盤 — this is how much room below the
// bottom line to reserve so that text doesn't run into the next stave down
// when any measure actually has a lyric set for 上鍵盤/下鍵盤 (a score with
// no lyrics at all keeps relying purely on the note-collision gap above).
const LYRIC_RESERVE_PX = 18;

// 譜表の下にぶら下がる記号の行の高さ(px)。
//   ・強弱記号(段ごとに高さを揃えた1行 — drawDynamicsRow)
//   ・符頭の下に付くアーティキュレーション(スタッカート等)
// LilyPond も譜表の縦位置を決めるときに譜表の外に出るこれらの記号を勘定に
// 入れるので、譜表と譜表の間隔にもその分の場所を確保する。
const DYNAMIC_ROW_PX = 30;

// 段の中で「この記号は譜表の下に出るか」— 強弱記号は必ず下、
// アーティキュレーションは符尾と反対側なので符尾が上向きのときだけ下に出る。
// 符尾の向きは描画時にしか分からないので、ここでは下に出うるかどうかで見る。
function hasBelowStaffMarks(notes) {
  return (notes || []).some(
    (n) => n.dynamic || (n.articulation && STEM_OPPOSITE_ARTICULATIONS.has(n.articulation)),
  );
}

function computeRequiredStaveGap(score, baseStaveGap) {
  let upperReachBelow = 0;
  let lowerReachAbove = 0;
  let lowerReachBelow = 0;
  let pedalReachAbove = 0;
  let pedalReachBelow = 0;
  const hasLyric = { upper: false, lower: false, pedal: false };
  const hasMarks = { upper: false, lower: false, pedal: false };
  score.measures.forEach((measure) => {
    PARTS.forEach((part) => {
      if (measure.lyrics && measure.lyrics[part]) hasLyric[part] = true;
      if (hasBelowStaffMarks(measure[part])) hasMarks[part] = true;
      const clef = getClef(score, part);
      (measure[part] || []).forEach((n) => {
        if (n.isRest) return;
        n.keys.forEach((tone) => {
          if (part === 'upper') upperReachBelow = Math.max(upperReachBelow, ledgerReachBelow(clef, tone.key));
          if (part === 'lower') {
            lowerReachAbove = Math.max(lowerReachAbove, ledgerReachAbove(clef, tone.key));
            lowerReachBelow = Math.max(lowerReachBelow, ledgerReachBelow(clef, tone.key));
          }
          if (part === 'pedal') {
            pedalReachAbove = Math.max(pedalReachAbove, ledgerReachAbove(clef, tone.key));
            pedalReachBelow = Math.max(pedalReachBelow, ledgerReachBelow(clef, tone.key));
          }
        });
      });
    });
  });

  // その譜表の下線から、いちばん下にはみ出すものまでの距離(px)。加線の下に
  // 強弱記号の行、さらにその下に歌詞の行、という順に積み上がる。
  const roomBelow = (part, ledgerUnits) => {
    let px = ledgerUnits * INDEX_STEP_PX;
    if (hasMarks[part]) px += DYNAMIC_ROW_PX;
    if (hasLyric[part]) px += LYRIC_RESERVE_PX;
    return px;
  };
  const upperLowerPx = roomBelow('upper', upperReachBelow)
    + (lowerReachAbove + STAVE_GAP_SAFETY_INDEX_UNITS) * INDEX_STEP_PX;
  const lowerPedalPx = roomBelow('lower', lowerReachBelow)
    + (pedalReachAbove + STAVE_GAP_SAFETY_INDEX_UNITS) * INDEX_STEP_PX;
  const neededPx = Math.max(upperLowerPx, lowerPedalPx);
  return {
    gap: Math.max(baseStaveGap, STAVE_HEIGHT_PX + neededPx),
    // How far below its own bottom line 上鍵盤/下鍵盤's lowest note reaches
    // (px) — the per-line dynamics/lyric rows (see below) start just past this
    // so a ledger line under the very column the text starts at can't run
    // through it, whatever the whole score's tallest downward reach is.
    upperReachBelowPx: upperReachBelow * INDEX_STEP_PX,
    lowerReachBelowPx: lowerReachBelow * INDEX_STEP_PX,
    // ペダル譜表の下線から下へどれだけ場所がいるか。下にはもう譜表がないので
    // 譜表の間隔ではなく「段と段の間隔」の下限になる(renderScore の
    // minSystemGap)。最後の段ではそのままページ下端の余白になり、
    // ページ番号と重ならないための余裕でもある。
    pedalBelowPx: roomBelow('pedal', pedalReachBelow),
  };
}

// Groups measure indices into lines by GREEDILY packing them left to right
// until the next measure's nominal width would overflow the line's available
// width (word-wrap style, like a mainstream notation app's automatic system
// breaks) — replacing the old fixed "N measures per line" setting entirely.
// A measure explicitly marked lineBreak (see the measure-number right-click
// menu in app.js) still forces an early break regardless of remaining width.
function computeLines(score, layout) {
  const availableWidth = layout.pageWidth - layout.pageMargin * 2;
  const scale = score.measureWidthScale || 1;
  const avgCount = averageNoteCount(score);
  const keySigWidth = keySignatureExtraWidth(score, layout);
  const lines = [];
  let current = [];
  let currentNominalSum = 0;

  score.measures.forEach((m, idx) => {
    const nominal = measureNominalWidth(m, avgCount, scale);
    if (current.length > 0) {
      const firstColExtra = layout.clefExtraWidth + keySigWidth
        + (current[0] === 0 ? layout.timeSigExtraWidth : 0);
      if (currentNominalSum + nominal + firstColExtra > availableWidth) {
        lines.push(current);
        current = [];
        currentNominalSum = 0;
      }
    }
    current.push(idx);
    currentNominalSum += nominal;
    if (m.lineBreak) {
      lines.push(current);
      current = [];
      currentNominalSum = 0;
    }
  });
  if (current.length > 0) lines.push(current);
  if (lines.length === 0) lines.push([]);
  return lines;
}

// Identifies "the same staff position" for tie/slur matching between two
// notes — letter+octave, ignoring accidental (a tie/slur always connects
// notation at the same line/space regardless of how it's spelled).
function pitchId(key) {
  const m = /^([a-gA-G])(?:#{1,2}|b{1,2}|n)?\/(.+)$/.exec(key);
  return m ? `${m[1].toLowerCase()}/${m[2]}` : key;
}

// --- 臨時記号をいつ書くか(LilyPond の既定 accidentalStyle) ----------------
//
// 「臨時記号は必要になった音符に一度だけ書き、同じ小節の同じオクターヴでは
// 繰り返さない。小節線で効力が切れる」という譜面の基本規則。調号がすでに与えて
// いる変化(ト長調のファ♯など)も書かない。逆に、直前で臨時記号がついた音を
// 元に戻すときはナチュラルを書く。
//
// この楽譜モデルは音高を常に明示的な綴り(c#/4 など)で持っているので、そのまま
// 描くと同じ小節に何度も♯が並んでしまう。ここで「実際に鳴る変化」と「その時点で
// 有効な変化」を突き合わせ、食い違うときだけ記号を出す。
//
// LilyPond の既定は譜表(Staff)単位なので、上鍵盤/下鍵盤/ペダルそれぞれ独立に
// 数える(この関数がパートごとに呼ばれるのがそれに当たる)。
function accidentalsForMeasure(notes, keySignature) {
  const active = new Map(); // "C4" -> 今その音に効いている変化 ('' / '#' / 'b' / '##' / 'bb')
  return notes.map((n) => {
    if (n.isRest) return [];
    return n.keys.map((tone) => {
      const { letter, accidental, octave } = parseKey(tone.key);
      const fromKeySig = keySignatureAccidentalForLetter(keySignature, letter);
      // 綴りに記号がなければ調号どおりに鳴る。'n' は明示的なナチュラル(=変化なし)。
      let sounding;
      if (accidental === '') sounding = fromKeySig;
      else if (accidental === 'n') sounding = '';
      else sounding = accidental;
      const slot = `${letter}${octave}`;
      const effective = active.has(slot) ? active.get(slot) : fromKeySig;
      active.set(slot, sounding);
      if (sounding === effective) return null;
      return sounding === '' ? 'n' : sounding;
    });
  });
}

function buildStaveNotes(measure, part, clef, keySignature) {
  const notes = measure[part];
  if (notes.length === 0) {
    const restKey = REST_ANCHOR_KEY[clef] || 'b/4';
    return [{ vfNote: new StaveNote({ keys: [restKey], duration: 'wr', clef }), noteRef: null }];
  }
  const accidentals = accidentalsForMeasure(notes, keySignature);
  return notes.map((n, noteIndex) => {
    const durStr = `${n.duration}${n.dotted ? 'd' : ''}${n.isRest ? 'r' : ''}`;
    const restKey = REST_ANCHOR_KEY[clef] || 'b/4';
    const keyStrings = n.isRest ? [restKey] : n.keys.map((tone) => tone.key);
    // autoStem — 符尾の向きは「第3線より上なら下向き、下なら上向き」で決まる
    // (和音は中央線からいちばん遠い音で決める)。VexFlow の StaveNote は指定が
    // なければ常に上向きにしてしまうので、明示的に自動判定を有効にする。連桁で
    // つながれた音符はこのあと群単位で向きが揃えられる(buildBeams参照)。
    const vfNote = new StaveNote({
      keys: keyStrings, duration: durStr, clef, autoStem: true,
    });
    if (n.dotted) Dot.buildAndAttach([vfNote], { all: true });
    if (!n.isRest) {
      (accidentals[noteIndex] || []).forEach((acc, i) => {
        if (acc) vfNote.addModifier(new Accidental(acc), i);
      });
    }
    if (n.selected) {
      // Highlight only the specific notehead selected within a chord, not
      // every pitch the note carries.
      const idx = n.selectedKeyIndex != null ? n.selectedKeyIndex : 0;
      if (n.isRest) {
        vfNote.setStyle({ fillStyle: '#1a73e8', strokeStyle: '#1a73e8' });
      } else {
        vfNote.setKeyStyle(idx, { fillStyle: '#1a73e8', strokeStyle: '#1a73e8' });
      }
    } else if (n.isRest && n.isPlaceholder) {
      vfNote.setStyle({ fillStyle: PLACEHOLDER_COLOR, strokeStyle: PLACEHOLDER_COLOR });
    }
    // Ctrl/Cmd+click multi-selection (see app.js's multiSelected) — a
    // distinct color from the single "active" selection above so both can be
    // told apart when a tone happens to be both. When every tone of a chord
    // is selected together (double-click — see onPageDoubleClick — or manual
    // Ctrl+click of each one), it reads as "this whole chord as one unit",
    // so it gets the same purple as a note-range selection instead of the
    // plain per-tone green.
    if (n.multiSelectedKeyIndices && n.multiSelectedKeyIndices.length) {
      const wholeChord = !n.isRest && n.multiSelectedKeyIndices.length === n.keys.length;
      const color = wholeChord ? '#9c27b0' : '#1e8e3e';
      n.multiSelectedKeyIndices.forEach((idx) => {
        if (n.isRest) {
          vfNote.setStyle({ fillStyle: color, strokeStyle: color });
        } else {
          vfNote.setKeyStyle(idx, { fillStyle: color, strokeStyle: color });
        }
      });
    }
    // Horizontal-drag note-range selection (see app.js's noteRangeSelection)
    // — a whole note (every tone of a chord together) is the unit, so every
    // key gets the same highlight rather than picking one like n.selected.
    if (n.rangeSelected) {
      if (n.isRest) {
        vfNote.setStyle({ fillStyle: '#9c27b0', strokeStyle: '#9c27b0' });
      } else {
        n.keys.forEach((_, idx) => vfNote.setKeyStyle(idx, { fillStyle: '#9c27b0', strokeStyle: '#9c27b0' }));
      }
    }
    // Manual stem flip. VexFlow picks a direction from the note's position on
    // the staff, which is right most of the time but not always — in a passage
    // that reads as two voices, or where a beam would collide with something,
    // the engraver overrides it. null means "leave it to VexFlow".
    if (!n.isRest && (n.stemDirection === 1 || n.stemDirection === -1)) {
      vfNote.setStemDirection(n.stemDirection);
    }
    return { vfNote, noteRef: n };
  });
}

// 音符そのものではなく音符に「付く」記号 — アーティキュレーション、運指、
// 強弱記号 — を後から取り付ける。
//
// アーティキュレーションの上下は符尾の向きから決まる(script.scm の
// side-relative-direction、addArticulationModifier 参照)。符尾の向きは連桁を
// 組んだ時点で群ごとに揃えられて初めて確定するので、この処理は buildBeams の
// あとでなければならない。
function attachNoteModifiers(built) {
  built.forEach(({ vfNote, noteRef: n }) => {
    if (!n) return;
    if (n.articulation) {
      addArticulationModifier(vfNote, n.articulation);
    }
    // 運指(fingering)。LilyPond の Fingering は fingeringOrientations の既定が
    // '(up down) で、まず上を試すので、既定は音符の上、必要なら下に回せる。
    //
    // VexFlow の FretHandFinger はタブ譜向けで、上下に置いても符頭から7pxしか
    // 離れず符頭や符尾に重なってしまうので使わない。Annotation は符尾の向きを
    // 見て符尾の先の外側に置いてくれるので、そちらに小さな数字として載せる。
    if (!n.isRest && n.fingering) {
      const finger = new Annotation(String(n.fingering));
      finger.setFont('Times New Roman, serif', 11, '', '');
      finger.setVerticalJustification(
        n.fingeringBelow ? AnnotationVerticalJustify.BOTTOM : AnnotationVerticalJustify.TOP,
      );
      vfNote.addModifier(finger, 0);
    }
    // 強弱記号は音符に貼りつけるのではなく、段ごとに高さを揃えて別に描く
    // (LilyPond の DynamicLineSpanner と同じ考えかた)。renderScore の
    // 「強弱記号の行」を参照。
  });
}

// 強弱記号を1段ぶんまとめて描く。
//
// LilyPond は同じ段の強弱記号を DynamicLineSpanner という1本の線の上に載せて
// 高さを揃える — 音符の高さにつられて記号が上下すると読み取りにくいからで、
// 印刷譜もそうなっている。音符ごとの修飾として描くと VexFlow は音符の高さから
// 位置を決めてしまうので、ここで段単位に描く(歌詞の行と同じやりかた)。
function drawDynamicsRow(ctx, entries, y) {
  ctx.save();
  entries.forEach(({ x, text }) => {
    const glyph = dynamicGlyphText(text);
    if (glyph) ctx.setFont(Metrics.get('fontFamily'), Metrics.get('fontSize'), '', '');
    else ctx.setFont('Times New Roman, serif', 13, 'bold', 'italic');
    ctx.fillText(glyph || text, x, y);
  });
  ctx.restore();
}

// 1小節ぶん(1パート)の連桁を組む。どの音符とどの音符をつなぐかの規則は
// beamGroups.js(LilyPond の拍子ごとの連桁規則の移植)が決め、ここはその結果を
// VexFlow の Beam に変換するだけ。
//
// VexFlow 自身の Beam.generateBeams は拍子を知らず、常に4分音符ぶん(8分音符
// 2つずつ)で区切ってしまうので使わない。
function buildBeams(built, timeSig) {
  const notes = built.map((b) => b.noteRef).filter(Boolean);
  if (notes.length !== built.length) return []; // 空小節の代替全休符だけの並び
  return beamGroupsForMeasure(notes, timeSig).map((indices) => {
    const vfNotes = indices.map((i) => built[i].vfNote);
    // 群の中で符尾の向きは揃える。利用者が手で向きを指定した音符が
    // ひとつでもあればそれを群全体に適用し、なければ自動判定に任せる。
    const forced = indices
      .map((i) => built[i].noteRef.stemDirection)
      .find((d) => d === 1 || d === -1);
    if (forced) {
      vfNotes.forEach((vf) => vf.setStemDirection(forced));
      return new Beam(vfNotes);
    }
    return new Beam(vfNotes, true);
  });
}

// 連符の括弧と数字の置きかた(LilyPond の TupletBracket)。
//   ・向きは符尾の側 (direction は符尾に従う)
//   ・連桁でつながっている群には括弧を書かず数字だけにする
//     (bracket-visibility の既定 #'if-no-beam)
// 連桁を作ったあとでないと hasBeam() が確定しないので、描画直前に呼ぶ。
function applyTupletPlacement(tuplets) {
  tuplets.forEach((tuplet) => {
    const notes = tuplet.getNotes();
    const down = notes.filter((vf) => vf.getStemDirection() === Stem.DOWN).length;
    tuplet.setTupletLocation(down > notes.length / 2 ? Tuplet.LOCATION_BOTTOM : Tuplet.LOCATION_TOP);
    tuplet.setBracketed(notes.some((vf) => !vf.hasBeam()));
  });
}

function applyBarlines(stave, measure) {
  if (measure.repeatStart) stave.setBegBarType(BarlineType.REPEAT_BEGIN);
  if (measure.repeatEnd) {
    stave.setEndBarType(BarlineType.REPEAT_END);
  } else if (measure.barlineEnd === 'double') {
    stave.setEndBarType(BarlineType.DOUBLE);
  } else if (measure.barlineEnd === 'final') {
    stave.setEndBarType(BarlineType.END);
  }
}

// Groups consecutive notes sharing the same tupletId into VexFlow Tuplet
// brackets, sized (notesOccupied) from each note's own tupletCount so 3/5/7
// tuplets each get their conventional ratio (3-in-2, 5-in-4, 7-in-4).
function buildTuplets(built) {
  const tuplets = [];
  let i = 0;
  while (i < built.length) {
    const id = built[i].noteRef && built[i].noteRef.tupletId;
    if (!id) { i += 1; continue; }
    let j = i;
    while (j < built.length && built[j].noteRef && built[j].noteRef.tupletId === id) j += 1;
    const group = built.slice(i, j);
    const count = group[0].noteRef.tupletCount || 3;
    tuplets.push({ notes: group.map((b) => b.vfNote), notesOccupied: tupletNotesOccupied(count) });
    i = j;
  }
  return tuplets;
}

// A hairpin (StaveHairpin) can't have a missing endpoint the way StaveTie/
// Curve can, so a hairpin that crosses a system break is drawn by hand as two
// independent wedges: one from the real note out to its own stave's edge,
// one from the other stave's edge in to the real note. Mirrors
// StaveHairpin's own renderHairpin() geometry (see vexflow/src/stavehairpin.js).
function drawPartialHairpin(ctx, note, kind, isOutgoing) {
  const stave = note.checkStave();
  const height = 10;
  const y = stave.getY() + stave.getHeight() + 20;
  const noteX = note.getAbsoluteX();
  const edgeX = isOutgoing ? stave.getTieEndX() : stave.getTieStartX();
  const firstX = isOutgoing ? noteX : edgeX;
  const lastX = isOutgoing ? edgeX : noteX;
  ctx.beginPath();
  if (kind === 'cresc') {
    ctx.moveTo(lastX, y);
    ctx.lineTo(firstX, y + height / 2);
    ctx.lineTo(lastX, y + height);
  } else {
    ctx.moveTo(firstX, y);
    ctx.lineTo(lastX, y + height / 2);
    ctx.lineTo(firstX, y + height);
  }
  ctx.stroke();
  ctx.closePath();
}

// VexFlow has no dedicated Glissando modifier (only StaveTie/Curve/
// StaveHairpin), so a グリッサンド is drawn by hand as a straight line
// between two noteheads plus a small "gliss." label — same free-hand
// approach as drawPartialHairpin above.
function noteHeadPosition(vfNote, keyIndex) {
  const ys = vfNote.getYs();
  const xs = vfNote.noteHeads ? vfNote.noteHeads.map((nh) => nh.getAbsoluteX()) : null;
  const y = ys[keyIndex] !== undefined ? ys[keyIndex] : ys[0];
  const x = xs && xs[keyIndex] !== undefined ? xs[keyIndex] : vfNote.getAbsoluteX();
  return { x, y };
}

function drawGlissandoLine(ctx, a, b) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.closePath();
  // setFont は (family, size, weight, style) — 4番目がイタリック。
  ctx.setFont('Times New Roman, serif', 10, '', 'italic');
  ctx.fillText('gliss.', (a.x + b.x) / 2 - 10, (a.y + b.y) / 2 - 4);
  ctx.restore();
}

// A link crossing a system break has no note to draw the second endpoint
// from — same problem drawPartialHairpin solves for hairpins — so it's split
// into two segments, each running from the real note out to its own stave's
// edge.
function drawPartialGlissando(ctx, vfNote, keyIndex, isOutgoing) {
  const stave = vfNote.checkStave();
  const { x, y } = noteHeadPosition(vfNote, keyIndex);
  const edgeX = isOutgoing ? stave.getTieEndX() : stave.getTieStartX();
  const notePoint = { x, y };
  const edgePoint = { x: edgeX, y };
  drawGlissandoLine(ctx, isOutgoing ? notePoint : edgePoint, isOutgoing ? edgePoint : notePoint);
}

const MARK_BOX_HEIGHT = 15;
const MARK_BOX_PAD_X = 5;
const MARK_BOX_GAP = 4;

// VexFlow's render context has no rect()/strokeRect() primitive (only path
// commands), so a bordered box is drawn as four lines — same technique
// already used for hairpins above.
function strokeBox(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.stroke();
}

// 4/4 and 2/2 can each be shown either as digits or as their traditional
// symbol (common time "C" / alla breve "C|", both built into VexFlow's own
// TimeSignature glyph set) — score.timeSigDisplay is the user's toggle (see
// onPageMouseDown's timeSigHitMap click handling), and only actually changes
// anything for those two specific signatures; anything else has no symbol
// form and always shows as digits regardless of the toggle's state.
function timeSigGlyph(score) {
  if (score.timeSigDisplay !== 'symbol') return score.timeSig;
  if (score.timeSig === '4/4') return 'C';
  if (score.timeSig === '2/2') return 'C|';
  return score.timeSig;
}

function textWidthAt(ctx, text, size) {
  ctx.save();
  ctx.setFont('Arial', size, '');
  const w = ctx.measureText(text).width;
  ctx.restore();
  return w;
}

// A リハーサル/レジストレーション mark is a small bordered box (e.g. "Intro",
// "M3") centered over the note it's attached to.
function drawMarkBox(ctx, text, centerX, boxY) {
  const width = textWidthAt(ctx, text, 9) + MARK_BOX_PAD_X * 2;
  const boxX = centerX - width / 2;
  ctx.save();
  ctx.setFont('Arial', 9, '');
  strokeBox(ctx, boxX, boxY, width, MARK_BOX_HEIGHT);
  ctx.fillText(text, boxX + MARK_BOX_PAD_X, boxY + MARK_BOX_HEIGHT - 4);
  ctx.restore();
  return { x0: boxX, x1: boxX + width };
}

// 反復記号(セーニョ/コーダ/To Coda/D.C./D.S./Fine)を1小節ぶん描く。
//
// 置きかたは記号の意味で決まる:
//   ・セーニョとコーダは「戻ってくる/飛んでくる先」の目印なので小節の頭
//   ・To Coda・D.C.・D.S.・Fine は「ここまで来たらこうする」という指示なので
//     小節の終わり
//
// セーニョ(𝄋)とコーダ(𝄌)は文字ではなく記号なので音楽フォントの字形で描き、
// 添える語(Coda / to / D.C. / D.S. / Fine)は欧文で描く。1つの表示が
// 「記号」と「語」の2片に分かれることがある(𝄌 Coda、to 𝄌)ので、片ごとに
// フォントを持たせて左から並べる。
const REPEAT_MARKER_PARTS = {
  Segno: [{ text: SEGNO_GLYPH, glyph: true }],
  Coda: [{ text: CODA_GLYPH, glyph: true }, { text: ' Coda', glyph: false, upright: true }],
  'To Coda': [{ text: 'to ', glyph: false, upright: true }, { text: CODA_GLYPH, glyph: true }],
};
// 小節の頭に置く記号 — 飛んでくる先を指すもの。
const REPEAT_MARKERS_AT_START = new Set(['Segno', 'Coda']);

const MARKER_GLYPH_SIZE = 20;
const MARKER_TEXT_SIZE = 13;
// 記号と語のあいだの隙間(px)。空白文字だけでは詰まって見える。
const MARKER_PART_GAP = 3;

function drawRepeatMarker(ctx, marker, x, measureWidth, baselineY) {
  const parts = REPEAT_MARKER_PARTS[marker] || [{ text: marker, glyph: false }];
  const musicFont = Metrics.get('fontFamily');
  const setPartFont = (part) => {
    if (part.glyph) ctx.setFont(musicFont, MARKER_GLYPH_SIZE, '', '');
    // 語のうち Coda / to は記号に添える名前なので立体、D.C./D.S./Fine は
    // 演奏の指示語なのでイタリック(印刷譜の慣習)。
    else if (part.upright) ctx.setFont('Times New Roman, serif', MARKER_TEXT_SIZE, 'bold', '');
    else ctx.setFont('Times New Roman, serif', MARKER_TEXT_SIZE, 'bold', 'italic');
  };

  ctx.save();
  const widths = parts.map((part) => { setPartFont(part); return ctx.measureText(part.text).width; });
  const total = widths.reduce((a, b) => a + b, 0) + MARKER_PART_GAP * (parts.length - 1);
  let cursorX = REPEAT_MARKERS_AT_START.has(marker) ? x + 4 : x + measureWidth - total - 4;
  parts.forEach((part, i) => {
    setPartFont(part);
    ctx.fillText(part.text, cursorX, baselineY);
    cursorX += widths[i] + MARKER_PART_GAP;
  });
  ctx.restore();
}

// Finds whichever part has a note starting exactly at `beat` (within float
// epsilon) in this measure — used to anchor a リハーサル/レジストレーション
// mark's x position, since marks.beat is shared across parts/chord-tones
// rather than tied to one specific note (see findOrCreateMark in app.js).
function findAnchorForBeat(measure, notesHitByPart, beat) {
  for (let i = 0; i < PARTS.length; i += 1) {
    const part = PARTS[i];
    const notes = measure[part] || [];
    const hits = notesHitByPart[part] || [];
    let cursor = 0;
    for (let j = 0; j < notes.length; j += 1) {
      const start = cursor;
      cursor += noteBeats(notes[j]);
      if (Math.abs(start - beat) < 1e-6 && hits[j]) {
        const hit = hits[j];
        return { x: hit.xs ? Math.min(...hit.xs) : hit.x, part, note: hit.noteRef };
      }
    }
  }
  return null;
}

// Height reserved for 1番括弧/2番括弧 etc. above the chord/リハーサル/
// レジストレーション band — only added to a system's own slot when the score
// actually has one (see hasVolta in renderScore).
const VOLTA_BAND_HEIGHT = 20;

// n番括弧 (repeat-ending brackets) — measure.volta = { number } marks the
// measure carrying a bracket labelled "N.".
//
// Drawn as a 鉤括弧: a downward tick at the left, then a horizontal line to
// the end of the measure, with NO closing tick on the right. One bracket
// covers exactly one measure and is set on a single selected measure (see
// app.js's volta controls).
function drawVoltaBrackets(ctx, score, measureIndices, measureColumns, lineY) {
  const y = lineY + 4;
  const tickHeight = 7;
  measureIndices.forEach((m) => {
    const measure = score.measures[m];
    if (!measure.volta) return;
    const col = measureColumns[m];
    if (!col) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(col.x, y + tickHeight);
    ctx.lineTo(col.x, y);
    ctx.lineTo(col.x + col.width, y);
    ctx.stroke();
    ctx.setFont('Arial', 11, '');
    ctx.fillText(`${measure.volta.number}.`, col.x + 4, y + 11);
    ctx.restore();
  });
}

// Draws this measure's per-note/per-beat annotations once every part's note
// x positions are known (notesHitByPart, built right after each stave's
// notes/hitMap in renderScore): コード, リハーサル, and レジストレーション all
// share one row (the slot the measure number used to occupy), in that
// priority order — コード never moves, then リハーサル nudges right of any
// コード it would overlap, then レジストレーション nudges right of both.
function drawPerNoteMarks({
  ctx, page, measureIndex, measure, notesHitByPart, boxY, markHitMap, showChordSymbols,
  keySignature,
}) {
  const shiftPast = (centerX, width, placed) => {
    let cx = centerX;
    placed.forEach((r) => {
      const boxX = cx - width / 2;
      const overlaps = boxX < r.x1 + MARK_BOX_GAP && boxX + width > r.x0 - MARK_BOX_GAP;
      if (overlaps) cx = r.x1 + MARK_BOX_GAP + width / 2;
    });
    return cx;
  };

  // A 上鍵盤 note with enough ledger lines can reach up as high as the mark
  // band itself — those notes always keep their position/spelling, so a mark
  // that would land on top of one shifts sideways instead (same shiftPast
  // mechanism used for two marks that would otherwise collide with each
  // other). Only 上鍵盤 is checked: 下鍵盤/ペダル sit further down the system,
  // well clear of this band regardless of how high their own notes reach.
  const bandBottomY = boxY + MARK_BOX_HEIGHT + 3;
  const upperNoteObstacles = (notesHitByPart.upper || [])
    .filter((hit) => hit.noteRef && !hit.noteRef.isRest && Math.min(...(hit.ys || [hit.y])) <= bandBottomY)
    .map((hit) => {
      const xs = hit.xs || [hit.x];
      return { x0: Math.min(...xs) - 4, x1: Math.max(...xs) + 4 };
    });

  const placedChord = [...upperNoteObstacles];
  (notesHitByPart.lower || []).forEach((entry) => {
    if (!showChordSymbols) return;
    const note = entry.noteRef;
    if (!note || note.isRest || !note.chord) return;
    const x = entry.xs ? Math.min(...entry.xs) : entry.x;
    const y = boxY + MARK_BOX_HEIGHT - 4;
    ctx.save();
    ctx.setFont('Arial', 10, '');
    // A tentative auto-detected chord (more than one equally-valid reading,
    // e.g. a symmetric dim7) prints in orange — click it to pick from the
    // real candidates instead of the free-form editor.
    if (note.chordTentative) ctx.setFillStyle(PLACEHOLDER_COLOR);
    // 綴りは楽譜の調号に合わせて読み替えて書く(ヘ長調なら A# ではなく Bb)。
    const chordText = displayChordSymbol(note.chord, keySignature);
    ctx.fillText(chordText, x, y);
    ctx.restore();
    const w = textWidthAt(ctx, chordText, 10);
    const x0 = x - 2;
    const x1 = x + w + 2;
    markHitMap.push({
      page, measureIndex, part: 'lower', noteId: note.id, kind: 'chord', x0, x1, y0: boxY, y1: boxY + MARK_BOX_HEIGHT,
    });
    placedChord.push({ x0, x1 });
  });

  const placedRehearsal = [];
  (measure.marks || []).forEach((mark) => {
    if (!mark.rehearsal) return;
    const anchor = findAnchorForBeat(measure, notesHitByPart, mark.beat);
    if (!anchor) return;
    const width = textWidthAt(ctx, mark.rehearsal, 9) + MARK_BOX_PAD_X * 2;
    const centerX = shiftPast(anchor.x, width, placedChord);
    const { x0, x1 } = drawMarkBox(ctx, mark.rehearsal, centerX, boxY);
    markHitMap.push({
      page, measureIndex, part: anchor.part, noteId: anchor.note.id, kind: 'rehearsal', x0, x1, y0: boxY, y1: boxY + MARK_BOX_HEIGHT,
    });
    placedRehearsal.push({ x0, x1 });
  });

  (measure.marks || []).forEach((mark) => {
    if (!mark.registration) return;
    const anchor = findAnchorForBeat(measure, notesHitByPart, mark.beat);
    if (!anchor) return;
    const width = textWidthAt(ctx, mark.registration, 9) + MARK_BOX_PAD_X * 2;
    const centerX = shiftPast(anchor.x, width, [...placedChord, ...placedRehearsal]);
    const { x0, x1 } = drawMarkBox(ctx, mark.registration, centerX, boxY);
    markHitMap.push({
      page, measureIndex, part: anchor.part, noteId: anchor.note.id, kind: 'registration', x0, x1, y0: boxY, y1: boxY + MARK_BOX_HEIGHT,
    });
  });
}

// Renders the whole score into `container` as one or more page divs.
// Returns hit-test maps used to translate mouse clicks into (part, measure,
// pitch) for notes, into (measureIndex) for the measure-number label, and
// into (measureIndex, part, noteId, kind) for the per-note chord/リハーサル/
// レジストレーション boxes (see drawPerNoteMarks).
export function renderScore(container, score, layout = LAYOUT) {
  container.innerHTML = '';
  const hitMap = [];
  const annotationHitMap = [];
  const markHitMap = [];
  const timeSigHitMap = [];
  const pages = [];

  const {
    pageWidth, pageHeight, pageMargin, topMargin,
    rehearsalBandHeight, measureNumberHeight, clefExtraWidth, timeSigExtraWidth, titleHeaderHeight,
  } = layout;
  // Widened beyond layout's own default when a 上鍵盤 note's ledger lines
  // reaching down would otherwise collide with a 下鍵盤 note's reaching up
  // (or the same for 下鍵盤/ペダル) — see computeRequiredStaveGap. Applied
  // uniformly to every system in the score, never just the offending one.
  // 形式タブの縦スライダー(score.systemHeightScale)で3段セットの高さを縮める/
  // 広げる。縮めれば1ページに入る段数が増える。ただし加線や譜表の下の記号が
  // ぶつかる分は computeRequiredStaveGap が押し戻すので、譜面が壊れるほどは
  // 詰まらない。
  const heightScale = score.systemHeightScale || 1;
  const scaledStaveGap = Math.round(layout.staveGap * heightScale);
  const staveGapInfo = computeRequiredStaveGap(score, scaledStaveGap);
  const staveGap = staveGapInfo.gap;
  // 段と段の間隔も縦スライダーで一緒に伸び縮みさせる。譜表だけ詰めて段の
  // あいだが空いたままだと、詰めたぶんが段数に結びつかない。
  const systemGap = Math.round(layout.systemGap * heightScale);
  // 1番括弧/2番括弧 etc. (see drawVoltaBrackets) need their own row above the
  // existing chord/リハーサル/レジストレーション band — reserved only when the
  // score actually uses one, so scores that don't stay exactly as tight to
  // the clef as they were tuned to be (see rehearsalBandHeight's own
  // comment).
  const hasVolta = score.measures.some((m) => m.volta);
  const voltaOffset = hasVolta ? VOLTA_BAND_HEIGHT : 0;


  const lines = computeLines(score, layout);
  const totalLines = lines.length;

  // 1ページに何段(上鍵盤・下鍵盤・ペダルの3段で1セット＝1段落)入るか。
  //
  // 1ページ目だけは曲名・作詞・作曲の欄が上を占めるので、その分だけ入る数が
  // 少ない。2ページ目以降はその欄がなく縦に余裕があるので、段と段の間隔を
  // 詰めればもう1セット入る — 入るなら入れる、詰めても入らないなら1ページ目と
  // 同じ数のままにして、はみ出させない。
  //
  // staveGap は楽譜中のいちばん長い加線に合わせて広がる(computeRequiredStaveGap)
  // ので、段の高さは楽譜ごとに変わる。段数を決め打ちにせず毎回この計算をする。
  //
  // systemInkHeight は1段が実際に紙を占める高さ — マーク帯の上端から
  // ペダル譜表の下線まで。上鍵盤の譜表が持つ上の余白(STAVE_HEADROOM_PX)と
  // ペダル譜表そのものの高さ(STAVE_HEIGHT_PX)まで含めるのが肝心で、ここを
  // 落とすと段どうしが重なり、最後の段は下の余白へせり出してページ番号と重なる。
  const systemInkHeight = voltaOffset + rehearsalBandHeight
    + STAVE_HEADROOM_PX + staveGap * 2 + STAVE_HEIGHT_PX;
  const firstPageUsable = pageHeight - topMargin - titleHeaderHeight - pageMargin;
  const laterPageUsable = pageHeight - topMargin - pageMargin;

  // ペダル譜の下線から次の段の最上端までにあけたい間隔(px)。ここに入るのは
  // 小節番号、ペダルの強弱記号、ペダルの歌詞。最後の段ではページ下端の余白に
  // なるので、この幅が確保されているかぎりページ番号とも重ならない。
  const minSystemGap = Math.max(
    BOTTOM_LINE_Y_OFFSET + 4 + measureNumberHeight + 8,
    staveGapInfo.pedalBelowPx + BOTTOM_LINE_Y_OFFSET + 8,
  );

  const firstPageLines = Math.max(1, Math.min(
    layout.linesPerPage,
    Math.floor(firstPageUsable / (systemInkHeight + systemGap)),
  ));
  const wantedLaterLines = firstPageLines + layout.extraLinesAfterFirstPage;
  const gapForWantedLater = Math.floor(laterPageUsable / wantedLaterLines) - systemInkHeight;
  const laterPageLines = gapForWantedLater >= minSystemGap ? wantedLaterLines : firstPageLines;

  const pageCapacity = (page) => (page === 0 ? firstPageLines : laterPageLines);
  // その枚数の段でページを満たすときの段間。詰まりすぎない範囲で、余った縦の
  // 余白を段の間に配る(LilyPond の垂直スペーシングと同じ考えかた)。
  const pageSystemGap = (page) => {
    const usable = page === 0 ? firstPageUsable : laterPageUsable;
    const fitted = Math.floor(usable / pageCapacity(page)) - systemInkHeight;
    return Math.max(minSystemGap, Math.min(systemGap, fitted));
  };

  const totalPages = totalLines <= firstPageLines
    ? 1
    : 1 + Math.ceil((totalLines - firstPageLines) / laterPageLines);
  // 段番号 → そのページの先頭段番号。ページごとに入る段数が違うので
  // 単純な割り算では出せない。
  const pageLineStart = (page) => (page === 0 ? 0 : firstPageLines + (page - 1) * laterPageLines);

  // Cross-measure connectors (ties/slurs/hairpins) are built as soon as both
  // endpoints are known, but only drawn in a final pass once every stave on
  // every page has been formatted (so absolute note positions are final). A
  // pending mark whose `line` doesn't match the line it resolves on crossed a
  // system break, and is split into two independently-anchored halves.
  // Tie is tracked per part *and per pitch* (a Map keyed by pitchId), since
  // it can only ever connect to the next same-pitch note and each tone in a
  // chord can carry its own independent tie. Slur is an explicit
  // { noteId, pitchKey } link (see app.js's toggleSlurFromSelectedTone) since
  // it can connect any two pitches, not just adjacent identical ones —
  // slurLinks below is resolved once every note's vfNote is known
  // (builtByNoteId), after the per-line loop finishes.
  const deferredMarks = [];
  const pendingTie = {}; // part -> Map<pitchId, { vfNote, keyIndex, line, ctx }>
  const pendingHairpin = {}; // part -> { vfNote, line, ctx, kind } (hairpins stay whole-note)
  const builtByNoteId = new Map(); // noteId -> { vfNote, line, ctx, part }
  // 段をまたぐ 8va/8vb 括弧を段ごとに切って描くために、パート×段ごとの
  // いちばん左/右の音符を覚えておく(下の ottavaLinks の描画で使う)。
  const lineEdgeNotes = new Map(); // "part|line" -> { first, last }

  const noteById = new Map();
  const partByNoteId = new Map();
  score.measures.forEach((measure) => {
    PARTS.forEach((part) => {
      measure[part].forEach((n) => {
        noteById.set(n.id, n);
        partByNoteId.set(n.id, part);
      });
    });
  });
  const slurLinks = [];
  noteById.forEach((n) => {
    if (n.isRest) return;
    n.keys.forEach((tone, keyIndex) => {
      if (!tone.slurTo) return;
      const targetNote = noteById.get(tone.slurTo.noteId);
      const targetKeyIndex = targetNote && targetNote.keys.findIndex(
        (t) => pitchId(t.key) === tone.slurTo.pitchKey,
      );
      if (!targetNote || targetKeyIndex === -1) return; // dangling — target note/pitch no longer exists
      slurLinks.push({
        from: { noteId: n.id, keyIndex }, to: { noteId: tone.slurTo.noteId, keyIndex: targetKeyIndex },
      });
    });
  });
  const glissandoLinks = [];
  noteById.forEach((n) => {
    if (n.isRest) return;
    n.keys.forEach((tone, keyIndex) => {
      if (!tone.glissandoTo) return;
      const targetNote = noteById.get(tone.glissandoTo.noteId);
      const targetKeyIndex = targetNote && targetNote.keys.findIndex(
        (t) => pitchId(t.key) === tone.glissandoTo.pitchKey,
      );
      if (!targetNote || targetKeyIndex === -1) return; // dangling — target note/pitch no longer exists
      glissandoLinks.push({
        from: { noteId: n.id, keyIndex }, to: { noteId: tone.glissandoTo.noteId, keyIndex: targetKeyIndex },
      });
    });
  });
  // 8va / 8vb — an octave bracket over a passage. Unlike a tie or slur it isn't
  // per-tone visually (one bracket covers the whole run), so only the first
  // tone carrying the link is used.
  const ottavaLinks = [];
  noteById.forEach((n) => {
    if (n.isRest) return;
    const tone = n.keys.find((t) => t.ottavaTo);
    if (!tone) return;
    const targetNote = noteById.get(tone.ottavaTo.noteId);
    if (!targetNote) return; // dangling
    ottavaLinks.push({ fromId: n.id, toId: tone.ottavaTo.noteId, kind: tone.ottavaTo.kind });
  });

  for (let page = 0; page < totalPages; page++) {
    const pageTitleExtra = page === 0 ? titleHeaderHeight : 0;
    // Every page is exactly pageHeight (the A4-ratio height) — page 1's
    // title block eats into its own budget via pageTitleExtra shifting
    // lineY down, rather than growing the page taller and breaking its
    // proportions.
    const pageDivHeight = pageHeight;
    const pageDiv = document.createElement('div');
    pageDiv.className = 'score-page';
    pageDiv.style.width = `${pageWidth}px`;
    pageDiv.style.height = `${pageDivHeight}px`;
    container.appendChild(pageDiv);
    pages.push(pageDiv);

    const renderer = new Renderer(pageDiv, Renderer.Backends.SVG);
    renderer.resize(pageWidth, pageDivHeight);
    // VexFlow sizes the <svg> with plain width/height attributes, which pin
    // its contents to one fixed pixel size. Printing scales a page down to
    // real A4 (see style.css's @media print), and without a viewBox the
    // drawing inside would keep its original size and get clipped instead of
    // scaling with the element. Same numbers as the resize above, so this
    // changes nothing on screen.
    const svgEl = pageDiv.querySelector('svg');
    if (svgEl) {
      svgEl.setAttribute('viewBox', `0 0 ${pageWidth} ${pageDivHeight}`);
      svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    }
    const ctx = renderer.getContext();

    const lineStart = pageLineStart(page);
    const lineEnd = Math.min(totalLines, lineStart + pageCapacity(page));
    const thisPageSystemGap = pageSystemGap(page);

    for (let line = lineStart; line < lineEnd; line++) {
      const measureIndices = lines[line];
      const lineY = topMargin + pageTitleExtra
        + (line - lineStart) * (systemInkHeight + thisPageSystemGap);
      const staveTopY = lineY + voltaOffset + rehearsalBandHeight;
      const availableWidth = pageWidth - pageMargin * 2;
      const keySigWidth = keySignatureExtraWidth(score, layout);
      // The first column of every line carries a clef and key signature (and,
      // for the very first measure of the piece, the time signature too) —
      // give it extra width so that space doesn't eat into the notes' room
      // and push later measures (or measure 1's own notes) past the page edge.
      const firstColExtra = clefExtraWidth + keySigWidth + (measureIndices[0] === 0 ? timeSigExtraWidth : 0);
      const contentWidth = Math.max(20, availableWidth - firstColExtra);
      const widthScale = score.measureWidthScale || 1;
      const avgNoteCount = averageNoteCount(score);
      const nominalWidths = measureIndices.map(
        (m) => measureNominalWidth(score.measures[m], avgNoteCount, widthScale),
      );
      const totalNominal = nominalWidths.reduce((a, b) => a + b, 0) || 1;
      // Justify (stretch proportionally so the line's measures fill the full
      // width edge to edge, weighted by each measure's note-density) unless
      // this line is sparse enough that stretching it would look unnaturally
      // spread out — most often the piece's very last, partially-filled
      // system, which real notation software also leaves at natural width
      // instead of force-justifying.
      const justify = totalNominal >= contentWidth * 0.6;
      const widths = justify
        ? nominalWidths.map((w) => (w / totalNominal) * contentWidth)
        : nominalWidths;

      let colX = pageMargin;
      let linePedalStave = null;
      const lineStaves = { upper: null, lower: null, pedal: null };
      const measureColumns = {}; // measureIndex -> { x, width } — see drawVoltaBrackets
      // この段に出てくる強弱記号を集めておいて、小節を描き終えてから
      // パートごとに高さを揃えて描く(drawDynamicsRow)。
      const lineDynamics = { upper: [], lower: [], pedal: [] };
      measureIndices.forEach((m, colIndex) => {
        const isFirstOfLine = colIndex === 0;
        const measureWidth = isFirstOfLine ? widths[colIndex] + firstColExtra : widths[colIndex];
        const x = colX;
        colX += measureWidth;
        measureColumns[m] = { x, width: measureWidth };
        const measure = score.measures[m];

        const staves = {};
        PARTS.forEach((part, idx) => {
          const y = staveTopY + idx * staveGap;
          const stave = new Stave(x, y, measureWidth);
          if (isFirstOfLine) {
            stave.addClef(getClef(score, part));
            // Checked by accidental count, not by comparing to the literal
            // string 'C' — 'Am' (relative minor, also 0 accidentals) would
            // otherwise still call addKeySignature for no reason.
            if (score.keySignature && keySignatureAccidentalCount(score.keySignature) > 0) {
              stave.addKeySignature(score.keySignature);
            }
            if (m === 0) stave.addTimeSignature(timeSigGlyph(score));
          }
          applyBarlines(stave, measure);
          stave.setContext(ctx).draw();
          staves[part] = stave;
          if (m === 0) {
            // Click target for toggling 4/4↔C / 2/2↔¢ (see onPageMouseDown in
            // app.js) — captured on every part's own copy of the glyph so it
            // doesn't matter which staff the user clicks it on.
            const timeSigMod = stave.getModifiers().find((mod) => mod.getCategory() === 'TimeSignature');
            if (timeSigMod) {
              // Padded well past the glyph's own tight bounding box — a
              // numeral time signature in particular renders quite narrow,
              // making the un-padded box a fiddly target to click precisely.
              const bbox = timeSigMod.getBoundingBox();
              const TIME_SIG_HIT_PAD_X = 14;
              timeSigHitMap.push({
                page,
                measureIndex: m,
                part,
                x0: bbox.getX() - TIME_SIG_HIT_PAD_X,
                x1: bbox.getX() + bbox.getW() + TIME_SIG_HIT_PAD_X,
                y0: y - 20,
                y1: y + 60,
              });
            }
          }
        });
        linePedalStave = staves.pedal;
        lineStaves.upper = staves.upper;
        lineStaves.lower = staves.lower;
        lineStaves.pedal = staves.pedal;

        if (isFirstOfLine) {
          const brace = new StaveConnector(staves.upper, staves.pedal).setType('brace');
          brace.setContext(ctx).draw();
        }
        const leftLine = new StaveConnector(staves.upper, staves.pedal).setType('singleLeft');
        leftLine.setContext(ctx).draw();
        // 小節線は3段を貫いて引く。鍵盤楽譜では上鍵盤・下鍵盤・ペダルが
        // ひとつの組(大譜表)なので、小節の区切りは組全体を縦に貫くのが決まり。
        //
        // 各譜表が自前で引く小節線は譜表の中で切れてしまうので、譜表と譜表の
        // あいだも同じ形でつなぐ。ふつうの小節線は次の小節の singleLeft が
        // つないでくれるが、複縦線・終止線・リピートは形が違うので、その小節の
        // 右端に同じ形の連結線を引く。段の最後の小節には次の小節が来ないので、
        // ふつうの小節線もここで引く。
        const endConnectorType = (() => {
          if (measure.repeatEnd) return 'boldDoubleRight';
          if (measure.barlineEnd === 'final') return 'boldDoubleRight';
          if (measure.barlineEnd === 'double') return 'thinDouble';
          return colIndex === measureIndices.length - 1 ? 'singleRight' : null;
        })();
        if (endConnectorType) {
          new StaveConnector(staves.upper, staves.pedal)
            .setType(endConnectorType).setContext(ctx).draw();
        }
        if (measure.repeatStart) {
          new StaveConnector(staves.upper, staves.pedal)
            .setType('boldDoubleLeft').setContext(ctx).draw();
        }

        // セーニョ/コーダ/D.C./D.S./Fine — コード行と同じ帯に、記号の意味に応じて
        // 小節の頭または終わりに寄せて描く(drawRepeatMarker)。
        if (measure.marker) {
          drawRepeatMarker(
            ctx, measure.marker, x, measureWidth,
            lineY + voltaOffset + 2 + MARK_BOX_HEIGHT - 4,
          );
        }

        // Measure number now sits just below the pedal (bass) stave rather
        // than above the system — see style.css's .measure-number-label.
        // Its click/hit region is sized to the digit itself (not the whole
        // measure width) so it doesn't swallow clicks meant for the stave.
        const numberText = String(m + 1);
        const numberWidth = textWidthAt(ctx, numberText, 10);
        const numberY0 = staves.pedal.getBottomLineY() + 4;
        annotationHitMap.push({
          page,
          measureIndex: m,
          x0: x,
          x1: x + numberWidth + 6,
          numberY0,
          numberY1: numberY0 + measureNumberHeight,
        });

        const notesHitByPart = {};
        PARTS.forEach((part) => {
          const stave = staves[part];
          const clef = getClef(score, part);
          const built = buildStaveNotes(measure, part, clef, score.keySignature);
          const vfNotes = built.map((b) => b.vfNote);
          // Tuplets must be built before the Voice/Formatter run: creating a
          // Tuplet immediately applies the tick-multiplier to its notes so
          // spacing accounts for the shortened duration.
          const tuplets = buildTuplets(built).map(
            (g) => new Tuplet(g.notes, { notesOccupied: g.notesOccupied }),
          );
          // 連桁は拍子に沿って組む(buildBeams)。ここで群ごとに符尾の向きが
          // 確定するので、符尾の向きに依存するアーティキュレーションの取り付けと
          // 連符の括弧の向き/有無の判定はそのあとで行う。
          const beams = buildBeams(built, score.timeSig);
          attachNoteModifiers(built);
          applyTupletPlacement(tuplets);

          // VexFlow 5's VoiceTime keys are numBeats/beatValue (camelCase) —
          // the snake_case spelling this used to pass was dropped silently by
          // the Object.assign in Voice's constructor, leaving every voice at
          // the default 4/4 no matter what the score's time signature or
          // pickup length actually was.
          //
          // measureCapacity is in quarter notes and can be fractional (3/8 =
          // 1.5, a half-beat pickup = 0.5), so it's expressed in 32nd notes
          // here to keep numBeats a whole number: 4 quarters -> 32/32.
          const voice = new Voice({
            numBeats: measureCapacity(score, m) * 8, beatValue: 32,
          });
          voice.setStrict(false);
          voice.addTickables(vfNotes);
          // Formatter stretches whatever ticks are present across the full
          // target width — for a measure that isn't completely filled yet
          // (still being edited, or a short tuplet figure) that would drag
          // notes apart into an exaggerated beam slant. Scale the target
          // width down to how full the measure actually is so sparse
          // content stays compact instead of being stretched to fill.
          const capacityBeats = measureCapacity(score, m);
          const usedBeats = built.reduce(
            (sum, b) => sum + (b.noteRef ? noteBeats(b.noteRef) : capacityBeats),
            0,
          );
          const fillRatio = capacityBeats > 0 ? Math.min(1, usedBeats / capacityBeats) : 1;
          // Formatter lays notes out starting at the stave's noteStartX,
          // which already sits past any clef/key/time signature — so the
          // width available to notes is always the plain per-measure column
          // width (widths[colIndex]), never measureWidth (which, for a
          // line's first measure, also includes that reserved clef/key/
          // time-sig room and would otherwise push notes past the measure's
          // right edge).
          const fullWidth = Math.max(widths[colIndex] - 20, 20);
          const targetWidth = Math.max(30, fullWidth * fillRatio);
          new Formatter().joinVoices([voice]).format([voice], targetWidth);
          voice.draw(ctx, stave);
          beams.forEach((b) => b.setContext(ctx).draw());
          tuplets.forEach((t) => t.setContext(ctx).draw());

          // Tie is matched *per pitch* (see pitchId) so a chord can have some
          // tones tie forward and others not, independently.
          pendingTie[part] = pendingTie[part] || new Map();

          const real = built.filter((b) => b.noteRef);
          real.forEach((b) => {
            const n = b.noteRef;
            builtByNoteId.set(n.id, {
              vfNote: b.vfNote, line, ctx, part,
            });
            if (!n.isRest) {
              const edgeKey = `${part}|${line}`;
              const edge = lineEdgeNotes.get(edgeKey);
              if (!edge) lineEdgeNotes.set(edgeKey, { first: b.vfNote, last: b.vfNote });
              else edge.last = b.vfNote;
            }

            // Hairpins stay a whole-note mark (not per-tone).
            if (n.hairpin === 'cresc-start' || n.hairpin === 'decresc-start') {
              pendingHairpin[part] = {
                vfNote: b.vfNote, line, ctx, kind: n.hairpin === 'cresc-start' ? 'cresc' : 'decresc',
              };
            } else if (n.hairpin === 'cresc-end' || n.hairpin === 'decresc-end') {
              const pend = pendingHairpin[part];
              if (pend) {
                if (pend.line === line) {
                  deferredMarks.push({
                    type: 'hairpin', a: pend.vfNote, b: b.vfNote, kind: pend.kind, ctx,
                  });
                } else {
                  deferredMarks.push({
                    type: 'hairpin-partial', note: pend.vfNote, kind: pend.kind, outgoing: true, ctx: pend.ctx,
                  });
                  deferredMarks.push({
                    type: 'hairpin-partial', note: b.vfNote, kind: pend.kind, outgoing: false, ctx,
                  });
                }
              }
              pendingHairpin[part] = undefined;
            }

            if (n.isRest) {
              // A genuine rest breaks tie continuity for every tone in this
              // part. An unfilled タイ/スラー placeholder, though, doesn't —
              // it may only ever be standing in for one tone of a chord
              // whose other tones tie across it to a later note (see
              // addPitchToSelectedNote's partialChordNote) — so leave
              // anything pending untouched and let it resolve once we reach
              // whatever note actually continues it.
              if (!n.isPlaceholder) pendingTie[part].clear();
              return;
            }

            // Every pitch this note actually carries. A tie may only ever
            // connect to the *immediately following* note, so once this note
            // has had its chance to receive them, any pitch still pending
            // that isn't one of these was left dangling by an edit (its
            // target got deleted, re-pitched, or had a note inserted in
            // front of it) and is dropped below rather than being carried
            // forward to hunt for a same-pitch note further down the piece.
            const pidsHere = new Set(n.keys.map((tone) => pitchId(tone.key)));

            n.keys.forEach((tone, ki) => {
              const pid = pitchId(tone.key);
              const incomingTie = pendingTie[part].get(pid);
              if (incomingTie) {
                if (incomingTie.line === line) {
                  deferredMarks.push({
                    type: 'tie', a: incomingTie.vfNote, b: b.vfNote, aIndex: incomingTie.keyIndex, bIndex: ki, ctx,
                  });
                } else {
                  deferredMarks.push({
                    type: 'tie', a: incomingTie.vfNote, b: null, aIndex: incomingTie.keyIndex, bIndex: ki, ctx: incomingTie.ctx,
                  });
                  deferredMarks.push({
                    type: 'tie', a: null, b: b.vfNote, aIndex: incomingTie.keyIndex, bIndex: ki, ctx,
                  });
                }
                pendingTie[part].delete(pid);
              }
              if (tone.tieToNext) {
                pendingTie[part].set(pid, { vfNote: b.vfNote, keyIndex: ki, line, ctx });
              }
            });

            // Drop the dangling ones (see pidsHere). Entries this very note
            // just added are all in pidsHere by construction, so they survive
            // to be matched against the *next* note.
            pendingTie[part].forEach((_, pid) => {
              if (!pidsHere.has(pid)) pendingTie[part].delete(pid);
            });
          });

          const topY = stave.getYForLine(0);
          const step = (stave.getYForLine(1) - stave.getYForLine(0)) / 2;

          const notesHit = real.map((b) => ({
            noteRef: b.noteRef,
            x: b.vfNote.getAbsoluteX(),
            ys: b.vfNote.getYs(),
            // Per-notehead x — when two chord tones are a step apart, VexFlow
            // shifts one sideways to avoid the noteheads overlapping (a
            // "seconds" collision), so a single note-wide x isn't accurate
            // enough to click-test each tone (see findClickedNote in app.js).
            xs: b.noteRef.isRest ? undefined : b.vfNote.noteHeads.map((nh) => nh.getAbsoluteX()),
          }));

          notesHit.forEach((hit) => {
            if (!hit.noteRef || !hit.noteRef.dynamic) return;
            lineDynamics[part].push({
              x: hit.xs ? Math.min(...hit.xs) : hit.x,
              text: hit.noteRef.dynamic,
            });
          });

          hitMap.push({
            part,
            measureIndex: m,
            page,
            x0: stave.getNoteStartX(),
            x1: x + measureWidth,
            topY,
            step,
            clef,
            notes: notesHit,
          });
          notesHitByPart[part] = notesHit;
        });

        drawPerNoteMarks({
          ctx,
          page,
          measureIndex: m,
          measure,
          notesHitByPart,
          boxY: lineY + voltaOffset + 2,
          markHitMap,
          showChordSymbols: score.showChordSymbols !== false,
          keySignature: score.keySignature,
        });
      });

      if (hasVolta) {
        drawVoltaBrackets(ctx, score, measureIndices, measureColumns, lineY);
      }

      // 小節番号(LilyPond の BarNumber)。既定では各段の先頭に、譜表の上へ小さく
      // 添える。曲の1小節目には付けない(break-visibility の既定
      // #end-of-line-invisible がそう振る舞う)。
      //
      // 画面上の .measure-number-label(app.js)は小節を選ぶためのクリック領域で、
      // 印刷時には消える編集用の部品なので、印刷される番号はここで譜面そのものに
      // 描く。
      if (line > 0 && measureIndices.length > 0) {
        ctx.save();
        ctx.setFont('Times New Roman, serif', 11, 'bold', '');
        ctx.fillText(String(measureIndices[0] + 1), pageMargin, staveTopY - 4);
        ctx.restore();
      }

      // 歌詞 — one line of text per system *per staff* (上鍵盤/下鍵盤/ペダル
      // each shown near their own stave), regardless of which specific
      // measure on this line it was set from (see targetMeasure's 対象小節).
      // 上鍵盤/下鍵盤 sit just below their own bottom line, in the gap before
      // the next stave down; ペダル keeps its previous spot below the measure
      // number, since there's no further stave below it to make room in.
      const reachBelowPxByPart = {
        upper: staveGapInfo.upperReachBelowPx, lower: staveGapInfo.lowerReachBelowPx, pedal: 0,
      };

      // 強弱記号の行 — 段の中では音符の高さに関わらず1本の高さに揃える
      // (LilyPond の DynamicLineSpanner)。譜表の下、加線より下から始める。
      const dynamicRowY = {};
      ['upper', 'lower', 'pedal'].forEach((part) => {
        const stave = lineStaves[part];
        if (!stave || lineDynamics[part].length === 0) return;
        const y = stave.getBottomLineY() + Math.max(26, reachBelowPxByPart[part] + 16);
        dynamicRowY[part] = y;
        drawDynamicsRow(ctx, lineDynamics[part], y);
      });

      ['upper', 'lower', 'pedal'].forEach((part) => {
        const lineLyric = measureIndices.map((m) => score.measures[m].lyrics[part]).find((t) => t);
        const stave = lineStaves[part];
        if (!lineLyric || !stave) return;
        // 14px is the usual clearance below the bottom line, but a ledger
        // line reaching further down than that (see computeRequiredStaveGap)
        // pushes the lyric to start past it instead of running through it —
        // whatever the whole score's tallest reach turns out to be, applied
        // uniformly rather than checked per measure/column. 強弱記号の行が
        // あるときはさらにその下から始める。
        const base = part === 'pedal'
          ? stave.getBottomLineY() + measureNumberHeight + 10
          : stave.getBottomLineY() + Math.max(14, reachBelowPxByPart[part] + 8);
        const lyricY = dynamicRowY[part] ? Math.max(base, dynamicRowY[part] + 15) : base;
        ctx.save();
        ctx.setFont('Arial', 11, '');
        ctx.fillText(lineLyric, pageMargin, lyricY);
        ctx.restore();
      });
    }

    // ページ番号 — bottom-center of every page, on by default (hidden
    // nowhere — unlike the measure-number labels/ribbon this is meant to
    // print, so it's drawn straight into the page's own canvas rather than
    // as a DOM overlay app.js would have to remember to exclude from print).
    ctx.save();
    ctx.setFont('Arial', 10, '');
    const pageNumberText = String(page + 1);
    const pageNumberWidth = textWidthAt(ctx, pageNumberText, 10);
    ctx.fillText(pageNumberText, (pageWidth - pageNumberWidth) / 2, pageHeight - pageMargin / 2);
    ctx.restore();
  }

  // Now that every note on every page has a built vfNote (builtByNoteId),
  // resolve each スラー link into a drawable mark — same-line links become
  // one Curve; links crossing a system break split into two independently
  // anchored halves, same as tie.
  slurLinks.forEach(({ from, to }) => {
    const a = builtByNoteId.get(from.noteId);
    const b = builtByNoteId.get(to.noteId);
    if (!a || !b) return; // shouldn't happen — both were confirmed to exist above
    if (a.line === b.line) {
      deferredMarks.push({
        type: 'slur', a: a.vfNote, b: b.vfNote, aIndex: from.keyIndex, bIndex: to.keyIndex, ctx: b.ctx,
      });
    } else {
      deferredMarks.push({
        type: 'slur', a: a.vfNote, b: null, aIndex: from.keyIndex, bIndex: to.keyIndex, ctx: a.ctx,
      });
      deferredMarks.push({
        type: 'slur', a: null, b: b.vfNote, aIndex: from.keyIndex, bIndex: to.keyIndex, ctx: b.ctx,
      });
    }
  });

  // Same idea for グリッサンド links.
  glissandoLinks.forEach(({ from, to }) => {
    const a = builtByNoteId.get(from.noteId);
    const b = builtByNoteId.get(to.noteId);
    if (!a || !b) return; // shouldn't happen — both were confirmed to exist above
    if (a.line === b.line) {
      deferredMarks.push({
        type: 'glissando', a: a.vfNote, b: b.vfNote, aIndex: from.keyIndex, bIndex: to.keyIndex, ctx: b.ctx,
      });
    } else {
      deferredMarks.push({
        type: 'glissando-partial', note: a.vfNote, keyIndex: from.keyIndex, outgoing: true, ctx: a.ctx,
      });
      deferredMarks.push({
        type: 'glissando-partial', note: b.vfNote, keyIndex: to.keyIndex, outgoing: false, ctx: b.ctx,
      });
    }
  });

  // 8va/8vb brackets. VexFlow's TextBracket wants both notes, so a bracket that
  // crosses a system break is drawn from its start note to the last note on
  // that same line, then resumed on the next — the same convention printed
  // scores use. A bracket whose ends are on different lines with nothing to
  // anchor to is simply skipped rather than drawn to nowhere.
  ottavaLinks.forEach(({ fromId, toId, kind }) => {
    const a = builtByNoteId.get(fromId);
    const b = builtByNoteId.get(toId);
    if (!a || !b) return;
    const position = kind === '8vb' ? TextBracket.Position.BOTTOM : TextBracket.Position.TOP;
    const superscript = kind === '8vb' ? 'vb' : 'va';
    const drawBracket = (start, stop, ctx) => {
      new TextBracket({
        start, stop, text: '8', superscript, position,
      }).setContext(ctx).draw();
    };
    if (a.line === b.line) {
      drawBracket(a.vfNote, b.vfNote, a.ctx);
      return;
    }
    // 段をまたぐ括弧は、印刷譜と同じように段ごとに切って描く — 開始音符から
    // その段の最後の音符まで、そして次の段の頭から終了音符まで。
    // TextBracket は両端に音符を要求するので、途中の段の端の音符を代わりに使う。
    const part = partByNoteId.get(fromId);
    const lastOnLine = (lineEdgeNotes.get(`${part}|${a.line}`) || {}).last;
    const firstOnLine = (lineEdgeNotes.get(`${part}|${b.line}`) || {}).first;
    if (lastOnLine && lastOnLine !== a.vfNote) drawBracket(a.vfNote, lastOnLine, a.ctx);
    if (firstOnLine && firstOnLine !== b.vfNote) drawBracket(firstOnLine, b.vfNote, b.ctx);
  });

  // Two tones of the same chord tied to the next chord produce two separate
  // 'tie' deferredMarks entries with the same (a, b) note pair. VexFlow's
  // supported way to tie multiple tones between the same two notes is a
  // *single* StaveTie whose index arrays each carry every tied tone, so
  // group same-pair ties together before drawing.
  //
  // The option names are firstIndexes/lastIndexes (see vexflow's TieNotes) —
  // NOT firstIndices/lastIndices. StaveTie.setNotes() silently substitutes
  // [0] for anything it doesn't recognize, so a misspelling here doesn't
  // throw: it just draws exactly one tie, always on the chord's lowest
  // notehead, no matter how many tones were actually tied.
  const tieGroups = [];
  deferredMarks.forEach((mark) => {
    if (mark.type !== 'tie') return;
    let group = tieGroups.find((g) => g.a === mark.a && g.b === mark.b && g.ctx === mark.ctx);
    if (!group) {
      group = {
        a: mark.a, b: mark.b, ctx: mark.ctx, firstIndexes: [], lastIndexes: [],
      };
      tieGroups.push(group);
    }
    group.firstIndexes.push(mark.aIndex ?? mark.bIndex ?? 0);
    group.lastIndexes.push(mark.bIndex ?? mark.aIndex ?? 0);
  });
  tieGroups.forEach((g) => {
    // A tie split across a system break has only one of its two notes; VexFlow's
    // own synchronizeIndexes() then copies whichever index array belongs to the
    // note that does exist onto the other, so both arrays are passed as-is here.
    new StaveTie({
      firstNote: g.a, lastNote: g.b, firstIndexes: g.firstIndexes, lastIndexes: g.lastIndexes,
    }).setContext(g.ctx).draw();
  });

  // スラー is deliberately NOT per-tone the way タイ is. A tie belongs to one
  // pitch (each tone of a chord can tie or not, independently), but a slur is
  // a phrase marking over the passage as a whole — printed scores draw one
  // curve above a slurred chord progression, not one per chord tone. VexFlow's
  // Curve agrees: it has no per-tone index at all, positioning itself purely
  // from the notes' stem extents, so several Curves on the same (a, b) pair
  // would land on identical coordinates anyway. Draw one curve per distinct
  // note pair and skip the duplicates.
  const drawnSlurPairs = [];
  deferredMarks.forEach((mark) => {
    if (mark.type === 'slur') {
      const already = drawnSlurPairs.some(
        (g) => g.a === mark.a && g.b === mark.b && g.ctx === mark.ctx,
      );
      if (already) return;
      drawnSlurPairs.push({ a: mark.a, b: mark.b, ctx: mark.ctx });
      new Curve(mark.a || undefined, mark.b || undefined, { yShift: 10 }).setContext(mark.ctx).draw();
    } else if (mark.type === 'hairpin') {
      const type = mark.kind === 'cresc' ? StaveHairpin.type.CRESC : StaveHairpin.type.DECRESC;
      new StaveHairpin({ firstNote: mark.a, lastNote: mark.b }, type).setContext(mark.ctx).draw();
    } else if (mark.type === 'hairpin-partial') {
      drawPartialHairpin(mark.ctx, mark.note, mark.kind, mark.outgoing);
    } else if (mark.type === 'glissando') {
      drawGlissandoLine(
        mark.ctx, noteHeadPosition(mark.a, mark.aIndex), noteHeadPosition(mark.b, mark.bIndex),
      );
    } else if (mark.type === 'glissando-partial') {
      drawPartialGlissando(mark.ctx, mark.note, mark.keyIndex, mark.outgoing);
    }
  });

  return {
    hitMap,
    annotationHitMap,
    markHitMap,
    timeSigHitMap,
    pages,
    totalPages,
    staveGap,
    // 形式タブの縦スライダーが「いま1ページに何段入っているか」を出せるように
    // 返す(app.js の updateHeightSliderUI)。
    firstPageLines,
    laterPageLines,
  };
}

// How far above and below a stave's top line a click still counts as belonging
// to that stave.
//
// These used to be fixed numbers tuned for the default 100px stave gap. But
// staveGap widens to clear tall ledger lines (see computeRequiredStaveGap), and
// the bands didn't grow with it — which opened a dead strip between staves
// where clicks matched nothing at all. Scaling with the gap keeps the staves'
// bands touching whatever the spacing is. They deliberately overlap a little;
// resolveClickTarget in app.js settles the ambiguity by preferring whichever
// stave actually has a note under the pointer.
export function hitBandAbove(staveGap) {
  return Math.max(45, staveGap * 0.45);
}

export function hitBandBelow(staveGap) {
  return Math.max(85, staveGap * 0.85);
}

export function findHitRegion(hitMap, pageIndex, part, x, y, staveGap = LAYOUT.staveGap) {
  return hitMap.find(
    (r) => r.page === pageIndex && r.part === part && x >= r.x0 && x <= r.x1
      && y >= r.topY - hitBandAbove(staveGap) && y <= r.topY + hitBandBelow(staveGap),
  );
}
