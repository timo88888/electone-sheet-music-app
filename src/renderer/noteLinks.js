// 音符間リンク(タイ/スラー/グリッサンド)の整合性
//
// A tie/slur/glissando is a reference from one tone to another note, so any
// edit at the other end can leave it pointing at something that no longer
// exists: deleting the target, changing its pitch, truncating the score at a
// final barline, clearing a measure range, pasting a copy elsewhere, and so
// on. Those edits happen in a dozen different places in app.js, and having
// each one clean up after itself didn't work — most of them didn't, which
// showed up as slurs vanishing for no reason and ties stretching across whole
// measures to reach the next same-pitch note.
//
// So integrity is enforced in one place instead: app.js runs pruneDanglingLinks
// from pushHistory(), which every mutation already goes through.
//
// Kept in its own module (rather than inside app.js) because these are pure
// functions over the score model with no DOM involvement — which is what makes
// them directly testable. See test/noteLinks.test.js.

import { parseKey } from './pitchMap.js';

export const LINK_FIELDS = ['slurTo', 'glissandoTo'];

// Same-staff-position identity (letter+octave, ignoring accidental) used as a
// slur/glissando's stored target. Must match staffRenderer.js's pitchId()
// format exactly, since that's what resolves the link back into a specific
// tone at render time.
export function pitchKeyOf(key) {
  const { letter, octave } = parseKey(key);
  return `${letter.toLowerCase()}/${octave}`;
}

// Every note in the score, keyed by id.
function indexNotesById(score, parts) {
  const byId = new Map();
  score.measures.forEach((measure) => {
    parts.forEach((part) => {
      (measure[part] || []).forEach((n) => byId.set(n.id, n));
    });
  });
  return byId;
}

// Notes in playing order for one part, flattened across measures — a tie
// routinely crosses a barline, so "the next note" isn't necessarily in the
// same measure's array.
function flattenPartNotes(score, part) {
  const flat = [];
  score.measures.forEach((measure) => {
    (measure[part] || []).forEach((n) => flat.push(n));
  });
  return flat;
}

// Drops links that can no longer land anywhere.
//
// タイ connects a pitch to that same pitch on the *immediately following*
// note. If the next note doesn't carry the pitch any more, the tie is over —
// regardless of what appears later in the part. (Without this rule a tie whose
// target got re-pitched kept hunting forward and attached itself to the next
// same-pitch note it could find, several measures away.)
//
// スラー/グリッサンド are explicit { noteId, pitchKey } links, so both the note
// and a tone at that pitch on it have to still exist.
export function pruneDanglingLinks(score, parts) {
  if (!score || !Array.isArray(score.measures)) return score;

  parts.forEach((part) => {
    const flat = flattenPartNotes(score, part);
    flat.forEach((n, i) => {
      if (n.isRest) return;
      // An unfilled N連符 placeholder doesn't sound and doesn't interrupt a
      // tie in flight, so it's skipped when looking for "the next note".
      let next = null;
      for (let j = i + 1; j < flat.length; j += 1) {
        if (flat[j].isPlaceholder) continue;
        next = flat[j];
        break;
      }
      (n.keys || []).forEach((tone) => {
        if (!tone.tieToNext) return;
        const pk = pitchKeyOf(tone.key);
        const lands = !!next && !next.isRest
          && (next.keys || []).some((t) => pitchKeyOf(t.key) === pk);
        if (!lands) tone.tieToNext = false;
      });
    });
  });

  const byId = indexNotesById(score, parts);
  byId.forEach((n) => {
    (n.keys || []).forEach((tone) => {
      LINK_FIELDS.forEach((field) => {
        const link = tone[field];
        if (!link) return;
        const target = byId.get(link.noteId);
        const lands = !!target && !target.isRest
          && (target.keys || []).some((t) => pitchKeyOf(t.key) === link.pitchKey);
        if (!lands) tone[field] = null;
      });
    });
  });

  return score;
}

// Called when one tone's pitch changes, so links pointing *at* that tone move
// with it instead of being pruned away on the next pass. Without this,
// dragging a note, nudging it with the arrow keys, or transposing a region
// silently deleted every slur and glissando that ended there.
export function retargetLinksTo(score, parts, noteId, oldPitchKey, newPitchKey) {
  if (oldPitchKey === newPitchKey) return;
  score.measures.forEach((measure) => {
    parts.forEach((part) => {
      (measure[part] || []).forEach((n) => {
        (n.keys || []).forEach((tone) => {
          LINK_FIELDS.forEach((field) => {
            const link = tone[field];
            if (link && link.noteId === noteId && link.pitchKey === oldPitchKey) {
              link.pitchKey = newPitchKey;
            }
          });
        });
      });
    });
  });
}

// Bulk form of retargetLinksTo for an operation that moves many notes by the
// same interval at once (移調). Rescanning the whole score once per moved tone
// would be quadratic; this makes one pass and shifts the stored pitch of every
// link that lands inside `movedNoteIds`.
export function retargetLinksAfterTranspose(score, parts, movedNoteIds, shiftPitchKey) {
  score.measures.forEach((measure) => {
    parts.forEach((part) => {
      (measure[part] || []).forEach((n) => {
        (n.keys || []).forEach((tone) => {
          LINK_FIELDS.forEach((field) => {
            const link = tone[field];
            if (link && movedNoteIds.has(link.noteId)) {
              link.pitchKey = shiftPitchKey(link.pitchKey);
            }
          });
        });
      });
    });
  });
}

// Deep-copies notes for pasting, giving each a fresh id and rewriting any
// タイ/スラー/グリッサンド between them to point at the copies. Links to notes
// *outside* the copied set are dropped — keeping them drew a slur from the
// pasted passage all the way back to whatever it was copied from.
export function cloneNotesWithFreshIds(notes, makeId) {
  const idMap = new Map();
  notes.forEach((n) => idMap.set(n.id, makeId()));
  return notes.map((n) => {
    const clone = structuredClone(n);
    clone.id = idMap.get(n.id);
    (clone.keys || []).forEach((tone) => {
      LINK_FIELDS.forEach((field) => {
        if (!tone[field]) return;
        const mapped = idMap.get(tone[field].noteId);
        tone[field] = mapped ? { ...tone[field], noteId: mapped } : null;
      });
    });
    return clone;
  });
}
