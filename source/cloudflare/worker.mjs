/**
 * Cloudflare Worker for serving static assets
 * Uses the new Static Assets binding (replaces Pages)
 * https://developers.cloudflare.com/workers/static-assets/
 */

export default {
	// eslint-disable-next-line @typescript-eslint/require-await
	async fetch(request, env) {
		// Serve static assets via the ASSETS binding
		return env.ASSETS.fetch(request);
	},
};
