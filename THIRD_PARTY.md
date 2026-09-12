# Third-party source

- Active runtime: Scramjet-LS-Bypass https://github.com/paxton-warin/Scramjet-LS-Bypass/tree/4f452feec4d6804730b903294d0f9bec8002a635 — fork of Scramjet; existing AGPL notices retained. The eight committed app/vendor artifacts are copied without modification. `/source/scramjet-source.tar.gz` contains this exact fork revision.

- Scramjet demo/core/controller/helpers: https://github.com/MercuryWorkshop/scramjet/tree/e9ff92d1ec98ba140cb4bca840fb40c2b9b52ebf — package licenses AGPL-3.0-only. Original demo is retained under upstream/demo-original. Full pinned source is available through scripts/build-upstream.sh.
- Ultraviolet 3.2.10: https://github.com/titaniumnetwork-dev/Ultraviolet — AGPL-3.0.
- Libcurl transport 2.0.5: https://github.com/MercuryWorkshop/CurlTransport — AGPL-3.0-only.
- BareMux 2.1.9: https://github.com/MercuryWorkshop/bare-mux — see included package license.
- Epoxy transport 2.1.28: https://github.com/MercuryWorkshop/EpoxyTransport — see included package license.
- Wisp JS 0.4.1: https://github.com/MercuryWorkshop/wisp-js — see included package license.
- React / React DOM: https://github.com/facebook/react — MIT.
- Lucide: https://github.com/lucide-icons/lucide — ISC.

Exact application dependencies and integrity hashes are in pnpm-lock.yaml. Built runtime hashes are in runtime/public/manifest.json. The interface and three built-in games were written for this project; external games open at their original URLs through the selected proxy engine.

- React Markdown 10.1.0 and remark-gfm 4.0.1: https://github.com/remarkjs/react-markdown and https://github.com/remarkjs/remark-gfm — MIT.
