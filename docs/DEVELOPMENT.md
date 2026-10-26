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

This repository is the single maintenance and release entry point for SDK code, CLI commands, tests, templates, examples and documentation. SDK changes are committed here directly; Moben Cloud does not keep a second complete SDK package.

Moben Cloud still owns `api/src/app-sdk`, which its built-in apps and gateway use at runtime. The SDK keeps a source snapshot of those shared page/manifest helpers and validators in `src/core`. Ordinary `npm test`, `npm run typecheck` and `npm run build` use that checked-in snapshot and require no Cloud checkout.

When the shared contract changes, update and test the Cloud helpers first. From this SDK checkout, explicitly import that helper directory:

```sh
npm run sync -- --source /path/to/moben-cloud/api/src/app-sdk
npm test
npm run typecheck
npm run build
```

Use the path appropriate for your machine and shell. The import reads only visible TypeScript files and replaces `src/core` after checking the input. Review and commit the helper snapshot with its associated SDK changes; SDK-specific changes belong outside the generated helper directory.

Release versions from this repository after the SDK checks pass. Publish the same built archive to npm and GitHub Release. Cloud protocol documentation and the SDK's `REMOTE_APPS.md` should be updated together when their shared contract changes.
