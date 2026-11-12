# Published DSH consumer SDK

`adapters/dsh/consumer-0.2/` pins the same fixture to DSH **0.2.2-rc.1** and its peer closure. Install that manifest and lockfile into `.tmp/dsh-sdk-0-2` with the same `npm ci` command, then run `npm run test:dsh` with `DSH_PACKAGE_ROOT` pointing there. One test file covers both targets: it selects the available services, system-prompt persona keys and request-stop path from the installed SDK.

This manifest and lockfile install the published SDK used by `dsh.test.mjs`, without the DSH CLI, web UI, or concrete tool/provider implementations. Every DSH package is pinned to `0.1.0-rc.6`; the other direct dependencies pin the required Cordis peer set. Installing only `@deepseek-ai/dsh@0.1.0-rc.6` does not pin that SDK: the CLI's caret dependencies can resolve to later prereleases.

From the repository root, reproduce the CI installation in an isolated directory:

```sh
mkdir -p .tmp/dsh-sdk
cp adapters/dsh/consumer/package{,-lock}.json .tmp/dsh-sdk/
npm ci --prefix .tmp/dsh-sdk --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --cache .tmp/dsh-npm-cache --fetch-retries=1 --fetch-timeout=20000 --timing --loglevel=http
DSH_PACKAGE_ROOT="$PWD/.tmp/dsh-sdk" npm run test:dsh
```

`DSH_PACKAGE_ROOT` is the SDK resolution anchor: this fixture manifest works alongside the existing full-DSH-installation entry. The test still uses the real published profile discovery, Loader, prompt service and agent loop. Its request hook stops before provider resolution.

`node-addon-require-builtin` is needed for the Loader's native bare-package resolution from the temporary profile. Keep it even though Loader declares it an optional peer. Without it, the Loader can import absolute SDK entries but cannot resolve the generated bundle from the profile.

To update the target, change the exact versions in `package.json`, copy it into a fresh repository `.tmp/` directory, and run `npm install --package-lock-only` there against the public npm registry. Bring the generated lockfile back here, then run the locked install and consumer tests above. Required peers belong in the manifest; do not use `--legacy-peer-deps` or substitute local SDK paths for CI.

CI caps the install at three minutes and the job at five. npm prints fetch/timing progress and writes diagnostics under `.tmp/dsh-npm-cache/_logs/`; failed jobs upload that directory as `dsh-consumer-npm-logs`.
