/**
 * Cloudflare Worker for serving static assets
 * Uses the new Static Assets binding (replaces Pages)
 * https://developers.cloudflare.com/workers/static-assets/
 */

export default {
	async fetch(request, env) {
		// Serve static assets via the ASSETS binding
		// With not_found_handling = "single-page-application",
		// requests that don't match assets will automatically return index.html
		return env.ASSETS.fetch(request);
	},
};
