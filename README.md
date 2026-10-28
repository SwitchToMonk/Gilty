# Gitly

An Android client for GitHub. Repository browsing, commits, issues, pull requests, gists, notifications and contribution statistics, with an offline-first cache so the app stays usable when the network or the hourly API allowance does not.

**Version 3.73** · package `com.onegit` · Android 7.0+ (API 24) · target API 34

---

## Features

- **Repositories** — browse files and folders, switch branch, read a file with line numbers, edit and commit without leaving the app.
- **Commits** — history across every repository, with a per-file diff and change view.
- **Issues and pull requests** — list, filter, comment, label, assign, review and merge.
- **Gists** — create, edit and delete.
- **Notifications** — inbox plus a background check with configurable interval.
- **Statistics** — contribution calendar, per-repository traffic and a weekly summary with interactive charts.
- **Collaboration** — invite collaborators, accept or decline repository invitations.
- **Home screen widgets** — contribution graph, month view and activity.
- **Multiple accounts** — sign in with more than one GitHub account and switch between them; each keeps its own cache and API allowance.
- **78 languages** listed, with English, Korean and Hindi translated end to end.

## Signing in

Two methods, both ending in the same session:

| Method | How it works |
|---|---|
| Personal access token | Paste a token with `repo`, `read:user`, `notifications` and `gist` scopes. |
| Sign in with GitHub | OAuth device flow through the native bridge — no client secret is stored in the app. |

Both request the same scopes. If GitHub declines one, the app says which.

## Offline and API behaviour

GitHub allows 5,000 REST requests per hour **per account**, with a separate GraphQL budget. The app is built to work inside that:

- Replies are cached and revalidated with `If-None-Match`; a `304` costs nothing.
- Saved data is shown immediately and refreshed in the background.
- When a budget runs out the app moves to another stream — GraphQL, search, public REST, Atom feeds or the raw file host — rather than stopping.
- The API budget screen reports what is left, per account, read from response headers only (looking at it spends nothing).

## Requirements

- JDK 17
- Android SDK: `build-tools;34.0.0` and `platforms;android-34`

No Gradle is required.

## Building

```bash
./build.sh
```

Produces `Gitly.apk` in the project root. The script runs `aapt2` → `javac` → `d8` → `zipalign` → `apksigner` and expects the toolchain at the paths set in `build.sh`.

## Project layout

```
assets/www/          the entire UI — a single-page app in a WebView
  index.html         shell and mount points
  app.js             application logic, routing, API layer, i18n wiring
  app.css            styling
  i18n.js            language tables (164 keys × 78 languages listed)
src/com/onegit/      native side, 11 classes
  MainActivity.java  WebView host and the JavaScript bridge
  UploadService.java background uploads
  WidgetData.java    shared account and widget storage
  *.java             four home screen widgets and their config
AndroidManifest.xml  package, permissions, activities, widgets
build.sh             build without Gradle
```

The UI is plain JavaScript with no framework and no build step — edit a file in `assets/www/` and rebuild.

## Configuration

- **OAuth** — the client ID lives in `assets/www/oauth-config.js`. The device flow needs no secret.
- **Updates** — the app checks `BonkerUnkilBonki/Gitly-Update` for new releases.

## Notes

- A token or OAuth session is stored on the device and mirrored to native storage, so an app restart does not require signing in again.
- Downloaded files are saved to `Download/Gitly`.
- The contribution, traffic and weekly statistics need a signed-in session; public-only browsing works without one.

---

Release history: see [CHANGELOG.md](CHANGELOG.md).
