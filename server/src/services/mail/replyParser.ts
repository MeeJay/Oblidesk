/**
 * replyParser.ts — reply-above-the-line.
 *
 * An inbound reply is four things glued together: what the person actually
 * wrote, the quoted history their client helpfully re-sent, their signature,
 * and (increasingly) three paragraphs of legal boilerplate. A timeline that
 * renders all four is unreadable by the fifth message; a timeline that renders
 * only the first is a lie of omission.
 *
 * So this module COLLAPSES. It does not delete.
 *
 * ── The two invariants ──────────────────────────────────────────────────────
 *
 *   1. NOTHING IS DROPPED. The parser returns a partition of the input: every
 *      byte lands in exactly one segment, and `assertTiles()` proves it before
 *      the result is returned. If the partition does not reconstruct the input
 *      exactly, the parser gives up and calls the whole message "reply" —
 *      being verbose is a cosmetic failure, losing a customer's sentence is
 *      not. This is checked rather than reasoned about because the boundary
 *      heuristics below are regex-shaped, and regexes are where "obviously it
 *      tiles" goes to die.
 *
 *   2. ONE BAD PART NEVER FAILS THE MESSAGE. Every decode is wrapped: a body
 *      part with a charset nobody has heard of, a truncated base64 blob, a
 *      quoted-printable stream that ends mid-escape — each degrades to bytes
 *      plus a parse-error note, and the message still becomes a ticket. A mail
 *      pipeline that 500s on one malformed vendor signature is a mail pipeline
 *      that silently stops taking tickets on a Friday afternoon.
 *
 * ── What the caller does with the result ────────────────────────────────────
 *
 * `journal.body_html` gets the reply only. The collapsed segments go into
 * `journal.meta.mail.chip` as ONE pre-rendered, already-sanitised block, plus
 * `meta.mail.segments` for a client that wants to label them individually. The
 * raw RFC-822 message is kept under `mail_messages.raw_key` regardless, so
 * "show me exactly what they sent" is always answerable.
 *
 * The chip is rendered with `<blockquote>` and `<p>` rather than a `<div>` with
 * a class, because `utils/markdown`'s allowlist keeps neither `div` nor
 * `class` — a chip that depends on markup the sanitiser strips is a chip that
 * silently becomes a wall of text in production.
 */
import { escapeHtml, htmlToPlainText, sanitizeHtml } from '../../utils/markdown';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Shapes
// ═════════════════════════════════════════════════════════════════════════════

export type SegmentKind = 'reply' | 'quote' | 'signature' | 'disclaimer';

export interface TextSegment {
  kind: SegmentKind;
  text: string;
  /** Byte-for-byte offsets into the source. The partition proof reads these. */
  start: number;
  end: number;
  /** Why the boundary was drawn here — surfaced in the chip's label. */
  reason: string;
}

export interface ParsedReply {
  /** Above the line. This is what the timeline shows uncollapsed. */
  replyText: string;
  /** Sanitised HTML for the reply half, or null when the source was text-only. */
  replyHtml: string | null;
  /** Everything collapsed, in source order. */
  collapsed: TextSegment[];
  /** ONE already-sanitised block for the expandable chip. Empty when nothing collapsed. */
  chipHtml: string;
  /** Plain-text version of the collapsed half, for search and for digests. */
  chipText: string;
  /** Non-fatal problems: a charset we guessed at, a part that would not decode. */
  warnings: string[];
  /** True when the partition proof failed and the parser fell back to verbatim. */
  degraded: boolean;
}

export interface ParseReplyInput {
  text?: string | null;
  html?: string | null;
  /** RFC 3676 — `Content-Type: text/plain; format=flowed`. */
  formatFlowed?: boolean;
  delSp?: boolean;
  /** Off means "keep the whole thing above the line" (a tenant setting). */
  collapseQuotes?: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Transfer decoding, none of which may throw
// ═════════════════════════════════════════════════════════════════════════════

export interface DecodeResult {
  value: string;
  /** NULL on a clean decode. A string here becomes a parse-error chip. */
  error: string | null;
}

/**
 * Quoted-printable, RFC 2045 §6.7.
 *
 * Written out rather than reached for through a library because the failure
 * mode matters more than the happy path: a soft line break at the very end of
 * a truncated part, an `=` followed by one hex digit, an `=` followed by
 * nothing. Each of those appears in real mail from real appliances, and each
 * must produce output rather than an exception.
 */
export function decodeQuotedPrintable(input: string | Buffer): Buffer {
  const source = Buffer.isBuffer(input) ? input.toString('binary') : String(input);
  const out: number[] = [];

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch !== '=') {
      out.push(source.charCodeAt(i) & 0xff);
      continue;
    }

    // Soft line break: `=` at end of line, possibly with trailing whitespace.
    const rest = source.slice(i + 1);
    const soft = /^[ \t]*\r?\n/.exec(rest);
    if (soft) {
      i += soft[0].length;
      continue;
    }

    const hex = /^([0-9A-Fa-f]{2})/.exec(rest);
    if (hex) {
      out.push(parseInt(hex[1], 16));
      i += 2;
      continue;
    }

    // A lone `=`. Not legal, and common. Keep it — dropping it would silently
    // change a price list or a URL.
    out.push(0x3d);
  }

  return Buffer.from(out);
}

/** Base64 that tolerates the whitespace, wrapping and missing padding real mail has. */
export function decodeBase64Loose(input: string | Buffer): Buffer {
  const cleaned = (Buffer.isBuffer(input) ? input.toString('ascii') : String(input)).replace(
    /[^A-Za-z0-9+/=]/g,
    '',
  );
  // Buffer.from ignores trailing garbage, but an unpadded length still decodes
  // short. Pad to a multiple of four so an Apple `base64` part that lost its
  // final `=` yields the last character rather than losing it.
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/** Charsets Node's Buffer understands natively, by their common mail spellings. */
const NATIVE_CHARSETS: Readonly<Record<string, BufferEncoding>> = {
  'utf-8': 'utf8',
  utf8: 'utf8',
  'us-ascii': 'ascii',
  ascii: 'ascii',
  'iso-8859-1': 'latin1',
  'iso8859-1': 'latin1',
  latin1: 'latin1',
  'cp1252': 'latin1',
  'utf-16le': 'utf16le',
  'utf-16': 'utf16le',
  'ucs-2': 'utf16le',
};

/**
 * Bytes → string, guessing when the header lies or is missing.
 *
 * Order matters:
 *   1. an explicit charset Node knows natively;
 *   2. `TextDecoder`, which on a full-ICU Node (the default since 14) handles
 *      windows-1252, koi8-r, shift_jis, gb18030 and the rest;
 *   3. a BOM;
 *   4. a UTF-8 validity probe — a byte sequence that round-trips through UTF-8
 *      almost certainly IS UTF-8, whatever the header claimed;
 *   5. latin1, which cannot fail and cannot lose a byte (every octet maps to a
 *      code point), so the worst case is mojibake the raw .eml can resolve.
 *
 * Never throws. An unknown charset is a warning, not an outage.
 */
export function decodeCharset(bytes: Buffer, charset?: string | null): DecodeResult {
  const declared = (charset ?? '').trim().toLowerCase().replace(/^["']|["']$/g, '');

  if (declared && NATIVE_CHARSETS[declared]) {
    return { value: bytes.toString(NATIVE_CHARSETS[declared]), error: null };
  }

  if (declared) {
    try {
      return { value: new TextDecoder(declared, { fatal: false }).decode(bytes), error: null };
    } catch {
      // Fall through to the guesses, and say so.
    }
  }

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return {
      value: bytes.subarray(3).toString('utf8'),
      error: declared ? `unknown charset "${declared}" — decoded as UTF-8 (BOM)` : null,
    };
  }

  const asUtf8 = bytes.toString('utf8');
  if (!asUtf8.includes('�')) {
    return {
      value: asUtf8,
      error: declared ? `unknown charset "${declared}" — decoded as UTF-8` : null,
    };
  }

  return {
    value: bytes.toString('latin1'),
    error: `could not decode charset "${declared || 'unspecified'}" — fell back to latin-1`,
  };
}

/** Apply a Content-Transfer-Encoding. Unknown encodings pass through untouched. */
export function decodeTransferEncoding(
  raw: Buffer,
  encoding: string | null | undefined,
): { bytes: Buffer; error: string | null } {
  const name = (encoding ?? '').trim().toLowerCase();
  try {
    if (name === 'quoted-printable') return { bytes: decodeQuotedPrintable(raw), error: null };
    if (name === 'base64') return { bytes: decodeBase64Loose(raw), error: null };
    return { bytes: raw, error: null };
  } catch (err) {
    return {
      bytes: raw,
      error: `transfer-encoding "${name}" failed to decode (${(err as Error).message}) — kept raw`,
    };
  }
}

/**
 * One body part, decoded, with every failure caught.
 *
 * This is the function that makes invariant 2 true: it is the only path a body
 * part takes into the parser, and it has no throwing branch.
 */
export function safeDecodePart(
  raw: Buffer,
  options: { encoding?: string | null; charset?: string | null } = {},
): DecodeResult {
  try {
    const transfer = decodeTransferEncoding(raw, options.encoding);
    const charset = decodeCharset(transfer.bytes, options.charset);
    const error = [transfer.error, charset.error].filter(Boolean).join('; ') || null;
    return { value: charset.value, error };
  } catch (err) {
    return {
      value: raw.toString('latin1'),
      error: `part could not be decoded (${(err as Error).message}) — kept as raw bytes`,
    };
  }
}

/**
 * RFC 3676 format=flowed: a trailing space means "this line continues".
 *
 * Undoing it is not cosmetic. Without it, an Apple Mail paragraph arrives as
 * seventy-character lines, the quote detector below sees line starts where the
 * writer saw none, and a hard-wrapped sentence beginning with "From " is read
 * as a forwarded header block.
 *
 * `delSp=yes` means the space itself was inserted by the sender and must be
 * removed on reflow; `delSp=no` means it was theirs and stays.
 */
export function unflow(text: string, delSp = false): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let buffer: string | null = null;

  for (const rawLine of lines) {
    // Space-stuffing: a leading space is escaping, not content.
    const line = rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine;
    // A signature separator is never flowed, even when it looks like it is.
    const isSeparator = line === '-- ';
    const flowed = !isSeparator && line.endsWith(' ');

    const piece = flowed ? (delSp ? line.slice(0, -1) : line) : line;
    buffer = buffer === null ? piece : buffer + piece;

    if (!flowed) {
      out.push(buffer);
      buffer = null;
    }
  }
  if (buffer !== null) out.push(buffer);
  return out.join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Where the reply ends
// ═════════════════════════════════════════════════════════════════════════════

interface Boundary {
  index: number;
  kind: Exclude<SegmentKind, 'reply'>;
  reason: string;
}

/**
 * Attribution lines, multilingual.
 *
 * A desk that only knows `On … wrote:` collapses nothing for a French or
 * German tenant, which means every reply from those tenants renders the whole
 * thread — the exact failure this module exists to prevent, invisible to
 * whoever tested it in English.
 */
const ATTRIBUTION_PATTERNS: readonly RegExp[] = [
  // English: "On Tue, 3 Sep 2024 at 09:14, Jane Doe <jane@x> wrote:"
  /^\s*(?:on\b[\s\S]{0,220}?\bwrote\s*:)\s*$/im,
  /^\s*(?:on\b[\s\S]{0,220}?\bwrote\s*:)$/im,
  // French: "Le mar. 3 sept. 2024 à 09:14, Jane Doe a écrit :"
  /^\s*le\b[\s\S]{0,220}?\ba\s+écrit\s*:\s*$/im,
  /^\s*le\b[\s\S]{0,220}?\ba\s+ecrit\s*:\s*$/im,
  // German: "Am 03.09.2024 um 09:14 schrieb Jane Doe:"
  /^\s*am\b[\s\S]{0,220}?\bschrieb\b[^\n]{0,120}:\s*$/im,
  // Spanish / Italian / Dutch
  /^\s*el\b[\s\S]{0,220}?\bescribió\s*:\s*$/im,
  /^\s*il\b[\s\S]{0,220}?\bha\s+scritto\s*:\s*$/im,
  /^\s*op\b[\s\S]{0,220}?\bschreef\b[^\n]{0,120}:\s*$/im,
];

/** Hard separators every Outlook-family client emits. */
const SEPARATOR_PATTERNS: readonly { re: RegExp; reason: string }[] = [
  { re: /^-{2,}\s*original message\s*-{2,}\s*$/im, reason: 'Original Message separator' },
  { re: /^-{2,}\s*message d'origine\s*-{2,}\s*$/im, reason: "Message d'origine separator" },
  { re: /^-{2,}\s*ursprüngliche nachricht\s*-{2,}\s*$/im, reason: 'Ursprüngliche Nachricht separator' },
  { re: /^-{2,}\s*forwarded message\s*-{2,}\s*$/im, reason: 'Forwarded message separator' },
  { re: /^-{2,}\s*message transféré\s*-{2,}\s*$/im, reason: 'Message transféré separator' },
  { re: /^_{10,}\s*$/m, reason: 'Outlook horizontal rule' },
  { re: /^\*?from:\*?\s.+\n(?:.*\n){0,4}?\s*\*?(?:sent|date|envoyé|gesendet):\*?\s/im, reason: 'Quoted header block' },
];

/** Legal boilerplate openers. Matched at paragraph level, not word level. */
const DISCLAIMER_PATTERNS: readonly RegExp[] = [
  /^[^\n]{0,80}\bconfidentialit(?:y|é)\s+(?:notice|statement|avis)\b/im,
  /\bthis\s+(?:e-?mail|message)\s+(?:and\s+any\s+(?:attachments?|files?)\s+)?(?:is|are)\s+(?:strictly\s+)?(?:confidential|intended\s+(?:solely|only))/im,
  /\bce\s+(?:message|courriel|e-?mail)\s+(?:et\s+(?:toutes\s+)?(?:les|ses)\s+pi[eè]ces\s+jointes\s+)?(?:est|sont)\s+(?:strictement\s+)?confidentiel/im,
  /\bdiese\s+e-?mail\s+(?:und\s+etwaige\s+anh[äa]nge\s+)?(?:ist|sind)\s+vertraulich/im,
  /\bif\s+you\s+(?:are\s+not\s+the\s+intended\s+recipient|have\s+received\s+this\s+(?:e-?mail|message)\s+in\s+error)\b/im,
  /\bsi\s+vous\s+n['’]?[eê]tes\s+pas\s+le\s+destinataire\b/im,
  /\bplease\s+consider\s+the\s+environment\s+before\s+printing\b/im,
  /\bn['’]?imprimez\s+ce\s+(?:message|courriel)\s+que\s+si\s+n[ée]cessaire\b/im,
];

/**
 * The start of the run of `>`-quoted lines that reaches the end of the message.
 *
 * Only a run that reaches the END counts. A `>` in the middle with prose after
 * it is somebody quoting one line to answer it — collapsing from there would
 * hide their answer, which is the whole message.
 */
function trailingQuoteRunStart(text: string): number | null {
  const lines = text.split('\n');
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    offsets.push(cursor);
    cursor += line.length + 1;
  }

  let start: number | null = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (/^\s*>/.test(line)) {
      start = offsets[i];
      continue;
    }
    if (line.trim() === '' && start !== null) continue;
    break;
  }
  // A single quoted line at the very end is usually a stray, not a thread.
  if (start === null) return null;
  const quotedLines = text.slice(start).split('\n').filter((l) => /^\s*>/.test(l)).length;
  return quotedLines >= 2 ? start : null;
}

/**
 * The signature separator. RFC 3676 §4.3 spells it `-- ` (with the space); a
 * great many clients drop the space, so both are accepted — but only when what
 * follows is SHORT. A `--` twenty lines from the end is a horizontal rule
 * somebody typed, and treating it as a signature would collapse their message.
 */
function signatureStart(text: string): number | null {
  const re = /(^|\n)(--[ \t]?)(\r?\n)/g;
  let match: RegExpExecArray | null;
  let best: number | null = null;
  while ((match = re.exec(text)) !== null) {
    const index = match.index + (match[1] ? match[1].length : 0);
    const tail = text.slice(index);
    const lines = tail.split('\n').length;
    if (lines <= 14) best = index;
  }
  return best;
}

function firstMatch(text: string, patterns: readonly RegExp[]): number | null {
  let best: number | null = null;
  for (const pattern of patterns) {
    // Patterns are module-level; `exec` on a /g regex would carry lastIndex
    // between calls. None of these carry /g, and `search` cannot either.
    const index = text.search(pattern);
    if (index >= 0 && (best === null || index < best)) best = index;
  }
  return best;
}

function collectBoundaries(text: string): Boundary[] {
  const marks: Boundary[] = [];

  const attribution = firstMatch(text, ATTRIBUTION_PATTERNS);
  if (attribution !== null) {
    marks.push({ index: attribution, kind: 'quote', reason: 'Attribution line' });
  }

  for (const { re, reason } of SEPARATOR_PATTERNS) {
    const index = text.search(re);
    if (index >= 0) marks.push({ index, kind: 'quote', reason });
  }

  const quoteRun = trailingQuoteRunStart(text);
  if (quoteRun !== null) marks.push({ index: quoteRun, kind: 'quote', reason: 'Quoted history' });

  const signature = signatureStart(text);
  if (signature !== null) marks.push({ index: signature, kind: 'signature', reason: 'Signature block' });

  const disclaimer = firstMatch(text, DISCLAIMER_PATTERNS);
  if (disclaimer !== null) {
    // Snap back to the start of the paragraph so the collapsed block reads as
    // one thing rather than starting mid-sentence.
    const before = text.lastIndexOf('\n\n', disclaimer);
    marks.push({
      index: before >= 0 ? before + 2 : disclaimer,
      kind: 'disclaimer',
      reason: 'Legal disclaimer',
    });
  }

  return marks.sort((a, b) => a.index - b.index || a.kind.localeCompare(b.kind));
}

/**
 * INVARIANT 1, enforced. The segments must reconstruct the source exactly.
 *
 * A `join('')` comparison rather than a length check: two off-by-one errors
 * that cancel out would pass a length check and silently reorder somebody's
 * paragraph.
 */
function assertTiles(source: string, segments: readonly TextSegment[]): boolean {
  let cursor = 0;
  for (const segment of segments) {
    if (segment.start !== cursor) return false;
    if (segment.end < segment.start || segment.end > source.length) return false;
    cursor = segment.end;
  }
  return cursor === source.length && segments.map((s) => s.text).join('') === source;
}

/**
 * Partition plain text into reply + collapsed segments.
 *
 * Exported on its own because the digest builder and the search indexer want
 * the reply half without paying for HTML sanitisation.
 */
export function splitPlainText(text: string): { segments: TextSegment[]; degraded: boolean } {
  const source = text.replace(/\r\n/g, '\n');
  const verbatim: TextSegment[] = [
    { kind: 'reply', text: source, start: 0, end: source.length, reason: 'Whole message' },
  ];
  if (source.trim() === '') return { segments: verbatim, degraded: false };

  const marks = collectBoundaries(source).filter((mark) => mark.index > 0);
  if (marks.length === 0) return { segments: verbatim, degraded: false };

  const cuts: Boundary[] = [];
  for (const mark of marks) {
    // Two detectors firing on the same block (an attribution line immediately
    // followed by `>` quoting) must not produce a zero-length segment.
    if (cuts.length > 0 && mark.index <= cuts[cuts.length - 1].index) continue;
    cuts.push(mark);
  }

  const segments: TextSegment[] = [
    { kind: 'reply', text: source.slice(0, cuts[0].index), start: 0, end: cuts[0].index, reason: 'Reply' },
  ];
  for (let i = 0; i < cuts.length; i += 1) {
    const start = cuts[i].index;
    const end = i + 1 < cuts.length ? cuts[i + 1].index : source.length;
    segments.push({ kind: cuts[i].kind, text: source.slice(start, end), start, end, reason: cuts[i].reason });
  }

  if (!assertTiles(source, segments)) return { segments: verbatim, degraded: true };
  return { segments, degraded: false };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — The HTML side
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Where the quoted history starts in an HTML body.
 *
 * Every client marks it, and every client marks it differently. These are the
 * markers as they actually appear on the wire, not as the vendors document
 * them: Gmail's `gmail_quote`, Outlook Web's `divRplyFwdMsg` and
 * `appendonsend`, Thunderbird's `moz-cite-prefix`, Apple Mail's plain
 * `blockquote type="cite"`, Yahoo's `yahoo_quoted`.
 */
const HTML_QUOTE_MARKERS: readonly { re: RegExp; reason: string }[] = [
  { re: /<div[^>]+class\s*=\s*["'][^"']*\bgmail_quote\b/i, reason: 'Gmail quote' },
  { re: /<div[^>]+id\s*=\s*["']divRplyFwdMsg["']/i, reason: 'Outlook reply header' },
  { re: /<div[^>]+id\s*=\s*["']appendonsend["']/i, reason: 'Outlook appended thread' },
  { re: /<div[^>]+class\s*=\s*["'][^"']*\bmoz-cite-prefix\b/i, reason: 'Thunderbird citation' },
  { re: /<div[^>]+class\s*=\s*["'][^"']*\byahoo_quoted\b/i, reason: 'Yahoo quote' },
  { re: /<div[^>]+class\s*=\s*["'][^"']*\bOutlookMessageHeader\b/i, reason: 'Outlook message header' },
  { re: /<blockquote[^>]+type\s*=\s*["']cite["']/i, reason: 'Cited blockquote' },
  { re: /<hr[^>]*\bid\s*=\s*["']stopSpelling["']/i, reason: 'Outlook separator rule' },
];

const HTML_SIGNATURE_MARKERS: readonly { re: RegExp; reason: string }[] = [
  { re: /<div[^>]+id\s*=\s*["']Signature["']/i, reason: 'Signature block' },
  { re: /<div[^>]+class\s*=\s*["'][^"']*\bgmail_signature\b/i, reason: 'Gmail signature' },
  { re: /(?:^|>)\s*--\s*(?:<br\s*\/?>|<\/p>)/i, reason: 'Signature separator' },
];

export function splitHtml(html: string): { segments: TextSegment[]; degraded: boolean } {
  const source = html;
  const verbatim: TextSegment[] = [
    { kind: 'reply', text: source, start: 0, end: source.length, reason: 'Whole message' },
  ];
  if (source.trim() === '') return { segments: verbatim, degraded: false };

  const marks: Boundary[] = [];
  for (const { re, reason } of HTML_QUOTE_MARKERS) {
    const index = source.search(re);
    if (index > 0) marks.push({ index, kind: 'quote', reason });
  }
  for (const { re, reason } of HTML_SIGNATURE_MARKERS) {
    const index = source.search(re);
    if (index > 0) marks.push({ index, kind: 'signature', reason });
  }
  for (const pattern of DISCLAIMER_PATTERNS) {
    const index = source.search(pattern);
    if (index > 0) marks.push({ index, kind: 'disclaimer', reason: 'Legal disclaimer' });
  }

  if (marks.length === 0) return { segments: verbatim, degraded: false };
  marks.sort((a, b) => a.index - b.index);

  // Only the FIRST marker matters for HTML: unlike plain text, the markup is
  // nested, and slicing at a later marker would cut inside the block the first
  // one opened. One cut keeps the halves independently sanitisable.
  const cut = marks[0];
  const segments: TextSegment[] = [
    { kind: 'reply', text: source.slice(0, cut.index), start: 0, end: cut.index, reason: 'Reply' },
    {
      kind: cut.kind,
      text: source.slice(cut.index),
      start: cut.index,
      end: source.length,
      reason: cut.reason,
    },
  ];

  if (!assertTiles(source, segments)) return { segments: verbatim, degraded: true };
  return { segments, degraded: false };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Inline images
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Rewrite `cid:` references to real attachment URLs.
 *
 * Two things happen here that both matter:
 *
 *   • A cid the map does not know becomes an `alt`-only placeholder rather than
 *     a broken `cid:` src. `multipart/related` with a broken Content-ID is
 *     endemic — Outlook rewrites cids on forward, and a signature image whose
 *     part was dropped by a virus scanner leaves the reference behind. Left
 *     alone, the browser shows a broken-image glyph in the middle of a reply.
 *
 *   • The result is a RELATIVE url, which `utils/markdown`'s sanitiser accepts
 *     (no scheme, so no scheme check to fail) without having to widen
 *     `extraImageSchemes`. Widening that list to include `cid:` would mean any
 *     future path that renders unrewritten mail HTML emits live `cid:` srcs.
 */
export function rewriteCidReferences(
  html: string,
  cidToAttachmentId: ReadonlyMap<string, number>,
): { html: string; resolved: string[]; unresolved: string[] } {
  const resolved: string[] = [];
  const unresolved: string[] = [];

  const rewritten = html.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)(["'])\s*cid:([^"'>\s]+)\s*\2/gi,
    (_whole, prefix: string, quote: string, rawCid: string) => {
      const cid = decodeURIComponent(rawCid).replace(/^<|>$/g, '').trim();
      const id = cidToAttachmentId.get(cid) ?? cidToAttachmentId.get(cid.toLowerCase());
      if (id === undefined) {
        unresolved.push(cid);
        // Keep the tag (so alt text survives) but strip the dead reference.
        return `${prefix}${quote}${quote}`;
      }
      resolved.push(cid);
      return `${prefix}${quote}/api/attachments/${id}/download${quote}`;
    },
  );

  return { html: rewritten, resolved, unresolved };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — The one chip
// ═════════════════════════════════════════════════════════════════════════════

const SEGMENT_LABELS: Readonly<Record<SegmentKind, string>> = {
  reply: 'Reply',
  quote: 'Quoted history',
  signature: 'Signature',
  disclaimer: 'Legal disclaimer',
};

/**
 * Render every collapsed segment as ONE block.
 *
 * One, not one per segment: three chips stacked under a two-line reply is the
 * clutter the collapse was supposed to remove. The segments are labelled
 * inside it so an agent can still tell the quoted thread from the boilerplate.
 */
export function buildChip(segments: readonly TextSegment[], sourceIsHtml: boolean): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.kind === 'reply') continue;
    if (segment.text.trim() === '') continue;

    const body = sourceIsHtml
      ? sanitizeHtml(segment.text, { openLinksInNewTab: true })
      : `<p>${escapeHtml(segment.text.trim()).replace(/\n/g, '<br>')}</p>`;
    if (body.trim() === '') continue;

    parts.push(
      `<p><strong>${escapeHtml(SEGMENT_LABELS[segment.kind])}</strong>` +
        `<small> — ${escapeHtml(segment.reason)}</small></p>` +
        `<blockquote>${body}</blockquote>`,
    );
  }
  return parts.join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — The entry point
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Parse one message body into its reply half and its collapsed half.
 *
 * HTML wins when both are present, because that is what the sender saw; the
 * plain part is still parsed and used for the text projection, so search and
 * digests never depend on HTML-to-text conversion of a quoted thread.
 */
export function parseReply(input: ParseReplyInput): ParsedReply {
  const warnings: string[] = [];
  let degraded = false;

  const collapse = input.collapseQuotes !== false;

  let text = typeof input.text === 'string' ? input.text : '';
  if (input.formatFlowed && text !== '') {
    try {
      text = unflow(text, Boolean(input.delSp));
    } catch (err) {
      warnings.push(`format=flowed reflow failed (${(err as Error).message}) — kept hard wrapping`);
    }
  }

  const html = typeof input.html === 'string' ? input.html : '';
  const hasHtml = html.trim() !== '';

  // ── Plain text half ──────────────────────────────────────────────────────
  const textSplit = collapse && text.trim() !== ''
    ? splitPlainText(text)
    : {
        segments: [
          { kind: 'reply' as const, text, start: 0, end: text.length, reason: 'Whole message' },
        ],
        degraded: false,
      };
  if (textSplit.degraded) {
    degraded = true;
    warnings.push('quote detection did not reconstruct the plain-text body — kept it verbatim');
  }

  // ── HTML half ────────────────────────────────────────────────────────────
  const htmlSplit = collapse && hasHtml
    ? splitHtml(html)
    : {
        segments: [
          { kind: 'reply' as const, text: html, start: 0, end: html.length, reason: 'Whole message' },
        ],
        degraded: false,
      };
  if (htmlSplit.degraded) {
    degraded = true;
    warnings.push('quote detection did not reconstruct the HTML body — kept it verbatim');
  }

  const htmlReplySegment = htmlSplit.segments.find((s) => s.kind === 'reply');
  const replyHtmlRaw = hasHtml ? (htmlReplySegment?.text ?? html) : '';
  const replyHtml = hasHtml ? sanitizeHtml(replyHtmlRaw, { openLinksInNewTab: true }) : null;

  const textReplySegment = textSplit.segments.find((s) => s.kind === 'reply');
  let replyText = (textReplySegment?.text ?? text).trim();
  if (replyText === '' && replyHtml) replyText = htmlToPlainText(replyHtml).trim();

  // The collapsed half is taken from whichever source we are rendering, so the
  // chip and the reply always come from the same partition — mixing them lets
  // a segment appear twice (once in the reply, once in the chip) or not at all.
  const collapsedSource = hasHtml ? htmlSplit.segments : textSplit.segments;
  const collapsed = collapsedSource.filter((s) => s.kind !== 'reply' && s.text.trim() !== '');

  const chipHtml = buildChip(collapsed, hasHtml);
  const chipText = collapsed
    .map((segment) =>
      hasHtml ? htmlToPlainText(segment.text).trim() : segment.text.trim(),
    )
    .filter((piece) => piece !== '')
    .join('\n\n');

  return { replyText, replyHtml, collapsed, chipHtml, chipText, warnings, degraded };
}

export const replyParser = {
  decodeQuotedPrintable,
  decodeBase64Loose,
  decodeCharset,
  decodeTransferEncoding,
  safeDecodePart,
  unflow,
  splitPlainText,
  splitHtml,
  rewriteCidReferences,
  buildChip,
  parseReply,
};

export default replyParser;
