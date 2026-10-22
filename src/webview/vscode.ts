import type { ToHost } from '../protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): Record<string, unknown> | undefined;
  setState(state: Record<string, unknown>): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function post(message: ToHost): void {
  api.postMessage(message);
}

/** Per-webview UI state that survives the view being hidden/restored (draft text etc.). */
export function loadUiState<T extends object>(): Partial<T> {
  return (api.getState() ?? {}) as Partial<T>;
}

export function saveUiState(patch: Record<string, unknown>): void {
  api.setState({ ...(api.getState() ?? {}), ...patch });
}
