# Third-Party Notices

DSim's own source code is dedicated to the public domain under The Unlicense. See the [LICENSE](./LICENSE) file.

DSim depends on third-party packages that are **not** part of this dedication.
Each retains its own license. These dependencies are fetched at install time
(via pnpm into `node_modules`) and are not redistributed within this
repository, so their license texts live alongside their respective packages.

Most dependencies are permissively licensed (MIT / ISC) and impose no
conditions on this repository. The following dependencies carry redistribution
conditions worth noting if you ship a built copy of the app:

## Fonts — SIL Open Font License 1.1 (OFL-1.1)

The following fonts are bundled into the production build output (`dist/`) when
you run `pnpm build`:

- **Fraunces** — `@fontsource-variable/fraunces`
- **Hanken Grotesk** — `@fontsource-variable/hanken-grotesk`
- **Spline Sans Mono** — `@fontsource-variable/spline-sans-mono`

Under OFL-1.1, when you distribute these font files you must keep their license
and copyright notices with them, you may not sell the fonts on their own, and
you may not rename them to a reserved font name. Each Fontsource package
includes its own `LICENSE`/`OFL.txt`; do not strip these from build output.

## Everything else

All other runtime and development dependencies (e.g. React, React Router,
Fastify and its plugins, Zod, Lucide icons, TypeScript, Vite, Vitest) are
licensed under MIT, ISC, or Apache-2.0. Their license terms apply only to those
packages, not to DSim's own code, and are available in their respective
`node_modules` directories.
