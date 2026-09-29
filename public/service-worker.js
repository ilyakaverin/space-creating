/**
 * The site is no longer a PWA and registers no service worker. Browsers that
 * installed the old one keep it until it removes itself — deleting this
 * file would not be enough, as a worker whose update check fails stays
 * installed. So this is what they find at the old address on their next
 * visit: it deletes every cache the old worker filled, then unregisters.
 * It handles no requests, so they all go straight to the network.
 *
 * Once visitors have had time to come back (a few months), this file and
 * its header in next.config.ts can go.
 */
self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
			.then(() => self.registration.unregister()),
	);
});
