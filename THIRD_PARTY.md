# Third-party source

- Active runtime: Scramjet-LS-Bypass https://github.com/paxton-warin/Scramjet-LS-Bypass/tree/4f452feec4d6804730b903294d0f9bec8002a635 — fork of Scramjet; existing AGPL notices retained. The eight committed app/vendor artifacts are copied without modification. `/source/scramjet-source.tar.gz` contains this exact fork revision.

- Scramjet demo/core/controller/helpers: https://github.com/MercuryWorkshop/scramjet/tree/e9ff92d1ec98ba140cb4bca840fb40c2b9b52ebf — package licenses AGPL-3.0-only. Original demo is retained under upstream/demo-original. Full pinned source is available through scripts/build-upstream.sh.
- Libcurl transport 2.0.5: https://github.com/MercuryWorkshop/CurlTransport — AGPL-3.0-only.
- Wisp JS 0.4.1: https://github.com/MercuryWorkshop/wisp-js — see included package license.
- React / React DOM: https://github.com/facebook/react — MIT.
- Lucide: https://github.com/lucide-icons/lucide — ISC.

Exact application dependencies and integrity hashes are in pnpm-lock.yaml. Built runtime hashes are in runtime/public/manifest.json. The interface and three built-in games were written for this project; external games open at their original URLs through the selected proxy engine.

- React Markdown 10.1.0 and remark-gfm 4.0.1: https://github.com/remarkjs/react-markdown and https://github.com/remarkjs/remark-gfm — MIT.

- Expanded Apps/Games catalog and cover images: adapted from UseInterstellar/Interstellar at `1e13802605b1ff85461adcb0c438594cbe600415` (AGPL-3.0), https://github.com/UseInterstellar/Interstellar/tree/1e13802605b1ff85461adcb0c438594cbe600415 . Original license is included in docs/catalog/Interstellar-LICENSE.txt. Names/logos identify their respective services and games. Atlas bundles catalog metadata and covers, not the external games themselves. `scripts/import-catalog.py` records the pinned source and selection/availability checks; broken relative deployment routes are not imported. Owner edits and hidden entries are retained on restart.

- KaTeX 0.16.47 (bundled math renderer/styles/fonts): https://github.com/KaTeX/KaTeX — MIT, notice retained in `docs/licenses/KaTeX-MIT.txt`. remark-math 6.0.0 and rehype-katex 7.0.1: https://github.com/remarkjs/remark-math — MIT; dependency versions/integrity are pinned in pnpm-lock.yaml.
