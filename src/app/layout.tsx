import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "./globals.css";

/**
 * The pixel font, served from this site and preloaded. next/font exposes it
 * as a CSS variable, which globals.css puts first in the font stack.
 */
const bios = localFont({
	src: "../assets/Fonts/WebPlus_IBM_BIOS.woff",
	variable: "--font-bios",
	display: "swap",
	// The default fallback is a resized Arial; a pixel font falls back to monospace.
	adjustFontFallback: false,
	fallback: ["monospace"],
});

export const metadata: Metadata = {
	title: "creating space",
	description: "creating space",
	manifest: "/favicon/site.webmanifest",
	icons: {
		icon: [
			{ url: "/favicon/favicon-32x32.png", sizes: "32x32", type: "image/png" },
			{ url: "/favicon/favicon-16x16.png", sizes: "16x16", type: "image/png" },
		],
		apple: { url: "/favicon/apple-touch-icon.png", sizes: "76x76" },
		other: {
			rel: "mask-icon",
			url: "/favicon/safari-pinned-tab.svg",
			color: "#5bbad5",
		},
	},
	appleWebApp: {
		capable: true,
		title: "creating space",
		statusBarStyle: "black",
	},
	other: {
		"msapplication-TileColor": "#da532c",
	},
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	themeColor: "#000000",
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en" className={bios.variable}>
			<body>
				{children}
				<ServiceWorkerRegistration />
			</body>
		</html>
	);
}
