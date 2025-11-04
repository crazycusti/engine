/**
 * Build-time environment configuration
 */
export interface BuildConfig {
  /** Build mode (development/production) */
  mode: string;
  /** Build timestamp */
  timestamp: string;
};

/**
 * Runtime URL functions that can be passed to the engine
 */
export interface URLFunctions {
  /** Function that returns the signaling server URL */
  signalingURL?: () => string;
  /** Function that returns CDN URL for a file */
  cdnURL?: (filename: string, gameDir: string) => string;
};
