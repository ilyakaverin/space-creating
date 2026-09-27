import { PasskeyLogin } from "@/components/PasskeyLogin";
import styles from "./page.module.css";

export default function Home() {
	return (
		<main className={styles.main}>
			{/* A 32×32 icon from public/: next/image would add nothing here. */}
			<img
				className={styles.logo}
				src="/favicon/favicon-32x32.png"
				alt="creating space logo"
				width={32}
				height={32}
			/>
			<PasskeyLogin />
		</main>
	);
}
