import type { Call, Platform } from '../../index';

export interface ElectronCallOptions {
  platform: Platform;
  /** The bot's display name. */
  name: string;
  leave(): Promise<unknown>;
  screenshot(): Promise<Buffer>;
}

/** The public Call over the app's CallClient. Advanced: the app owns the window and the join. */
export function electronCall(client: object, options: ElectronCallOptions): Call;
