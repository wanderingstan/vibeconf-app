export interface PlaywrightHostOptions {
  /** The bot's browser profile, kept between runs. */
  userDataDir: string;
  headless?: boolean;
  /** Playwright browser channel. Default 'chrome'. */
  channel?: string;
  executablePath?: string;
  /** Extra Chromium flags. */
  args?: string[];
}

/** An opaque host to pass to join(). */
export interface PlaywrightHost {
  close(): Promise<void>;
}

export function playwrightHost(options: PlaywrightHostOptions): Promise<PlaywrightHost>;
