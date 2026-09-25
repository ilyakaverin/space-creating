# Svelte learning

```
pnpm install
```

```
pnpm dev
```

Developer build will be served on localhost:3000

Tech stack: sveltekit, svelte 5, vite, typescript, biome

Pages are server-rendered; `@sveltejs/adapter-node` builds a standalone node server.

Installable as a PWA: `static/favicon/site.webmanifest` plus `src/service-worker.ts`, which precaches the build output and static files and keeps the last server render as an offline fallback. SvelteKit only registers the service worker in production builds, so test it with `pnpm build && pnpm start` over https or localhost.

## Scripts

- `pnpm dev` — dev server on port 3000
- `pnpm build` — production build to `build` (node server) and `.svelte-kit`
- `pnpm start` — run the built node server (`node build`), port via `PORT`
- `pnpm preview` — serve the production build through vite
- `pnpm check` — type/a11y check via `svelte-check`
- `pnpm lint` — biome lint + format check
- `pnpm format` — biome format, writing changes

## History

V1: react, react router v6, redux, redux toolkit, parcel, typescript

V2: migrated to pnpm and vite, added rtk query, refactored all components and design

V3: migrated to svelte, evaporated old project

V4: migrated to sveltekit with server-side rendering
