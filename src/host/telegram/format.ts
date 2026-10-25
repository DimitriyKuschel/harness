// Agent replies are markdown; Telegram takes a small HTML subset (b, i, s, code, pre, a, blockquote) and
// at most 4096 characters per message. Pure helpers, no vscode.

/** Telegram counts the text after entity parsing; leave room for the header and footer lines. */
export const CHUNK = 3500;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Markdown → Telegram HTML. Anything it doesn't know stays as escaped text. */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let fence: { lang: string; body: string[] } | undefined;
  let quote: string[] = [];
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.join('\n')}</blockquote>`);
    quote = [];
  };

  for (const line of lines) {
    if (fence) {
      if (/^\s*```\s*$/.test(line)) {
        const cls = fence.lang ? ` class="language-${escapeHtml(fence.lang)}"` : '';
        out.push(`<pre><code${cls}>${escapeHtml(fence.body.join('\n'))}</code></pre>`);
        fence = undefined;
      } else fence.body.push(line);
      continue;
    }
    const open = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (open) {
      flushQuote();
      fence = { lang: open[1], body: [] };
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      quote.push(inline(q[1]));
      continue;
    }
    flushQuote();
    const heading = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(`<b>${inline(heading[1])}</b>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('──────');
      continue;
    }
    const item = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (item) {
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[2]);
      const bullet = task ? (task[1] === ' ' ? '☐' : '☑') : '•';
      out.push(`${item[1]}${bullet} ${inline(task ? task[2] : item[2])}`);
      continue;
    }
    out.push(inline(line));
  }
  // An unclosed fence (cut-off stream) is still code.
  if (fence) out.push(`<pre><code>${escapeHtml(fence.body.join('\n'))}</code></pre>`);
  flushQuote();
  return out.join('\n');
}

/** Inline markdown of one line: code spans first, so nothing inside them is touched. */
function inline(text: string): string {
  const parts = text.split(/(`+[^`]*?`+)/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${escapeHtml(part.replace(/^`+|`+$/g, ''))}</code>`;
      let s = escapeHtml(part);
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`);
      s = s.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<b>$1</b>');
      s = s.replace(/(?<![\w_])__(?=\S)(.+?)(?<=\S)__(?![\w_])/g, '<b>$1</b>');
      s = s.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<s>$1</s>');
      // Single * only: underscores are everywhere in identifiers.
      s = s.replace(/(?<![\w*])\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*(?![\w*])/g, '<i>$1</i>');
      return s;
    })
    .join('');
}

/**
 * Splits markdown into pieces of at most `max` characters, at paragraph or line breaks where possible.
 * A code block cut in two is closed and reopened, so each piece renders on its own.
 */
export function chunkMarkdown(md: string, max = CHUNK): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let size = 0;
  let fence: string | undefined;

  const flush = () => {
    if (!cur.length) return;
    if (fence !== undefined) cur.push('```');
    chunks.push(cur.join('\n').trim());
    cur = fence !== undefined ? [`\`\`\`${fence}`] : [];
    size = cur.reduce((n, l) => n + l.length + 1, 0);
  };

  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    let line = raw;
    // A line longer than a whole message is cut where it must be.
    while (line.length > max - 20) {
      flush();
      cur.push(line.slice(0, max - 20));
      size += max - 20;
      line = line.slice(max - 20);
      flush();
    }
    // Prefer a break between paragraphs once the piece is reasonably full.
    if (size + line.length + 1 > max || (size > max * 0.8 && !line.trim() && fence === undefined)) flush();
    cur.push(line);
    size += line.length + 1;
    const f = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (f) fence = fence === undefined ? f[1] : undefined;
  }
  if (cur.length) chunks.push(cur.join('\n').trim());
  return chunks.filter(Boolean);
}

/** The first `max` characters, cut at a line break, with fences closed. */
export function preview(md: string, max: number): { text: string; cut: boolean } {
  if (md.length <= max) return { text: md, cut: false };
  const [first] = chunkMarkdown(md, max);
  return { text: first, cut: true };
}
