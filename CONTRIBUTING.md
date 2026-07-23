# Contributing

Autopilot requires Node 22. Install dependencies with `yarn install`, then run:

```text
yarn typecheck
yarn test
yarn build
```

Behavior changes should start with a failing test. Keep lifecycle protocol
changes separate from product-shell changes and preserve the manifest, marker,
trailer, ref, and session-command contracts unless a design explicitly
versions them.
