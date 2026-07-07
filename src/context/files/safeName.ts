/**
 * Filesystem-name safety for the DOS device names Windows still reserves.
 *
 * Windows refuses to create a file OR folder named CON, PRN, AUX, NUL, COM1–9
 * or LPT1–9 — case-insensitively, and even with an extension (`con.md` is just
 * as illegal as `con`). A slug derived from a project name ("Con", "Aux") or a
 * page id can land on one, and the write then fails with EINVAL on Windows
 * while working fine on macOS/Linux — a classic cross-platform footgun. Windows
 * also silently trims a trailing dot or space from a name, which can collapse
 * two distinct names into one path. Both are escaped here. Pure + unit-tested.
 */

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Return `name` unchanged unless it would be unwritable on Windows, in which
 *  case it's minimally escaped (leading underscore for a reserved device name;
 *  trailing dots/spaces replaced) so the same path is usable on every OS. */
export function avoidReservedName(name: string): string {
  // The reserved check applies to the part before the FIRST dot ("con.md" is
  // reserved because of "con").
  const base = name.split(".")[0] ?? name;
  let out = RESERVED.test(base) ? `_${name}` : name;
  // Windows strips trailing dots/spaces — escape them so distinct names stay
  // distinct and the path stays writable.
  out = out.replace(/[. ]+$/, (m) => "_".repeat(m.length));
  return out || "_";
}
