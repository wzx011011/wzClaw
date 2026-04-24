# wzxClaw Monorepo

This repository contains the wzxClaw desktop IDE, its Android companion app, and the standalone NAS relay service in a single monorepo.

## Projects

- `wzxClaw_desktop/` - Electron desktop app, the main product surface.
- `wzxClaw_android/` - Flutter Android companion app for remote control.
- `relay/` - Node.js WebSocket relay deployment used by the Android/Desktop bridge.

## Quick Start

### Desktop

```bash
cd wzxClaw_desktop
npm ci
npm test
npm run build:win
```

### Android

```bash
cd wzxClaw_android
flutter pub get
flutter analyze --no-fatal-infos
flutter test
build_apk.bat
```

### Relay

```bash
cd relay
npm test
docker-compose up -d --build
```

## Entry Points

### Desktop Development

- Code lives in `wzxClaw_desktop/`
- Main validation commands:
	- `cd wzxClaw_desktop && npm test`
	- `cd wzxClaw_desktop && npm run build:win`

### Android Development

- Code lives in `wzxClaw_android/`
- Main validation commands:
	- `cd wzxClaw_android && flutter analyze --no-fatal-infos`
	- `cd wzxClaw_android && flutter test`
	- `cd wzxClaw_android && build_apk.bat`

### Relay Deployment

- Service code and NAS deployment assets live in `relay/`
- Main validation and deployment commands:
	- `cd relay && npm test`
	- `cd relay && docker-compose up -d --build`
	- `cd relay && docker logs wzxclaw-relay`

### Runtime Topology

```text
Android app <-> relay service <-> desktop app
```

- `wzxClaw_android/` is the mobile client
- `relay/` is the NAS-hosted transport layer
- `wzxClaw_desktop/` is the main interactive product surface

## Repository Layout

```text
.
|- .github/workflows/   # Monorepo CI and release entrypoints
|- wzxClaw_desktop/     # Electron app
|- wzxClaw_android/     # Flutter app
|- relay/               # NAS relay service
\- CLAUDE.md           # Repo-specific agent/developer guidance
```

## Structure Decision

The relay service now lives at the repository root as `relay/`.

Reasoning:

- The desktop app, Android app, and NAS relay are separate runtime surfaces with different deployment targets.
- The relay is protocol-coupled to the apps, but not source-coupled, so a top-level service directory matches the actual architecture better.
- Keeping the relay at the root makes ownership and deployment boundaries clearer without changing runtime behavior.

## Notes

- Root-level `REVIEW.md` files are treated as local scratch artifacts and ignored by Git.
- Keep product code inside the subprojects rather than reintroducing source directories at the repository root.
