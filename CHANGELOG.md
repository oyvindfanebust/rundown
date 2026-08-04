# Changelog

## [0.4.0](https://github.com/oyvindfanebust/rundown/compare/v0.3.0...v0.4.0) (2026-07-16)


### Features

* **jira:** scoped-token support via the api.atlassian.com gateway ([#46](https://github.com/oyvindfanebust/rundown/issues/46)) ([b1a3735](https://github.com/oyvindfanebust/rundown/commit/b1a3735b4024cb98a9394dc668bcfb092bf86b5b))

## [0.3.0](https://github.com/oyvindfanebust/rundown/compare/v0.2.3...v0.3.0) (2026-07-16)


### Features

* **jira:** add the Jira Cloud source (ADR-0013) ([#42](https://github.com/oyvindfanebust/rundown/issues/42)) ([fc2e360](https://github.com/oyvindfanebust/rundown/commit/fc2e360f53a32491f4d2c7731594cb67ea6f7dce))

## [0.2.3](https://github.com/oyvindfanebust/rundown/compare/v0.2.2...v0.2.3) (2026-07-16)


### Refactors

* sources receive resolved config via constructor injection ([#27](https://github.com/oyvindfanebust/rundown/issues/27)) ([#37](https://github.com/oyvindfanebust/rundown/issues/37)) ([174e840](https://github.com/oyvindfanebust/rundown/commit/174e840a10a6175881306a083a4b032fc2590173))

## [0.2.2](https://github.com/oyvindfanebust/rundown/compare/v0.2.1...v0.2.2) (2026-07-16)


### Documentation

* add ADR-0013 for the Jira source design ([#17](https://github.com/oyvindfanebust/rundown/issues/17)) ([#28](https://github.com/oyvindfanebust/rundown/issues/28)) ([f7c4ab5](https://github.com/oyvindfanebust/rundown/commit/f7c4ab5647d164ebe1e3af8e58901c08fe677b9c))
* ADR-0014 — Slack source design ([#21](https://github.com/oyvindfanebust/rundown/issues/21)) ([#34](https://github.com/oyvindfanebust/rundown/issues/34)) ([6eac610](https://github.com/oyvindfanebust/rundown/commit/6eac610a6d0a8b1f07e179f6cfa34bd7d0d397a8))

## [0.2.1](https://github.com/oyvindfanebust/rundown/compare/v0.2.0...v0.2.1) (2026-07-16)


### Bug Fixes

* parse CLI flags per command so brief-only flags error elsewhere ([#32](https://github.com/oyvindfanebust/rundown/issues/32)) ([88bf79a](https://github.com/oyvindfanebust/rundown/commit/88bf79a2c2ec1e4449954a9467e39701ddb26452))

## [0.2.0](https://github.com/oyvindfanebust/rundown/compare/v0.1.5...v0.2.0) (2026-07-16)


### Features

* add `--source` flag to narrow a brief to a subset of configured sources ([#29](https://github.com/oyvindfanebust/rundown/issues/29)) ([0afedaa](https://github.com/oyvindfanebust/rundown/commit/0afedaa2fd1c1820fc4caf6dc5ad18429a830fb8))

## [0.1.5](https://github.com/oyvindfanebust/rundown/compare/v0.1.0...v0.1.5) (2026-07-15)


### Refactors

* centralize the status-only Source error scrub (ADR-0004 §5) ([#24](https://github.com/oyvindfanebust/rundown/issues/24)) ([7945ebd](https://github.com/oyvindfanebust/rundown/commit/7945ebdf4514cb5bab83accffd30c41fe117593a))

## [0.1.0](https://github.com/oyvindfanebust/rundown/releases/tag/v0.1.0) (2026-07-14)


### Features

* initial public release of rundown ([f70cb8c](https://github.com/oyvindfanebust/rundown/commit/f70cb8c5125384760551b8d42613076e0f2bf2bc))
