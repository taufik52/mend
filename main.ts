// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move chains: original path -> final path, following chained moves. */
  readonly moveChain = new Map<string, string>();
  recordMove(oldP: string, newP: string): void {
    for (const [k, v] of this.moveChain) {
      if (v === oldP) {
        this.moveChain.set(k, newP);
        return;
      }
    }
    this.moveChain.set(oldP, newP);
  }
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Sections 5-8: line matching and the three non-JSON formats ---- */

interface FileParts {
  lines: string[];
  br: '\r\n' | '\n';
  finalBreak: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const parts = text.split(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(f: FileParts): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** All 0-based starts where `o` occurs in `lines` at this tier (overlaps count). */
function occurrencesAt(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const keys = o.map((l) => tierKey(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, 1, 2 — or only 0 when strict) at which `o` occurs at least once. */
function firstTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** First tier with an occurrence at or after `from`. */
function firstTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t).filter((s) => s >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NewLine {
  text: string;
  /** Index into O of the context line this replaces with the file's own line, or null. */
  ctx: number | null;
}

/** Build the replacement lines: context lines as the file's own, tier-2 re-indent for the rest. */
function buildNew(fileLines: string[], start: number, o: string[], n: NewLine[], tier: number): string[] {
  const out: string[] = [];
  const fLead = ((fileLines[start] ?? '').match(/^[ \t]*/) ?? [''])[0]!;
  const pLead = ((o[0] ?? '').match(/^[ \t]*/) ?? [''])[0]!;
  for (const nl of n) {
    if (nl.ctx !== null) {
      out.push(fileLines[start + nl.ctx]!);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(pLead)) {
      t = fLead + t.slice(pLead.length);
    }
    out.push(t);
  }
  return out;
}

/* ---- Section 6: unified diffs ---- */

interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEolCtxPlus: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noEolPlus: boolean;
}

interface UniSection {
  oldP: string | null; // null: /dev/null, no file
  newP: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** Path from a `--- `/`+++ ` header line: text after the marker, to the first tab, trimmed, a/b/ stripped. */
function hdrPath(s: string): string {
  const tab = s.indexOf('\t');
  const t = (tab >= 0 ? s.slice(0, tab) : s).trim();
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    let sec: UniSection;
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldP: m[1]!, newP: m[2]!, creation: false, deletion: false, hunks: [] };
      i++;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { oldP: null, newP: null, creation: false, deletion: false, hunks: [] };
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`); // hunk before any section
    } else {
      i++; // prose outside sections is ignored
      continue;
    }
    // Header, up to the first hunk.
    let oldHdr: string | null = null;
    let newHdr: string | null = null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    while (i < n) {
      const h = lines[i]!;
      if (h.startsWith('@@')) break;
      if (h.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          oldHdr = hdrPath(h.slice(4));
          newHdr = hdrPath(lines[i + 1]!.slice(4));
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (h.startsWith('rename from ')) {
        renameFrom = h.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (h.startsWith('rename to ')) {
        renameTo = h.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (h.startsWith('new file mode')) {
        sec.creation = true;
        i++;
        continue;
      }
      if (h.startsWith('deleted file mode')) {
        sec.deletion = true;
        i++;
        continue;
      }
      i++; // index, modes, similarity, Index:, any other line: ignored
    }
    if (oldHdr !== null) {
      sec.oldP = oldHdr;
      sec.newP = newHdr;
    } else if (renameFrom !== null) {
      sec.oldP = renameFrom;
      sec.newP = renameTo;
    }
    if (sec.oldP === '/dev/null') sec.oldP = null;
    if (sec.newP === '/dev/null') sec.newP = null;
    // Hunks.
    while (i < n) {
      const h = lines[i]!;
      if (h.startsWith('@@')) {
        const m = hunkRe.exec(h);
        if (!m) throw new Exit2(`error: parse ${i + 1}`);
        const a = parseInt(m[1]!, 10);
        i++;
        const body: string[] = [];
        while (i < n) {
          const b = lines[i]!;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b.startsWith('diff --git ')) break;
          if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
            body.push(b);
            i++;
            continue;
          }
          break;
        }
        while (body.length > 0 && body[body.length - 1] === '') body.pop();
        let lastCp = -1;
        let lastPlus = -1;
        for (let k = 0; k < body.length; k++) {
          const b = body[k]!;
          if (b.startsWith(' ') || b.startsWith('+') || b === '') lastCp = k;
          if (b.startsWith('+')) lastPlus = k;
        }
        const noEolCtxPlus = lastCp >= 0 && lastCp + 1 < body.length && body[lastCp + 1]!.startsWith('\\');
        const noEolPlus = lastPlus >= 0 && lastPlus + 1 < body.length && body[lastPlus + 1]!.startsWith('\\');
        const o: string[] = [];
        const nn: NewLine[] = [];
        for (const b of body) {
          if (b.startsWith('\\')) continue;
          if (b.startsWith(' ')) {
            o.push(b.slice(1));
            nn.push({ text: b.slice(1), ctx: o.length - 1 });
          } else if (b.startsWith('-')) {
            o.push(b.slice(1));
          } else if (b.startsWith('+')) {
            nn.push({ text: b.slice(1), ctx: null });
          } else if (b === '') {
            o.push('');
            nn.push({ text: '', ctx: o.length - 1 });
          }
        }
        sec.hunks.push({ a, o, n: nn, noEolCtxPlus, noEolPlus });
        continue;
      }
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      i++; // outside bodies, lines that are not part of a section header are ignored
    }
    sections.push(sec);
  }
  return sections;
}

/** Apply a section's hunks in order to a file's lines; `path` names the file for failures. */
function applyHunks(file: FileParts, hunks: Hunk[], strict: boolean, path: string): FileParts {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const m = firstTier(file.lines, h.o, strict);
      if (m === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = m.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const s of m.occ) {
        const dist = Math.abs(s - target);
        if (dist < bestDist) {
          best = s;
          bestDist = dist;
        }
      }
      const start = best;
      const touchesEnd = start + h.o.length === file.lines.length;
      const rep = buildNew(file.lines, start, h.o, h.n, m.tier);
      file.lines = [...file.lines.slice(0, start), ...rep, ...file.lines.slice(start + h.o.length)];
      if (touchesEnd) file.finalBreak = !h.noEolCtxPlus;
      d += h.n.length - h.o.length;
    } else {
      const pos = Math.max(0, Math.min(h.a + d, file.lines.length));
      const atEnd = pos === file.lines.length;
      const ins = h.n.map((nl) => nl.text);
      file.lines = [...file.lines.slice(0, pos), ...ins, ...file.lines.slice(pos)];
      if (atEnd && ins.length > 0) file.finalBreak = !h.noEolCtxPlus;
      d += h.n.length;
    }
  }
  return file;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => (tree: Tree) => {
    const oldP = sec.oldP;
    const newP = sec.newP;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = sec.creation || oldP === null;
    const isDelete = !isCreate && (sec.deletion || newP === null);
    if (isCreate) {
      const p = newP!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const content: string[] = [];
      let lastNoEol = false;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (const nl of h.n) {
          if (nl.ctx === null) {
            content.push(nl.text);
            hasPlus = true;
          }
        }
        if (hasPlus) lastNoEol = h.noEolPlus;
      }
      const f: FileParts = { lines: content, br: '\n', finalBreak: content.length > 0 && !lastNoEol };
      tree.now.set(p, joinFile(f));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      // Move.
      const cur = tree.get(oldP!);
      if (cur === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const out = joinFile(applyHunks(splitFile(cur), sec.hunks, strict, oldP!));
      tree.now.set(newP!, out);
      tree.now.set(oldP!, null);
      tree.recordMove(oldP!, newP!);
      return;
    }
    const p = oldP!;
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    tree.now.set(p, joinFile(applyHunks(splitFile(cur), sec.hunks, strict, p)));
  });
}

/* ---- Section 7: SEARCH/REPLACE blocks ---- */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevEnd = 0; // index just past the previous block's REPLACE line
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break; // REPLACE before =======: malformed
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (t.trim() === '') continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (blocks.length === 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = blocks[blocks.length - 1]!.path;
    }
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseSearchReplace(lines);
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      const f: FileParts = { lines: [...b.newLines], br: '\n', finalBreak: b.newLines.length > 0 };
      tree.now.set(b.path, joinFile(f));
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const file = splitFile(cur);
    const m = firstTier(file.lines, b.oldLines, strict);
    if (m === null) throw new Fail('no-match', b.path);
    if (m.occ.length > 1) throw new Fail('ambiguous', b.path);
    const start = m.occ[0]!;
    const n: NewLine[] = b.newLines.map((t) => ({ text: t, ctx: null }));
    const rep = buildNew(file.lines, start, b.oldLines, n, m.tier);
    file.lines = [...file.lines.slice(0, start), ...rep, ...file.lines.slice(start + b.oldLines.length)];
    tree.now.set(b.path, joinFile(file));
  });
}

/* ---- Section 8: V4A patches ---- */

interface V4AChunk {
  anchor: string | null;
  o: string[];
  n: NewLine[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[]; // Add File lines
  chunks: V4AChunk[];
  updateLine: number; // 1-based line of the Update File line, for parse errors
}

function v4aSectionStart(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  const kinds = [
    ['*** Add File:', 'add'],
    ['*** Delete File:', 'delete'],
    ['*** Update File:', 'update'],
  ] as const;
  for (const [prefix, kind] of kinds) {
    if (line === prefix) return { kind, path: '' };
    if (line.startsWith(prefix + ' ')) return { kind, path: line.slice(prefix.length + 1).trim() };
  }
  return null;
}

function buildV4AChunk(anchor: string | null, body: string[], eof: boolean): V4AChunk {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.startsWith(' ')) {
      o.push(b.slice(1));
      n.push({ text: b.slice(1), ctx: o.length - 1 });
    } else if (b.startsWith('-')) {
      o.push(b.slice(1));
    } else if (b.startsWith('+')) {
      n.push({ text: b.slice(1), ctx: null });
    } else if (b === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    }
  }
  return { anchor, o, n, eof };
}

function parseV4a(lines: string[]): V4ASection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const ss = v4aSectionStart(line);
    if (ss === null) throw new Exit2(`error: parse ${i + 1}`);
    if (ss.kind === 'add') {
      i++;
      const ls: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (v4aSectionStart(l) !== null) break;
        if (l.startsWith('+')) {
          ls.push(l.slice(1));
          i++;
          continue;
        }
        if (l.trim() === '') {
          ls.push('');
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (ls.length > 0 && ls[ls.length - 1] === '') ls.pop();
      sections.push({ kind: 'add', path: ss.path, moveTo: null, lines: ls, chunks: [], updateLine: 0 });
      continue;
    }
    if (ss.kind === 'delete') {
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (blank(l)) {
          i++;
          continue;
        }
        if (v4aSectionStart(l) !== null) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push({ kind: 'delete', path: ss.path, moveTo: null, lines: [], chunks: [], updateLine: 0 });
      continue;
    }
    // Update File.
    const updateLine = i + 1;
    i++;
    let moveTo: string | null = null;
    if (i < last && lines[i] === '*** Move to:') {
      moveTo = '';
      i++;
    } else if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i++;
    }
    const chunks: V4AChunk[] = [];
    let curAnchor: string | null = null;
    let curBody: string[] = [];
    let curEof = false;
    let haveChunk = false;
    const pushChunk = (stripTrailing: boolean): void => {
      if (!haveChunk) return;
      const body = [...curBody];
      if (stripTrailing) {
        while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
      }
      chunks.push(buildV4AChunk(curAnchor, body, curEof));
      curBody = [];
      curEof = false;
      haveChunk = false;
    };
    while (i < last) {
      const l = lines[i]!;
      if (v4aSectionStart(l) !== null) break;
      if (l.startsWith('@@')) {
        pushChunk(false);
        const anchorText = l.slice(2).trim();
        curAnchor = anchorText === '' ? null : anchorText;
        haveChunk = true;
        i++;
        continue;
      }
      if (l === '*** End of File') {
        if (!haveChunk) {
          curAnchor = null;
          curBody = [];
          haveChunk = true;
        }
        curEof = true;
        pushChunk(false);
        i++;
        continue;
      }
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        if (!haveChunk) {
          curAnchor = null;
          haveChunk = true;
        }
        curBody.push(l);
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    pushChunk(true);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
    sections.push({ kind: 'update', path: ss.path, moveTo, lines: [], chunks, updateLine });
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4a(lines);
  return sections.map((sec) => (tree: Tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      const f: FileParts = { lines: [...sec.lines], br: '\n', finalBreak: sec.lines.length > 0 };
      tree.now.set(sec.path, joinFile(f));
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    // Update.
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const file = splitFile(cur);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let found: number | null = null;
        for (const t of tiers) {
          const key = tierKey(ch.anchor, t);
          for (let k = cursor; k < file.lines.length; k++) {
            if (tierKey(file.lines[k]!, t) === key) {
              found = k;
              break;
            }
          }
          if (found !== null) break;
        }
        if (found === null) throw new Fail('no-match', sec.path);
        cursor = found + 1;
      }
      if (ch.o.length > 0) {
        if (ch.eof) {
          const tiers = strict ? [0] : [0, 1, 2];
          const start = file.lines.length - ch.o.length;
          let hit: { tier: number; start: number } | null = null;
          if (start >= cursor) {
            for (const t of tiers) {
              if (occurrencesAt(file.lines, ch.o, t).includes(start)) {
                hit = { tier: t, start };
                break;
              }
            }
          }
          if (hit === null) throw new Fail('no-match', sec.path);
          const rep = buildNew(file.lines, hit.start, ch.o, ch.n, hit.tier);
          file.lines = [...file.lines.slice(0, hit.start), ...rep, ...file.lines.slice(hit.start + ch.o.length)];
          cursor = hit.start + rep.length;
        } else {
          const m = firstTierFrom(file.lines, ch.o, cursor, strict);
          if (m === null) throw new Fail('no-match', sec.path);
          const start = m.occ[0]!;
          const rep = buildNew(file.lines, start, ch.o, ch.n, m.tier);
          file.lines = [...file.lines.slice(0, start), ...rep, ...file.lines.slice(start + ch.o.length)];
          cursor = start + rep.length;
        }
      } else {
        const pos = ch.eof ? file.lines.length : cursor;
        const ins = ch.n.map((nl) => nl.text);
        file.lines = [...file.lines.slice(0, pos), ...ins, ...file.lines.slice(pos)];
        cursor = pos + ins.length;
      }
    }
    const out = joinFile(file);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.recordMove(sec.path, sec.moveTo);
    } else {
      tree.now.set(sec.path, out);
    }
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const deleted = new Set<string>();
  const created = new Set<string>();
  const modified = new Set<string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) created.add(p);
    else if (now === null) deleted.add(p);
    else modified.add(p);
  }
  const outRows: { key: string; line: string }[] = [];
  for (const [oldP, newP] of tree.moveChain) {
    if (deleted.has(oldP) && created.has(newP)) {
      deleted.delete(oldP);
      created.delete(newP);
      outRows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of deleted) outRows.push({ key: p, line: `D ${p}` });
  for (const p of created) outRows.push({ key: p, line: `A ${p}` });
  for (const p of modified) outRows.push({ key: p, line: `M ${p}` });
  outRows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = outRows.map((r) => r.line);
  if (!check) {
    const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const p of changed) {
      if (tree.now.get(p) === null && tree.original(p) !== null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null || tree.original(p) === now) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
