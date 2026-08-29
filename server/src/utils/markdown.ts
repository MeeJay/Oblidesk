/**
 * markdown.ts — Markdown to sanitised HTML, with no third-party parser.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THIS FILE IS A SECURITY BOUNDARY. Treat every change as a security      ║
 * ║  change.                                                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The ticket journal renders content that arrives from people who are not
 * trusted: a portal requester types a comment, an inbound e-mail carries a
 * vendor's HTML signature, an alert payload from another suite app supplies a
 * description. That content is then shown to an AGENT — a session holding
 * `ticket_rw`, often `config_admin`, sometimes platform admin. A stored XSS in
 * the journal is therefore not a defacement; it is privilege escalation from
 * "anyone who can e-mail the support address" to "administrator of the desk".
 *
 * Two entry points, and they are different jobs:
 *
 *   renderMarkdown(md)  — for content we know is markdown (journal bodies, KB
 *                         articles, macro text). The source is escaped in full
 *                         BEFORE any structure is built, so no raw HTML in the
 *                         markdown can reach the output. The result is then
 *                         passed through sanitizeHtml anyway, because one choke
 *                         point that always runs beats two paths where one
 *                         might be forgotten.
 *
 *   sanitizeHtml(html)  — for content that is ALREADY HTML (an inbound e-mail
 *                         body). Tag and attribute allowlist, URL scheme
 *                         allowlist, dangerous elements removed together with
 *                         their contents.
 *
 * Design rules that must survive any edit:
 *   • Allowlist, never blocklist. An unknown tag is dropped, not kept.
 *   • `script`, `style`, `iframe`, `object`, `embed`, `form`, `svg`, `math` and
 *     friends are removed WITH their text content — leaving the body of a
 *     `<style>` behind as text is how a "sanitiser" leaks CSS injection.
 *   • Every `on*` attribute is dropped, always, on every tag, before the
 *     allowlist is even consulted.
 *   • `style`, `srcset`, `formaction`, `xlink:*` are dropped.
 *   • `javascript:`, `data:`, `vbscript:`, `file:`, `blob:` and protocol-
 *     relative `//host` URLs are dropped — after entity-decoding and control-
 *     character stripping, because `java&#115;cript&colon;alert(1)` and
 *     `java\tscript:alert(1)` are both live URLs in a browser.
 *   • Every link gets `rel="noopener noreferrer nofollow"`.
 */

// ═════════════════════════════════════════════════════════════════════════════
// Options
// ═════════════════════════════════════════════════════════════════════════════

export interface SanitizeOptions {
  /** Render `<img>` at all. Default true. */
  allowImages?: boolean;
  /**
   * Extra URL schemes accepted for `<img src>` — e.g. `['cid:']` once the mail
   * pipeline rewrites content-ids into attachment links. Default: none.
   */
  extraImageSchemes?: readonly string[];
  /** Render tables. Default true. */
  allowTables?: boolean;
  /** Add `target="_blank"` to absolute links. Default true. */
  openLinksInNewTab?: boolean;
  /** Hard cap on input size; anything beyond is truncated. Default 512 KiB. */
  maxInputLength?: number;
}

const DEFAULTS: Required<SanitizeOptions> = {
  allowImages: true,
  extraImageSchemes: [],
  allowTables: true,
  openLinksInNewTab: true,
  maxInputLength: 512 * 1024,
};

function withDefaults(options?: SanitizeOptions): Required<SanitizeOptions> {
  return { ...DEFAULTS, ...(options ?? {}) };
}

// ═════════════════════════════════════════════════════════════════════════════
// Allowlists
// ═════════════════════════════════════════════════════════════════════════════

/** Tags that survive, mapped to the attributes they may keep. */
const ALLOWED_TAGS: Readonly<Record<string, readonly string[]>> = {
  p: [],
  br: [],
  hr: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  strong: [], b: [], em: [], i: [], u: [], s: [], del: [], ins: [], mark: [],
  small: [], sub: [], sup: [],
  code: [], pre: ['data-lang'], kbd: [], samp: [],
  blockquote: ['cite'],
  ul: [], ol: ['start'], li: [],
  dl: [], dt: [], dd: [],
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  table: [], thead: [], tbody: [], tfoot: [], tr: [], caption: [],
  th: ['colspan', 'rowspan', 'scope'],
  td: ['colspan', 'rowspan'],
  abbr: ['title'],
};

/** Removed together with everything between the open and close tag. */
const STRIP_WITH_CONTENT: readonly string[] = [
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'noscript', 'noframes', 'template', 'svg', 'math', 'form', 'input', 'button',
  'select', 'option', 'optgroup', 'textarea', 'label', 'fieldset', 'legend',
  'link', 'meta', 'base', 'title', 'canvas', 'audio', 'video', 'source',
  'track', 'map', 'area', 'portal', 'dialog', 'slot',
];

/** Void elements — never given a closing tag. */
const VOID_TAGS = new Set(['br', 'hr', 'img']);

const TABLE_TAGS = ['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption'];

/** Schemes a link may use. Everything else is dropped. */
const SAFE_LINK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:', 'tel:']);
/** Schemes an image may use by default. */
const SAFE_IMAGE_SCHEMES: readonly string[] = ['http:', 'https:'];

/** Hard cap on output nesting — pathological-input protection. */
const MAX_DEPTH = 100;

/**
 * The placeholder sentinel. NUL is stripped from every input before parsing
 * begins, so a hostile author cannot forge one of our placeholders.
 */
const SENTINEL = '\u0000';

// ═════════════════════════════════════════════════════════════════════════════
// Escaping helpers
// ═════════════════════════════════════════════════════════════════════════════

/** Full escape — for text we are inserting into HTML ourselves. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const VALID_ENTITY = /&(?!#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[a-zA-Z][a-zA-Z0-9]{1,31};)/g;

/**
 * Idempotent text-node escape — leaves an already-valid entity alone, so that
 * running the sanitiser over its own output does not turn `&amp;` into
 * `&amp;amp;`. That idempotence is what lets renderMarkdown pipe its result
 * through sanitizeHtml unconditionally.
 */
function escapeTextNode(value: string): string {
  return value.replace(VALID_ENTITY, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape a value that will sit inside a double-quoted attribute. */
function escapeAttribute(value: string): string {
  return value
    .replace(VALID_ENTITY, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Two jobs, one table.
 *
 * The first group is what a URL check must see through: `&colon;`, `&Tab;` and
 * `&NewLine;` are all live characters inside an href, and a scheme test that
 * runs before decoding them sees a harmless string.
 *
 * The second group is ordinary text: `htmlToPlainText` feeds notification
 * previews and the text/plain part of outbound mail, and this desk's default
 * locale is French — an e-mail subject reading "bonne journ&eacute;e" is a
 * visible defect, not a rounding error.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  // Structural / security-relevant
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', colon: ':', sol: '/', lpar: '(', rpar: ')',
  Tab: '\t', tab: '\t', NewLine: '\n', newline: '\n',

  // Punctuation and symbols that show up in real correspondence
  hellip: '…', mdash: '—', ndash: '–', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', deg: '°', euro: '€', pound: '£', cent: '¢',
  copy: '©', reg: '®', trade: '™', times: '×', divide: '÷', plusmn: '±',
  sect: '§', para: '¶', dagger: '†', permil: '‰', prime: '′',

  // Latin-1 letters — French first, then the rest of western Europe
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', acirc: 'â', auml: 'ä', aacute: 'á', aring: 'å', atilde: 'ã',
  ccedil: 'ç', ugrave: 'ù', ucirc: 'û', uuml: 'ü', uacute: 'ú',
  icirc: 'î', iuml: 'ï', iacute: 'í', igrave: 'ì',
  ocirc: 'ô', ouml: 'ö', oacute: 'ó', ograve: 'ò', otilde: 'õ', oslash: 'ø',
  ntilde: 'ñ', yuml: 'ÿ', szlig: 'ß', aelig: 'æ', oelig: 'œ',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Agrave: 'À', Acirc: 'Â',
  Ccedil: 'Ç', Ugrave: 'Ù', Ucirc: 'Û', Icirc: 'Î', Ocirc: 'Ô',
  Ntilde: 'Ñ', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', AElig: 'Æ', OElig: 'Œ',
};

/**
 * Decode entities BEFORE validating a URL.
 *
 * `javascript&colon;alert(1)` and `&#106;avascript:alert(1)` are both executed
 * by a browser; a scheme check that runs on the raw text sees neither. Decode
 * repeatedly (bounded) because `&amp;#58;` decodes to `&#58;` decodes to `:`.
 */
function decodeEntities(value: string): string {
  let out = value;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = out.replace(
      /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g,
      (match: string, body: string) => {
        if (body.charAt(0) === '#') {
          const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
          const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
          if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
          try {
            return String.fromCodePoint(code);
          } catch {
            return match;
          }
        }
        const named = NAMED_ENTITIES[body];
        return named === undefined ? match : named;
      },
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

/** C0/C1 controls and NUL — never legitimate in the content we render. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/** Everything a browser skips while parsing a URL scheme. */
const URL_IGNORABLE = /[\u0000-\u0020\u007F-\u00A0\u2000-\u200D\u2028\u2029\uFEFF]/g;

// ═════════════════════════════════════════════════════════════════════════════
// URL sanitisation
// ═════════════════════════════════════════════════════════════════════════════

/** Returns a safe URL, or null when the URL must be dropped. */
function sanitizeUrl(raw: string, allowedSchemes: ReadonlySet<string>): string | null {
  if (!raw) return null;

  const decoded = decodeEntities(raw).trim();
  if (decoded.length === 0) return null;

  // What the browser actually sees when it decides the scheme.
  const probe = decoded.replace(URL_IGNORABLE, '').toLowerCase();
  if (probe.length === 0) return null;

  // Protocol-relative (`//evil.tld/x`) inherits the page scheme and leaves this
  // origin while looking relative. Dropped on purpose.
  if (probe.startsWith('//')) return null;

  // Same-document fragments and root-relative paths are safe and needed —
  // attachment downloads are served from /api/attachments/...
  if (probe.startsWith('#') || probe.startsWith('/')) return decoded;

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/.exec(probe);
  // No scheme at all: a relative path such as `docs/setup.md`. Safe.
  if (!schemeMatch) return decoded;

  return allowedSchemes.has(`${schemeMatch[1]}:`) ? decoded : null;
}

function imageSchemes(opts: Required<SanitizeOptions>): ReadonlySet<string> {
  return new Set([
    ...SAFE_IMAGE_SCHEMES,
    ...opts.extraImageSchemes.map((scheme) => scheme.toLowerCase()),
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// sanitizeHtml — the allowlist pass
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Sanitise arbitrary HTML down to the allowlist above.
 *
 * Never throws: bad input yields less output, never an exception. This runs on
 * the journal render path, and an exception there would take out a whole ticket
 * page over one malformed vendor signature.
 */
export function sanitizeHtml(html: string, options?: SanitizeOptions): string {
  if (typeof html !== 'string' || html.length === 0) return '';
  const opts = withDefaults(options);

  let input = html.slice(0, opts.maxInputLength);

  // 1. Remove anything that is not markup we would ever keep, plus its content.
  input = input
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, '')
    .replace(/<![^>]*>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '');

  for (const tag of STRIP_WITH_CONTENT) {
    // Paired form: <script …> … </script>
    input = input.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
    // Unclosed or self-closing form: <script src=…> with no terminator.
    input = input.replace(new RegExp(`<\\/?${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }

  // 2. Walk the remaining tags, rebuilding only what is allowed.
  //    The regex is built per call: a module-level /g regex carries lastIndex
  //    between calls and is a classic source of "works once, then skips".
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const out: string[] = [];
  const open: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(input)) !== null) {
    if (match.index > cursor) out.push(escapeTextNode(input.slice(cursor, match.index)));
    cursor = tagRe.lastIndex;

    const raw = match[0];
    const name = match[1].toLowerCase();
    const attrText = match[2] ?? '';
    const isClosing = raw.charAt(1) === '/';

    const allowedAttrs = ALLOWED_TAGS[name];
    if (!allowedAttrs) {
      // Unknown or purely structural tag (div, span, body…): drop the TAG but
      // keep the text around it. Dropping the content too would silently
      // swallow the body of most HTML e-mail.
      continue;
    }
    if (name === 'img' && !opts.allowImages) continue;
    if (!opts.allowTables && TABLE_TAGS.includes(name)) continue;

    if (isClosing) {
      if (VOID_TAGS.has(name)) continue;
      const at = open.lastIndexOf(name);
      if (at === -1) continue; // stray close tag
      for (let i = open.length - 1; i >= at; i -= 1) out.push(`</${open[i]}>`);
      open.length = at;
      continue;
    }

    if (!VOID_TAGS.has(name) && open.length >= MAX_DEPTH) continue;

    const rebuilt = rebuildAttributes(name, attrText, allowedAttrs, opts);
    if (rebuilt === null) continue; // an <a>/<img> whose URL was refused

    out.push(`<${name}${rebuilt}>`);
    if (!VOID_TAGS.has(name)) open.push(name);
  }

  if (cursor < input.length) out.push(escapeTextNode(input.slice(cursor)));

  // 3. Close anything still open, innermost first.
  for (let i = open.length - 1; i >= 0; i -= 1) out.push(`</${open[i]}>`);

  return out.join('');
}

/**
 * Rebuild a tag's attribute list from the allowlist.
 *
 * Returns the attribute string (with a leading space, or empty), or null when
 * the tag must be dropped entirely — an `<a>` with no usable href is noise and
 * an `<img>` with a refused src renders a broken-image icon that tells the
 * reader nothing.
 */
function rebuildAttributes(
  tag: string,
  attrText: string,
  allowed: readonly string[],
  opts: Required<SanitizeOptions>,
): string | null {
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const kept: string[] = [];
  let href: string | null = null;
  let src: string | null = null;

  let attr: RegExpExecArray | null;
  while ((attr = attrRe.exec(attrText)) !== null) {
    const name = attr[1].toLowerCase();
    const value = attr[2] ?? attr[3] ?? attr[4] ?? '';

    // Event handlers are dropped on EVERY tag, unconditionally, before the
    // allowlist is consulted. `on*` is the entire XSS surface of an attribute
    // allowlist that has a hole in it.
    if (name.startsWith('on')) continue;
    // `style` can carry url(javascript:…) and CSS that repositions an element
    // over the page. There is no safe subset worth writing a CSS parser for.
    if (name === 'style' || name === 'srcset' || name === 'formaction') continue;
    if (name.startsWith('xlink:') || name.startsWith('xmlns')) continue;
    if (!allowed.includes(name)) continue;

    if (name === 'href') {
      href = sanitizeUrl(value, SAFE_LINK_SCHEMES);
      continue;
    }
    if (name === 'src') {
      src = sanitizeUrl(value, imageSchemes(opts));
      continue;
    }
    if (['width', 'height', 'colspan', 'rowspan', 'start'].includes(name)) {
      // Numeric only: a `width` of `100%;position:fixed` is not a width.
      if (!/^\d{1,5}$/.test(value.trim())) continue;
      kept.push(`${name}="${value.trim()}"`);
      continue;
    }
    if (name === 'scope') {
      const scope = value.trim().toLowerCase();
      if (!['row', 'col', 'rowgroup', 'colgroup'].includes(scope)) continue;
      kept.push(`scope="${scope}"`);
      continue;
    }
    if (name === 'data-lang') {
      if (!/^[a-zA-Z0-9_+-]{1,24}$/.test(value.trim())) continue;
      kept.push(`data-lang="${value.trim()}"`);
      continue;
    }

    kept.push(`${name}="${escapeAttribute(value)}"`);
  }

  if (tag === 'a') {
    if (!href) return null;
    const parts = [`href="${escapeAttribute(href)}"`, ...kept];
    // rel is not optional: a target=_blank link without noopener hands the
    // opener's window object to the destination page.
    parts.push('rel="noopener noreferrer nofollow"');
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && opts.openLinksInNewTab) parts.push('target="_blank"');
    return ` ${parts.join(' ')}`;
  }

  if (tag === 'img') {
    if (!src) return null;
    return ` ${[`src="${escapeAttribute(src)}"`, ...kept].join(' ')}`;
  }

  return kept.length > 0 ? ` ${kept.join(' ')}` : '';
}

// ═════════════════════════════════════════════════════════════════════════════
// renderMarkdown — a small, deliberate subset
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Supported: ATX headings, thematic breaks, fenced and indented code, inline
 * code, blockquotes, ordered/unordered lists with nesting, GFM pipe tables,
 * bold / italic / strikethrough, links, images, autolinked bare URLs, and hard
 * line breaks (two trailing spaces, or a trailing backslash).
 *
 * NOT supported, on purpose: raw HTML passthrough. The whole source is escaped
 * before a single structural rule runs, so `<img onerror=…>` typed by a
 * requester renders as the literal text they typed. That is the entire security
 * argument for writing this instead of pulling in a parser that has an
 * `html: true` option somebody will eventually flip.
 */
export function renderMarkdown(markdown: string, options?: SanitizeOptions): string {
  if (typeof markdown !== 'string' || markdown.trim().length === 0) return '';
  const opts = withDefaults(options);

  const source = markdown
    .slice(0, opts.maxInputLength)
    .replace(/\r\n?/g, '\n')
    // Strip control characters (they hide tokens from a reviewer's eye and are
    // what makes the SENTINEL unforgeable) but keep \n and \t.
    .replace(CONTROL_CHARS, '');

  // Fenced code comes out first so nothing inside it is ever interpreted.
  const codeBlocks: string[] = [];
  // The closing alternative is `(?![\s\S])` — true end of input — NOT `$`.
  // Under the /m flag `$` also matches before every newline, so the lazy body
  // would stop at the first line end and leave the closing fence behind as a
  // stray paragraph of backticks.
  const withoutFences = source.replace(
    /^(?: {0,3})(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)(?:^(?: {0,3})\1[ \t]*$|(?![\s\S]))/gm,
    (_match: string, _fence: string, info: string, body: string) => {
      const language = (info || '').trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9_+-]/g, '');
      const langAttr = language ? ` data-lang="${escapeAttribute(language)}"` : '';
      codeBlocks.push(`<pre${langAttr}><code>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`);
      return `${SENTINEL}CB${codeBlocks.length - 1}${SENTINEL}`;
    },
  );

  const html = renderBlocks(withoutFences.split('\n'), opts, 0);

  const restored = html.replace(
    new RegExp(`${SENTINEL}CB(\\d+)${SENTINEL}`, 'g'),
    (_m: string, index: string) => codeBlocks[Number(index)] ?? '',
  );

  // Second pass through the allowlist. renderBlocks only emits tags we wrote
  // ourselves, so this changes nothing today — it is here so that a future edit
  // introducing a hole in the renderer still cannot produce output outside the
  // allowlist. escapeTextNode is idempotent, so the double pass is free of
  // double-escaping.
  return sanitizeHtml(restored, opts);
}

interface ListFrame {
  ordered: boolean;
  indent: number;
}

function renderBlocks(lines: string[], opts: Required<SanitizeOptions>, depth: number): string {
  if (depth > 8) return escapeHtml(lines.join('\n'));

  const codeLineRe = new RegExp(`^\\s*(${SENTINEL}CB\\d+${SENTINEL})\\s*$`);
  const out: string[] = [];
  const listStack: ListFrame[] = [];
  let paragraph: string[] = [];

  const closeParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push(`<p>${renderInline(paragraph.join('\n'), opts)}</p>`);
    paragraph = [];
  };

  const closeLists = (toIndent = -1): void => {
    while (listStack.length > 0 && listStack[listStack.length - 1].indent > toIndent) {
      const frame = listStack.pop() as ListFrame;
      out.push('</li>');
      out.push(frame.ordered ? '</ol>' : '</ul>');
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // A line that is only a fenced-code placeholder is a block of its own.
    const placeholder = codeLineRe.exec(line);
    if (placeholder) {
      closeParagraph();
      closeLists();
      out.push(placeholder[1]);
      continue;
    }

    if (line.trim() === '') {
      closeParagraph();
      // A blank line does NOT close a list: `- a\n\n- b` is one loose list.
      continue;
    }

    // ── Thematic break ────────────────────────────────────────────────────
    if (/^ {0,3}(?:-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      closeParagraph();
      closeLists();
      out.push('<hr>');
      continue;
    }

    // ── ATX heading ───────────────────────────────────────────────────────
    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      closeParagraph();
      closeLists();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2], opts)}</h${level}>`);
      continue;
    }

    // ── Blockquote: consume the whole run, then recurse ───────────────────
    if (/^ {0,3}>/.test(line)) {
      closeParagraph();
      closeLists();
      const quoted: string[] = [];
      let j = i;
      while (
        j < lines.length &&
        (/^ {0,3}>/.test(lines[j]) || (quoted.length > 0 && lines[j].trim() !== ''))
      ) {
        quoted.push(lines[j].replace(/^ {0,3}>\s?/, ''));
        j += 1;
      }
      i = j - 1;
      out.push(`<blockquote>${renderBlocks(quoted, opts, depth + 1)}</blockquote>`);
      continue;
    }

    // ── GFM table: a header row followed by a delimiter row ───────────────
    if (
      opts.allowTables &&
      line.includes('|') &&
      i + 1 < lines.length &&
      isTableDelimiter(lines[i + 1])
    ) {
      closeParagraph();
      closeLists();
      const header = splitTableRow(line);
      const body: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') {
        body.push(splitTableRow(lines[j]));
        j += 1;
      }
      i = j - 1;
      out.push(renderTable(header, body, opts));
      continue;
    }

    // ── List item ─────────────────────────────────────────────────────────
    const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
    if (item) {
      closeParagraph();
      const indent = item[1].replace(/\t/g, '    ').length;
      const ordered = /\d/.test(item[2]);

      closeLists(indent);

      const top = listStack[listStack.length - 1];
      if (!top || top.indent < indent) {
        listStack.push({ ordered, indent });
        out.push(ordered ? '<ol>' : '<ul>');
      } else {
        out.push('</li>');
        if (top.ordered !== ordered) {
          // A `-` list turning into a `1.` list at the same indent is two lists.
          out.push(top.ordered ? '</ol>' : '</ul>');
          listStack.pop();
          listStack.push({ ordered, indent });
          out.push(ordered ? '<ol>' : '<ul>');
        }
      }
      out.push(`<li>${renderInline(item[3], opts)}`);
      continue;
    }

    // ── Indented code — only outside a list, where indent means nesting ────
    if (listStack.length === 0 && /^ {4,}\S/.test(line)) {
      closeParagraph();
      const code: string[] = [];
      let j = i;
      while (j < lines.length && (/^ {4,}/.test(lines[j]) || lines[j].trim() === '')) {
        code.push(lines[j].replace(/^ {4}/, ''));
        j += 1;
      }
      while (code.length > 0 && code[code.length - 1].trim() === '') code.pop();
      i = j - 1;
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    // ── Lazy continuation of the current list item ────────────────────────
    if (listStack.length > 0 && paragraph.length === 0) {
      out.push(` ${renderInline(line.trim(), opts)}`);
      continue;
    }

    paragraph.push(line.trim());
  }

  closeParagraph();
  closeLists();
  return out.join('');
}

// ── Tables ───────────────────────────────────────────────────────────────────

function isTableDelimiter(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * Column alignment from the delimiter row is deliberately NOT rendered: it
 * would have to travel as an inline `style`, and `style` is dropped by the
 * sanitiser on every tag. Alignment degrades to the stylesheet default rather
 * than being faked with an attribute nothing reads.
 */
function renderTable(
  header: string[],
  body: string[][],
  opts: Required<SanitizeOptions>,
): string {
  const head = header.map((cell) => `<th>${renderInline(cell, opts)}</th>`).join('');
  const rows = body
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell, opts)}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

// ── Inline ───────────────────────────────────────────────────────────────────

/**
 * Inline rendering, in an order chosen so no later rule can corrupt an earlier
 * rule's output:
 *
 *   1. code spans are lifted out (nothing inside one is ever interpreted);
 *   2. the remaining text is fully HTML-escaped — from here on, no character of
 *      user text can become markup by accident;
 *   3. images and links are turned into tags, and every emitted TAG is itself
 *      lifted out behind a placeholder so that step 4's emphasis rules cannot
 *      reach inside an `href` (a URL such as `https://host/_a_` would otherwise
 *      grow an `<em>` in the middle of the attribute);
 *   4. emphasis, then line breaks;
 *   5. tags and code spans are put back.
 */
function renderInline(text: string, opts: Required<SanitizeOptions>): string {
  const parked: string[] = [];
  const park = (html: string): string => {
    parked.push(html);
    return `${SENTINEL}T${parked.length - 1}${SENTINEL}`;
  };

  // 1. Code spans.
  let working = text.replace(/(`+)([\s\S]*?)\1/g, (_m: string, _ticks: string, body: string) =>
    park(`<code>${escapeHtml(body.trim())}</code>`),
  );

  // 2. Escape everything that is left.
  working = escapeHtml(working);

  // 3a. Images before links — `![alt](src)` would otherwise match the link rule.
  if (opts.allowImages) {
    working = working.replace(
      /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
      (match: string, alt: string, src: string, title?: string) => {
        const safe = sanitizeUrl(src, imageSchemes(opts));
        if (!safe) return alt || match;
        const titleAttr = title ? ` title="${escapeAttribute(title)}"` : '';
        return park(
          `<img src="${escapeAttribute(safe)}" alt="${escapeAttribute(alt)}"${titleAttr}>`,
        );
      },
    );
  } else {
    working = working.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m: string, alt: string) => alt);
  }

  // 3b. Links. The label stays in the stream so it still gets emphasis; only
  //     the opening and closing tags are parked.
  working = working.replace(
    /\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
    (_match: string, label: string, href: string, title?: string) => {
      const safe = sanitizeUrl(href, SAFE_LINK_SCHEMES);
      if (!safe) return label; // keep the words, drop the trap
      const titleAttr = title ? ` title="${escapeAttribute(title)}"` : '';
      const target =
        /^[a-z][a-z0-9+.-]*:/i.test(safe) && opts.openLinksInNewTab ? ' target="_blank"' : '';
      const openTag = `<a href="${escapeAttribute(
        safe,
      )}"${titleAttr} rel="noopener noreferrer nofollow"${target}>`;
      return `${park(openTag)}${label}${park('</a>')}`;
    },
  );

  // 3c. Bare http(s) URLs.
  working = working.replace(
    /(^|[\s(])(https?:\/\/[^\s<>"'()]+[^\s<>"'().,;:!?])/g,
    (_m: string, lead: string, url: string) => {
      const safe = sanitizeUrl(url, SAFE_LINK_SCHEMES);
      if (!safe) return `${lead}${url}`;
      const target = opts.openLinksInNewTab ? ' target="_blank"' : '';
      const openTag = `<a href="${escapeAttribute(
        safe,
      )}" rel="noopener noreferrer nofollow"${target}>`;
      return `${lead}${park(openTag)}${url}${park('</a>')}`;
    },
  );

  // 4. Emphasis — longest delimiter first, so `**bold**` never falls through to
  //    the single-asterisk rule.
  working = working
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?!_)/g, '$1<em>$2</em>');

  // 5. Hard line breaks, then soft ones.
  working = working.replace(/(?: {2,}|\\)\n/g, '<br>\n').replace(/\n/g, '<br>');

  // 6. Restore the parked tags and code spans.
  return working.replace(
    new RegExp(`${SENTINEL}T(\\d+)${SENTINEL}`, 'g'),
    (_m: string, index: string) => parked[Number(index)] ?? '',
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Plain text
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Strip markup down to readable text — for search indexing, notification
 * previews and the `text/plain` alternative part of an outbound e-mail.
 */
export function markdownToPlainText(markdown: string): string {
  if (typeof markdown !== 'string') return '';
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1 ($2)')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .replace(/(\*\*|__|~~|\*|_)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Strip tags from HTML down to text — the inbound-e-mail counterpart. */
export function htmlToPlainText(html: string): string {
  if (typeof html !== 'string') return '';
  return decodeEntities(
    html
      .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<\/?(p|div|br|tr|li|h[1-6]|blockquote)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(CONTROL_CHARS, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
