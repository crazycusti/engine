let gameModules = {};

try {
  // @ts-ignore - import.meta.glob is a Vite-specific feature
  gameModules = import.meta.glob('../../game/*/main.mjs');
// eslint-disable-next-line no-unused-vars
} catch (e) {
  // highly likely running in node.js, no pre-bundled modules available
}

/**
 * Loads a game module by directory name
 * @param {string} gameDir - The game directory name (e.g., 'id1', etc.)
 * @returns {Promise<import("./GameLoader").GameModuleInterface>} The loaded game module
 */
export async function loadGameModule(gameDir) {
  const modulePath = `../../game/${gameDir}/main.mjs`;

  // Try the pre-bundled modules first (Vite production build)
  if (gameModules[modulePath]) {
    return await gameModules[modulePath]();
  }

  // Fallback to dynamic import
  try {
    return await import(/* @vite-ignore */ modulePath);
  } catch (e) {
    throw new Error(`Game module not found: ${gameDir} (${e.message})`);
  }
};
