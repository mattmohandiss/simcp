# Simulation MCP Contributor Instructions

- Keep engineering choices explicit: never infer materials, boundary conditions,
  or substitute stale entity selections.
- Preserve exact-byte artifact validation, filesystem-root restrictions, bounded
  child processes, controlled environments, and failure/result verification.
- Keep dependencies and test inputs server-local. Do not invoke other MCP servers
  from the implementation or rely on another repository's tests.
- Prefer `just` recipes. Run `just check` in the `checks` Nix shell for fast
  validation; use `just integration` in the full shell for native solver changes.
- `.envrc` activates the flake; require `direnv allow` after changes. Keep
  credentials out of the repository and document placeholders only.
- Keep language tooling and additive editor/agent configuration project-local.
- Report which native checks ran; do not treat skipped tests as solver evidence.

See [README](README.md) for commands, supported physics, and current build limitations.
