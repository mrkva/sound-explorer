# Sound Explorer

Spectrogram viewer for long-duration field recordings. Two apps: web (`apps/web/`) and desktop Electron (`apps/desktop/`).

## Development workflow

- Develop on a feature branch, commit as you go.
- Push to the branch when changes are ready for review or testing.
- Only merge to `main` when the user says to.

## Release process

When the user says **"release"** (with or without a version number), do all of the following:

1. **Determine the version.** If the user specifies one (e.g. "release 0.9.0"), use it. Otherwise, look at the current version and ask.

2. **Bump the version** in all four files:
   - `apps/desktop/package.json` — `"version"` field
   - `apps/desktop/src/version.js` — `VERSION` constant
   - `apps/web/js/version.js` — `VERSION` constant
   - `apps/web/sw.js` — `CACHE_VERSION` constant

3. **Commit** the version bump to the current branch (or `main`):
   ```
   Bump version to X.Y.Z
   ```

4. **Merge to `main`** if not already on main (push the branch, merge via PR or fast-forward).

5. **Tag and push:**
   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```
   This triggers the Release Desktop App workflow which builds mac/linux/win and creates a GitHub Release.

6. **Confirm** the release workflow started and tell the user the tag name.

## Project structure

- `apps/web/` — Static web app (HTML/JS/CSS), deployed to GitHub Pages via `pages.yml` on push to `main`
- `apps/desktop/` — Electron app, built and released via `release-desktop.yml` on version tags
- `docs/` — Architecture and rebuild spec documentation

## Build notes

- Desktop build: `cd apps/desktop && npm install && npx electron-builder --<platform> --publish never`
- Web app: static files, no build step
- Desktop `scripts/afterPack.js` ad-hoc signs macOS builds (no Developer ID certificate configured)
- electron-builder needs `repository` field in `package.json` to generate update info in CI
