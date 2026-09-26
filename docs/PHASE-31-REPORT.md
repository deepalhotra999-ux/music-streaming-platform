# Phase 31 Report — Accessibility Audit & Hardening

Date: 2026-09-26
Status: Complete
Base: `9ca9d20` (Phase 30)

## Summary

Audited and hardened accessibility across the mobile app (Expo / React
Native), the admin console (React web SPA), and their shared design
systems. This phase added no features and changed no business logic; it
made the existing product usable with screen readers, keyboard-only
navigation, large text, and reduced motion.

Standing reference: `docs/ACCESSIBILITY.md` (principles, conventions,
contrast measurements, full audit matrix, manual verification matrices).

## Acceptance Criteria

- [x] Shared mobile design system hardened (Button, IconButton, TextInput,
      Screen, States, announce, useReducedMotion)
- [x] Player/background playback/offline given announcements and semantics
- [x] Auth, catalog, search, library, playlists given labels/states/errors
- [x] Artist platform, subscriptions, royalties given labels/states
- [x] Rooms given labels, live regions, progress semantics
- [x] Collaboration, community, commerce given labels and modal isolation
- [x] CarPlay/Android Auto JS layers verified (titles/subtitles; native
      templates own accessibility)
- [x] Admin keyboard/semantic accessibility (skip link, focus trap,
      landmarks, table scope, contextual row actions)
- [x] Contrast measured and fixed (textFaint, primaryFilled, error text)
- [x] Touch targets ≥44pt, font scaling never disabled, reduced motion
      respected
- [x] Automated accessibility tests added (mobile 22, admin 8)
- [x] Manual matrices defined (VoiceOver, TalkBack, keyboard, web SR)
- [x] Full verification matrix run; no Phase 31 regressions
- [x] Phase 32 NOT started

## What changed

### Mobile — new files

- `src/components/IconButton.tsx` — labelled 44pt icon button
- `src/components/announce.ts` — central screen-reader announcements
- `src/components/useReducedMotion.ts` — OS reduced-motion hook
- `src/player/usePlaybackAnnouncements.ts` — "Now playing" + error announcements
- `src/offline/useDownloadAnnouncements.ts` — download completion/failure announcements
- `src/components/__tests__/accessibility.test.tsx` (8 tests)
- `src/player/__tests__/announcements.test.tsx` (6 tests)
- `src/offline/__tests__/announcements.test.tsx` (4 tests)
- `src/community/components/__tests__/ReportDialog.a11y.test.tsx` (4 tests)

### Mobile — modified

- Design tokens: `textFaint` → `#8E8EA0` (4.6:1), `primaryFilled` `#6A48F0`
  (5.53:1) for filled buttons, `primaryFilledPressed`
- `States.tsx`: Loading = progressbar/live region; Error = alert/assertive
- `Screen.tsx`: `modal` prop → `accessibilityViewIsModal`
- `TextInput.tsx`: visible label, required marker, error in accessible name,
  alert errors
- `Button.tsx`: filled-primary contrast
- `ArtworkImage.tsx`: decorative by default, opt-in accessible images
- `SeekBar.tsx`: formatted "1:23 of 3:45" value, increment/decrement
- `MiniPlayer.tsx`: expand label includes playback errors
- `PlayerControls.tsx`: filled-primary contrast
- Reduced-motion-aware modals: profile purchase, compose picker, artist
  product-create, artist inventory, playlist form, report dialog
- Modal isolation: profile purchase, compose picker, playlist form, artist
  product dialogs, report dialog (also fixed invalid backdrop nesting)
- Auth (login/register), checkout, artist store/product/orders: visible
  labels via shared `TextInput`, required markers, assertive errors
- Rooms: now-playing group label, progressbar with static value, join-form
  labels, reconnecting/live/error semantics
- Commerce: contextual action labels, meaningful product images
- Subscriptions `PurchaseSheet`: progress/error/live semantics

### Admin — modified

- `ConfirmDialog.tsx`: focus trap, initial focus on Cancel, focus return
- `Layout.tsx`: skip link, labelled aside, main target
- `index.css`: `:focus-visible` outlines, skip-link styles
- `Pagination.tsx`: `<nav aria-label="Pagination">`
- All 69 `<th>` → `<th scope="col">`
- Commerce tabs: tablist/tab/aria-selected
- Row actions: contextual `aria-label`s ("View album {title}" etc.)

### Docs

- `docs/ACCESSIBILITY.md` — standing reference (new)
- `docs/PHASE-31-REPORT.md` — this file (new)

## Tests

| Suite                                      | Result                                                        |
| ------------------------------------------ | ------------------------------------------------------------- |
| Backend                                    | 654/655 (1 pre-existing analytics UTC-day failure, untouched) |
| Mobile                                     | 766/766 (101 suites; 22 new a11y tests)                       |
| Admin                                      | 48/48 (9 files; 8 new focus/semantic tests)                   |
| Mobile subscriptions + royalty regressions | 47/47                                                         |
| TypeScript (mobile, admin, backend)        | Clean                                                         |
| ESLint                                     | 2 pre-existing errors in untouched lines (documented)         |
| Prettier                                   | Phase 31 files formatted                                      |
| Expo Doctor                                | 19/21 (2 pre-existing expo-modules-core failures)             |
| Backend build                              | Clean                                                         |
| Admin build                                | Clean                                                         |
| Expo export (android, ios)                 | Both green                                                    |

## Pre-existing issues (untouched, not Phase 31 regressions)

1. Backend `analytics.test.ts` "buckets plays by UTC day": expected `0`,
   received `undefined`. Pre-existing; left untouched.
2. Expo Doctor `expo-modules-core` direct-install + version mismatch checks.
   Pre-existing.
3. ESLint `no-require-imports` in
   `RoyaltyPeriodDetailScreen.test.tsx:230`; `no-empty-function` in
   `CommercePage.tsx:78`. Both pre-existing in HEAD.

## Limitations

- **No physical screen-reader or device testing.** The sandbox has no
  iOS/Android device, VoiceOver/TalkBack, or desktop screen reader. All
  semantics verified via automated tests + code inspection. Manual matrices
  in `docs/ACCESSIBILITY.md` are defined but **pending** on real hardware.
- CarPlay/Android Auto: native templates own accessibility; JS supplies
  titles/subtitles. No head-unit validation.
- Canvas trend chart: data also available as text.
- Dynamic Type: layouts tolerate scaling; largest-size visual pass pending
  on device.

## Manual checklist (for release)

- [ ] VoiceOver matrix (10 scenarios) on iPhone
- [ ] TalkBack matrix (5 scenarios) on Android
- [ ] Keyboard-only matrix (5 scenarios) on admin
- [ ] Web screen-reader matrix (4 scenarios) on admin
- [ ] Dynamic Type largest-size pass
- [ ] Reduce Motion pass

## Files changed

50 files changed, +1255/−474. Full list in the commit. Key areas:
mobile `src/components/`, `src/player/`, `src/offline/`, `src/app/(commerce)/`,
`src/app/(artist)/`, `src/app/room/`, `src/screens/`, `src/subscriptions/`,
`src/community/components/ReportDialog.tsx`, `src/theme/colors.ts`;
admin `src/components/`, `src/pages/`, `src/index.css`; docs.

## Notes

- No ADR: no architectural decision was made (native-platform semantics
  throughout).
- No copyrighted music introduced. No test data left behind. Dev servers
  were not started (no servers needed for this phase's verification).
- Commit includes its own hash; the hash is reported below and not amended
  into the report.
- Phase 32 was not started.
