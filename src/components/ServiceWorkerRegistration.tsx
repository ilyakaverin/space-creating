"use client";

import { useEffect } from "react";

/**
 * Registers public/service-worker.js, which makes the site installable and
 * keeps it usable offline. Production builds only: during development a
 * worker left over from an earlier production run on the same localhost port
 * would serve stale files, so it is removed instead.
 */
export function ServiceWorkerRegistration() {
	useEffect(() => {
		if (!("serviceWorker" in navigator)) {
			return;
		}
		if (process.env.NODE_ENV !== "production") {
			void navigator.serviceWorker
				.getRegistrations()
				.then((registrations) =>
					Promise.all(registrations.map((entry) => entry.unregister())),
				);
			return;
		}
		navigator.serviceWorker
			.register("/service-worker.js")
			.catch((error: unknown) =>
				console.error("Service worker registration failed:", error),
			);
	}, []);
	return null;
}
