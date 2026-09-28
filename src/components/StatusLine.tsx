import type { Feedback } from "./usePasskeySession";

/** The line under the buttons; screen readers announce what appears in it. */
export function StatusLine({ status, message }: Feedback) {
	return (
		<p className="message" aria-live="polite">
			{status === "pending" ? (
				"Waiting for your authenticator…"
			) : status === "verifying" ? (
				"Verifying…"
			) : status === "error" ? (
				<span className="error">{message}</span>
			) : (
				message
			)}
		</p>
	);
}
