import MarkdownIt from 'markdown-it';
import { memo, useMemo, type MouseEvent } from 'react';
import { t } from '../../i18n';
import { post } from '../vscode';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const escape = md.utils.escapeHtml;
const FILE_REF = /^(?:\.{1,2}\/|\/)?[\w@.\-[\]]+(?:\/[\w@.\-[\]]+)*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+(?::\d+)?)?$/;

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const lang = token.info.trim().split(/\s+/)[0] ?? '';
  return (
    `<div class="codeblock"><div class="codeblock-head"><span>${escape(lang)}</span>` +
    `<button class="codeblock-copy" data-code="${escape(token.content)}" title="${escape(t().copy)}"><i class="codicon codicon-copy"></i></button></div>` +
    `<pre><code>${escape(token.content)}</code></pre></div>`
  );
};

md.renderer.rules.code_inline = (tokens, idx) => {
  const content = tokens[idx].content;
  if (FILE_REF.test(content) && !/^\d/.test(content)) {
    return `<code class="file-ref" data-path="${escape(content)}" title="${escape(t().openFile)}">${escape(content)}</code>`;
  }
  return `<code>${escape(content)}</code>`;
};

/** Agent output rendered as markdown; file references and links route through the extension host. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => md.render(text), [text]);
  return <div className="markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});

function onClick(e: MouseEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement;
  const file = target.closest<HTMLElement>('[data-path]');
  if (file) {
    e.preventDefault();
    post({ type: 'openFile', path: file.dataset.path! });
    return;
  }
  const copy = target.closest<HTMLButtonElement>('.codeblock-copy');
  if (copy) {
    post({ type: 'copy', text: copy.dataset.code ?? '' });
    copy.classList.add('done');
    setTimeout(() => copy.classList.remove('done'), 1200);
    return;
  }
  const link = target.closest<HTMLAnchorElement>('a[href]');
  if (link) {
    e.preventDefault();
    post({ type: 'openLink', url: link.getAttribute('href')! });
  }
}
