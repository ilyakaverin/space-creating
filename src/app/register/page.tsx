import { RegisterForm } from "@/components/RegisterForm";
import type { Metadata } from "next";
import Link from "next/link";
import styles from "../page.module.css";

export const metadata: Metadata = {
	title: "sign up · creating space",
};

export default function Register() {
	return (
		<main className={styles.main}>
			<Link href="/" aria-label="creating space home">
				{/* A 32×32 icon from public/: next/image would add nothing here. */}
				<img
					className={styles.logo}
					src="/favicon/favicon-32x32.png"
					alt=""
					width={32}
					height={32}
				/>
			</Link>
			<RegisterForm />
		</main>
	);
}
