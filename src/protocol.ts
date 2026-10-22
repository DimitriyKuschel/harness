import type { Prefs, ViewState } from './core/types';

/** Webview → extension host. */
export type ToHost =
  | { type: 'ready' }
  | { type: 'send'; text: string; prefs: Prefs }
  | { type: 'stop' }
  | { type: 'prefs'; prefs: Prefs }
  | { type: 'newChat' }
  | { type: 'openChat'; id: string }
  | { type: 'deleteChat'; id: string }
  | { type: 'review'; id: string }
  | { type: 'fix'; id: string }
  | { type: 'rerun'; id: string; stronger: boolean }
  | { type: 'debate'; round: string }
  | { type: 'continueTeam'; id: string }
  | { type: 'unqueue'; index: number }
  | { type: 'openFile'; path: string }
  | { type: 'openLink'; url: string }
  | { type: 'copy'; text: string }
  | { type: 'command'; command: 'settings' | 'refresh' | 'limits' | 'log' | 'trust' };

/** Extension host → webview. */
export type ToWebview = { type: 'state'; state: ViewState };
