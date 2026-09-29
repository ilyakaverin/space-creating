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

/**
 * Only plain successful answers are kept. Safari refuses to show a page
 * from a response that was redirected, so such a copy would break the
 * offline fallback.
 */
const cacheable = (response) => response.ok && !response.redirected;

/**
 * Saving a copy is a bonus: a full or restricted storage (private windows,
 * low disk space) must never turn a good answer into a failed page. So the
 * write runs beside the response, and its errors are only logged.
 */
const keepCopy = (event, cacheName, request, response, afterPut) => {
	const copy = response.clone();
	event.waitUntil(
		caches
			.open(cacheName)
			.then(async (cache) => {
				await cache.put(request, copy);
				await afterPut?.(cache);
			})
			.catch((error) =>
				console.warn("[service worker] cache write failed", error),
			),
	);
};

const precache = async () => {
	const response = await fetch("/", { cache: "no-cache" });
	if (!cacheable(response)) {
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

/**
 * Pages are fetched fresh, with the last good copy as the offline fallback.
 * Only a failed fetch — no network — falls back; nothing else can make the
 * page fail here.
 */
const fromNetworkFirst = async (event) => {
	const { request } = event;
	let response;
	try {
		response = await fetch(request);
	} catch (error) {
		const cached = await caches
			.open(PAGE_CACHE)
			.then(
				async (cache) =>
					(await cache.match(request)) ?? (await cache.match("/")),
			)
			.catch(() => undefined);
		if (cached) {
			return cached;
		}
		throw error;
	}
	if (cacheable(response)) {
		keepCopy(event, PAGE_CACHE, request, response);
	}
	return response;
};

/** Cache keys keep insertion order, so the first ones are the oldest. */
const trim = async (cache, maxEntries) => {
	const keys = await cache.keys();
	const excess = keys.slice(0, Math.max(0, keys.length - maxEntries));
	await Promise.all(excess.map((key) => cache.delete(key)));
};

const fromCacheFirst = async (event) => {
	const { request } = event;
	const cached = await caches
		.match(request, { cacheName: STATIC_CACHE })
		.catch(() => undefined);
	if (cached) {
		return cached;
	}
	const response = await fetch(request);
	if (cacheable(response)) {
		keepCopy(event, STATIC_CACHE, request, response, (cache) =>
			trim(cache, MAX_STATIC_ENTRIES),
		);
	}
	return response;
};

const fromCacheThenRefresh = async (event) => {
	const cached = await caches
		.match(event.request, { cacheName: PUBLIC_CACHE })
		.catch(() => undefined);
	const refresh = fetch(event.request).then((response) => {
		if (cacheable(response)) {
			keepCopy(event, PUBLIC_CACHE, event.request, response);
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
		event.respondWith(fromNetworkFirst(event));
	} else if (isStatic(url)) {
		event.respondWith(fromCacheFirst(event));
	} else if (isPublic(url)) {
		event.respondWith(fromCacheThenRefresh(event));
	}
});
