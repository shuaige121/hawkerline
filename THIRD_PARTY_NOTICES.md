# Third-party components

These components keep their own licenses; the Hawkerline Community License does not apply to them.

| Component | Where | License |
|---|---|---|
| Leaflet 1.9.4 | `web/vendor/leaflet/` (bundled) | BSD-2-Clause, see `web/vendor/leaflet/LICENSE` |
| qrcode-svg | npm dependency, bundled into the Worker at build time | MIT |
| iconv-lite | npm dependency (kitchen print agent) | MIT |

Development-only dependencies (Wrangler, Puppeteer) are installed by `npm ci` and are not distributed with this repository.
