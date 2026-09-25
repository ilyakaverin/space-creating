/// <reference types="@sveltejs/kit" />
import { build, files, version } from "$service-worker";

const sw = self as unknown as ServiceWorkerGlobalScope;

const ASSET_CACHE = `assets-${version}`;
const PAGE_CACHE = `pages-${version}`;
const ASSETS = [...build, ...files];

sw.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(ASSET_CACHE)
			.then((cache) => cache.addAll(ASSETS))
			.then(() => sw.skipWaiting()),
	);
});

sw.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((key) => key !== ASSET_CACHE && key !== PAGE_CACHE)
						.map((key) => caches.delete(key)),
				),
			)
			.then(() => sw.clients.claim()),
	);
});

/** Hashed build output and static files never change under a given version. */
const fromCacheFirst = async (request: Request): Promise<Response> => {
	const cache = await caches.open(ASSET_CACHE);
	const cached = await cache.match(request);
	if (cached) {
		return cached;
	}
	const response = await fetch(request);
	if (response.ok) {
		await cache.put(request, response.clone());
	}
	return response;
};

/** Server-rendered pages are fetched fresh, with the last good render as the offline fallback. */
const fromNetworkFirst = async (request: Request): Promise<Response> => {
	const cache = await caches.open(PAGE_CACHE);
	try {
		const response = await fetch(request);
		if (response.ok) {
			await cache.put(request, response.clone());
		}
		return response;
	} catch (cause) {
		const cached = (await cache.match(request)) ?? (await cache.match("/"));
		if (cached) {
			return cached;
		}
		throw cause;
	}
};

sw.addEventListener("fetch", (event) => {
	const { request } = event;
	if (request.method !== "GET") {
		return;
	}
	const url = new URL(request.url);
	if (url.origin !== location.origin) {
		return;
	}
	event.respondWith(
		ASSETS.includes(url.pathname)
			? fromCacheFirst(request)
			: fromNetworkFirst(request),
	);
});
