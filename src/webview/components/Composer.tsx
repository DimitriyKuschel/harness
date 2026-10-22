import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import type { AgentView, Autonomy, Mode, Prefs, Profile } from '../../core/types';
import { AGENT_META, cx } from '../util';
import { loadUiState, post, saveUiState } from '../vscode';

export interface ComposerHandle {
  fill(text: string, mode?: Mode): void;
}

interface Props {
  prefs: Prefs;
  onPrefs: (p: Prefs) => void;
  agents: AgentView[];
  running: boolean;
  queue: string[];
}

interface MentionOption {
  id: string;
  label: string;
  hint: string;
  disabled?: boolean;
}

const MODES: { id: Mode; label: string; icon: string; title: string }[] = [
  { id: 'auto', label: 'Авто', icon: 'sparkle', title: 'Роутер выбирает исполнителя, модель и effort. Крупную работу сам отдаёт всей команде' },
  { id: 'team', label: 'Команда', icon: 'organization', title: 'Лид составляет план и раздаёт задачи агентам по сильным сторонам, затем проверяет результат' },
  { id: 'brainstorm', label: 'Брейншторм', icon: 'lightbulb', title: 'Все агенты отвечают независимо, модератор сводит мнения' },
];

const PROFILES: { id: Profile; label: string; title: string }[] = [
  { id: 'eco', label: 'Эко', title: 'На уровень проще: экономия лимитов' },
  { id: 'balanced', label: 'Баланс', title: 'Как оценил роутер' },
  { id: 'max', label: 'Макс', title: 'На уровень сильнее: качество важнее лимитов' },
];

const AUTONOMY: { id: Autonomy; label: string; title: string }[] = [
  { id: 'readonly', label: 'Только чтение', title: 'Агенты читают проект, но ничего не меняют' },
  { id: 'auto', label: 'Правки', title: 'Агенты правят файлы в проекте; опасные команды — по их авто-проверке' },
  { id: 'full', label: 'Полный доступ', title: 'Без песочницы и подтверждений. Только для доверенных задач' },
];

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ prefs, onPrefs, agents, running, queue }, ref) {
  const [text, setText] = useState(() => (loadUiState<{ draft: string }>().draft as string) ?? '');
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    fill(value, mode) {
      setText(value);
      if (mode && mode !== prefs.mode) onPrefs({ ...prefs, mode });
      requestAnimationFrame(() => {
        area.current?.focus();
        area.current?.setSelectionRange(value.length, value.length);
      });
    },
  }));

  useEffect(() => saveUiState({ draft: text }), [text]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => {
    const focus = () => area.current?.focus();
    window.addEventListener('focus', focus);
    focus();
    return () => window.removeEventListener('focus', focus);
  }, []);

  const options: MentionOption[] = [
    ...agents.map((a) => ({
      id: a.id,
      label: a.label,
      hint: a.installed && a.enabled ? AGENT_META[a.id].tagline : a.installed ? 'выключен' : 'не установлен',
      disabled: !a.installed || !a.enabled,
    })),
    { id: 'all', label: 'Все', hint: 'брейншторм всей командой' },
  ].filter((o) => !mention || o.id.startsWith(mention.query.toLowerCase()) || o.label.toLowerCase().startsWith(mention.query.toLowerCase()));

  const updateMention = (value: string, caret: number) => {
    const m = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(value.slice(0, caret));
    if (m) {
      setMention({ query: m[1], start: caret - m[1].length - 1 });
      setActive(0);
    } else {
      setMention(null);
    }
  };

  const insertMention = (opt: MentionOption) => {
    if (!mention || opt.disabled) return;
    const caret = area.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}@${opt.id} ${text.slice(caret)}`;
    setText(next);
    setMention(null);
    const pos = mention.start + opt.id.length + 2;
    requestAnimationFrame(() => area.current?.setSelectionRange(pos, pos));
  };

  const send = () => {
    if (!text.trim()) return;
    post({ type: 'send', text: text.trim(), prefs });
    setText('');
    setMention(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && options.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(options[active]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' && running) {
      post({ type: 'stop' });
    }
  };

  return (
    <div className="composer">
      <div className="bar-inner">
      {queue.length > 0 && (
        <div className="queue">
          {queue.map((q, i) => (
            <div key={i} className="queue-item" title={q}>
              <i className="codicon codicon-clock" />
              <span>{q}</span>
              <button className="icon-button subtle" title="Убрать из очереди" onClick={() => post({ type: 'unqueue', index: i })}>
                <i className="codicon codicon-close" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className={cx('input-wrap', prefs.mode !== 'auto' && prefs.mode)}>
        {mention && options.length > 0 && (
          <div className="mention-menu">
            {options.map((o, i) => (
              <button
                key={o.id}
                className={cx('mention-option', i === active && 'active', o.disabled && 'disabled')}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(o);
                }}
                onMouseEnter={() => setActive(i)}
              >
                {o.id === 'all' ? (
                  <span className="avatar small all">
                    <i className="codicon codicon-organization" />
                  </span>
                ) : (
                  <span className={cx('avatar', 'small', `agent-${o.id}`)}>{AGENT_META[o.id as keyof typeof AGENT_META].short}</span>
                )}
                <span className="mention-label">@{o.id}</span>
                <span className="mention-hint">{o.hint}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          value={text}
          rows={1}
          placeholder={
            prefs.mode === 'brainstorm'
              ? 'Тема для брейншторма — ответят все агенты…'
              : prefs.mode === 'team'
                ? 'Задача для всей команды — лид распределит работу…'
                : 'Задача для команды. @claude, @codex, @gemini — обратиться напрямую'
          }
          onChange={(e) => {
            setText(e.target.value);
            updateMention(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setMention(null), 100)}
        />
        <div className="input-actions">
          {running && (
            <button className="icon-button stop" title="Остановить всех (Esc)" onClick={() => post({ type: 'stop' })}>
              <i className="codicon codicon-debug-stop" />
            </button>
          )}
          <button
            className="send-button"
            title={running ? 'Поставить в очередь (Enter)' : 'Отправить (Enter)'}
            disabled={!text.trim()}
            onClick={send}
          >
            <i className={cx('codicon', running ? 'codicon-history' : 'codicon-send')} />
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="segmented" role="radiogroup" aria-label="Режим">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={prefs.mode === m.id}
              className={cx(prefs.mode === m.id && 'selected')}
              title={m.title}
              onClick={() => onPrefs({ ...prefs, mode: m.id })}
            >
              <i className={`codicon codicon-${m.icon}`} />
              {m.label}
            </button>
          ))}
        </div>
        {prefs.mode !== 'brainstorm' && (
          <button
            className={cx('picker-button', 'toggle', prefs.autopilot && 'on')}
            role="switch"
            aria-checked={prefs.autopilot}
            title={
              prefs.autopilot
                ? 'Автопилот включён: команда работает итерациями «план → задачи → проверка», пока лид не признает цель достигнутой или ему не понадобится ваше решение'
                : 'Автопилот выключен: после проверки лид ждёт вашего решения'
            }
            onClick={() => onPrefs({ ...prefs, autopilot: !prefs.autopilot })}
          >
            <i className={cx('codicon', prefs.autopilot ? 'codicon-sync' : 'codicon-debug-pause')} />
            Автопилот
          </button>
        )}
        <Picker
          icon="dashboard"
          value={prefs.profile}
          options={PROFILES}
          onChange={(profile) => onPrefs({ ...prefs, profile })}
          label="Расход лимитов"
        />
        <Picker
          icon={prefs.autonomy === 'readonly' ? 'lock' : prefs.autonomy === 'full' ? 'warning' : 'edit'}
          value={prefs.autonomy}
          options={AUTONOMY}
          onChange={(autonomy) => onPrefs({ ...prefs, autonomy })}
          label="Что агентам можно делать в проекте"
          danger={prefs.autonomy === 'full'}
        />
      </div>
      </div>
    </div>
  );
});

/** Compact toolbar picker; the menu opens upwards and explains each option. */
function Picker<T extends string>({
  icon,
  value,
  options,
  onChange,
  label,
  danger,
}: {
  icon: string;
  value: T;
  options: { id: T; label: string; title: string }[];
  onChange: (v: T) => void;
  label: string;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.id === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={cx('picker', danger && 'danger', open && 'open')} ref={ref}>
      <button
        className="picker-button"
        title={`${label}: ${current.title}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <i className={`codicon codicon-${icon}`} />
        {current.label}
        <i className="codicon codicon-chevron-down chevron" />
      </button>
      {open && (
        <div className="picker-menu" role="listbox" aria-label={label}>
          <div className="picker-title">{label}</div>
          {options.map((o) => (
            <button
              key={o.id}
              role="option"
              aria-selected={o.id === value}
              className={cx('picker-option', o.id === value && 'selected')}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
              }}
            >
              <i className={cx('codicon', o.id === value ? 'codicon-check' : 'codicon-blank')} />
              <span>
                <span className="picker-option-label">{o.label}</span>
                <span className="picker-option-desc">{o.title}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
