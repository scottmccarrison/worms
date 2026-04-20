# Worms

Browser-based multiplayer Worms-style artillery game.

## Status

Modernized scaffolding. The legacy 2013 codebase is archived under
[`reference/`](reference/README.md) and is being ported module-by-module
into `src/`.

## Quick start

Requires Node 20+.

    npm install
    npm run dev

Then open http://localhost:5173.

## Scripts

| Command             | What it does                            |
| ------------------- | --------------------------------------- |
| `npm run dev`       | Vite dev server with hot reload.        |
| `npm run build`     | Typecheck + production build to `dist/`. |
| `npm run preview`   | Serve the production build locally.     |
| `npm run typecheck` | `tsc --noEmit`.                         |
| `npm run lint`      | Biome check (lint + format).            |
| `npm run format`    | Biome format (writes changes).          |

## Stack

- TypeScript 5 (strict, bundler resolution)
- Vite 6 (dev server + bundler)
- Biome 1.9 (lint + format)
- *(Future)* Socket.IO, planck.js, canvas rendering

## Structure

    /src          new codebase (entry: src/main.ts)
    /public       static assets served at root
    /reference    archived original codebase (not built)
    /data         game assets (shared with reference during porting)

## Attribution

Fork of [CiaranMcCann/Worms-Armageddon-HTML5-Clone](https://github.com/CiaranMcCann/Worms-Armageddon-HTML5-Clone)
by Ciaran McCann (2012-2013, Apache 2.0). See [`NOTICE`](NOTICE) and
[`LICENSE.txt`](LICENSE.txt).

Original game design and assets: (C) [Team17](http://www.team17.com).
This clone is a non-commercial educational project; no affiliation with Team17.
