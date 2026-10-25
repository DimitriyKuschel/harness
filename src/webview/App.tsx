import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { exhaustedUntil } from '../core/quota';
import { AGENT_LABELS, type Mode, type Prefs, type ViewState } from '../core/types';
import { setLocale, t } from '../i18n';
import type { ToWebview } from '../protocol';
import { Composer, type ComposerHandle } from './components/Composer';
import { EmptyState } from './components/EmptyState';
import { Header } from './components/Header';
import { MessageView, RoundHeader } from './components/MessageView';
import { TrustNotice } from './components/TrustNotice';
import { post } from './vscode';

export function App() {
  const [state, setState] = useState<ViewState>();
  const [localPrefs, setLocalPrefs] = useState<Prefs>();
  const prefs = localPrefs ?? state?.prefs;
  // The local copy only bridges the round trip: once the host's prefs change (here, in another view or from
  // Telegram), they win, or the next message would send stale prefs back.
  const hostPrefs = JSON.stringify(state?.prefs);
  useEffect(() => setLocalPrefs(undefined), [hostPrefs]);
  const [atBottom, setAtBottom] = useState(true);
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const conversationId = state?.conversation.id;

  useEffect(() => {
    const onMessage = (e: MessageEvent<ToWebview>) => {
      if (e.data?.type === 'state') setState(e.data.state);
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Follow the stream while the user is at the bottom; leave them alone when they scroll up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state]);

  useEffect(() => {
    stick.current = true;
    setAtBottom(true);
  }, [conversationId]);

  // Content also grows without a state change (fonts, expanding tool lists): keep following it.
  useEffect(() => {
    const el = scroller.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [!!state]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    stick.current = bottom;
    setAtBottom(bottom);
  };

  const scrollDown = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    stick.current = true;
  };

  const updatePrefs = useCallback((p: Prefs) => {
    setLocalPrefs(p);
    post({ type: 'prefs', prefs: p });
  }, []);

  const pick = useCallback((text: string, mode: Mode) => composer.current?.fill(text, mode), []);

  if (!state || !prefs) {
    return (
      <div className="loading">
        <i className="codicon codicon-loading codicon-modifier-spin" />
      </div>
    );
  }

  // Module-level strings read the locale at render time, so set it before anything renders.
  setLocale(state.locale);
  const { messages } = state.conversation;
  const canReview = state.agents.filter((a) => a.installed && a.enabled).length >= 2;
  const outOfQuota = new Set(state.agents.filter((a) => exhaustedUntil(a.limits)).map((a) => a.id));

  return (
    <div className="app">
      <Header state={state} prefs={prefs} onPrefs={updatePrefs} />
      <div className="messages" ref={scroller} onScroll={onScroll}>
        <div className="messages-inner">
          {messages.length === 0 ? (
            <EmptyState agents={state.agents} workspace={state.workspace} trusted={state.trusted} onPick={pick} />
          ) : (
            messages.map((m, i) => {
              const startsRound =
                m.round && (m.kind === 'brainstorm' || m.kind === 'debate') && messages[i - 1]?.round !== m.round;
              const roundAgents = startsRound
                ? messages.filter((x) => x.round === m.round && x.kind !== 'synthesis' && x.agent).map((x) => AGENT_LABELS[x.agent!])
                : [];
              return (
                <div key={m.id} id={`msg-${m.id}`}>
                  {startsRound && <RoundHeader kind={m.kind!} agents={roundAgents} />}
                  <MessageView message={m} busy={state.running || !state.trusted} canReview={canReview} outOfQuota={outOfQuota} />
                </div>
              );
            })
          )}
        </div>
      </div>
      {!atBottom && messages.length > 0 && (
        <button className="scroll-down" onClick={scrollDown} title={t().scrollDown}>
          <i className="codicon codicon-arrow-down" />
        </button>
      )}
      {state.trusted ? (
        <Composer ref={composer} prefs={prefs} onPrefs={updatePrefs} agents={state.agents} running={state.running} queue={state.queue} />
      ) : (
        <TrustNotice workspace={state.workspace} />
      )}
    </div>
  );
}
