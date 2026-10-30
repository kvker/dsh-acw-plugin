# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-30

### Added

- Convert a picked workspace directory into the AI Context Workspace layout: the directory becomes `<name>--acw`, its
  contents move into `projects/<name>/`, and the ACW root is registered instead of the original path.
- Template handling: clone `kvker/ai-context-workspace` once into a local cache, copy it per conversion, and prewarm it
  in the background.
- Old-workspace compatibility: a directory counts as ACW when `background/`, `conventions/`, `artifacts/` and `.agents/`
  all exist, with or without `.acw-marker`.
- First-turn `$an-init` offer, gated on the skill file still being present.
- Workspace titles follow the ACW directory name; legacy titles are synced on load.
- Safety rules: existing target, session history, protected paths, ACW nesting, and rollback on failure.
- Diagnostics at `~/.dsh/ai-context-workspace/last-run.json`.
- Unit tests and GitHub Actions CI.
