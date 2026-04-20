# Reference (archived)

In-tree archive of the original
[Worms-Armageddon-HTML5-Clone](https://github.com/CiaranMcCann/Worms-Armageddon-HTML5-Clone)
codebase by Ciaran McCann (2012-2013), preserved verbatim from the fork point.

## Why keep it

The new implementation under `/src` is being ported module-by-module
from this reference. Keeping the original here makes cross-referencing
fast: click through to `reference/src/weapons/HandGrenade.ts` instead of
digging through `git show`.

## Status

- **Not built.** `tsconfig.json` excludes this tree; Vite does not import it.
- **Not linted.** `biome.json` ignores it.
- **Not running.** The assets, HTML shell, and build system that drove this
  code are removed or replaced. It only compiles with the original MSBuild pipeline.

## License

Original code (C) 2012-2013 Ciaran McCann, Apache License 2.0. See `/LICENSE.txt`.

## When to delete

Once every module referenced here has been ported to `/src`, this directory
gets removed in a dedicated "retire-legacy" PR.
