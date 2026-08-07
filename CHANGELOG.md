# Changelog

## [0.9.0](https://github.com/oyvindfanebust/rundown/compare/v0.8.0...v0.9.0) (2026-08-07)


### Features

* attribute Brief evidence quotes via a per-message relationship ([#95](https://github.com/oyvindfanebust/rundown/issues/95)) ([33e218c](https://github.com/oyvindfanebust/rundown/commit/33e218c8d510cd024e03877962da79c77471a748))


### Bug Fixes

* clamp evidence attribution at the Brief boundary ([#87](https://github.com/oyvindfanebust/rundown/issues/87)) ([8d9f7b9](https://github.com/oyvindfanebust/rundown/commit/8d9f7b9f949cd31abc59ed597222754cac9c924b)), closes [#86](https://github.com/oyvindfanebust/rundown/issues/86)
* **update:** discriminate thrown swap failures by stage ([#92](https://github.com/oyvindfanebust/rundown/issues/92)) ([ea0fd2a](https://github.com/oyvindfanebust/rundown/commit/ea0fd2a9fa90b1d8907035c669c59f3f1f6156b7)), closes [#90](https://github.com/oyvindfanebust/rundown/issues/90)

## [0.8.0](https://github.com/oyvindfanebust/rundown/compare/v0.7.0...v0.8.0) (2026-08-05)


### Features

* **jira:** Retry-After-bounded retry on 429 rate limits ([#81](https://github.com/oyvindfanebust/rundown/issues/81)) ([9b900b1](https://github.com/oyvindfanebust/rundown/commit/9b900b1bb4bfb95eba36f4e2294a1ab74c678812)), closes [#26](https://github.com/oyvindfanebust/rundown/issues/26)

## [0.7.0](https://github.com/oyvindfanebust/rundown/compare/v0.6.0...v0.7.0) (2026-08-05)


### ⚠ BREAKING CHANGES

* a config file with a stray top-level key used to load and is now rejected. Unknown top-level keys fail hard, naming the key and the known keys.

### Features

* download, verify, smoke-test, and atomically swap the binary ([#78](https://github.com/oyvindfanebust/rundown/issues/78)) ([407ef4a](https://github.com/oyvindfanebust/rundown/commit/407ef4a41cd11c62effa8e2dd879e07c2ba6c485)), closes [#65](https://github.com/oyvindfanebust/rundown/issues/65)
* latest-release discovery via redirect and strictly-greater comparison ([#77](https://github.com/oyvindfanebust/rundown/issues/77)) ([64357fd](https://github.com/oyvindfanebust/rundown/commit/64357fd83e5759488c298b50834d533fd7b98e2c)), closes [#64](https://github.com/oyvindfanebust/rundown/issues/64)
* throttled update gate and the detached internal worker mode ([#76](https://github.com/oyvindfanebust/rundown/issues/76)) ([b843556](https://github.com/oyvindfanebust/rundown/commit/b843556f6d35c1a11c26806e51c1a1a4124158f6)), closes [#63](https://github.com/oyvindfanebust/rundown/issues/63)
* update state document and the status version line ([#73](https://github.com/oyvindfanebust/rundown/issues/73)) ([2a44f74](https://github.com/oyvindfanebust/rundown/commit/2a44f748b2f6e0ec4ed01b8fc98bbd64699b9056)), closes [#61](https://github.com/oyvindfanebust/rundown/issues/61)
* validated autoUpdate config field, strict top-level keys, durable-pin warning ([#74](https://github.com/oyvindfanebust/rundown/issues/74)) ([8467568](https://github.com/oyvindfanebust/rundown/commit/84675689bcfd5e47a41b27146a810ec755bb96e3))
* warn on a terminal after seven consecutive failed update checks ([#79](https://github.com/oyvindfanebust/rundown/issues/79)) ([78430a7](https://github.com/oyvindfanebust/rundown/commit/78430a78082352401eed37a335fb12c12cf0bca9)), closes [#66](https://github.com/oyvindfanebust/rundown/issues/66)


### Bug Fixes

* **slack:** emit the debug events the Slack source was dropping ([#72](https://github.com/oyvindfanebust/rundown/issues/72)) ([80feb75](https://github.com/oyvindfanebust/rundown/commit/80feb756db9973f6f3fa96185c28bda7ae0a0494)), closes [#56](https://github.com/oyvindfanebust/rundown/issues/56)

## [0.6.0](https://github.com/oyvindfanebust/rundown/compare/v0.5.0...v0.6.0) (2026-08-05)


### ⚠ BREAKING CHANGES

* `evidence[]` entries change from `{source, quote}` to `{source, where?, who?, quote}`, and the Summarizer's own output schema changes from `{source, quote}` to `{ref, quote}`. Consumers reading `evidence[].source` for attribution should read `where`/`who` instead; `source` is now strictly the source key and kind, code-filled rather than model-written.

### Features

* carry who-and-where attribution structurally on Brief evidence ([#55](https://github.com/oyvindfanebust/rundown/issues/55)) ([46f261b](https://github.com/oyvindfanebust/rundown/commit/46f261b81ac13ac641a2d827f2b097687cd62dc9))

## [0.5.0](https://github.com/oyvindfanebust/rundown/compare/v0.4.0...v0.5.0) (2026-08-04)


### Features

* add the debug logging channel (ADR-0015) ([#53](https://github.com/oyvindfanebust/rundown/issues/53)) ([765bd40](https://github.com/oyvindfanebust/rundown/commit/765bd40276f8c3161cdb0f31b2dd6da03b0648a3))
* **slack:** Slack source (ADR-0014) ([#43](https://github.com/oyvindfanebust/rundown/issues/43)) ([3d86d9e](https://github.com/oyvindfanebust/rundown/commit/3d86d9e26d6e644e73dae6164b01d9de99ef8afd))


### Bug Fixes

* surface the HTTP status in rejected-credential status() details ([#51](https://github.com/oyvindfanebust/rundown/issues/51)) ([f57e535](https://github.com/oyvindfanebust/rundown/commit/f57e5356140ee6e48e95ee919c7552c40221baf9)), closes [#49](https://github.com/oyvindfanebust/rundown/issues/49)

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
