import type { Part, Pipeline, Redirect, Script, Sequence, Simple, Word } from "./shell";

/** Reads a PowerShell or cmd.exe command line into the gate's command tree; what neither grammar covers comes back unreadable for a doubt. */

export interface WindowsParsed {
  script: Script;
  unreadable: string | null;
}

const PS_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

/** One word's parts as the line's shell would spell them; run-time pieces stay parts. */
class WordRead {
  private parts: Part[] = [];
  private text = "";

  constructor(
    private readonly src: string,
    private readonly kind: "ps" | "cmd",
  ) {}

  private flush(quote: "none" | "single" | "double" = "none"): void {
    this.parts.push({ kind: "text", text: this.text, quote });
    this.text = "";
  }

  /** Reads from `at` until a blank, a separator or an operator; `stop` is where it ended and `bad` a construct the read does not model. */
  scan(at: number): { word: Word; stop: number; bad: boolean } {
    const start = at;
    let i = at;
    let bad = false;
    const src = this.src;
    while (i < src.length) {
      const c = src[i];
      if (" \t\n;|<>".includes(c)) break;
      if (this.kind === "ps") {
        if (c === "&") break;
        if (c === "`") {
          this.text += src[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (c === "'") {
          const end = quoteEnd(src, i, "'");
          if (this.text) this.flush();
          this.parts.push({ kind: "text", text: end.text, quote: "single" });
          i = end.at;
          continue;
        }
        if (c === '"') {
          if (this.text) this.flush();
          const read = this.doubleQuote(i);
          bad ||= read.bad;
          i = read.at;
          continue;
        }
        if (c === "$" || (c === "@" && src[i + 1] === "(")) {
          const read = this.dollar(i);
          if (read === null) {
            bad = true;
            break;
          }
          if (this.text) this.flush();
          this.parts.push(read.part);
          i = read.at;
          continue;
        }
        if (c === "~" && this.parts.length === 0 && !this.text) {
          this.parts.push({ kind: "tilde", user: "" });
          i += 1;
          continue;
        }
        if (c === "{" || c === "}" || c === "(" || c === ")") {
          bad = true;
          break;
        }
      } else {
        if (c === "&") break;
        if (c === "^") {
          this.text += src[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (c === '"') {
          if (this.text) this.flush();
          const read = this.cmdQuote(i);
          bad ||= read.bad;
          i = read.at;
          continue;
        }
        if (c === "%" || c === "!") {
          const read = this.percent(i);
          if (read !== null) {
            if (this.text) this.flush();
            this.parts.push(read.part);
            i = read.at;
            continue;
          }
        }
        if (c === "(" || c === ")") {
          bad = true;
          break;
        }
      }
      this.text += c;
      i += 1;
    }
    if (this.text) this.flush();
    return { word: { raw: src.slice(start, i), start, end: i, parts: this.parts }, stop: i, bad };
  }

  /** A `"` stretch of a PowerShell word: `$` pieces inside stay run-time parts. */
  private doubleQuote(at: number): { at: number; bad: boolean } {
    let i = at + 1;
    let bad = false;
    while (i < this.src.length) {
      const c = this.src[i];
      if (c === '"') break;
      if (c === "`") {
        this.text += this.src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === "$") {
        const read = this.dollar(i);
        if (read === null) {
          bad = true;
          break;
        }
        if (this.text) this.flush("double");
        this.parts.push({ ...read.part, quoted: true } as Part);
        i = read.at;
        continue;
      }
      this.text += c;
      i += 1;
    }
    this.flush("double");
    return { at: i + 1, bad: bad || i >= this.src.length };
  }

  /** A `"` stretch of a cmd word: `%VAR%` inside stays a run-time part. */
  private cmdQuote(at: number): { at: number; bad: boolean } {
    let i = at + 1;
    let bad = false;
    while (i < this.src.length) {
      const c = this.src[i];
      if (c === '"') break;
      if (c === "%" || c === "!") {
        const read = this.percent(i);
        if (read !== null) {
          if (this.text) this.flush("double");
          this.parts.push({ ...read.part, quoted: true } as Part);
          i = read.at;
          continue;
        }
      }
      this.text += c;
      i += 1;
    }
    this.flush("double");
    return { at: i + 1, bad: bad || i >= this.src.length };
  }

  /** `$name`, `${name}`, `$env:name`, or a `$(...)`/`@(...)` the line runs; null where the dollar spells nothing the read covers. */
  private dollar(at: number): { part: Part; at: number } | null {
    const src = this.src;
    const open = src[at] === "@" && src[at + 1] === "(" ? at + 1 : src[at] === "$" && src[at + 1] === "(" ? at : -1;
    if (open >= 0) {
      const end = nestedEnd(src, open + 1);
      if (end < 0) return null;
      const inner = parseWindows(src.slice(open + 1, end), this.kind);
      return {
        part: { kind: "command", script: inner.script, raw: src.slice(at, end + 1), quoted: false },
        at: end + 1,
      };
    }
    if (src[at] !== "$") return null;
    let name: string | undefined;
    let len = 0;
    let env = false;
    if (src[at + 1] === "{") {
      const close = src.indexOf("}", at + 2);
      if (close > at + 2) {
        name = src.slice(at + 2, close);
        len = close - at + 1;
      }
    } else {
      env = /^env:/i.test(src.slice(at + 1, at + 5));
      const start = at + 1 + (env ? 4 : 0);
      name = PS_NAME.exec(src.slice(start))?.[0];
      if (name) len = start - at + name.length;
    }
    if (!name) return null;
    return {
      part: {
        kind: "param",
        name: env ? `env:${name}` : name,
        raw: src.slice(at, at + len),
        quoted: false,
        scripts: [],
      },
      at: at + len,
    };
  }

  /** `%NAME%` or `!NAME!`; null where the closing mark never comes, the mark staying literal. */
  private percent(at: number): { part: Part; at: number } | null {
    const src = this.src;
    const mark = src[at];
    const name = PS_NAME.exec(src.slice(at + 1))?.[0];
    if (!name || src[at + 1 + name.length] !== mark) return null;
    return {
      part: { kind: "param", name, raw: src.slice(at, at + 2 + name.length), quoted: false, scripts: [] },
      at: at + 2 + name.length,
    };
  }
}

/** The text of a quoted stretch and where it ends; two marks in a row stay one. */
function quoteEnd(src: string, at: number, mark: string): { text: string; at: number } {
  let text = "";
  for (let i = at + 1; i < src.length; i += 1) {
    if (src[i] === mark) {
      if (src[i + 1] === mark) {
        text += mark;
        i += 1;
        continue;
      }
      return { text, at: i + 1 };
    }
    text += src[i];
  }
  return { text, at: src.length };
}

/** The index of the `)` closing the `(` before `at`, quotes and nests counted; -1 when it never comes. */
function nestedEnd(src: string, at: number): number {
  let depth = 1;
  for (let i = at; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = quoteEnd(src, i, c).at - 1;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The literal of a word, null where a part of it waits for run time. */
const literalOf = (word: Word): string | null =>
  word.parts.every((p) => p.kind === "text") ? word.parts.map((p) => (p as { text: string }).text).join("") : null;

/** `>`, `>>`, `<`, an `n>` fd, an `n>&m` dup, or PowerShell's `*>`; null where the target never comes. */
function redirect(
  src: string,
  at: number,
  fd: string | null,
  kind: "ps" | "cmd",
): { redirect: Redirect; at: number } | null {
  let i = at;
  let stream = fd;
  if (src[i] === "*" && src[i + 1] === ">") {
    stream = "*";
    i += 1;
  }
  const op: Redirect["op"] = src.startsWith(">>", i) ? ">>" : (src[i] as Redirect["op"]);
  i += op === ">>" ? 2 : 1;
  while (" \t".includes(src[i])) i += 1;
  if (src[i] === "&" && /\d/.test(src[i + 1] ?? "")) {
    const to: Word = {
      raw: src[i + 1],
      start: i + 1,
      end: i + 2,
      parts: [{ kind: "text", text: src[i + 1], quote: "none" }],
    };
    return { redirect: { op: op === "<" ? "<&" : ">&", fd: stream, target: to, heredoc: null }, at: i + 2 };
  }
  const read = new WordRead(src, kind).scan(i);
  if (!read.word.parts.length) return null;
  return { redirect: { op, fd: stream, target: read.word, heredoc: null }, at: read.stop };
}

/** One command's words and redirects from `at`; a lone `&` inside a PowerShell line is its call marker, read over. */
function simple(src: string, at: number, kind: "ps" | "cmd"): { simple: Simple; stop: number; bad: boolean } {
  const out: Simple = { kind: "simple", assigns: [], words: [], redirects: [], start: at, end: at };
  let i = at;
  let bad = false;
  while (i < src.length) {
    const c = src[i];
    if (" \t\n".includes(c)) {
      i += 1;
      continue;
    }
    if (";|".includes(c) || (c === "&" && (kind === "cmd" || src[i + 1] === "&" || out.words.length > 0))) break;
    if (c === "&" && kind === "ps" && out.words.length === 0) {
      i += 1;
      continue;
    }
    if (c === "<" || c === ">" || (c === "*" && src[i + 1] === ">")) {
      const last = out.words[out.words.length - 1];
      const fd = last && /^\d$/.test(literalOf(last) ?? "") ? (out.words.pop(), literalOf(last)) : null;
      const read = redirect(src, i, fd ?? null, kind);
      if (read === null) {
        bad = true;
        break;
      }
      out.redirects.push(read.redirect);
      i = read.at;
      continue;
    }
    const read = new WordRead(src, kind).scan(i);
    if (!read.word.parts.length) break;
    bad ||= read.bad;
    out.words.push(read.word);
    i = read.stop;
  }
  out.end = i;
  return { simple: out, stop: i, bad };
}

/** The assignment a `set X=v`, `$x = v` or `$x=v` line carries, lifted out of its words. */
function liftAssigns(out: Simple, kind: "ps" | "cmd"): void {
  const words = out.words;
  if (kind === "cmd" && words.length > 1 && /^set$/i.test(literalOf(words[0]) ?? "")) {
    const text = words
      .slice(1)
      .map((w) => w.raw)
      .join(" ");
    const match = /^"?([A-Za-z_][A-Za-z0-9_]*)=(.*)"?$/s.exec(text);
    if (match) {
      out.assigns.push({ name: match[1], append: false, indexed: false, value: words[words.length - 1], items: null });
      out.words = [];
    }
    return;
  }
  if (kind === "ps") {
    const spaced = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(words[0]?.raw ?? "")?.[1];
    if (spaced && words.length > 1 && literalOf(words[1]) === "=") {
      out.assigns.push({ name: spaced, append: false, indexed: false, value: words[2] ?? null, items: null });
      out.words = words.slice(3);
      return;
    }
    const inline = /^\$([A-Za-z_][A-Za-z0-9_]*)=$/.exec(words[0]?.raw ?? "")?.[1];
    if (inline) {
      out.assigns.push({ name: inline, append: false, indexed: false, value: words[1] ?? null, items: null });
      out.words = words.slice(2);
    }
  }
}

/** A PowerShell or cmd line read as far as its grammar goes: sequences of pipelines of commands, and the tail that would not tokenize. */
export function parseWindows(src: string, kind: "ps" | "cmd"): WindowsParsed {
  const script: Script = [];
  let sequence: Sequence = { pipelines: [], ops: [], background: false };
  let pipeline: Pipeline = { negated: false, commands: [], pipes: [] };
  let unreadable: string | null = null;
  let i = 0;
  const closePipeline = () => {
    if (pipeline.commands.length) sequence.pipelines.push(pipeline);
    pipeline = { negated: false, commands: [], pipes: [] };
  };
  const closeSequence = () => {
    closePipeline();
    if (sequence.pipelines.length) script.push(sequence);
    sequence = { pipelines: [], ops: [], background: false };
  };
  while (i < src.length) {
    const c = src[i];
    if (" \t".includes(c)) {
      i += 1;
      continue;
    }
    if (c === "\n" || c === ";") {
      closeSequence();
      i += 1;
      continue;
    }
    if (src.startsWith("&&", i) || src.startsWith("||", i)) {
      sequence.ops.push(src.slice(i, i + 2) as "&&" | "||");
      closePipeline();
      i += 2;
      continue;
    }
    if (c === "&") {
      if (kind === "cmd") closeSequence();
      else unreadable = unreadable ?? src.slice(i, i + 200);
      i += 1;
      if (kind === "ps") break;
      continue;
    }
    if (c === "|") {
      pipeline.pipes.push("|");
      i += 1;
      continue;
    }
    const read = simple(src, i, kind);
    if (read.simple.words.length || read.simple.assigns.length || read.simple.redirects.length) {
      liftAssigns(read.simple, kind);
      pipeline.commands.push(read.simple);
    }
    i = read.stop;
    if (read.bad) {
      unreadable = unreadable ?? src.slice(i, i + 200);
      break;
    }
    if (i < src.length && src[i] === "|" && src[i + 1] !== "|") continue;
  }
  closeSequence();
  return { script, unreadable };
}
