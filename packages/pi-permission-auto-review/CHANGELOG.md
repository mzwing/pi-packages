# @mzwing/pi-permission-auto-review

## 0.3.1

### Patch Changes

- [`125187d`](https://github.com/mzwing/pi-packages/commit/125187d5046cc459280b5bf46e266aee783bd6ec) Thanks [@mzwing](https://github.com/mzwing)! - chore(pi-permission-auto-review): reconcile the bundled Guardian policy against openai/codex@6478a751, accept @gotgenes/pi-permission-system v29
  
  Upstream moved `policy_template.md` and `policy.md` from `codex-rs/core/src/guardian` to `codex-rs/core/assets/guardian` (openai/codex#41477). Both files are byte-identical across the move, so the adapted policy text is unchanged; only the tracked directory and the pinned revision recorded in `POLICY_REVISION` move.
  
  v29.0.0 removes the deprecated process-root service slot — `getRootPermissionsService()` and its publish/unpublish pair. This extension registers through the keyed locator `getPermissionsService(sessionId)`, which that release leaves untouched along with the `PermissionsService` interface, the authorizer contract, and the `permissions:ready` payload, so only the peer range widens.

## 0.3.0

### Minor Changes

- [`52ab334`](https://github.com/mzwing/pi-packages/commit/52ab3344add20a207796bccd40e5d7b836efe7e6) Thanks [@mzwing](https://github.com/mzwing)! - refactor for simpilicity, support for Pi 0.84 and pi-permission-system v27

## 0.2.0

### Minor Changes

- [`162b8f5`](https://github.com/mzwing/pi-packages/commit/162b8f580d76bf043e697a1dd97f172ea9abd7f0) Thanks [@mzwing](https://github.com/mzwing)! - feat(pi-permission-auto-review): sync the latest codex-auto-review prompt, enhance permission reviewer with user interaction handling and transcript statistics

## 0.1.4

### Patch Changes

- [`351bc90`](https://github.com/mzwing/pi-packages/commit/351bc903442cb7e42514b6672290ad7ef4e6750b) Thanks [@mzwing](https://github.com/mzwing)! - Prevent subagent extension instances from repeatedly registering the process-global `auto-review` authorizer.

## 0.1.3

### Patch Changes

- [`32a0e76`](https://github.com/mzwing/pi-packages/commit/32a0e768df3731bc081e54704550712453e5ace8) Thanks [@mzwing](https://github.com/mzwing)! - Add a legacy model registry provider lookup for Pi 0.80.10 and use it in permission auto-review.

- Updated dependencies [[`32a0e76`](https://github.com/mzwing/pi-packages/commit/32a0e768df3731bc081e54704550712453e5ace8)]:
  - @mzwing/pi-polyfill@0.0.1

## 0.1.2

### Patch Changes

- [`7ce3f16`](https://github.com/mzwing/pi-packages/commit/7ce3f16bafc1f23a1f80ec12488935478a59c96a) Thanks [@mzwing](https://github.com/mzwing)! - Use changeset to release, replace self written script

## 0.1.1

### Patch Changes

- No significant changes

## 0.1.0

### Patch Changes

- Initial release
