/**
 * Rate limiting — docs/passkey-backend-requirements.md BR-SEC-5.
 *
 * A fixed-window counter per key, kept in the database: on Vercel each
 * request may run in a different instance of the function, so a counter in
 * memory would only see part of the traffic (BR-OPS-5).
 */
import type { Sql } from "./database";
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
} satisfies Record<string, RateLimitRule>;

export interface RateLimiter {
	/** Counts one request against `key`; throws `rate_limited` when over the limit. */
	consume(key: string, rule: RateLimitRule): Promise<void>;
	/** Deletes windows that have ended, so the table does not grow forever. */
	prune(): Promise<number>;
}

export const createRateLimiter = (
	sql: Sql,
	now: () => number,
): RateLimiter => ({
	async consume(key, { limit, windowMs }) {
		const time = now();
		// One atomic statement: concurrent requests on other instances can
		// neither lose a count nor both start a fresh window.
		const { rows } = await sql.query<{ count: number; reset_at: Date }>(
			`INSERT INTO rate_limits AS r (key, count, reset_at) VALUES ($1, 1, $3)
			ON CONFLICT (key) DO UPDATE SET
				count = CASE WHEN r.reset_at <= $2 THEN 1 ELSE r.count + 1 END,
				reset_at = CASE WHEN r.reset_at <= $2 THEN excluded.reset_at ELSE r.reset_at END
			RETURNING count, reset_at`,
			[key, new Date(time), new Date(time + windowMs)],
		);
		const { count, reset_at } = rows[0];
		if (count > limit) {
			const retryAfter = Math.max(
				1,
				Math.ceil((reset_at.getTime() - time) / 1000),
			);
			throw new ApiError(
				"rate_limited",
				`Too many requests; retry in ${retryAfter} s.`,
				{ "Retry-After": String(retryAfter) },
			);
		}
	},

	async prune() {
		const { rowCount } = await sql.query(
			"DELETE FROM rate_limits WHERE reset_at <= $1",
			[new Date(now())],
		);
		return rowCount;
	},
});
