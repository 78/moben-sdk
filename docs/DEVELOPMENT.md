# Development and maintenance

[SDK overview](../README.md)

```sh
npm ci
npm test
npm run typecheck
npm run build
```

## Implementation boundaries

App definition, cloud connectivity, request dispatch and local app commands live in `src/define.ts`, `src/connect.ts`, `src/dispatch.ts`, `src/local.ts` and the App portion of `src/cli.ts`. Shared page, manifest and validation helpers live in `src/core`.

USB transport and the device client live in `src/device.ts`, protocol parsing and frame/snapshot validation in `src/device-protocol.ts`, and device commands in `src/device-cli.ts`. Keep serial transport details within those modules. Adding a device command should preserve the independent App connection and the optional loading of serial dependencies.

## Source ownership and synchronization

The product monorepo remains the source for this release workflow:

- `packages/app-sdk` owns the SDK-specific implementation, tests, templates and documentation.
- `api/src/app-sdk` owns the shared page/manifest helpers and gateway validation. In the product monorepo, `scripts/sync-core.mjs` regenerates the SDK's `src/core` from that source before tests and builds.
- The public `78/moben-sdk` repository contains a standalone SDK snapshot, including `src/core` and its lockfile. With no upstream helper directory present, the script uses the checked-in snapshot, so contributors can install, test and build without the product server repository.

Changes accepted in the public repository should first be incorporated into the appropriate source directory above, then exported back to the standalone snapshot. Shared-helper changes belong in `api/src/app-sdk`; SDK-only changes belong in `packages/app-sdk`. This keeps the public and product copies on the same implementation.

The sync script refreshes shared helpers only; it does not synchronize Git repositories. For a release, refresh the shared helpers, run SDK tests and type checks, and export the SDK sources plus the generated helper snapshot and lockfile to the public repository. Build and package that standalone snapshot for the versioned GitHub Release.
