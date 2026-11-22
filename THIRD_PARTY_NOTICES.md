# Third-Party Notices

Tsubasa Terminal is distributed under the MIT License (see `LICENSE`).
It bundles third-party components that remain under their own licenses.

The license and copyright texts these components require to be reproduced are
in [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt). This file is the inventory; that file is the notice.
Both are installed with the application under `resources/`, next to `LICENSE`.

Both are generated — run `node scripts/gen-notices.mjs` after any dependency
change rather than editing them by hand; `npm run typecheck` fails while they
are out of date. They cover what is actually shipped: the production
dependency closure from `package-lock.json`, which electron-builder installs
into `app.asar`, plus the development dependencies whose content the build
compiles into the application bundle. Other build-time tooling does not reach
the installed application and carries no distribution duty.

Covered: 77 packaged npm dependencies, 2 bundled build-time packages.

## Packaged npm dependencies

| Package | Version | License |
| --- | --- | --- |
| @anthropic-ai/sdk | 0.111.0 | MIT |
| @babel/helper-string-parser | 7.29.7 | MIT |
| @babel/helper-validator-identifier | 7.29.7 | MIT |
| @babel/parser | 7.29.7 | MIT |
| @babel/runtime | 7.29.7 | MIT |
| @babel/types | 7.29.7 | MIT |
| @electron-toolkit/utils | 4.0.0 | MIT |
| @floating-ui/core | 1.7.5 | MIT |
| @floating-ui/dom | 1.7.6 | MIT |
| @floating-ui/utils | 0.2.11 | MIT |
| @floating-ui/vue | 1.1.11 | MIT |
| @internationalized/date | 3.12.2 | Apache-2.0 |
| @internationalized/number | 3.6.7 | Apache-2.0 |
| @jridgewell/sourcemap-codec | 1.5.5 | MIT |
| @stablelib/base64 | 1.0.1 | MIT |
| @swc/helpers | 0.5.23 | Apache-2.0 |
| @tanstack/virtual-core | 3.17.3 | MIT |
| @tanstack/vue-virtual | 3.13.31 | MIT |
| @types/linkify-it | 5.0.0 | MIT |
| @types/markdown-it | 14.1.2 | MIT |
| @types/mdurl | 2.0.0 | MIT |
| @types/web-bluetooth | 0.0.21 | MIT |
| @vue/compiler-core | 3.5.39 | MIT |
| @vue/compiler-dom | 3.5.39 | MIT |
| @vue/compiler-sfc | 3.5.39 | MIT |
| @vue/compiler-ssr | 3.5.39 | MIT |
| @vue/reactivity | 3.5.39 | MIT |
| @vue/runtime-core | 3.5.39 | MIT |
| @vue/runtime-dom | 3.5.39 | MIT |
| @vue/server-renderer | 3.5.39 | MIT |
| @vue/shared | 3.5.39 | MIT |
| @vueuse/core | 14.3.0 | MIT |
| @vueuse/metadata | 14.3.0 | MIT |
| @vueuse/shared | 14.3.0 | MIT |
| @xterm/addon-fit | 0.11.0 | MIT |
| @xterm/addon-unicode-graphemes | 0.4.0 | MIT |
| @xterm/xterm | 6.0.0 | MIT |
| argparse | 2.0.1 | Python-2.0 |
| aria-hidden | 1.2.6 | MIT |
| asn1 | 0.2.6 | MIT |
| bcrypt-pbkdf | 1.0.2 | BSD-3-Clause |
| buildcheck | 0.0.7 | MIT |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| clsx | 2.1.1 | MIT |
| cpu-features | 0.0.10 | MIT |
| csstype | 3.2.3 | MIT |
| defu | 6.1.7 | MIT |
| entities | 4.5.0 | BSD-2-Clause |
| entities | 7.0.1 | BSD-2-Clause |
| estree-walker | 2.0.2 | MIT |
| fast-sha256 | 1.3.0 | Unlicense |
| json-schema-to-ts | 3.1.1 | MIT |
| linkify-it | 5.0.2 | MIT |
| lucide-vue-next | 0.577.0 | ISC |
| magic-string | 0.30.21 | MIT |
| markdown-it | 14.3.0 | MIT |
| mdurl | 2.0.0 | MIT |
| nan | 2.28.0 | MIT |
| nanoid | 3.3.15 | MIT |
| ohash | 2.0.11 | MIT |
| openai | 6.46.0 | Apache-2.0 |
| picocolors | 1.1.1 | ISC |
| postcss | 8.5.16 | MIT |
| punycode.js | 2.3.1 | MIT |
| reka-ui | 2.10.1 | MIT |
| safer-buffer | 2.1.2 | MIT |
| source-map-js | 1.2.1 | BSD-3-Clause |
| ssh2 | 1.17.0 | MIT |
| standardwebhooks | 1.0.0 | MIT |
| tailwind-merge | 3.6.0 | MIT |
| trzsz | 1.1.6 | MIT |
| ts-algebra | 2.0.0 | MIT |
| tslib | 2.8.1 | 0BSD |
| tweetnacl | 0.14.5 | Unlicense |
| uc.micro | 2.1.0 | MIT |
| vue | 3.5.39 | MIT |
| vue-demi | 0.14.10 | MIT |

## Build-time packages compiled into the bundle

| Package | Version | License | What ships |
| --- | --- | --- | --- |
| @withfig/autocomplete | 2.692.3 | ISC | command specs extracted into src/renderer/src/assets/fig-specs.json |
| tailwindcss | 4.3.2 | MIT | preflight and theme stylesheet compiled into the renderer CSS bundle |

## Packages shipping no license file

These declare a license in their manifest but ship no license text inside the
published package. The SPDX identifier in the tables above governs, and the
standard text for each of those identifiers appears in THIRD_PARTY_LICENSES.txt by way of
the other packages using it.

| Package | Version | License |
| --- | --- | --- |
| standardwebhooks | 1.0.0 | MIT |

## Additional notices

**Electron and Chromium.** The application runs on Electron (MIT), which embeds
Chromium, Node.js, V8 and their own dependencies. electron-builder places
`LICENSE.electron.txt` and `LICENSES.chromium.html` next to `TsubasaTerminal.exe` in
the installation directory; those two files are the notice for that layer and
are not repeated here.

**Command-line companion.** `resources/cli/tsubasa-ssh.js` is bundled from this
repository's own source and uses only Node.js built-in modules. It contains no
third-party code.

**Completion corpus.** `src/renderer/src/assets/fig-specs.json` is committed
data derived from `@withfig/autocomplete` (ISC, listed above):
`scripts/extract-specs.mjs` keeps the names, options and descriptions of a
fixed set of commands and drops everything else. It is the only third-party
material committed to this repository, and its notice is the ISC text in
THIRD_PARTY_LICENSES.txt.

**Terminal color schemes.** Tokyo Night, Dracula, Gruvbox Dark, Nord,
One Half Dark, One Half Light, Catppuccin Mocha and Catppuccin Latte in
`src/shared/terminalThemes.ts` reproduce the published color values of those
schemes, as converted by the iTerm2-Color-Schemes collection (the Catppuccin
ANSI colors from the official catppuccin/palette, the Latte selection color
from the official catppuccin/windows-terminal port). All eight schemes, that
collection and those Catppuccin projects are published under the MIT License.
Only color values are used; no source files from those projects are included.

**No vendored UI source.** The interface is styled with stylesheets authored in
this repository; `reka-ui` supplies unstyled behavioral primitives and is
consumed as an ordinary npm dependency. shadcn-vue component copies that
earlier versions carried under `components/ui/` were removed in v0.13.0 and
rewritten as this repository's own wrappers, so no copied component source
remains.
