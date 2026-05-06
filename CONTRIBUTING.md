# Contributing to wzxClaw

Thank you for your interest in contributing to wzxClaw! This guide will help you get started.

## Development Setup

### Prerequisites

- **Node.js** >= 20.19.0
- **npm** >= 10.0.0
- **Flutter SDK** (stable channel) — only needed for Android changes
- **JDK 17** — only needed for Android builds
- **Git** with bash (used by the Bash tool and terminal)

### Desktop (Electron)

```bash
cd wzxClaw_desktop
npm ci
npm test              # Run all tests
npm run dev           # Start dev server (must run outside VS Code/Cursor terminal)
```

### Android (Flutter)

```bash
cd wzxClaw_android
flutter pub get
flutter analyze --no-fatal-infos
flutter test
```

### Relay Server

```bash
cd relay
npm test
```

## Project Structure

```
wzxClaw_desktop/     → Electron desktop IDE (primary codebase)
wzxClaw_android/     → Flutter Android companion app
relay/               → Node.js WebSocket relay (NAS deployment)
```

See [README.md](README.md) for the full directory tree and architecture details.

## Code Style

- **TypeScript** — Follow existing patterns in the codebase. Comments are written in Chinese.
- **Dart** — Follow `analysis_options.yaml` rules (`flutter analyze` must pass).
- **Naming** — Follow the existing conventions in each subproject.
- **IPC channels** — All new IPC channels must be registered in `wzxClaw_desktop/src/shared/ipc-channels.ts`.
- **Agent events** — Always use `AsyncGenerator<AgentEvent>` pattern, never callbacks or Promises.
- **Renderer state** — Use Zustand stores, not React Context.

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/) format:

```
type(scope): description

feat(tools): add semantic search tool
fix(agent): resolve context compaction race condition
perf(renderer): memoize chat message components
docs: update API documentation
test(agent): add turn manager unit tests
refactor(llm): extract retry logic into shared module
```

Common types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `chore`, `ci`

## Pull Request Process

1. **Create a branch** from `master` with a descriptive name:
   - `feat/your-feature`
   - `fix/your-bugfix`
   - `refactor/your-refactor`

2. **Make your changes** and ensure:
   - All tests pass (`npm test` for desktop, `flutter test` for Android)
   - No lint errors (`flutter analyze --no-fatal-infos` for Android)
   - Code follows existing patterns and conventions

3. **Write clear commit messages** following the Conventional Commits format.

4. **Open a Pull Request** against `master` with:
   - A clear title summarizing the change
   - A description of what changed and why
   - Any relevant issue numbers

5. **CI must pass** — The CI pipeline runs desktop tests, build checks, Flutter analyze, and Flutter tests.

## Reporting Issues

When filing a bug report, please include:

- **Desktop or Android** — Which app is affected
- **Steps to reproduce** — Clear steps to trigger the issue
- **Expected behavior** — What you expected to happen
- **Actual behavior** — What actually happened
- **Environment** — OS version, app version, model/provider used

## Questions?

Feel free to open an issue with the `question` label if you need help getting started.
