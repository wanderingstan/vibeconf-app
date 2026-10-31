export type Platform = 'meet' | 'zoom' | 'teams' | 'slack';
export type CallState = 'joining' | 'lobby' | 'in-call' | 'left' | 'removed' | 'error';
export type JoinErrorCode =
  | 'lobby-timeout' | 'denied' | 'auth-required' | 'blocked-by-admin'
  | 'bot-check' | 'already-running' | 'ui-changed' | 'timeout';

export interface Capabilities {
  captions: boolean;
  chat: boolean;
  /** Whether the `chat` event fires. False on Slack; chat.read() still works. */
  chatEvents: boolean;
  share: boolean;
  camera: boolean;
}

export interface Caption {
  /** Revised turns keep their id: update by id, don't append. */
  id: number | string;
  speaker: string;
  text: string;
  /** Approximate: a turn counts as final once a newer one starts or the call ends. */
  final: boolean;
}
export interface Participant { name: string; speaking: boolean; isSelf: boolean; }
export interface ChatMessage { id: string; sender: string; text: string; }

export interface Playback {
  /** Resolves when the clip ends or is cancelled. */
  done: Promise<{ cancelled: boolean }>;
  cancel(): Promise<void>;
}

export interface CallEvents {
  state: [state: CallState];
  caption: [turn: Caption];
  participants: [participants: Participant[]];
  speaking: [change: { name: string; speaking: boolean }];
  chat: [message: ChatMessage];
  share: [change: { presenter: string | null; active: boolean }];
  stall: [info: { what: string }];
}

export class Call {
  readonly platform: Platform;
  readonly capabilities: Capabilities;
  readonly state: CallState;
  /** Plays after any clip already playing. Rejects with MutedError after mic.setMuted(true). */
  speak(source: string | Buffer): Promise<Playback>;
  readonly mic: { setMuted(muted: boolean): Promise<void> };
  readonly camera: { setOn(on: boolean): Promise<void> };
  participants(): Promise<Participant[]>;
  readonly chat: {
    /** Everything the platform currently shows. */
    read(): Promise<ChatMessage[]>;
    /** Rejects if the platform didn't confirm it. */
    send(text: string): Promise<void>;
  };
  readonly share: { start(source?: unknown): Promise<unknown>; stop(): Promise<unknown> };
  /** A PNG of the call page. */
  screenshot(): Promise<Buffer>;
  /** Leaves the call, and closes the browser if join() opened it. */
  leave(): Promise<void>;
  on<E extends keyof CallEvents>(event: E, listener: (...args: CallEvents[E]) => void): this;
  once<E extends keyof CallEvents>(event: E, listener: (...args: CallEvents[E]) => void): this;
  off<E extends keyof CallEvents>(event: E, listener: (...args: CallEvents[E]) => void): this;
}

export interface JoinOptions {
  /** The name people in the call see. */
  name: string;
  /** Browser profile folder, kept between runs. Required without `host`. */
  profile?: string;
  /** Use 'account' with a signed-in profile. Slack only works with 'account'. */
  identity?: 'guest' | 'account';
  /** A host from playwrightHost(), left open when the call ends. */
  host?: object;
  /** Includes time waiting in a lobby. Default 120000. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** State changes during the join, before a Call exists. */
  onState?: (state: CallState) => void;
}

/** Resolves once the bot is in the call; rejects with a JoinError otherwise. */
export function join(url: string, options: JoinOptions): Promise<Call>;

export class JoinError extends Error {
  readonly code: JoinErrorCode;
  /** A PNG of the page, when one could be taken. */
  readonly screenshot: Buffer | null;
}
export class UnsupportedError extends Error {}
export class MutedError extends Error {}
export const platforms: readonly Platform[];
