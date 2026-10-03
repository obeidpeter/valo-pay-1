# Pinned publishing Node runtime

The release's application source is based on a092e1b4b27463a3a455036bba6275da1e322e99.
Deployment-only changes pin official Node 24.21.0 without weakening package.json engines.
This was the latest Node 24 LTS entry in nodejs.org/dist/index.json when checked
on 2026-09-26 (release date 2026-09-07, LTS Krypton). Select the latest patched
release in the supported LTS line, not merely the minimum permitted by engines.

`.node-version` is shared with the primary GitHub Actions setup-node jobs.
The independent Node 22 compatibility job remains unchanged.

The API and web production build commands call `scripts/deployment-node.sh build`.
It downloads only the official Linux x64 archive from nodejs.org, checks the
committed SHA-256 before extraction, verifies the executable hash, and prepends
its bin directory to PATH. The hashes were verified against the official
v24.21.0 SHASUMS256.txt and its checked archive. Unsupported versions/platforms,
checksum failures, and failed downloads abort; there is no older-runtime fallback.

The resulting `.deployment-runtime` directory is a build output required in the
published runtime image, not committed binary content. API production startup
uses the wrapper's `run` mode, which never downloads. It verifies the executable
hash and version before replacing itself with Node. Build and start logs print
the actual version and executable path. A missing runtime prevents startup.

Local verification (does not publish or modify database data):

    bash scripts/deployment-node.sh build node --version
    bash scripts/deployment-node.sh run node --version
    bash scripts/deployment-node.sh build pnpm --filter @workspace/valo-pay-1-api-server run build
    bash scripts/deployment-node.sh build pnpm --filter @workspace/valo-pay-1 run build

The published image's build/start log and readiness check remain the final
confirmation after user-coordinated publication. No schema commands are part
of the build. The dual observation guards, service settings, and documented
anonymous sandbox expiry policy are not changed by this runtime configuration.

To upgrade, review the official release, change `.node-version` and both pinned
checksums together, then verify builds and startup before publishing. Never
replace the hashes with values obtained from an unverified archive.