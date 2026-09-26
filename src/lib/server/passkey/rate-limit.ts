/**
 * Rate limiting — docs/passkey-backend-requirements.md BR-SEC-5.
 *
 * A fixed-window counter per key, kept in memory. That is enough for a single
 * server process; several processes would need a shared store (BR-OPS-5).
 */
import { ApiError } from "./errors";

export interface RateLimitRule {
	limit: number;
	windowMs: number;
}

const MINUTE = 60_000;

export const RATE_LIMITS = {
	/** Per client IP, for both options endpoints. */
	options: { limit: 30, windowMs: MINUTE },
	/** Per client IP, for both verify endpoints. */
	verify: { limit: 10, windowMs: MINUTE },
	/** Per username, for registration options: slows down probing which names exist. */
	registrationName: { limit: 5, windowMs: MINUTE },
} satisfies Record<string, RateLimitRule>;

export interface RateLimiter {
	/** Counts one request against `key`; throws `rate_limited` when over the limit. */
	consume(key: string, rule: RateLimitRule): void;
	/** Forgets windows that have ended, so the map does not grow forever. */
	prune(): void;
}

export const createRateLimiter = (now: () => number): RateLimiter => {
	const windows = new Map<string, { count: number; resetAt: number }>();

	return {
		consume(key, { limit, windowMs }) {
			const time = now();
			let window = windows.get(key);
			if (!window || window.resetAt <= time) {
				window = { count: 0, resetAt: time + windowMs };
				windows.set(key, window);
			}
			window.count += 1;
			if (window.count > limit) {
				const retryAfter = Math.ceil((window.resetAt - time) / 1000);
				throw new ApiError(
					"rate_limited",
					`Too many requests; retry in ${retryAfter} s.`,
					{ "Retry-After": String(retryAfter) },
				);
			}
		},

		prune() {
			const time = now();
			for (const [key, window] of windows) {
				if (window.resetAt <= time) {
					windows.delete(key);
				}
			}
		},
	};
};
