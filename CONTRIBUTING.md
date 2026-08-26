# Contributing to Clean My Codex

Thanks for helping improve Clean My Codex. Bug reports, focused fixes and well-scoped feature proposals are welcome.

## Before you start

- Search existing issues before opening a new one.
- Use a private security report for vulnerabilities; do not disclose them in a public issue. See [SECURITY.md](SECURITY.md).
- For changes that expand what the app can delete, open an issue first. Cleanup must remain conservative and supported by positive evidence that a target is disposable.

## Development

The project requires Node.js 24 and pnpm 11.19.

```bash
pnpm install
pnpm dev
```

Run the complete check before submitting a pull request:

```bash
pnpm check
```

## Pull requests

- Keep each pull request focused on one change.
- Explain the user-visible behavior and the evidence behind any cleanup rule.
- Add or update tests for behavior changes.
- Update both `README.md` and `README_CN.md` when changing documented behavior.
- Do not include real Codex sessions, credentials, local paths or other private data in fixtures, screenshots, logs or commit history.

By contributing, you agree that your contribution is licensed under the project's [MIT License](LICENSE).
