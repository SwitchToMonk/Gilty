# Changelog

Release notes for Gitly, newest first. The main README describes the app itself;
this file keeps the detailed record of what changed in each version.

---

## What's new in v3.72 - read-only GraphQL stops undoing the free checks; fewer paid requests
- Read-only GraphQL calls (Commits tab, Productivity, a day's details) no longer drop any
  saved free-check tag. Before, they fell into "unknown write, clear everything", so each
  Commits-tab open cancelled the 3.70 saving across the app. Only a real mutation (the
  pull-request draft toggle) invalidates anything, and only this repository and the lists.
- Commits tab and Productivity show the saved data and ask GitHub at most once every 5
  minutes (a hand refresh waits at least 1 minute). A commit made from the app resets it.
  A day already looked at on Productivity is kept (today 5 minutes, earlier days 1 hour).
- Folder / multi-file upload to an existing branch is now ONE GraphQL request
  (createCommitOnBranch, its own budget) instead of one request per file plus about 5.
  Empty repositories, sets over 8 MB in total, and anything GitHub refuses keep the old
  blob route automatically.
- Security screen: the two on/off probes are remembered for 10 minutes and updated by the
  toggle itself, instead of 2 paid requests on every open.
- Search: the owner/name probe and the user's-repos list run on the first page only, and
  the user list only when the name search did not fill a screen.
- Settings sync: a write is skipped when nothing but the timestamp changed.
- Stats "still computing" (202) replies are remembered for 90 seconds, so reopening the
  screen does not pay again.
- Saved replies that carry no free-check tag (on/off probes, replies that came through a
  fallback route) are now kept for 15 minutes before any refresh, since each refresh of
  those is a paid request. The saved-reply store holds 700 entries (was 400) and, when
  full, drops the least recently saved first instead of an arbitrary one.
- Bigger on-device store: every saved reply is also written to IndexedDB (up to 4000
  entries, newest kept). When localStorage is full or a reply is evicted from it, the
  reply stays available from memory and IndexedDB, so it is shown and re-checked with its
  free tag instead of being fetched again from scratch.
- Account switch re-reads the profile with the saved tag (free when unchanged).
- Adding files from the Files screen is one GraphQL request for payloads up to about 10 MB
  (falls back to the blob route on any refusal).
- Settings > Notifications: "Check for alerts every" 15 / 30 / 60 minutes. Default stays
  15; a longer gap means fewer paid requests and later alerts.
- Widgets: the Productivity screen hands its calendar to the widgets, which store it on the
  device. They never send a request of their own when that is fresh, fetch at most once per
  time the app is on screen (and at most every 10 minutes), and when the app is closed only
  repaint the stored data.

## What's new in v3.71 - the request counter moves to Settings and costs nothing
- The floating "REST / GraphQL" counter on every screen is gone. The same numbers are
  now under Settings > API budget (it is also found by searching settings for
  "api", "credit" or "requests").
- The counter no longer sends any request of its own. It used to ask GitHub's
  /rate_limit endpoint every minute, at start, when returning to the app, every 15
  seconds while its sheet was open and during the start-up refresh. All of that is
  removed: the numbers are read only from the headers of replies the app already
  receives for other things, so looking at them cannot spend anything.
- Because of that the numbers are "as of the last reply" (the card says how long ago),
  and a meter nothing has used yet (for example GraphQL) shows "not read yet".
- The "requests are used up" bar still appears when the hour really is used up.

## What's new in v3.70 - writes no longer cost a refetch of everything
- A write (marking a notification read, starring, a settings toggle, an issue or
  commit) used to drop the saved free-check tag from EVERY saved reply, so the next
  visit to every screen was a full, charged request. Now only the replies the write
  can change lose their tag: the same repository, the lists that show many repos or
  people (your repos, starred, events, notifications, search, issues), and for
  notifications, stars, follows, profile and keys only their own endpoints. Everything
  else stays a free 304 check. A write to a path the app does not recognise still
  clears everything, so nothing can be left showing old data.
- The Deployments sheet looked up a status for every deployment (up to 15 requests
  after the list). It now looks up the newest 5; older rows list without a status chip.

## What's new in v3.69 - fewer requests per screen
- Commit counts (total and today) on the Commits screen now go through the saved-reply
  and free-check system: the number is saved with GitHub's tag, so asking again is a
  free 304, and every count shows in the usage meter. Before, they were sent outside
  the meter and always charged (2 per open).
- The background notification check (every 15 minutes) now sends conditional requests,
  so an unchanged answer is a free 304. The app-update check and the account check
  run every 6 hours instead of every 15 minutes, which cuts the paid requests per
  beat from 3 to at most 1. A different account is checked at once.
- A repository's contributors and latest release are loaded when that card nears the
  screen, and its language bar when you scroll down to it - not on every open.
- Repo settings: Collaborators, Branches, Tags, Webhooks, Deploy keys, GitHub Pages,
  Environments and Interaction limits load the first time you open each one (or press
  its Add / New button), instead of all at once.

## What's new in v3.68 - no Downloads screen, public data on the free hosts
- The Downloads screen is gone completely: its three routes, the profile
  "Download" button, the per-file sheet and its charts. (The separate repo
  Productivity/"repo stats" screen is untouched.)
- Public reads now go to GitHub's account-independent host first (REST without
  signing in, 60/hour per network; 10 are always kept back as the fallback):
  other people's profiles/repos/followers, public search, and any repository
  already known to be public. Private data and your own account stay on the
  signed-in API. If the free host is busy it falls back to the signed-in API.
- README/repo images load from raw.githubusercontent.com first (no API budget);
  only a private repository (404 there) falls back to the API.
- Download buttons for files and release assets of PUBLIC repositories use the
  github.com / raw.githubusercontent.com link directly (no API call); private or
  not-yet-known repositories keep the signed-in route.

## What's new in v3.67 - two widgets, refreshed only while the app is open
- Only two widgets remain: "Contributions graph 2x1" (graph only, no text) and
  "Contributions month 2x2". Profile, Quick, GitHub 2x1, Contributions 2x2,
  4x4, 4x2, 2x1 and Contribution activity widgets are removed completely
  (classes, layouts, manifest entries, descriptions).
- Widgets never fetch in the background any more: no system update timer
  (updatePeriodMillis=0), no refresh on the 15 minute notification beat, none
  on boot (boot only repaints saved numbers).
- They fetch only while Gitly is on screen: one GraphQL request per account
  (shared by both widgets), at most once every 10 minutes, then both repaint.
  Added or resized while the app is closed, a widget shows its last saved graph
  (or "open Gitly" on first use) and fills in the next time you open the app.
- Notifications polling (new activity, app updates) is unchanged.

## What's new in v3.66 - streams: when one runs out, the next takes over
Gitly now reads GitHub through a registry of independent free streams and
moves between them on its own:
1. REST, signed in (5,000/hour per account) - first, with free 304 checks
2. GraphQL, signed in (its own budget)
3. REST search, signed in (its own budget)
4. REST, NOT signed in (60/hour per network, public data only) - new
5. Public Atom feeds on github.com (no API budget) - now includes tags - new
6. raw.githubusercontent.com for file contents and READMEs (no API budget) - new
7. Saved data on the device
- A stream that is out of budget or failing is paused (20s, 1m, 5m, 15m
  back-off for network trouble; GitHub's reset time for limits) and wakes up
  by itself. A stream that cannot answer one particular question is skipped
  for that question only.
- GraphQL can now stand in for /user, so sign-in and the profile still work
  when the REST budget is gone. A rate-limited sign-in now says the token was
  accepted instead of "check the token and its scopes".
- With no budget left, Repos > Mine / Starred show the account's PUBLIC
  repositories through stream 4; private ones return when the budget does.
- The budget sheet lists every stream with its state and the last one used.
- Deliberately NOT included: pooling several accounts or tokens to dodge the
  limit (against GitHub's terms and it does not work for one account, whose
  tokens share one budget), and scraping github.com HTML.

## What's new in v3.16 - create the token inside Gitly
- The token screen now has three modes: In Gitly (the default),
  Fine-grained and Classic.
- In Gitly: pick the scopes and Gitly creates the token itself with its own
  GitHub app, using GitHub's device flow. You approve once with a short code
  - GitHub still requires that, and no app can skip it - and the token comes
  straight back to Gitly rather than you filling in a form on GitHub's site.
- The moment it arrives, Gitly shows the token in a copyable box and signs
  you in with it, so you can paste it into anything else that needs it.
- Gitly's current token is now shown on the same screen: masked until you
  tap Reveal, with a Copy button. Gitly stores the token locally, so it can
  hand it back whenever you need it.
- Fine-grained and Classic are unchanged: they still fill in GitHub's own
  form with your choices, for when you want a real PAT rather than a token
  tied to Gitly's app.

## What's new in v3.06 - pick which account a widget shows
- Adding a widget now opens a small picker when the app has more than
  one account signed in: choose the account that widget should show,
  or "Follow the app (active account)". With a single account there is
  nothing to ask and the widget is added straight away.
- A widget pinned to an account keeps showing it even after you switch
  accounts in the app; each widget remembers its own choice.
- Pushed numbers (login, unread count, today/streak/total) are now
  stored per account, so a widget can never show another account's
  totals. The app hands the native side the account list whenever it
  changes, and the widgets fetch with the right token.
- Backing out of the picker cancels adding the widget, as expected.

## What's new in v3.05 - release upload progress, and profile actions on one row
Release uploads now behave like the folder upload:
- Uploading an asset shows the same progress card with a live
  percentage, fed by the native side streaming the file in chunks
  (both the single-file path and the multi-file picker, which reports
  "File 2 of 5" as it goes).
- A batch of files shares one progress card instead of flickering
  per file.
- When a file lands you get a toast and a system notification
  ("Upload complete - app.apk was added to the release"), and the
  release page refreshes to show the new asset.
- A failure hides the card and reports the reason.

Profile screen:
- Follow / Edit profile, Open on GitHub and Productivity now sit on
  one row instead of stacking on three lines. They share the width
  evenly and trim their labels on narrow screens.

## What's new in v3.04 - GitHub sign-in on the website
The website now supports "Continue with GitHub", using the redirect flow
through a small helper (the device flow needs the app's native bridge,
and GitHub's token endpoint sends no CORS headers, so a page cannot
finish the flow itself - the client secret must never live in a page).

- New file assets/www/oauth-config.js: put your helper's URL in it and
  the button appears on the site and runs the full redirect flow.
- The flow: the site sends you to GitHub's authorize page with a random
  state, GitHub returns ?code=... to the site, the page posts the code
  to <helper>/token, and the helper swaps it for a token. The state is
  checked and cleared, and the ?code is removed from the address bar.
- If no helper is configured the button stays hidden and personal
  access token sign-in is used, exactly as before.
- The Android app is unchanged: it still uses the device flow.

To turn it on: deploy the Cloudflare Worker from the OAuth setup notes
(CLIENT_ID, CLIENT_SECRET, ALLOWED_ORIGIN), paste its URL into
oauth-config.js, re-upload that file, and make sure the OAuth app's
Redirect URI is the exact live site URL (the notes flag this).

## What's new in v3.03 - productivity for any user
- Every profile now has a Productivity button next to "Open on GitHub",
  opening that person's numbers: contribution graph, Activity overview
  radar, Right now stats, this-year breakdown, most active repositories
  and the Today tab with its day picker.
- GitHub exposes the same contributions collection on the User type, so
  the only difference is the query - viewer{} for you, user(login:) for
  someone else. Their figures are public contributions only, and the
  page says so.
- Numbers are cached per user, so revisiting a profile is instant, and
  the day picker and the Today tab's day detail follow whoever you are
  viewing.
- Fixed: another user's totals can no longer reach your home screen
  widget (a leftover call pushed whatever was loaded).

## What's new in v3.02 - desktop and laptop layout (and web publishing)
The web UI is now responsive, so the same files run as a phone app and
as a website:
- From 760px: content sits in a centred column, bottom sheets become
  centred dialogs, toast moves up, heatmap cells grow.
- From 1080px: the floating navigation pill becomes a permanent left
  rail, repository cards lay out two-up, and the content column widens.
- From 1400px: three-up repository grid and a wider column.
- Mouse and trackpad: hover feedback on cards, rows, buttons and tabs,
  pointer cursors, and thin styled scrollbars.
- Keyboard: Escape closes an open sheet, clicking outside it closes it
  too, and the navigation rail never auto-hides on a wide screen.
- On the published website the "Continue with GitHub" button is hidden
  (the device flow needs the app's native bridge - GitHub's OAuth
  endpoints send no CORS headers) and personal-access-token sign-in is
  used instead. Everything else works in a browser: the GitHub API
  sends access-control-allow-origin: *, so requests work from a page.

Publishing: upload the contents of assets/www (index.html, app.css,
app.js, fonts/, logo.jpg) to any static host - GitHub Pages works.
A ready-to-host copy is included as Gitly-Web.zip.

## What's new in v3.01 - no big container card on the repositories list
- The repositories screen a profile's "repos" count opens no longer
  puts the whole list inside one large grey card. Each repository
  keeps its own card and the list sits straight on the page, the same
  way the Popular repositories section already looks.

## What's new in v3.00 - a profile's "repos" count opens THAT user's repos
Fixed: tapping the "repos" number on someone's profile jumped to the
Repositories tab, which showed your own list - or the Discover page if
that was the last mode you used - instead of their repositories.

- Tapping the repos count now opens a proper screen for that user:
  every public repository they have, with a count line and a sort
  control (Most stars / Recently updated / Name A-Z). Tapping a
  repository opens it, as before.
- The same fix applies to the profile card on the Home screen.

## What's new in v2.99 - download files from a repository
- Every file row in the Files tab now has a download button on the
  right, so you can save a file without opening it first.
- The file viewer has a Download button as well, and it is offered for
  every file - including ones the viewer cannot show, such as a .ttf,
  a .keystore, or anything over 1MB where GitHub sends no preview.
- Downloads go through the GitHub API with your token and are saved to
  your Downloads folder, so private repositories work too.
- Edit and Delete stay exactly where they were (only on repositories
  you can push to).

## What's new in v2.98 - widgets follow the Pitch black theme
- Picking Pitch black in the app's Appearance settings now paints the
  home screen widgets pure black too, instead of the dark grey they
  used before. The rounded shape is kept.
- Inner cards (the graph panel on the contribution widgets) use a hair
  above pure black so the surface still reads on AMOLED screens.
- The Dark and Light themes leave the widgets exactly as they were.
- Changing the theme repaints the widgets immediately from the cached
  numbers, with no network call.

## What's new in v2.97 - grid cells are squares, like GitHub's
- The contribution squares were drawn with a fixed 4.5px corner
  radius, which turned small cells (the 2x1 and graph-only widgets)
  into circles. The radius now scales with the cell size at ~22% of
  it, so every widget shows GitHub's slightly rounded squares.
- Applied to all of them: Contributions 2x2, 4x4, 4x2, 2x1, the
  graph-only 2x1, and the heatmap inside the GitHub widget.
- The in-app heatmap's cell radius went from 3px to 2px on 11px
  cells, matching GitHub's proportions there too.

## What's new in v2.96 - a graph-only 2x1 contribution widget
- New widget: "Contributions graph 2x1" - just your contribution
  heatmap filling the whole widget, with no title, total or streak
  text at all. Same accent palette, same refresh schedule and same
  cached data as the other contribution widgets.
- The shared drawing code gained a graph-only mode so the widget
  never writes to text views it does not have.

Widget line-up now: Profile, Quick, Contributions 2x2, Contributions
4x4, Contributions 4x2, Contributions 2x1, Contributions graph 2x1,
GitHub 2x1.

## What's new in v2.95 - Contributions 2x1 widget, and the today ring is gone
- New widget: "Contributions 2x1" - the 2x2 contribution graph
  squeezed into a single row. A compact heatmap sits on the left with
  the year total and your current streak beside it. The squares are
  drawn at a fraction of the size so a whole year still fits, and it
  uses the same accent palette as everything else.
- Removed the ring (the glow) that marked today's cell in the widget
  grids - the heatmap now reads as a plain graph, like the app's own.
- The total on the contribution widgets is drawn in the accent colour
  instead of a fixed blue.

## What's new in v2.94 - GitHub widget clones the reference, in your accent colour
- The GitHub widget now matches the reference layout: the Octocat mark
  and your handle on the first line, today's contributions, streak and
  year total on the second, and your contribution heatmap underneath.
  The heatmap appears when the widget is tall enough and hides again
  when it is compact, so it still works as a 2x1.
- Every widget now uses the accent colour chosen in the app's settings
  instead of a fixed palette: the Octocat mark, the notification badge
  and the heatmap shades are all derived from it. Named accents,
  Dynamic (system colour) and a custom hex all work.
- Changing the accent repaints the widgets immediately from the cached
  numbers, with no network call.
- The contribution and profile widgets use the same accent palette, so
  everything on the home screen matches the app.

## What's new in v2.93 - widget data pushed from the app, radar rings removed
Fixed the GitHub 2x1 widget showing "sign in" while signed in, and
widget data vanishing when the app was closed:
- The app now hands its numbers straight to the widgets (login, unread
  count, today's contributions, streak, year total) through a bridge
  the moment it has them - after sign-in, when the home screen loads,
  when notifications load and when the Productivity page loads. They
  are stored on the device, so the widget shows them immediately and
  keeps them after the app is closed.
- Widgets also refresh when the app opens, on the 15 minute poll, after
  a reboot, and when the launcher asks for them.
- The widget's paint step can no longer throw, so it can never be left
  showing the blank initial layout, and an empty widget now says
  "Open Gitly to sign in" instead of the old misleading text.

Activity overview:
- Removed the circles (the concentric guide rings). The crosshair and
  the four data points stay, matching github.com.

## What's new in v2.92 - Activity overview chart on the Productivity tab
- The Productivity tab now opens with GitHub's "Activity overview"
  chart: a four-axis plot of what your contributions were made of -
  commits to the left, issues to the right, code review above and
  pull requests below - each point placed at that category's share of
  the total, with the percentage written on every axis and a legend
  showing the percentage and the raw count for each
- It uses the same GraphQL numbers already fetched for the
  "This year on GitHub" card, so there is no extra API call and the
  figures always agree with the rest of the page
- Shows a clear empty state when there has been no activity in the
  last year

Verified with the reported figures (Commits 99%, Issues 1%, Code
review 0%, Pull requests 0%): the percentages sum to 100, the commit
point plots far left, the issue point just right of centre, and the
two zero categories sit on the centre point.

## What's new in v2.91 - GitHub 2x1 widget, and widgets that stop going blank
New widget:
- GitHub 2x1 - a compact home screen widget in the GitHub app's style:
  the Octocat mark (drawn from the app's own SVG), your handle, how
  many notifications are waiting, and today's contributions with your
  streak. Tap it to open the app. Resizable horizontally.

Fixed - "widget data only loads when the app is open, then vanishes":
- Every widget now keeps its last good values in a cache and paints
  them immediately on every update, so a widget is never left empty.
  Before, an update rebuilt the widget with empty text and then
  fetched; if that fetch failed (no network, phone freshly booted,
  token not saved yet) the widget stayed blank and any earlier data
  was wiped.
- Widgets are refreshed by the background poller (every 15 minutes),
  after a reboot, when the app opens, and whenever the web UI pushes
  fresh data - so the values stay current without opening the app.
- A 4 minute throttle keeps those refreshes from double-fetching.
- The contribution and profile widgets benefit from the same cache.

Verified by compiling the Java explicitly (which caught a real
resource error the normal build hides) and checking the built APK.

## What's new in v2.90 - deep and fuzzy repository search
Fixed the reported bug: a public repo that is live could not be found
by name. Two real causes:

1. Searches were sent with "&sort=updated", which buries a small repo
   behind thousands of recently pushed ones - even for an exact name.
   Proof with the live API: for "dumprx", sorted by updated, the
   canonical 251-star DumprX/DumprX is not on page 1 at all, only
   0-star forks. Best match puts it first. Search now defaults to
   best match.
2. There was no exact-name pass and no fallback for repos too new to
   be in GitHub's search index.

Search now, for every query:
- resolves "owner/name" directly through the repositories API, so a
  repo is found even if the search index has not caught up yet
- runs an "in:name" pass (exact name) and a broad pass, and merges
  them without duplicates
- adds the owner's repositories when the term looks like a username
- retries with the longest word alone when a multi-word query finds
  nothing, which rescues slightly wrong phrasing
- re-ranks everything locally by real closeness - exact name, then
  prefix, then owner, then substring, then description and topics,
  with stars as a tiebreaker - so the repo you typed always rises to
  the top even when thousands of others match
- searching in the Starred tab now looks inside the repositories you
  starred (it previously searched repositories you own, which is why
  starred searches looked wrong)

Verified with 13 unit tests plus live API checks.

## v2.84 (reverted build) - back to the README image fix only
This build reverts the animation experiments from v2.85 to v2.89 and
returns the code to the v2.84 state:
- README images: all GitHub URL forms resolve correctly
  (raw.githubusercontent, github.com/.../blob/..., /raw/..., with or
  without ?raw=true), MIME is taken from the extension when GitHub
  reports something generic, images are fetched once and small ones
  are cached on the device
- <picture> art (the contribution snake) has every <source srcset>
  inlined too, so the dark and light variants both render
- An <img srcset> is inlined or dropped so it cannot override src
- An image that cannot be loaded at all becomes a tappable link

Removed again (they were added after 2.84): blob-URL loading, the
frame-keepalive loop, the repaint nudge, the 30-second SVG speed-up
and its setting, the native-first loading order and the 5-minute
refresh timer.

Note: the versionCode is 104 (not 98) because Android refuses to
install a lower versionCode over an installed app - the code is 2.84,
the package number simply keeps climbing so it installs as an update.

## What's new in v2.89 - README animation now loads the native way
The reference (github.com and GitHub's own app) animates these images
natively: the SVG is loaded as a normal image and the compositor runs
its animation. Gitly was inlining every image as bytes, which is why
it never matched that smoothness.

- Animated README art (the contribution snake, gifs) now loads
  straight from its URL first, so the WebView renders and animates it
  exactly like github.com does
- If that URL cannot be reached (raw.githubusercontent is blocked on
  some networks), the app falls back to the inlined copy, and drops
  the <picture> sources so the copy it controls is the one used
- A four-second safety net takes over if a <picture> source fails
  without reporting an error
- Frame keeping, the invisible repaint nudge and the 5-minute refresh
  all still apply, so the animation cannot stall

## What's new in v2.88 - stutters, pauses and freezes all addressed
1. Stutters / jerks
- README media now gets a compositing hint (will-change, backface)
  in addition to its own layer
- The WebView itself is put on a hardware layer, so animated art is
  driven by the compositor instead of waiting for a repaint

2. Pauses, then jumps
- The frame loop is more aggressive: on top of requesting frames
  every ~16ms, animated images are nudged into repainting about
  four times a second, which is what actually makes the renderer
  advance an animated SVG (the nudge is invisible)

3. Freezes at a random frame
- This one was the artwork itself, not the app: the contribution
  snake's SVG runs its entire cycle over 80.1 seconds and each cell
  lights for only ~0.02% of that, so it is genuinely static between
  steps - the same on github.com. Gitly now rescales that timeline
  to 30 seconds when it inlines the SVG, so the snake visibly moves.
  Only durations longer than 30s are touched and the whole thing can
  be turned off in Settings, Accessibility, "Faster README animations".

Verified against the real snake SVG: 80100ms becomes 30000ms, all
keyframes stay intact, and the file remains a valid SVG.

## What's new in v2.87 - animated README art refreshes itself every 5 minutes
- While a README with animated images (the contribution snake, gifs)
  is open, the app now pulls fresh data every 5 minutes so the art
  stays current with what GitHub has generated
- The refresh restarts that image's animation, which is exactly why
  it runs every 5 minutes and not more often - a per-second or
  per-millisecond poll would exceed GitHub's 5000 requests/hour limit
  and make the animation jump back to the start constantly
- The refresh timer stops by itself as soon as no animated image is
  on the page, so ordinary screens cost nothing
- Frames are still requested continuously (~60 per second) while an
  animated image is present - that is what makes the movement smooth

## What's new in v2.86 - snake stays smooth (data keeps flowing)
- Animated art (the contribution snake, gifs) is now always fetched
  fresh instead of being served from the cache, so its data keeps
  flowing and the animation starts clean every time a README opens
- The old blob is released when a new one replaces it, so repeated
  fetches cannot leak memory
- Frames are now requested for as long as an animated image is on
  the page - not only while it happens to be on screen - so the
  snake keeps moving smoothly and never stalls waiting for a tap
- The loop pauses only when the app is in the background, then
  resumes automatically
- Static images are still cached, so ordinary READMEs are unchanged

## What's new in v2.85 - snake animation now runs at full speed
The snake rendered but crawled, and only ran normally after a tap.
Cause: a WebView only produces frames while something asks for them,
so the animated SVG's internal animation was not being ticked.

Fixed three ways:
- Animated images (SVG, GIF, WebP) are now handed to the page as blob:
  URLs instead of data: URIs, which animate far more reliably
- README media gets its own compositing layer (translateZ), so the
  animation is driven by the compositor rather than the next repaint
- While an animated image is actually on screen the app keeps
  requesting frames, which makes the animation run at its true speed
  from the moment the README opens. The loop stops as soon as no
  animated image is visible, so there is no battery cost elsewhere.

## What's new in v2.84 - the real fix for the broken snake / README images
Root cause found: GitHub wraps modern README art - the contribution
snake above all - inside a <picture> element with <source srcset>
dark/light variants, and the browser picks the image from the SOURCE,
not from <img src>. Gitly was only inlining <img src>, so the WebView
kept fetching the original raw.githubusercontent URL, which is blocked
on many networks. That is why the snake stayed broken even though
other images worked.

Fixed:
- Every <source srcset> inside <picture> is now inlined through the
  API too, so both the dark and light snake render and animate
- An <img srcset> is inlined as well, or dropped when it cannot be,
  so it can never override the src we control
- Images now try a chain: API-inlined data URI, then the direct URL,
  then the native fetch bridge - so a single failure no longer leaves
  a permanently broken image
- If an image genuinely cannot be loaded by any route, it becomes a
  tappable "tap to open" link instead of a broken icon

Verified against the real markup GitHub serves for a snake README:
both source variants and the img resolve correctly and are inlined.

## What's new in v2.83 - README images fixed (contribution snake, gifs, badges)
Fixed:
- Images linked the common GitHub way - github.com/user/repo/blob/
  branch/file?raw=true, and the same with /raw/ - were not recognised
  as repository files, so the app tried to load a GitHub web page as
  an image. That is why the contribution snake animation, the racing
  gif and the stats/top-languages badges showed as broken icons. All
  of those URL forms now load through the API correctly.
- Query strings (?raw=true, ?sanitize=true) were passed to the
  contents API, which rejects them - they are now stripped.
- The image MIME type is now derived from the file extension when
  GitHub reports a generic type, so SVG and GIF art renders (and
  animates) instead of failing.
- READMEs no longer re-fetch the same image over and over: each
  image is fetched once, in-flight requests are shared, and small
  images are remembered on the device, so the snake animation is
  not restarted on every visit.

## What's new in v2.82 - GitHub account section keeps only Sign-in method
- Settings, GitHub account now shows a single row: Sign-in method
  (your token type and scopes). Edit profile, Email addresses,
  Authorized applications, SSH keys, GPG keys, Organizations and
  the github.com links were removed from this section, along with
  their sheets and code.
- Profile editing is still available from your own profile screen
  (the Edit button on the profile card).

## What's new in v2.81 - removed three account rows from Settings
Removed from the Settings page, as requested:
- Authorized applications
- Email addresses
- Watched repositories

Those sheets/screens and their code are gone entirely. The
Sign-in method row, SSH keys, GPG keys and Organizations remain.

## What's new in v2.80 - sign-in method detection and honest in-app limits
New:
- Settings, GitHub account: a "Sign-in method" row now shows exactly
  how you are signed in - classic token (ghp_), fine-grained token
  (github_pat_), or GitHub device sign-in - together with the token's
  scopes read live from GitHub
- Watched repositories screen (Settings, Notifications): every repo
  that can send you notifications, with one-tap unwatch - works with
  every sign-in method
- Authorized applications now shows each app's scopes when it loads

Fixes for "still not working":
- The app now detects your token type and explains precisely why a
  screen may be unavailable for it: OAuth device tokens cannot list
  app authorizations, fine-grained tokens cannot either - a classic
  ghp_ token unlocks that one screen, and the sheet now says so
  instead of a generic error
- Email addresses explains what your specific token needs (classic
  needs the user scope, fine-grained needs the Email addresses
  permission)

Note: with a classic personal access token (ghp_) that has broad
scopes, everything the GitHub API offers works inside the app -
including authorized applications and email management. Passwords,
passkeys, sessions, security log and token listings have no public
API for any client and remain linked to github.com only.

## What's new in v2.79 - fixes for sign-in method limitations and profile fields
Fixes:
- Authorized applications no longer shows a raw "Not Found" error
  when signed in with GitHub device sign-in (that method cannot
  list OAuth grants) - it now explains why and links straight to
  github.com/settings/applications
- Email addresses sheet: the scope message is no longer cut off
  (long messages now wrap), and there is a direct link to
  github.com/settings/emails
- Edit profile gains the Twitter/X username field and the
  "Available for hire" toggle from GitHub's profile settings

New account settings rows (from the GitHub screenshots):
- Password and authentication, Sessions, Notification preferences,
  Developer settings and the full Public profile editor
  (pronouns, social accounts, ORCID, achievements) open their
  github.com pages - those screens have no public API

## What's new in v2.78 - pull requests, Actions, security, insights and much more
New repository tabs:
- Pull requests: open/closed list, create PRs, close/reopen, comment,
  and merge with Merge / Squash / Rebase; PR pages show branches,
  +additions / -deletions, changed files, draft and merged badges
- Actions: workflow runs with status, branch, event and duration;
  run detail lists jobs and every step, with re-run and cancel
- Security and quality: Dependabot alerts with open alert list,
  Dependabot version updates, secret scanning, and security policy
- Insights: top contributors, commits-per-week chart for the last
  year, and the repository activity feed
- Deployments sheet from the repo screen (environment, state, time)

Repository settings additions:
- GitHub Pages: publish/unpublish, source branch and folder,
  custom domain, enforce HTTPS, visit site
- Environments: list, create and delete
- Interaction limits: restrict who can interact, with expiry
- Branch protection: required reviews and approvals, required
  status checks, admin enforcement, force push and deletion rules
- Danger zone: change visibility and transfer repository

Account settings additions:
- SSH keys and GPG keys: list, add and delete
- Organizations: list memberships, link to create a new org

Accessibility settings:
- Reduce motion (turns off animations app-wide)
- Show link underlines

Note: some GitHub pages (password/passkeys, sessions, fine-grained
token lists, security log) have no public API and remain on the
github.com website.

## What's new in v2.77 - updater pointed at the renamed repo
- IMPORTANT: the GitHub "Continue with GitHub" sign-in arrived in
  v2.75, but it only reached users who installed the APK directly.
  The public update repo's latest release was still v2.69, so
  everyone who updated in-app stayed on v2.69 and saw no sign-in
  button. Publish this APK as release v2.77 on the
  BonkerUnkilBonki/Gitly-Update repo so all users finally receive
  it through the in-app updater.
- The updater now targets BonkerUnkilBonki/Gitly-Update directly
  (the repo was renamed from OneGit) instead of relying on
  GitHub's redirect.

## What's new in v2.76 - version visible on the login screen
- The login screen now shows the app version (e.g. "Gitly v2.76")
  under the tagline, so it is easy to tell whether an installation
  is up to date. The GitHub OAuth "Continue with GitHub" button
  arrived in v2.75 - anyone who does not see it is on an older
  build and needs to update (in-app Settings, App updates, or
  download the latest Gitly.apk from the releases).

## What's new in v2.75 - GitHub OAuth sign-in
- Sign in with your GitHub account, no token pasting: "Continue
  with GitHub" on the login screen starts GitHub's official OAuth
  device flow. The app shows a one-time code (auto-copied), you
  approve it at github.com/login/device, and Gitly logs you in -
  automatically once approved, or via the "Continue" button.
  The pending sign-in survives closing the app and can be
  finished from the login screen within the 15-minute code
  lifetime. Scopes requested: repo, read:user, notifications,
  gist - identical to the token login. Personal access token
  login remains available as a fallback. The client secret is
  NOT stored in the app (the device flow does not need it).

## What's new in v2.74 - full repo & GitHub settings
- New Repository settings screen (Settings button next to Edit
  repository on your own repos), mirroring GitHub's repo settings:
  General (rename, description, homepage, default branch),
  Features (Issues, Wiki, Projects, Discussions, Template,
  Private), Pull requests (merge methods, auto-merge, auto-delete
  branches, allow forking), Collaborators (add/remove with
  permission level), Branches (make default, delete), Tags
  (delete), Webhooks (add with push/everything events, delete),
  Deploy keys (add with read-only option, delete), and a Danger
  zone (archive toggle, delete repository).
- New GitHub account section in app Settings: Edit profile
  (name, bio, company, location, website), Email addresses
  (list, add, remove - needs user:email scope on your token),
  and Authorized applications (list, revoke access).

## What's new in v2.73 - write actions only on your own repos
- Repos you do not have write access to no longer show owner
  controls: the Files screen hides Add file / Upload files /
  Upload folder, Releases hides New release, per-release
  Upload files / Edit release, and asset delete buttons, and
  the file view hides Edit / Delete. Access is checked per
  repo via GitHub's permissions (owner or collaborator), so
  your own repos and repos you collaborate on keep every
  control, and everything else is read-only - Star, Watch,
  Fork, New issue and downloads still work everywhere.

## What's new in v2.72 - GitHub-style sort dropdown
- The sort control is now a "Sort: ..." dropdown exactly like
  GitHub's, opening a bottom sheet with a checkmark on the
  active option. Repository sorting now offers GitHub's full
  option set: Best match, Most stars, Fewest stars, Most forks,
  Fewest forks, Recently updated, Least recently updated, plus
  Name A-Z. Searches and Discover are sorted server-side by the
  selected option, so results reorder across all pages.
  Commits and Issues screens use the same dropdown.

## What's new in v2.71 - sort button highlight fix
- Tapping a sort option now immediately moves the highlighted
  pill to the tapped button on every screen (previously the
  selection highlight stayed put on the Repos list and the
  global Issues screen even though the sorting itself worked).

## What's new in v2.70 - sort options
- Sort controls on every major list so you can find things fast:
  Repositories (Recent, Name, Stars, Forks, Newest repo),
  repo Commits (Newest, Oldest, Author), the global Commits
  tab (Newest, Oldest, Repo), and Issues (Updated, Newest,
  Oldest, Most comments) on both the repo screen and the
  global Issues screen. Your choice is remembered per screen,
  sorting applies instantly without refetching on the repos
  list, and search results sort too.

## What's new in v2.69 - repo tabs fix
- Fixed the Readme / Files / Commits / Issues tabs on the repo
  screen doing nothing when tapped: v2.68's in-page-anchor
  handling was swallowing their navigation. In-page README
  anchors still smooth-scroll; app routes (#/...) now pass
  through to the router as they should.

## What's new in v2.68 - complete README compatibility
- Fixed the last broken README images: badge and stats URLs that
  contain emoji or non-ASCII text were mangled while unmasking
  GitHub's camo proxy - they are now correctly percent-encoded,
  so every badge/card renders.
- README links now actually work: GitHub marks every link
  target="_blank" and the WebView silently dropped those taps -
  that is why clicking badges/panels did nothing. Links now open
  properly: github.com repo/profile links navigate inside the
  app, in-page anchors smooth-scroll to their heading (they used
  to break navigation by hijacking the route), and everything
  else opens in the browser.
- Any image or video the WebView still cannot load is retried
  through a native fetch and swapped in as a data URI.
- Collapsible README panels (<details>) now animate smoothly
  open/closed instead of popping, and are styled like cards.

## What's new in v2.67 - full README media support
- README images fixed for good, both causes found and fixed:
  GitHub proxies every external README image through
  camo.githubusercontent.com (blocked on some Indian networks) -
  those are now unmasked and loaded from the real host directly
  (stats cards, badges, animated emojis all render again). And
  in-repo images bigger than 1 MB (the profile "Welcome banner"
  style banners) were refused by the contents endpoint - they
  now fall back to the git blobs API, which serves files up to
  GitHub's 100 MB limit.
- Attachment links inside READMEs (pdf, txt, log, csv, tsv, json,
  yaml, rtf, docx, xlsx, pptx, zip, gz, and code files like
  .c .java .py .js .xml .ipynb ...) are now tap-to-download:
  they download through api.github.com and save into your
  Downloads folder, working even where raw.githubusercontent.com
  is blocked.
- Embedded videos (mp4, mov, webm) in READMEs now get proper
  full-width rounded layout, and README images can no longer
  overflow the screen edge (contribution graphs and wide stats
  images fit the display now).

## What's new in v2.66 - sheet scroll lock
- Fixed the page behind a bottom sheet scrolling while you
  scroll inside it (seen on the ChangeLog sheet over Settings).
  The page behind is now fully frozen while any sheet is open,
  and the sheet itself no longer lets scroll gestures pass
  through at its top and bottom edges.

## What's new in v2.65 - repo rename, glowing glass back buttons
- Edit repository sheet now has a Repository name field, so you
  can rename the repo right from the app. After a rename the
  app jumps to the new repo URL and any pinned shortcut is
  updated to the new name. Invalid names (spaces, empty, over
  100 characters) are rejected with a message before anything
  is sent to GitHub.
- When Navigation glow is on, the back buttons now carry the
  same accent-colored glow as the navigation bar.
- Back buttons keep the frosted glass (blurred, translucent)
  look of the navigation bar in every theme.

## What's new in v2.64 - ChangeLog button
- The App updates section in Settings now has a ChangeLog button
  (always visible, update or not): it opens the text you typed
  into "Describe this release" for the newest published
  release - rendered as rich markdown when GitHub returns HTML,
  plain text otherwise. Repo-stored images in the changelog use
  the same api.github.com inlining as READMEs, so they load on
  every network.

## What's new in v2.63 - tag-version update check
- Update detection now also compares versions again: if the
  release's TAG carries a newer version than the installed app
  (v2.64 > 2.63, or a number found in the release name when the
  tag has none), it always counts as an update. Combined with
  the any-new-release rule from 2.62, that means: newer tag
  version OR any release published after your install triggers
  the update popup, the Settings row with the APK download, and
  auto-download when enabled. The installed version is read
  from the Android package, so it is always accurate.

## What's new in v2.62 - releases show as updates, no version math
- The update check no longer compares version numbers at all.
  Gitly now remembers when it was installed/updated on this
  device (from the Android package itself): ANY release you
  publish on the OneGit releases page after that moment shows
  as an update - popup card, Settings row and auto-download -
  whatever the tag or title says. Installing the new APK resets
  the clock, so you are never nagged about a release you
  already have. Drafts are ignored; the newest PUBLISHED
  release is picked from the releases list directly, so it
  works even without GitHub's "Latest" marker.

## What's new in v2.61 - working update checker
- The update check was broken twice over. The web UI compared
  against a hardcoded version string that no longer matched the
  built app, and it only read the version from the release TAG -
  a tag like "vStable" with the number only in the release NAME
  (as in "vStable 2.60") was never detected, so Gitly kept
  saying "You are on the latest version". The installed version
  now comes straight from the Android package (it can never go
  stale again), and the checker reads the number from the tag OR
  the release name - so v2.60, vStable 2.60 and V2.60 all work.

## What's new in v2.60 - README images on every network
- Repo-stored README images (welcome banners, stats SVGs) still
  failed on some devices and networks, because they load from
  raw.githubusercontent.com - which several ISPs block even while
  the rest of GitHub works. Gitly now re-fetches those images
  through api.github.com (the same authenticated channel every
  other feature uses) and renders them from memory, so they work
  on any network - private repositories included. If that fetch
  ever fails, the direct URL remains as fallback. Applies to repo
  READMEs, profile READMEs, issues and comments.

## What's new in v2.59 - adaptive header titles
- The big header title now scales itself down (34px to a 22px
  floor) so long names like the Home greeting with your handle
  fit on one line instead of breaking mid-word with a dangling
  letter. Titles that still cannot fit wrap cleanly at word
  boundaries, and the size re-fits on rotation.

## What's new in v2.58 - header spacing
- Page titles no longer sit flush against the back button (2px
  gap -> 10px), subtitles get breathing room below the header
  row, and the Profile README screen shows the @handle as a
  proper big title instead of a cramped subtitle under the
  back pill.

## What's new in v2.57 - pill back buttons
- The back buttons on every detail screen (big header and the
  collapsed top bar) now sit in a frosted circular pill, matching
  the bottom navigation bar - with proper light, dark and pitch
  black variants.

## What's new in v2.56 - cleaner Profile README header
- The big "Profile README" title text no longer sits at the top of
  the profile README screen - the header now shows just the
  @handle. The small top bar still says Profile README while
  scrolling, so you always know where you are.

## What's new in v2.55 - fixed unreadable active-button text
- With a light accent color (custom or dynamic Material You), the
  Starred / Watching buttons on a repository and the active Follow
  button showed white text on a light accent background - almost
  invisible. They now use the accent-aware text color the rest of
  the app already uses, switching to dark text on light accents.

## What's new in v2.54 - fixed README images
- Images stored inside a repository (welcome banners, stats SVGs,
  screenshots - anything referenced with a relative path like
  ./assets/banner.png) were broken in repo READMEs, profile
  READMEs, issues and comments: they were resolved against
  github.com itself instead of the repository, so every one of
  them 404'd. Gitly now resolves them against the repository's
  raw files, so they render everywhere. Links inside READMEs
  now open the right file pages too, and in-page anchors no
  longer get mangled.

## What's new in v2.53 - fixed uploads into empty repositories
- Uploading a folder to a repository with no commits failed with
  "HTTP 409 - Git Repository is empty" for every file: GitHub's
  Git Data API refuses to touch a repository that has no commits
  yet. Gitly now bootstraps the repository first through the
  Contents API (a tiny invisible marker commit), then chains the
  real upload onto it and removes the marker again in the same
  push - so an empty repo ends up with exactly the files you
  uploaded, in one clean commit on top of the bootstrap.

## What's new in v2.52 - big, complete folder uploads
- Folder and multi-file uploads now run natively and stream every
  file straight to GitHub: per-file limit lifted from 10 MB to
  GitHub's own 100 MB max, and folders up to 2000 files (was 200).
  A multi-GB folder of normal files now uploads fine.
- Fixed files silently missing from folder uploads: one unreadable
  file or subfolder used to abort the whole walk (res/ and src/
  were dropped that way). Every file and subfolder is now isolated
  - a failure is reported by name instead of eating the rest.
- Upload files (multi-select) now lands everything in ONE commit,
  same as folder uploads, and handles large files the same way.
- Release assets now upload natively too - streamed, so assets up
  to GitHub's 2 GB per-file limit work instead of dying on big
  files.
- Upload progress shows real per-file counts, and the final toast
  says exactly how many made it and which files failed.

## What's new in v2.51 - fixed Upload folder
- The Upload folder button did nothing when tapped. A leftover counter
  reset (removed variables) crashed the tap handler in strict-mode JS
  before the folder picker could even open. Fixed: the handler now
  runs cleanly and the system folder picker opens again.

# Gitly — a One UI-inspired GitHub client for Android

## What's new in v2.50 - empty repos, activity detail, readable text
- New/empty repositories now show the Add file / Upload files /
  Upload folder buttons right on the Files tab, and the first
  upload works even with no commits yet
- Repo overview: "No README found" now has a Create README button
- Activity now shows full detail: every commit message in a
  push (up to 4, then +N more), plus new event types - followed
  users, open-sourced repos, wiki updates, collaborator added,
  commit comments
- Secondary text (repo names, times, activity lines) is much
  brighter on dark and AMOLED themes, and darker on light theme

## What's new in v2.49 - follow self-heals
- If a follow/unfollow fails with "Not Found", the app now
  re-checks who you are signed in as, fixes the button state
  and explains: following yourself is not possible
- Note: the follow guards from v2.47+ are all present; if you
  still see a Follow button on your own profile, update the app
  (check Settings > About shows the latest version)

## What's new in v2.48 - rebranded to Gitly
- The app is now called Gitly everywhere you can see it:
  launcher name, login screen, About card, update popups,
  widgets, notifications and downloads
- Installs right over the previous build - same app, new name;
  your account, pins, themes and settings are untouched

## What's new in v2.47 - FIXED Follow button
- Fix: tapping Follow navigated away instead of following -
  clicks inside the profile card no longer leak to the card's
  own tap action (same for Edit profile)
- Fix: the Follow button could appear on your OWN profile when
  the signed-in user wasn't known yet - GitHub then answered
  "Not Found" (self-follow). It is now never shown for yourself
- Extra guard: a follow request for yourself is blocked with a
  clear message instead of an error
- If the account behind the token changes, the screen re-renders
  so the right buttons show

## What's new in v2.46 - cleaner profile README + tappable stats
- Tapping the profile card now opens a dedicated Profile README
  screen: the user's header card plus their rendered README -
  no repo page clutter (stats, clone, edit buttons are gone)
- No special repo? The card still opens the normal profile
- The repos / followers / following pills on Home are now
  tappable: followers and following open the full list of
  users with avatars, and tapping any of them opens that
  person's profile

## What's new in v2.45 - Discover search + diff wrap + home fixes
- Discover tab now has a search bar - type to search all of
  GitHub (sorts by stars); empty search shows trending repos
- Diffs wrap instead of scrolling sideways - long lines fold
  down, so code is never cut off or invisible
- Stronger colors on diff lines (context text explicit,
  add/del backgrounds brighter)
- Home quicklinks row (Productivity / Discover / My profile)
  no longer overflows the screen edge - buttons share the
  row evenly
- Added bottom padding so the last card is never hidden
  under the navigation bar

## What's new in v2.44 - Profile README support
- Tapping the profile card (avatar / name / bio block) on Home
  or on any profile opens that user's special repository - the
  one named exactly like their username - if it exists
- No special repo? The card opens the normal profile instead
- Profile screens now render the user's Profile README below
  their info, exactly like GitHub does, with images and markdown
- The existence check is cached, so the card responds instantly

## What's new in v2.43 - open GitHub links in Gitly
- Gitly can now act as a handler for github.com links
  (github.com, www/m.github.com, gist.github.com), like the
  YouTube screenshots: enable via Android Settings > Apps >
  Gitly > Set as default > Supported web addresses, or pick
  "Always" in the link chooser
- Deep links map straight to app screens: repo, user, commits,
  commit detail (with view/revert), issues & PRs, releases,
  file tree/folder, gists
- Links the app has no screen for are left to the browser

## What's new in v2.42 - custom commit messages everywhere
- Delete file now also asks for a commit message (pre-filled
  "Delete <name>") - the last flow that used a fixed title
- Every commit-creating flow now supports custom messages:
  Upload files, Upload folder, Add file, Edit file, Delete file

## What's new in v2.41 - Issues moved to the Home card
- Bottom navigation is now Home / Repos / Commits (3 tabs)
- Issues lives on the Home profile card: a round icon button
  directly below the notification bell, same style and tap area
- The Issues screen itself is unchanged (tap the icon to open)

## What's new in v2.40 — FIXED commit view/delete + Commits tab + long-press
- FIX: tapping a commit in a repo's Commits list did nothing useful
  (it went to Repos) because GitHub's list API gives no repository
  URL - rows now carry the repo, so taps open the commit properly,
  and Revert/Rollback/view-file are all reachable
- NEW: "Commits" tab in the bottom navigation - your recent commits
  across every repository you own, with repo name, message, time
  and short SHA (loaded via GraphQL, cached for instant paint)
- NEW: long-press any commit row (Commits tab or a repo's commits
  list) to get options: View commit, Revert changes, Rollback
- Tap still opens the commit detail; long-press only opens options

## What's new in v2.39 — commit file viewer + custom commit messages
- Tap a changed file's name bar in any commit to open the full
  file content AT THAT COMMIT (GitHub-style "view file"), with
  File / Changes tabs — Changes shows the complete diff (not
  just the first 400 lines)
- Binary/too-large files get a Download button in the viewer
- Upload files / Upload folder now ask for a commit message
  first, in a small sheet with a sensible default pre-filled
- Cancel in that sheet stops the upload before anything commits

## What's new in v2.38 — undo commits (revert + rollback)
- Every commit detail screen now has two actions: Revert changes
  and Rollback (next to the additions/deletions stats)
- Revert creates a NEW commit that restores the state every file
  had before that commit — history stays intact
- Rollback permanently removes that commit AND every commit made
  after it from the default branch (confirm sheet shows how many)
- Rollback is only offered when the commit is on the default
  branch; a safety check runs first
- Uses the Git Data API (trees/commits/refs) since GitHub REST
  has no revert endpoint

## What's new in v2.37 — commit counters on the Commits screen
- A stats card at the top of a repo's Commits screen shows the
  TOTAL number of commits on the default branch and how many
  commits were made TODAY, fetched in parallel with the list
- Counts come from GitHub's Link header, so they are exact even
  for repos with thousands of commits

## What's new in v2.36 — folder uploads are a single commit
- Uploading a folder (or several files at once) now lands as ONE
  commit on the default branch instead of one commit per file,
  using GitHub's Git Data API (blobs -> tree -> commit)
- The progress card now shows "N files found" while scanning and
  "Committing x / y" while the single commit is assembled

## What's new in v2.35 — multiple GitHub accounts
- Add any number of GitHub accounts and switch between them from
  Settings > Account. Each account shows its avatar and login, with
  the active one marked
- Switching swaps the token everywhere (widgets, background
  notifications), clears the other account's cached data, and loads
  that account's pins and sync Gist - each account syncs separately
- "Add account" opens the sign-in screen with a Cancel button when
  you are already signed in
- Sign out removes the current account from the device and switches
  to the next one; if none remain, you land on the sign-in screen

## What's new in v2.34 — upload progress and notifications
- Uploads now show a live progress card with the current file, a
  "done / total" count and an accent progress bar (folder upload and
  Upload files)
- When an upload finishes successfully you get an Android system
  notification ("Upload complete — N files uploaded to repo")
- Cancelling the folder picker no longer leaves a stuck state

## What's new in v2.33 — fixed uploads over existing files
- Fixed "sha wasn't supplied" failures when uploading files that
  already exist in the repo: GitHub requires the current file sha to
  overwrite one. Folder upload, Upload files and Add file now check
  for an existing file first and overwrite it properly. The folder
  summary toast now also reports how many files failed

## What's new in v2.32 — upload folders to a repo
- New "Upload folder" button next to Add file / Upload files in the
  repo file browser: opens the system folder picker, walks the picked
  folder recursively and uploads every file while preserving the
  folder structure (subfolders included). Files land in the directory
  you are currently viewing. Limits: 200 files max, 10MB per file

## What's new in v2.31 — delete repository
- The Edit repository sheet now has a Danger zone with a Delete
  repository option, with a confirmation sheet that requires typing
  the repository name (like GitHub does) before the permanent delete
  goes through. Pinned references are cleaned up and you land back on
  the Repositories tab

## What's new in v2.30 — editable tags, Settings update panel
- The Edit release sheet now has a Tag field: change the tag of any
  release (drafts publish with the tag above)
- New "App updates" section in Settings: shows the installed version
  next to the latest release on GitHub, and when a newer one exists it
  lists the APK asset with a tap-to-download row plus a "Show update
  popup" button that replays the Home update popup on demand

## What's new in v2.29 — friendlier tag validation and API errors
- Fixed the "Validation Failed" error when publishing a release with a
  tag containing spaces: both the New release and Publish draft flows
  now check the tag up front and explain what is allowed (letters,
  numbers, dots, dashes - e.g. First-Stable)
- API errors now include GitHub's detailed reason instead of just
  "Validation Failed"

## What's new in v2.28 — publish drafts, rename files, instant updates
- Draft releases can now be published: the Edit release sheet shows a
  "Publish draft" section with a tag field and a Publish release
  button
- Uploaded files can be renamed: every release file row (on the
  Releases page and in the Edit release sheet) has a rename button
- Uploads and deletions now show up immediately: GitHub's API
  responses were being cached for up to a minute by the HTTP cache,
  so the app now always reads fresh data

## What's new in v2.27 — release files visible and removable
- Fixed uploaded files not appearing: uploading from the Edit release
  sheet now refreshes the release behind it, and the sheet itself
  shows a live "Files in this release" list with sizes and download
  counts after each upload
- Release assets can now be deleted: every file row on the Releases
  page and in the Edit release sheet has a delete button with a
  confirmation step

## What's new in v2.26 — fixed release asset uploads
- Fixed "Failed: Gitly.apk - Failed to fetch" when uploading files to
  a release: uploads.github.com does not send CORS headers, so the
  WebView blocked the upload. Release assets now upload through the
  native layer (no CORS restrictions) on a background thread, with the
  same progress toasts; affects New release and Edit release uploads

## What's new in v2.25 — attach files to new releases
- The New release sheet now has an "Attach files" section: pick any
  files from your device before publishing, see them listed with
  sizes, remove any you did not mean to add, and they upload
  automatically right after the release is published

## What's new in v2.24 — app update system
- New "Auto-download app updates" toggle in Settings: when you
  publish a new release on github.com/BonkerUnkilBonki/Gitly, the
  app detects it and downloads the update APK to your Downloads
  folder automatically (once per release)
- Update popup on the Home tab: when a newer release exists, a card
  slides in under the app bar for 20 seconds with an Update button
  (downloads the APK, or opens the releases page if no APK asset),
  then dismisses itself. It shows exactly once per release version -
  never again for the same one
- The preference syncs across devices via your private Gist
- Credits version line now reads from the app version automatically

## What's new in v2.23 — navigation follows the accent color
- The active tab pill in the bottom navigation bar now uses the
  selected accent color (with auto-contrast text) instead of a fixed
  black/grey pill, so it recolors with every accent, theme, dynamic
  and custom, just like the rest of the app

## What's new in v2.22 — instant pages, efficient saves
- Repos, Issues, repo detail and profile pages now paint instantly
  from the on-device cache the moment you navigate, then refresh
  silently in the background - no spinner flash on revisits
- On-device saves are more efficient: unchanged API responses are no
  longer rewritten to storage

## What's new in v2.21.1 — rollback of v2.22
- Restores the app to the v2.21 behavior: widget layout and colors,
  full-year contribution graph, no page-background glow, and the
  original page loading (spinner while fetching). All v2.22 changes
  are reverted.

## What's new in v2.47 - FIXED Follow button
- Fix: tapping Follow navigated away instead of following -
  clicks inside the profile card no longer leak to the card's
  own tap action (same for Edit profile)
- Fix: the Follow button could appear on your OWN profile when
  the signed-in user wasn't known yet - GitHub then answered
  "Not Found" (self-follow). It is now never shown for yourself
- Extra guard: a follow request for yourself is blocked with a
  clear message instead of an error
- If the account behind the token changes, the screen re-renders
  so the right buttons show

## What's new in v2.46 - cleaner profile README + tappable stats
- Tapping the profile card now opens a dedicated Profile README
  screen: the user's header card plus their rendered README -
  no repo page clutter (stats, clone, edit buttons are gone)
- No special repo? The card still opens the normal profile
- The repos / followers / following pills on Home are now
  tappable: followers and following open the full list of
  users with avatars, and tapping any of them opens that
  person's profile

## What's new in v2.45 - Discover search + diff wrap + home fixes
- Discover tab now has a search bar - type to search all of
  GitHub (sorts by stars); empty search shows trending repos
- Diffs wrap instead of scrolling sideways - long lines fold
  down, so code is never cut off or invisible
- Stronger colors on diff lines (context text explicit,
  add/del backgrounds brighter)
- Home quicklinks row (Productivity / Discover / My profile)
  no longer overflows the screen edge - buttons share the
  row evenly
- Added bottom padding so the last card is never hidden
  under the navigation bar

## What's new in v2.44 - Profile README support
- Tapping the profile card (avatar / name / bio block) on Home
  or on any profile opens that user's special repository - the
  one named exactly like their username - if it exists
- No special repo? The card opens the normal profile instead
- Profile screens now render the user's Profile README below
  their info, exactly like GitHub does, with images and markdown
- The existence check is cached, so the card responds instantly

## What's new in v2.43 - open GitHub links in Gitly
- Gitly can now act as a handler for github.com links
  (github.com, www/m.github.com, gist.github.com), like the
  YouTube screenshots: enable via Android Settings > Apps >
  Gitly > Set as default > Supported web addresses, or pick
  "Always" in the link chooser
- Deep links map straight to app screens: repo, user, commits,
  commit detail (with view/revert), issues & PRs, releases,
  file tree/folder, gists
- Links the app has no screen for are left to the browser

## What's new in v2.42 - custom commit messages everywhere
- Delete file now also asks for a commit message (pre-filled
  "Delete <name>") - the last flow that used a fixed title
- Every commit-creating flow now supports custom messages:
  Upload files, Upload folder, Add file, Edit file, Delete file

## What's new in v2.41 - Issues moved to the Home card
- Bottom navigation is now Home / Repos / Commits (3 tabs)
- Issues lives on the Home profile card: a round icon button
  directly below the notification bell, same style and tap area
- The Issues screen itself is unchanged (tap the icon to open)

## What's new in v2.40 — FIXED commit view/delete + Commits tab + long-press
- FIX: tapping a commit in a repo's Commits list did nothing useful
  (it went to Repos) because GitHub's list API gives no repository
  URL - rows now carry the repo, so taps open the commit properly,
  and Revert/Rollback/view-file are all reachable
- NEW: "Commits" tab in the bottom navigation - your recent commits
  across every repository you own, with repo name, message, time
  and short SHA (loaded via GraphQL, cached for instant paint)
- NEW: long-press any commit row (Commits tab or a repo's commits
  list) to get options: View commit, Revert changes, Rollback
- Tap still opens the commit detail; long-press only opens options

## What's new in v2.39 — commit file viewer + custom commit messages
- Tap a changed file's name bar in any commit to open the full
  file content AT THAT COMMIT (GitHub-style "view file"), with
  File / Changes tabs — Changes shows the complete diff (not
  just the first 400 lines)
- Binary/too-large files get a Download button in the viewer
- Upload files / Upload folder now ask for a commit message
  first, in a small sheet with a sensible default pre-filled
- Cancel in that sheet stops the upload before anything commits

## What's new in v2.38 — undo commits (revert + rollback)
- Every commit detail screen now has two actions: Revert changes
  and Rollback (next to the additions/deletions stats)
- Revert creates a NEW commit that restores the state every file
  had before that commit — history stays intact
- Rollback permanently removes that commit AND every commit made
  after it from the default branch (confirm sheet shows how many)
- Rollback is only offered when the commit is on the default
  branch; a safety check runs first
- Uses the Git Data API (trees/commits/refs) since GitHub REST
  has no revert endpoint

## What's new in v2.37 — commit counters on the Commits screen
- A stats card at the top of a repo's Commits screen shows the
  TOTAL number of commits on the default branch and how many
  commits were made TODAY, fetched in parallel with the list
- Counts come from GitHub's Link header, so they are exact even
  for repos with thousands of commits

## What's new in v2.36 — folder uploads are a single commit
- Uploading a folder (or several files at once) now lands as ONE
  commit on the default branch instead of one commit per file,
  using GitHub's Git Data API (blobs -> tree -> commit)
- The progress card now shows "N files found" while scanning and
  "Committing x / y" while the single commit is assembled

## What's new in v2.35 — multiple GitHub accounts
- Add any number of GitHub accounts and switch between them from
  Settings > Account. Each account shows its avatar and login, with
  the active one marked
- Switching swaps the token everywhere (widgets, background
  notifications), clears the other account's cached data, and loads
  that account's pins and sync Gist - each account syncs separately
- "Add account" opens the sign-in screen with a Cancel button when
  you are already signed in
- Sign out removes the current account from the device and switches
  to the next one; if none remain, you land on the sign-in screen

## What's new in v2.34 — upload progress and notifications
- Uploads now show a live progress card with the current file, a
  "done / total" count and an accent progress bar (folder upload and
  Upload files)
- When an upload finishes successfully you get an Android system
  notification ("Upload complete — N files uploaded to repo")
- Cancelling the folder picker no longer leaves a stuck state

## What's new in v2.33 — fixed uploads over existing files
- Fixed "sha wasn't supplied" failures when uploading files that
  already exist in the repo: GitHub requires the current file sha to
  overwrite one. Folder upload, Upload files and Add file now check
  for an existing file first and overwrite it properly. The folder
  summary toast now also reports how many files failed

## What's new in v2.32 — upload folders to a repo
- New "Upload folder" button next to Add file / Upload files in the
  repo file browser: opens the system folder picker, walks the picked
  folder recursively and uploads every file while preserving the
  folder structure (subfolders included). Files land in the directory
  you are currently viewing. Limits: 200 files max, 10MB per file

## What's new in v2.31 — delete repository
- The Edit repository sheet now has a Danger zone with a Delete
  repository option, with a confirmation sheet that requires typing
  the repository name (like GitHub does) before the permanent delete
  goes through. Pinned references are cleaned up and you land back on
  the Repositories tab

## What's new in v2.30 — editable tags, Settings update panel
- The Edit release sheet now has a Tag field: change the tag of any
  release (drafts publish with the tag above)
- New "App updates" section in Settings: shows the installed version
  next to the latest release on GitHub, and when a newer one exists it
  lists the APK asset with a tap-to-download row plus a "Show update
  popup" button that replays the Home update popup on demand

## What's new in v2.29 — friendlier tag validation and API errors
- Fixed the "Validation Failed" error when publishing a release with a
  tag containing spaces: both the New release and Publish draft flows
  now check the tag up front and explain what is allowed (letters,
  numbers, dots, dashes - e.g. First-Stable)
- API errors now include GitHub's detailed reason instead of just
  "Validation Failed"

## What's new in v2.28 — publish drafts, rename files, instant updates
- Draft releases can now be published: the Edit release sheet shows a
  "Publish draft" section with a tag field and a Publish release
  button
- Uploaded files can be renamed: every release file row (on the
  Releases page and in the Edit release sheet) has a rename button
- Uploads and deletions now show up immediately: GitHub's API
  responses were being cached for up to a minute by the HTTP cache,
  so the app now always reads fresh data

## What's new in v2.27 — release files visible and removable
- Fixed uploaded files not appearing: uploading from the Edit release
  sheet now refreshes the release behind it, and the sheet itself
  shows a live "Files in this release" list with sizes and download
  counts after each upload
- Release assets can now be deleted: every file row on the Releases
  page and in the Edit release sheet has a delete button with a
  confirmation step

## What's new in v2.26 — fixed release asset uploads
- Fixed "Failed: Gitly.apk - Failed to fetch" when uploading files to
  a release: uploads.github.com does not send CORS headers, so the
  WebView blocked the upload. Release assets now upload through the
  native layer (no CORS restrictions) on a background thread, with the
  same progress toasts; affects New release and Edit release uploads

## What's new in v2.25 — attach files to new releases
- The New release sheet now has an "Attach files" section: pick any
  files from your device before publishing, see them listed with
  sizes, remove any you did not mean to add, and they upload
  automatically right after the release is published

## What's new in v2.24 — app update system
- New "Auto-download app updates" toggle in Settings: when you
  publish a new release on github.com/BonkerUnkilBonki/Gitly, the
  app detects it and downloads the update APK to your Downloads
  folder automatically (once per release)
- Update popup on the Home tab: when a newer release exists, a card
  slides in under the app bar for 20 seconds with an Update button
  (downloads the APK, or opens the releases page if no APK asset),
  then dismisses itself. It shows exactly once per release version -
  never again for the same one
- The preference syncs across devices via your private Gist
- Credits version line now reads from the app version automatically

## What's new in v2.23 — navigation follows the accent color
- The active tab pill in the bottom navigation bar now uses the
  selected accent color (with auto-contrast text) instead of a fixed
  black/grey pill, so it recolors with every accent, theme, dynamic
  and custom, just like the rest of the app

## What's new in v2.22 — theme-synced widgets, page glow, instant pages
- Widgets now follow the app's color scheme: theme (light/dark/AMOLED)
  and accent color selected in Settings are pushed to the widgets, so
  heatmap, cards and text recolor to match. Open the app once after
  changing theme/accent to refresh the widgets
- Bigger heatmap squares: widgets show the last 6 months (2x2 shows
  recent months) at roughly double the previous size
- New "page background glow": with Navigation glow enabled, a soft
  accent-colored glow rises from the bottom of the screen behind the
  navigation bar, matching the navbar glow and changing with the
  selected accent
- Faster, calmer page changes: Repos, Issues, repo detail and profile
  pages now paint instantly from the on-device cache, then refresh
  silently in the background - no more spinner flash when revisiting
  a page
- On-device saves are more efficient: unchanged API responses are no
  longer rewritten to storage

## What's new in v2.21 — widgets redesigned to match Productivity
- Contribution widgets now mirror the in-app Productivity page: dark
  card layout (page background #161719, cards #242527, One UI rounded
  corners) instead of the old single flat panel
- 4x4 widget: full Productivity overview - contribution graph with
  the "Less ... More" legend, "Right now" (this week, this month,
  current streak, longest streak, daily average, busiest day) and
  "This year on GitHub" (commits, pull requests, issues, reviews,
  new repos, contributions)
- 4x2 widget: contribution graph card plus this week / current
  streak / busiest day
- 2x2 widget: compact Productivity card with recent-months heatmap
  and streak/busiest-day footer
- Widget stats use the exact same math and query as the Productivity
  page, so numbers always match the app
- Tapping a widget now opens the Productivity page

## What's new in v2.20 — contribution widget redesign
- Fixed the contribution widget's heatmap being invisible: empty and
  low-activity cells were almost the same color as the widget
  background. New palette matches the in-app heatmap exactly (Samsung
  blue at 40/60/80/100%, visible empty cells)
- Widget levels now use the same buckets as the app (0 / 1-2 / 3-6 /
  7-11 / 12+) instead of scaling against your busiest day, so light
  days are visible and colors are consistent with the Productivity
  heatmap
- 2x2 widget now shows the last ~4 months at a readable size instead
  of a squeezed full year (stats still cover the whole year)
- Footer reads "Best day 79 · 3-day streak · 148 this year" and aligns
  with the header

## What's new in v2.19
- Fixed the white corner artifacts: the WebView's native background
  now follows the app theme (was fixed light gray, which leaked
  through GPU compositing gaps at rounded corners in dark themes)
- Extra compositing hardening: the glass navbar, app bar and bottom
  sheets render on their own GPU layers, eliminating the white
  L-shaped corner fragments on the files page and the white tips on
  sheet corners

## What's new in v2.18
- Fixed the viewer glitch (red fragments, overlapping header, clipped
  text) when opening very large files like big JSON exports: the file
  viewer now caps rendering at the first 60,000 characters / 2,000
  lines so the WebView never breaks, with a note showing where it cut
  off. Edit still works on the full content via the raw API

## What's new in v2.17
- The active tab pill in the bottom navigation now covers the whole
  tab — icon and label text together — with a smooth rounded capsule
  shape (previously it wrapped only the icon)

## What's new in v2.16
- Navigation bar is now a full capsule (fully rounded ends instead of
  squarical corners)
- New "Navigation glow" toggle in Settings > Appearance (off by
  default): when enabled, adds an accent-colored glow around the
  bottom bar and the active tab pill
- The navigation glow preference syncs across devices via your
  GitHub account

## What's new in v2.15 — glassmorphic navbar
- Restyled the bottom navigation to a professional floating glass bar:
  translucent frosted background with real blur, hairline border and
  a soft, diffuse shadow — no more neon glow
- Active tab is now a solid dark pill with white icon and label
  (adapts per theme: dark pill on the light glass, grey pill on dark
  and pitch black)

## What's new in v2.14
- Fixed the "Save changes" button (and all primary buttons) being hard
  to read with light accent colors — button text now auto-switches
  between white and dark based on the accent's brightness
- Alerts moved: the bell now lives at the top-right of the profile
  card (next to the profile picture) on Home and the profile page;
  the bottom nav is now Home, Repos, Issues
- On-device data saving: every page you visit is cached locally, so
  when you open the app offline you see your saved data instead of
  blank screens (with a small "Offline — showing saved data" toast);
  fresh data is fetched automatically whenever you are back online

## What's new in v2.13 — fast-switch glitch fixed
- Fixed the "Cannot set properties of null (setting 'innerHTML')"
  crash that appeared when quickly switching tabs or sections while a
  page was still loading (README, notifications and feed updates)
- Added a render-session guard across every view: when you switch
  tabs/sections, any in-flight load from the previous screen is
  discarded instead of overwriting the new screen or flashing stale
  content

## What's new in v2.12
- Removed the "One UI 9-inspired" line and the Samsung mention from the
  Credits page — the bullet list is now just version, sync note and
  the GitHub disclaimer

## What's new in v2.11
- Developer details (Name, Age, Profession) in the Credits tab are now
  centered under the logo, matching the card's centered layout

## What's new in v2.10
- Reverted the v2.9 profile-picture fallback changes per user request
  (avatars render exactly as before)
- Fixed a stray "NaN" that could appear in the profile card markup
  introduced by the reverted change

## What's new in v2.9 — Today's productivity
- The Productivity tab now has two sub-tabs: Overview and Today
- Today shows the selected day at a glance: big contribution count,
  a tappable bar chart of the last 7 days, and a date picker (plus a
  Today button) to inspect any particular day
- For the picked day it fetches per-day stats straight from GitHub:
  commits, pull requests, issues, reviews, and the exact repositories
  you committed to that day (tap to open)
- Avatar fix: profile pictures that fail to load now fall back to a
  rounded letter placeholder instead of showing blank, and a stale
  cached profile without a picture is refreshed from GitHub

## What's new in v2.8 — Productivity tab
- The Gists quicklink on Home is gone — replaced by a Productivity tab
  (also hidden from profile pages; gist pages still exist if you need
  them)
- Productivity shows, from GitHub's GraphQL contribution data:
  - Contribution graph for the last 12 months (accent-colored heatmap,
    scrollable, per-day tooltips)
  - This week / this month contribution counts, current and longest
    streak, daily average, busiest day
  - Yearly breakdown: commits made, pull requests, issues, reviews,
    new repos, total contributions
  - Most active repositories ranked by commits this year (tap to open)
- Stats are cached on-device, so the page opens instantly and refreshes
  in the background

## What's new in v2.7
- Persistent activity history: Recent activity is now saved on the
  device and never cleared — every refresh merges new events into the
  stored history (deduplicated, newest first, up to 300 events)
- Your own GitHub activity is included (pushes, releases, stars,
  forks…), not just events from people you follow, so the feed stays
  populated
- Home always shows the 3 latest events with a View all activity
  button below them; the activity page shows the whole accumulated
  history
- Credits: the logo moved into the Developer card, above the name

## What's new in v2.6
- Edit release: every release card has an Edit release button — change
  the title and release notes, and upload files straight into the
  release from the same sheet (multi-select via the device picker)
- Recent activity on Home now shows the latest 3 items; a View all
  activity button opens a full activity page with everything from
  people you follow (back arrow returns Home)
- Files tab: long-press any file to get the delete confirmation
  (with a small haptic buzz); a normal tap still opens the file

## What's new in v2.5 — credits page polish
- The Gitly logo (yes, the cat) now sits at the top of the Credits
  tab in Settings, rounded to match the card design with an accent
  glow
- Version info is now a proper bullet list, one item per line:
  Version, description, sync note, disclaimer

## What's new in v2.4 — full repo editing
- Upload files: any repo's Files tab has an Upload files button that
  opens the Android file picker (multi-select) and commits each file
  straight to the repo
- Edit file: tap a file in the Files tab, then Edit — make changes in
  the editor, write a commit message, and commit
- Delete file: same viewer, Delete button, with confirmation
- New release: the Releases page has a New release button — tag,
  title, description, Final / Pre-release / Draft
- Upload release assets: every release card has an Upload asset
  button that uploads any file from your device to that release
  (APKs, zips, anything)
- Edit repository: repos you can push to show an Edit repository
  button on the repo page — description, homepage and
  public/private visibility

## What's new in v2.3 — new app font
- The entire app now uses the bundled Google Sans Flex font (shown in
  your screenshot request) for every screen, card, button and label
- Font is embedded in the APK, works fully offline
- The old Font setting (System / App default) was removed since the
  app font is now always the bundled one; code blocks, diffs and file
  views intentionally stay monospace for readability

## What's new in v2.2
- Removed the "Your GitHub, the One UI way" tagline from the home header
- Auto-sync on open: Gitly quietly restores your synced preferences
  from your private Gist in the background every time the app opens —
  no waiting, the app is usable instantly
- On-device data cache: your profile and the Recent activity feed are
  cached locally, so the home screen appears immediately from cache and
  fresh data arrives silently in the background
- New Credits tab in Settings: version info, developer details, and
  connect buttons for Telegram (t.me/BonkerUnkilBonki) and GitHub
  (github.com/BonkerUnkilBonki) with logos, plus languages used

## What's new in v2.1 — issue creation everywhere
- New issue from the global Issues tab: a New issue button now sits at
  the top of the Issues tab in the bottom nav — pick one of your repos
  from the picker sheet, then write the title and description
- (Creating issues from a specific repo's Issues tab was already there
  and still works the same)

## What's new in v2.0 — create things on GitHub
- Create repository: Repos tab > New repository — name, description,
  Private/Public, optional README initialization; jumps straight into
  your new repo
- Create gist: Gists > New gist — description, filename, content,
  Secret/Public
- Add file: any repo's Files tab > Add file — filename, content and
  commit message, committed straight from the app
- Close / reopen issues and pull requests from the issue detail header
- Edit profile: your own profile page > Edit profile — name, bio,
  location

## What's new in v1.9
- Removed the custom TTF font import feature; the Font setting now offers
  System (default) and App default only

## What's new in v1.8
- Custom color: a dashed "Custom" dot in the accent picker opens a full
  color picker plus hex input — any color becomes your accent, with
  matching pressed/glow shades derived automatically
- Font options: System (default), App default, or Custom TTF —
  import any .ttf/.otf from your device (up to 4 MB) via the native
  file picker and Gitly renders its entire UI in your font
- Custom color and font preference sync across devices (the font file
  itself stays on the device that imported it)

## What's new in v1.7
- Glow effects toggle: Settings > Appearance > Glow effects — instantly
  kills every neon glow (buttons, cards, highlights, spinner, logo pulse)
  for a flat, battery-friendlier look; synced across devices
- Three new accent colors: Teal, Red, Indigo (9 accents total)
- Dynamic color: a rainbow "Dynamic" dot in Settings picks up your
  system / wallpaper accent (Material You) on Android 12+ and applies it
  to the whole UI — buttons, highlights, glows; falls back to blue where
  unavailable

## What's new in v1.6
- Contributions 4x2 wide widget: full-year heatmap plus best day, streak
  and yearly total, sized for a 4x2 slot
- Background GitHub activity notifications: Gitly now checks GitHub
  roughly every 15 minutes (even when closed) and posts system
  notifications for new issues, PRs, mentions, reviews, releases and CI
  results on repos you watch or participate in
  - Notification permission is requested on first launch (Android 13+)
  - Toggle in Settings > Notifications; re-arms itself after reboot
  - Deduplicated per thread — you get notified once per activity
  - Tapping a notification opens the Alerts tab

## What's new in v1.5
- Contribution activity widgets (long-press home screen > Widgets > Gitly):
  - Contributions 2x2: compact full-year heatmap
  - Contributions 4x4: full-year heatmap plus best day, current streak
    and yearly total
- One UI 9 styling: dark rounded cards, Samsung-blue contribution scale
  (empty -> bright), today's cell ringed
- Live data via GitHub GraphQL using your saved token; refreshes every
  30 minutes and every time you open the app
- All four Gitly widgets now: Profile, Quick, Contributions 2x2, 4x4

## What's new in v1.4
- Home screen widgets (long-press your launcher > Widgets > Gitly):
  - Gitly Profile: avatar, name and repo/follower stats, refreshed live
  - Gitly Quick: Home / Repos / Issues / Alerts launch pills
- Releases: view every release with notes, assets (size + download count),
  and one-tap in-app downloads via Android DownloadManager — plus
  Source code (zip / tar.gz) for every tag
- Clone sheet: HTTPS and SSH URLs with native copy buttons, Download ZIP
- Repo topics shown as chips
- Release assets download straight to your Downloads folder with a
  system notification (works for public repos; private-repo asset
  downloads may require re-auth in a browser)

## What's new in v1.3
- Fixed the empty space above the big header (title now sits right under the
  status bar like One UI)
- Repo actions: Star/Unstar, Watch/Unwatch, Fork (with confirmation), and
  Open on GitHub
- Language breakdown card on repo pages (colored bar + percentages)
- Create new issues from any repo (bottom sheet form)
- Followers / Following lists — tap the stats on any profile
- Gists: browse your gists and public gists of any user, view file contents
- Notifications filter: Unread / All
- Home quick links: Gists, Discover, My profile

## What's new in v1.2
- Settings moved from the bottom bar to a top-right gear icon (also in the
  collapsed app bar while scrolling)
- Bottom navigation auto-hides while scrolling down or after ~4s idle and
  slides back on any touch or upward scroll
- Fuller One UI 9 rounding: cards 32px, navbar 34px, bigger pills and radii
  everywhere; subtle card outlines in dark/pitch themes
- Five accent color schemes: Blue, Purple, Green, Pink, Amber — recolors
  buttons, highlights, glows and the login logo; synced across devices

## What's new in v1.1
- Pitch black (AMOLED) theme — third theme option alongside light and dark
- Home activity feed (pushes, stars, forks, issues, PRs, releases)
- Commits tab per repo + full commit detail with colorized diffs
- Releases page per repo, contributors row on repo detail
- Pull requests view (global and per repo) — open PRs, comment on them
- User profiles: tap any username/avatar — stats, popular repos, follow/unfollow
- People results in search, Discover tab (trending high-star repos)
- Animations and glows: staggered card entrances, press feedback, glowing
  buttons/nav/toasts, star pin pop, sheet slide-up, refresh button
- Status and navigation bar colors follow the selected theme natively

Gitly is a lightweight GitHub client wrapped in a Samsung One UI-style interface:
big collapsing titles, floating pill bottom navigation, rounded cards, segmented
controls, pill buttons and a dark mode with the One UI dark palette.

## The APK

`Gitly.apk` — install it on any Android 7.0+ (API 24) device. It is signed with
the included debug keystore, so future builds signed with the same key will
install as updates over this one.

## Signing in

Gitly connects to GitHub with a personal access token (the same idea as the
official GitHub CLI or third-party clients):

1. In the app, tap "Create a token with the right scopes" (or visit
   https://github.com/settings/tokens/new?scopes=repo,read:user,notifications,gist&description=Gitly).
2. Generate the token and paste it into Gitly.

Scopes used: `repo`, `read:user`, `notifications`, `gist`.
The token is stored only on your device (localStorage inside the app).

## Sync across devices

- All GitHub content (repos, issues, notifications) is fetched live from your
  account, so every device you sign in on shows the same thing.
- App preferences (pinned repositories, theme) are additionally saved to a
  private Gist in your GitHub account. On a new device, sign in and your pins
  and theme are restored automatically ("Restore from GitHub" in Settings).
- The access token is never synced — you enter it once per device.

## Features

- Home: profile, stats, pinned repositories
- Repositories: your repos, starred repos, GitHub search, pin/unpin
- Repo detail: README rendering, file browser with file viewer, issues
- Issues: created/assigned, open/closed, full issue threads with comments,
  post comments
- Notifications: unread threads, open thread subject, mark read / mark all
- Settings: dark mode, sync management, sign out

## Project layout

    AndroidManifest.xml     app manifest (com.onegit)
    src/com/onegit/         MainActivity (WebView wrapper)
    assets/www/             the whole client UI (HTML/CSS/JS, no framework)
    res/                    theme, strings, launcher icons
    gen_icon.py             regenerates launcher icons (Pillow)
    build.sh                builds the APK without Gradle
    debug.keystore          signing key (keep it to sign updates)

## Building

The build script uses only Android build-tools + a JDK (no Gradle):

    # one-time toolchain setup
    export SDK=/path/to/sdk
    # build-tools 34.0.0 in $SDK/build-tools/34.0.0
    # platform android-34 in  $SDK/platforms/android-34/android.jar
    # JDK 17 on PATH

    bash build.sh          # produces Gitly.apk

Icons can be regenerated with `python3 gen_icon.py`.

## Notes

- Not affiliated with GitHub or Samsung; One UI is used purely as a visual
  inspiration.
- The web UI is plain HTML/CSS/JS served from the app's assets, so it can also
  be opened in any browser as a PWA-style page if you extract assets/www/.
