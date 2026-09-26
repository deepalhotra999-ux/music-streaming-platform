# Accessibility — Waveform

Date: 2026-09-26 (Phase 31)
Status: Audited and hardened across mobile, admin, and web surfaces.

This document is the standing accessibility reference for the Waveform
music platform. It covers the mobile app (Expo / React Native), the admin
console (React web SPA), design-system conventions, the audit matrix from
the Phase 31 hardening pass, and the manual verification matrices for
screen readers and keyboard-only use.

## Principles

1. **Native first.** We use React Native's built-in accessibility props
   (`accessibilityRole`, `accessibilityLabel`, `accessibilityHint`,
   `accessibilityState`, `accessibilityValue`, `accessibilityLiveRegion`,
   `accessibilityViewIsModal`) and the web platform's native semantics
   (`<button>`, `<nav>`, `<main>`, `<table>` with `scope`, `role="alert"`,
   `aria-live`). No custom accessibility frameworks.
2. **Names for everything interactive.** Every button, link, input, and
   custom control exposes an accessible name. Icon-only controls use the
   shared `IconButton` (mobile) or visible text / `aria-label` (web).
3. **State is announced, not just shown.** Loading, errors, empty states,
   and async completions (track changes, downloads) use live regions or
   explicit announcements.
4. **Contrast is measured, not eyeballed.** Text/background pairs meet
   WCAG AA (4.5:1 for body text). Measured values are in the audit matrix.
5. **Motion respects the user.** Reduced-motion preferences disable modal
   transitions; no essential information is conveyed by animation alone.
6. **Touch targets are 44pt minimum** (via size or `hitSlop`).
7. **Font scaling is never disabled.** No `allowFontScaling={false}`
   anywhere; layouts tolerate Dynamic Type growth.

## Mobile design system (`apps/mobile/src/components/`)

### `IconButton`

Required `label`, `accessibilityRole="button"`, `accessibilityState`
(disabled/selected), minimum 44×44pt target, decorative icon hidden
(`accessible={false}`). Use for every icon-only control.

### `Button`

Exposes role, label, hint, disabled, and busy (`accessibilityState.busy`)
states. Primary actions use the `primaryFilled` token for contrast.

### `TextInput`

- Visible label with required marker (`*`).
- Accessible name = label + required state + current error.
- Errors render with `accessibilityRole="alert"` and assertive live region.
- Password show/hide toggle is a labelled button.

### `Screen`

Accepts a `modal` prop that sets `accessibilityViewIsModal`, isolating
modal content from the background for screen readers.

### `States` (`LoadingState`, `ErrorState`, `EmptyState`)

- Loading: `progressbar` role, label, polite live region.
- Error: `alert` role, assertive live region, retry button.

### `announce.ts`

Central wrapper around `AccessibilityInfo.announceForAccessibility` for
one-shot announcements (track changes, download completions).

### `useReducedMotion.ts`

Reads the OS reduced-motion setting, subscribes to changes, and
`modalAnimationFor()` returns `"none"` when reduced motion is preferred.
All app modals use it.

## Mobile conventions

- **Artwork is decorative by default** (`ArtworkImage` hides images from
  the accessibility tree). Pass `accessibilityLabel` only when the image
  itself carries meaning (e.g. a product photo in commerce).
- **Cards are single accessible buttons** with coherent labels
  ("{title} by {artist}"); nested actions are separate controls outside
  the card's accessible name.
- **SeekBar** announces formatted position/duration
  ("1:23 of 3:45"), not raw milliseconds, and supports
  accessibility increment/decrement actions.
- **Room progress** is a `progressbar` with a static value — never a live
  region (it updates every second).
- **Modals** use `accessibilityViewIsModal`, a coherent label, reduced-
  motion-aware transitions, and an explicit dismiss path (button and/or
  hardware back). The dismiss backdrop is a _sibling_ of the sheet, never
  its parent.
- **Async announcements**: track changes ("Now playing: … by …"),
  playback errors, and download completions/failures are announced once
  each. Pre-existing terminal downloads are baselined, not announced, on
  launch.
- **Forms**: visible labels, required markers, inline errors as alerts,
  busy/disabled button states, hints for format constraints.

## Admin console (`apps/admin`)

- Skip link ("Skip to main content") targeting `#admin-main-content`.
- Visible `:focus-visible` outlines on all interactive elements.
- Landmarks: `<aside aria-label="Admin">`, `<nav aria-label="Admin sections">`,
  `<main>`, pagination as `<nav aria-label="Pagination">`.
- One `<h1>` per page; tables use `<th scope="col">`.
- `ConfirmDialog`: `role="alertdialog"` + `aria-modal`, labelled by title,
  described by message, Escape/backdrop cancel, focus trap (Tab cycles),
  initial focus on the safe (Cancel) action, focus returns to the trigger
  on close.
- Loading states use `role="status"`; errors use `role="alert"`.
- Row actions in tables use `aria-label` with the entity name
  ("View album {title}", "Suspend store {name}") so they are unambiguous
  when navigating by button.
- Commerce tabs use `role="tablist"`/`role="tab"` with `aria-selected`.
- Status is always text + color, never color alone.

## Contrast measurements (Phase 31)

| Pair                                | Ratio  | Verdict                                                                  |
| ----------------------------------- | ------ | ------------------------------------------------------------------------ |
| `textFaint` `#8E8EA0` on background | 4.6:1  | AA pass (was 3.93:1 at `#6E6E80`)                                        |
| White on `primaryFilled` `#6A48F0`  | 5.53:1 | AA pass                                                                  |
| White on original primary `#7C5CFF` | 4.35:1 | Below AA for small text → replaced by `primaryFilled` for filled buttons |
| White on error `#FF6B6B`            | 2.78:1 | Fail → error-filled actions use dark text (7.08:1)                       |
| Dark text on error `#FF6B6B`        | 7.08:1 | AA pass                                                                  |

## Audit matrix (Phase 31)

Severity: **C**ritical (blocks use), **M**ajor (difficult/confusing),
**m**inor (polish).

### Mobile — shared design system

| Component            | Issue                         | Sev | Prior behavior             | Change                                       | Verification   | Status |
| -------------------- | ----------------------------- | --- | -------------------------- | -------------------------------------------- | -------------- | ------ |
| `States.tsx` Loading | No role/live region           | M   | Silent spinner             | `progressbar` role + polite live region      | Unit test      | Fixed  |
| `States.tsx` Error   | Error not announced           | M   | Plain text                 | `alert` role + assertive live region         | Unit test      | Fixed  |
| `Screen`             | Modals not isolated           | M   | Background still reachable | `modal` prop → `accessibilityViewIsModal`    | Manual         | Fixed  |
| `TextInput`          | No required/error semantics   | M   | Label only                 | Required marker, error in name, alert errors | Unit tests (8) | Fixed  |
| `Button`             | Low-contrast primary          | M   | 4.35:1 white on `#7C5CFF`  | `primaryFilled` `#6A48F0` (5.53:1)           | Measured       | Fixed  |
| `IconButton`         | (new) Unlabelled icon buttons | M   | Ad-hoc Pressables          | Enforced label/role/44pt                     | Unit tests (3) | Fixed  |
| `ArtworkImage`       | Decorative art announced      | m   | Images in a11y tree        | Hidden by default, opt-in label              | Unit tests (6) | Fixed  |
| Modals (6)           | Motion ignores OS setting     | m   | Always animated            | `modalAnimationFor()` everywhere             | Unit tests     | Fixed  |
| `textFaint`          | 3.93:1 contrast               | M   | `#6E6E80`                  | `#8E8EA0` (4.6:1)                            | Measured       | Fixed  |

### Mobile — player & playback

| Component        | Issue                   | Sev | Prior behavior        | Change                                           | Verification   | Status |
| ---------------- | ----------------------- | --- | --------------------- | ------------------------------------------------ | -------------- | ------ |
| `SeekBar`        | Announced raw ms        | M   | "45000"               | Formatted "0:45 of 3:00", increment/decrement    | Unit test      | Fixed  |
| Playback         | Track changes silent    | M   | No announcement       | "Now playing: … by …" via hook                   | Unit tests (4) | Fixed  |
| Playback         | Errors silent           | M   | No announcement       | Announced once per unique error                  | Unit tests     | Fixed  |
| `MiniPlayer`     | Expand label hid errors | m   | Generic label         | Includes playback error                          | Manual         | Fixed  |
| Room progress    | N/A (new)               | m   | —                     | `progressbar` role, static value, no live region | Manual         | Fixed  |
| Room now-playing | Fragmented announcement | m   | Title/artist separate | Grouped "Now playing: … by …"                    | Manual         | Fixed  |

### Mobile — offline

| Component | Issue                       | Sev | Prior behavior  | Change                             | Verification   | Status |
| --------- | --------------------------- | --- | --------------- | ---------------------------------- | -------------- | ------ |
| Downloads | Completions/failures silent | M   | No announcement | Announced once; baseline on launch | Unit tests (4) | Fixed  |

### Mobile — auth & forms

| Component                   | Issue                                   | Sev | Prior behavior    | Change                                   | Verification | Status |
| --------------------------- | --------------------------------------- | --- | ----------------- | ---------------------------------------- | ------------ | ------ |
| Login/Register              | Required fields unmarked, errors silent | M   | Plain inputs      | Required markers, assertive error alerts | Manual       | Fixed  |
| Checkout                    | Placeholder-only labels                 | M   | No visible labels | Shared `TextInput` with visible labels   | Manual       | Fixed  |
| Artist store/product/orders | Placeholder-only labels                 | M   | No visible labels | Shared `TextInput` with visible labels   | Manual       | Fixed  |

### Mobile — rooms, community, commerce

| Component       | Issue                              | Sev | Prior behavior   | Change                                         | Verification   | Status |
| --------------- | ---------------------------------- | --- | ---------------- | ---------------------------------------------- | -------------- | ------ |
| Room lobby/join | Unlabelled controls, silent errors | M   | —                | Labels, hints, assertive error alerts          | Manual         | Fixed  |
| `ReportDialog`  | Sheet nested in backdrop button    | M   | Invalid nesting  | Siblings; backdrop button + modal sheet        | Unit tests (4) | Fixed  |
| Commerce cards  | Ambiguous action names             | m   | "Remove", "View" | Contextual labels ("Remove {title} from cart") | Manual         | Fixed  |
| Product images  | Decorative-only                    | m   | Hidden           | Meaningful images get labels                   | Manual         | Fixed  |

### Admin console

| Component       | Issue                                                                  | Sev | Prior behavior                   | Change                                            | Verification       | Status |
| --------------- | ---------------------------------------------------------------------- | --- | -------------------------------- | ------------------------------------------------- | ------------------ | ------ |
| `ConfirmDialog` | No focus trap; focus landed on destructive button; focus lost on close | C   | Tab escaped; Enter could confirm | Focus trap, initial focus on Cancel, focus return | Unit tests (8)     | Fixed  |
| Layout          | No skip link; aside unlabeled                                          | M   | —                                | Skip link, `aria-label="Admin"`                   | Manual             | Fixed  |
| CSS             | No visible focus indicator                                             | M   | Browser default/removed          | `:focus-visible` outline + skip-link styles       | Manual             | Fixed  |
| Tables          | `th` without scope                                                     | m   | Implicit only                    | `scope="col"` on all 69 headers                   | Manual             | Fixed  |
| Row actions     | Ambiguous names ("View" × N)                                           | M   | —                                | `aria-label` with entity name                     | Unit tests updated | Fixed  |
| Commerce tabs   | Not exposed as tabs                                                    | m   | Plain buttons                    | `tablist`/`tab`/`aria-selected`                   | Manual             | Fixed  |
| Pagination      | Not a landmark                                                         | m   | `<div>`                          | `<nav aria-label="Pagination">`                   | Manual             | Fixed  |

## Manual verification matrices

These matrices define the required manual pass. The sandbox cannot run
VoiceOver/TalkBack or a physical device; each item must be checked on a
real device before release. Status: **not yet performed** (sandbox
limitation — see "Limitations").

### VoiceOver (iOS)

| #   | Scenario                     | Expected                                                   | Status  |
| --- | ---------------------------- | ---------------------------------------------------------- | ------- |
| V1  | Launch → tab through home    | All sections reachable, coherent names                     | Pending |
| V2  | Play a track                 | Hears "Now playing: {title} by {artist}"                   | Pending |
| V3  | Seek via rotor/actions       | Hears formatted position/duration                          | Pending |
| V4  | Background the app           | Lock-screen controls reflect metadata                      | Pending |
| V5  | Download a track, background | Hears "Download complete…" on finish                       | Pending |
| V6  | Open report dialog           | Focus enters modal; background silent                      | Pending |
| V7  | Checkout form                | Every field has visible + spoken label, required announced | Pending |
| V8  | Join a room                  | Status changes announced; progress readable, not chatty    | Pending |
| V9  | Dynamic Type at largest      | No clipped text, no broken layout                          | Pending |
| V10 | Reduce Motion on             | Modals appear without animation                            | Pending |

### TalkBack (Android)

| #   | Scenario                    | Expected                                   | Status  |
| --- | --------------------------- | ------------------------------------------ | ------- |
| T1  | Linear navigation of player | Controls in logical order with states      | Pending |
| T2  | SeekBar actions             | "Swipe up/down to adjust" announces values | Pending |
| T3  | Form validation             | Errors announced assertively on submit     | Pending |
| T4  | Download completion         | Announcement fires once                    | Pending |
| T5  | Modal dialogs               | `accessibilityViewIsModal` contains focus  | Pending |

### Keyboard-only (admin web)

| #   | Scenario                              | Expected                                | Status  |
| --- | ------------------------------------- | --------------------------------------- | ------- |
| K1  | Tab through sidebar → content         | Skip link first, logical order          | Pending |
| K2  | Open confirm dialog, Tab              | Focus trapped; starts on Cancel         | Pending |
| K3  | Escape in dialog                      | Dialog closes, focus returns to trigger | Pending |
| K4  | Operate all tables/filters/pagination | All reachable and operable              | Pending |
| K5  | Focus visibility                      | Clear outline on every control          | Pending |

### Web screen reader (admin)

| #   | Scenario     | Expected                          | Status  |
| --- | ------------ | --------------------------------- | ------- |
| W1  | Landmarks    | Banner/nav/main identified        | Pending |
| W2  | Tables       | Column headers announced per cell | Pending |
| W3  | Row actions  | "View album {title}" unambiguous  | Pending |
| W4  | Async states | Loading/errors announced          | Pending |

## Limitations

- **No physical screen-reader validation.** The sandbox has no iOS/Android
  device, no VoiceOver/TalkBack, and no desktop screen reader. All
  semantics were verified via automated tests and code inspection only.
- **CarPlay / Android Auto:** accessibility is provided by the native
  templates (standard list/now-playing UI). The JS layer supplies
  titles/subtitles. No head-unit validation performed.
- **WebGL/canvas:** the analytics trend chart (mobile) is canvas-drawn;
  its data is also available as text (stat cards, top lists).
- Truncation with `numberOfLines` is used in lists; full content is always
  one tap away on a detail screen.
