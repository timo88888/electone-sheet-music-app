import {
  Renderer, Stave, StaveNote, StaveConnector, Voice, Formatter, Dot, Beam,
  BarlineType, StaveTie, Curve, StaveHairpin, Annotation, AnnotationVerticalJustify, Accidental,
  Articulation, Tuplet, Ornament, Stroke,
} from '../../node_modules/vexflow/build/esm/entry/vexflow.js';
import {
  PARTS, measureCapacity, getClef, REST_ANCHOR_KEY, noteBeats, keySignatureAccidentalCount,
  tupletNotesOccupied,
} from './scoreModel.js';
import { parseKey } from './pitchMap.js';

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

// Attaches note.articulation to vfNote, picking whichever VexFlow modifier
// class actually renders that code — a plain articulation glyph (staccato,
// fermata, ...), a stem-attached ornament (trill, turn, mordent), or an
// arpeggio wavy line across the whole chord (Stroke, not tied to one key).
function addArticulationModifier(vfNote, articulation) {
  if (ARTICULATION_CODES[articulation]) {
    vfNote.addModifier(new Articulation(ARTICULATION_CODES[articulation]), 0);
  } else if (ORNAMENT_CODES[articulation]) {
    vfNote.addModifier(new Ornament(ORNAMENT_CODES[articulation]), 0);
  } else if (articulation === ARPEGGIO_ARTICULATION) {
    vfNote.addModifier(new Stroke(Stroke.Type.ARPEGGIO_DIRECTIONLESS), 0);
  }
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
  linesPerPage: 4,
  pageWidth: 1050,
  pageHeight: Math.round(1050 * A4_RATIO),
  pageMargin: 40,
  staveGap: 100,
  // Vertical gap between one system's measure-number row (just below its
  // pedal stave) and the next system's mark row. Needs *some* room for
  // ledger lines plus dynamics/lyric text hanging below the pedal stave.
  systemGap: 80,
  topMargin: 110,
  // Band holding コード text and リハーサル/レジストレーション boxes, one line
  // above the stave (see renderScore's per-note mark drawing). Sized so the
  // band's own bottom edge clears the treble clef's tip instead of sitting
  // right against the staff — a clef's swirl reaches noticeably above the
  // top line, and a tall upper-staff note's ledger lines can reach up nearly
  // as far, so drawPerNoteMarks also treats those ledger-line notes as
  // obstacles the same way it treats a neighboring mark (see
  // upperNoteObstacles). Priority when marks would collide is コード, then
  // リハーサル, then レジストレーション — later ones shift right.
  rehearsalBandHeight: 29,
  // Now below the pedal stave (moved off the top of the system) — see
  // renderMeasureNumbers in app.js.
  measureNumberHeight: 14,
  clefExtraWidth: 32,
  timeSigExtraWidth: 30,
  keySigWidthPerAccidental: 9,
  keySigBaseWidth: 14,
  // reserved space at the top of page 1 only, for the title/composer/lyricist
  // text overlay app.js renders on top of the score
  titleHeaderHeight: 70,
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
const LYRIC_RESERVE_PX = 28;

function computeRequiredStaveGap(score, baseStaveGap) {
  let upperReachBelow = 0;
  let lowerReachAbove = 0;
  let lowerReachBelow = 0;
  let pedalReachAbove = 0;
  let hasLyrics = false;
  score.measures.forEach((measure) => {
    if ((measure.lyrics && (measure.lyrics.upper || measure.lyrics.lower))) hasLyrics = true;
    PARTS.forEach((part) => {
      const clef = getClef(score, part);
      (measure[part] || []).forEach((n) => {
        if (n.isRest) return;
        n.keys.forEach((tone) => {
          if (part === 'upper') upperReachBelow = Math.max(upperReachBelow, ledgerReachBelow(clef, tone.key));
          if (part === 'lower') {
            lowerReachAbove = Math.max(lowerReachAbove, ledgerReachAbove(clef, tone.key));
            lowerReachBelow = Math.max(lowerReachBelow, ledgerReachBelow(clef, tone.key));
          }
          if (part === 'pedal') pedalReachAbove = Math.max(pedalReachAbove, ledgerReachAbove(clef, tone.key));
        });
      });
    });
  });
  const upperLowerUnits = upperReachBelow + lowerReachAbove + STAVE_GAP_SAFETY_INDEX_UNITS;
  const lowerPedalUnits = lowerReachBelow + pedalReachAbove + STAVE_GAP_SAFETY_INDEX_UNITS;
  let neededPx = Math.max(upperLowerUnits, lowerPedalUnits) * INDEX_STEP_PX;
  if (hasLyrics) neededPx = Math.max(neededPx, LYRIC_RESERVE_PX);
  return {
    gap: Math.max(baseStaveGap, STAVE_HEIGHT_PX + neededPx),
    // How far below its own bottom line 上鍵盤/下鍵盤's lowest note reaches
    // (px) — the per-line lyric row (see below) starts just past this so a
    // ledger line under the very column the lyric text starts at can't run
    // through it, whatever the whole score's tallest downward reach is.
    upperReachBelowPx: upperReachBelow * INDEX_STEP_PX,
    lowerReachBelowPx: lowerReachBelow * INDEX_STEP_PX,
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

function buildStaveNotes(measure, part, clef) {
  const notes = measure[part];
  if (notes.length === 0) {
    const restKey = REST_ANCHOR_KEY[clef] || 'b/4';
    return [{ vfNote: new StaveNote({ keys: [restKey], duration: 'wr', clef }), noteRef: null }];
  }
  return notes.map((n) => {
    const durStr = `${n.duration}${n.dotted ? 'd' : ''}${n.isRest ? 'r' : ''}`;
    const restKey = REST_ANCHOR_KEY[clef] || 'b/4';
    const keyStrings = n.isRest ? [restKey] : n.keys.map((tone) => tone.key);
    const vfNote = new StaveNote({ keys: keyStrings, duration: durStr, clef });
    if (n.dotted) Dot.buildAndAttach([vfNote], { all: true });
    if (!n.isRest) {
      n.keys.forEach((tone, i) => {
        const accMatch = /^[a-gA-G](#{1,2}|b{1,2}|n)\//.exec(tone.key);
        if (accMatch) vfNote.addModifier(new Accidental(accMatch[1]), i);
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
    if (n.articulation) {
      addArticulationModifier(vfNote, n.articulation);
    }
    if (n.dynamic) {
      // dynamics conventionally sit below the staff
      const anno = new Annotation(n.dynamic);
      anno.setVerticalJustification(AnnotationVerticalJustify.BOTTOM);
      vfNote.addModifier(anno, 0);
    }
    return { vfNote, noteRef: n };
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
  ctx.setFont('Arial', 9, 'italic');
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

// n番括弧 (repeat-ending brackets) — measure.volta = { number, span } marks
// the FIRST measure of a span-measures-long bracket labelled "N.". Only
// measures actually on this line get drawn; a bracket whose span runs past
// the line's last measure (crossing a system break) just draws without its
// closing downward tick, reading as "continues" rather than abruptly ending
// mid-air — same convention printed scores use.
function drawVoltaBrackets(ctx, score, measureIndices, measureColumns, lineY) {
  const y = lineY + 4;
  const tickHeight = 7;
  measureIndices.forEach((m) => {
    const measure = score.measures[m];
    if (!measure.volta) return;
    const startCol = measureColumns[m];
    if (!startCol) return;
    const endIndex = m + measure.volta.span - 1;
    const lastOnLine = measureIndices[measureIndices.length - 1];
    const clippedEndIndex = Math.min(endIndex, lastOnLine);
    const endCol = measureColumns[clippedEndIndex];
    if (!endCol) return;
    const x0 = startCol.x;
    const x1 = endCol.x + endCol.width;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x0, y + tickHeight);
    ctx.lineTo(x0, y);
    ctx.lineTo(x1, y);
    if (clippedEndIndex === endIndex) ctx.lineTo(x1, y + tickHeight);
    ctx.stroke();
    ctx.setFont('Arial', 11, '');
    ctx.fillText(`${measure.volta.number}.`, x0 + 4, y + 11);
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
    ctx.fillText(note.chord, x, y);
    ctx.restore();
    const w = textWidthAt(ctx, note.chord, 10);
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
    linesPerPage, pageWidth, pageHeight, pageMargin, systemGap, topMargin,
    rehearsalBandHeight, measureNumberHeight, clefExtraWidth, timeSigExtraWidth, titleHeaderHeight,
  } = layout;
  // Widened beyond layout's own default when a 上鍵盤 note's ledger lines
  // reaching down would otherwise collide with a 下鍵盤 note's reaching up
  // (or the same for 下鍵盤/ペダル) — see computeRequiredStaveGap. Applied
  // uniformly to every system in the score, never just the offending one.
  const staveGapInfo = computeRequiredStaveGap(score, layout.staveGap);
  const staveGap = staveGapInfo.gap;
  // 1番括弧/2番括弧 etc. (see drawVoltaBrackets) need their own row above the
  // existing chord/リハーサル/レジストレーション band — reserved only when the
  // score actually uses one, so scores that don't stay exactly as tight to
  // the clef as they were tuned to be (see rehearsalBandHeight's own
  // comment).
  const hasVolta = score.measures.some((m) => m.volta);
  const voltaOffset = hasVolta ? VOLTA_BAND_HEIGHT : 0;

  const lines = computeLines(score, layout);
  const totalLines = lines.length;
  const totalPages = Math.max(1, Math.ceil(totalLines / linesPerPage));

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
  const builtByNoteId = new Map(); // noteId -> { vfNote, line, ctx }

  const noteById = new Map();
  score.measures.forEach((measure) => {
    PARTS.forEach((part) => {
      measure[part].forEach((n) => noteById.set(n.id, n));
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
    const ctx = renderer.getContext();

    const lineStart = page * linesPerPage;
    const lineEnd = Math.min(totalLines, lineStart + linesPerPage);

    for (let line = lineStart; line < lineEnd; line++) {
      const measureIndices = lines[line];
      const lineY = topMargin + pageTitleExtra
        + (line - lineStart) * (staveGap * 2 + systemGap + rehearsalBandHeight + voltaOffset);
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

        // D.C./D.S./Fine/Coda playback-jump marker — right-aligned in the
        // コード row, independent of those per-note marks.
        if (measure.marker) {
          ctx.save();
          ctx.setFont('Arial', 10, 'bold');
          const w = ctx.measureText(measure.marker).width;
          ctx.fillText(measure.marker, x + measureWidth - w - 4, lineY + rehearsalBandHeight - 6);
          ctx.restore();
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
          const built = buildStaveNotes(measure, part, clef);
          const vfNotes = built.map((b) => b.vfNote);
          // Tuplets must be built before the Voice/Formatter run: creating a
          // Tuplet immediately applies the tick-multiplier to its notes so
          // spacing accounts for the shortened duration.
          const tuplets = buildTuplets(built).map(
            (g) => new Tuplet(g.notes, { notesOccupied: g.notesOccupied }),
          );

          const voice = new Voice({ num_beats: measureCapacity(score, m), beat_value: 4 });
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
          const beams = Beam.generateBeams(vfNotes);
          voice.draw(ctx, stave);
          beams.forEach((b) => b.setContext(ctx).draw());
          tuplets.forEach((t) => t.setContext(ctx).draw());

          // Tie is matched *per pitch* (see pitchId) so a chord can have some
          // tones tie forward and others not, independently.
          pendingTie[part] = pendingTie[part] || new Map();

          const real = built.filter((b) => b.noteRef);
          real.forEach((b) => {
            const n = b.noteRef;
            builtByNoteId.set(n.id, { vfNote: b.vfNote, line, ctx });

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
        });
      });

      if (hasVolta) {
        drawVoltaBrackets(ctx, score, measureIndices, measureColumns, lineY);
      }

      // 歌詞 — one line of text per system *per staff* (上鍵盤/下鍵盤/ペダル
      // each shown near their own stave), regardless of which specific
      // measure on this line it was set from (see targetMeasure's 対象小節).
      // 上鍵盤/下鍵盤 sit just below their own bottom line, in the gap before
      // the next stave down; ペダル keeps its previous spot below the measure
      // number, since there's no further stave below it to make room in.
      const reachBelowPxByPart = { upper: staveGapInfo.upperReachBelowPx, lower: staveGapInfo.lowerReachBelowPx };
      ['upper', 'lower', 'pedal'].forEach((part) => {
        const lineLyric = measureIndices.map((m) => score.measures[m].lyrics[part]).find((t) => t);
        const stave = lineStaves[part];
        if (!lineLyric || !stave) return;
        // 14px is the usual clearance below the bottom line, but a ledger
        // line reaching further down than that (see computeRequiredStaveGap)
        // pushes the lyric to start past it instead of running through it —
        // whatever the whole score's tallest reach turns out to be, applied
        // uniformly rather than checked per measure/column.
        const lyricY = part === 'pedal'
          ? stave.getBottomLineY() + measureNumberHeight + 10
          : stave.getBottomLineY() + Math.max(14, reachBelowPxByPart[part] + 8);
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

  // Two tones of the same chord tied to the next chord produce two separate
  // 'tie' deferredMarks entries with the same (a, b) note pair — issuing one
  // StaveTie per tone (each with its own single-element firstIndices/
  // lastIndices) only ever rendered one visible curve. VexFlow's supported
  // way to tie multiple tones between the same two notes is a *single*
  // StaveTie whose firstIndices/lastIndices each carry every tied tone, so
  // group same-pair ties together before drawing.
  const tieGroups = [];
  deferredMarks.forEach((mark) => {
    if (mark.type !== 'tie') return;
    let group = tieGroups.find((g) => g.a === mark.a && g.b === mark.b && g.ctx === mark.ctx);
    if (!group) {
      group = {
        a: mark.a, b: mark.b, ctx: mark.ctx, firstIndices: [], lastIndices: [],
      };
      tieGroups.push(group);
    }
    group.firstIndices.push(mark.aIndex ?? mark.bIndex ?? 0);
    group.lastIndices.push(mark.bIndex ?? mark.aIndex ?? 0);
  });
  tieGroups.forEach((g) => {
    new StaveTie({
      firstNote: g.a, lastNote: g.b, firstIndices: g.firstIndices, lastIndices: g.lastIndices,
    }).setContext(g.ctx).draw();
  });

  // Same idea for スラー: two tones of a chord each slurred to the next
  // chord produce two 'slur' marks with the same (a, b) note pair, but
  // VexFlow's Curve has no per-tone index at all — its position comes purely
  // from the *note's* stem extents, so two Curves on the same pair would
  // compute identical coordinates and draw exactly on top of each other
  // (indistinguishable from a single curve). Give each one after the first a
  // larger yShift so they visibly fan out instead of overlapping.
  const slurGroupCounts = [];
  deferredMarks.forEach((mark) => {
    if (mark.type === 'slur') {
      let group = slurGroupCounts.find((g) => g.a === mark.a && g.b === mark.b && g.ctx === mark.ctx);
      if (!group) {
        group = { a: mark.a, b: mark.b, ctx: mark.ctx, count: 0 };
        slurGroupCounts.push(group);
      }
      const yShift = 10 + group.count * 8;
      group.count += 1;
      new Curve(mark.a || undefined, mark.b || undefined, { yShift }).setContext(mark.ctx).draw();
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
    hitMap, annotationHitMap, markHitMap, timeSigHitMap, pages, totalPages,
  };
}

export function findHitRegion(hitMap, pageIndex, part, x, y) {
  return hitMap.find(
    (r) => r.page === pageIndex && r.part === part && x >= r.x0 && x <= r.x1
      && y >= r.topY - 40 && y <= r.topY + 80,
  );
}
