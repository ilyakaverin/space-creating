/**
 * Offline support for the installed app (PWA). Next.js gives a service worker
 * no list of its build output, so this one caches at runtime:
 *
 * - Page navigations: network first, the last good copy when offline.
 * - /_next/static/: cache first. Next.js puts a content hash in every file
 *   name there, so a cached copy is never stale.
 * - /favicon/ (icons, manifest): served from the cache, refreshed behind it.
 * - Everything else, above all /api/, is never answered from a cache.
 *
 * Installing caches "/" and the files its HTML names, so the app works
 * offline right after the first visit.
 *
 * Kept at the URL SvelteKit used, so browsers that installed the old version
 * of the site update to this worker instead of keeping the old one.
 */
const PAGE_CACHE = "pages-v1";
const STATIC_CACHE = "static-v1";
const PUBLIC_CACHE = "public-v1";
const CURRENT_CACHES = [PAGE_CACHE, STATIC_CACHE, PUBLIC_CACHE];
/** Hashed files pile up across deploys; past this many, the oldest are dropped. */
const MAX_STATIC_ENTRIES = 200;

const isStatic = (url) => url.pathname.startsWith("/_next/static/");
const isPublic = (url) => url.pathname.startsWith("/favicon/");

const precache = async () => {
	const response = await fetch("/", { cache: "no-cache" });
	if (!response.ok) {
		return;
	}
	const html = await response.clone().text();
	await (await caches.open(PAGE_CACHE)).put("/", response);
	// A Set: pages name some files twice (preload and script tag), and
	// addAll rejects a list with duplicates.
	const paths = new Set(
		[...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((match) => match[1]),
	);
	const urls = [...paths].map((path) => new URL(path, self.location.origin));
	await (await caches.open(STATIC_CACHE)).addAll(urls.filter(isStatic));
	await (await caches.open(PUBLIC_CACHE)).addAll(urls.filter(isPublic));
};

self.addEventListener("install", (event) => {
	event.waitUntil(
		precache()
			// Offline or a failing server must not block the update itself.
			.catch((error) => console.warn("[service worker] precache failed", error))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					// Also removes the old SvelteKit worker's caches.
					keys
						.filter((key) => !CURRENT_CACHES.includes(key))
						.map((key) => caches.delete(key)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

/** Pages are fetched fresh, with the last good copy as the offline fallback. */
const fromNetworkFirst = async (request) => {
	const cache = await caches.open(PAGE_CACHE);
	try {
		const response = await fetch(request);
		if (response.ok) {
			await cache.put(request, response.clone());
		}
		return response;
	} catch (error) {
		const cached = (await cache.match(request)) ?? (await cache.match("/"));
		if (cached) {
			return cached;
		}
		throw error;
	}
};

/** Cache keys keep insertion order, so the first ones are the oldest. */
const trim = async (cache, maxEntries) => {
	const keys = await cache.keys();
	const excess = keys.slice(0, Math.max(0, keys.length - maxEntries));
	await Promise.all(excess.map((key) => cache.delete(key)));
};

const fromCacheFirst = async (request) => {
	const cache = await caches.open(STATIC_CACHE);
	const cached = await cache.match(request);
	if (cached) {
		return cached;
	}
	const response = await fetch(request);
	if (response.ok) {
		await cache.put(request, response.clone());
		await trim(cache, MAX_STATIC_ENTRIES);
	}
	return response;
};

const fromCacheThenRefresh = async (event) => {
	const cache = await caches.open(PUBLIC_CACHE);
	const cached = await cache.match(event.request);
	const refresh = fetch(event.request).then(async (response) => {
		if (response.ok) {
			await cache.put(event.request, response.clone());
		}
		return response;
	});
	if (!cached) {
		return refresh;
	}
	event.waitUntil(refresh.catch(() => undefined));
	return cached;
};

self.addEventListener("fetch", (event) => {
	const { request } = event;
	const url = new URL(request.url);
	if (
		request.method !== "GET" ||
		url.origin !== self.location.origin ||
		url.pathname.startsWith("/api/")
	) {
		return;
	}
	if (request.mode === "navigate") {
		event.respondWith(fromNetworkFirst(request));
	} else if (isStatic(url)) {
		event.respondWith(fromCacheFirst(request));
	} else if (isPublic(url)) {
		event.respondWith(fromCacheThenRefresh(event));
	}
});
