# currentPersonId Audit — wellet.js
**Date:** 2025-05-13 (overnight pass)  
**Reviewer:** Automated audit per Betsy's request  
**Scope:** Read-only. No fixes shipped. Findings only.

---

## Summary

`currentPersonId` is a module-level `var` (line 63). It is set through `setCurrentPersonId()` (line 65) and directly mutated in two edge-case spots (lines 3189, 7744, 7901). The 3fe00b4 switcher commit added `switchToRealPerson()` which calls `loadPersonData()` + a view-specific re-render block. The critical question is: **which render functions read `currentPersonId` without being called inside that re-render block?**

---

## The switcher re-render block (3fe00b4 — lines 1894–1915)

`switchToRealPerson()` calls, in order:
1. `loadPersonData(personId)` — refreshes all live* arrays and sets `currentPersonId`
2. `renderUpdateMe()`
3. `renderTimeline()`
4. `renderPatterns()`
5. View-specific: `renderSignalsView()` / `renderRecordsView()` / `renderResourcesView()` / `renderPeopleView()` / `renderAskView()` — whichever is currently visible

---

## currentPersonId Usage Table

| # | Line(s) | Function | What it paints / does | In switcher re-render? | Severity |
|---|---------|----------|-----------------------|------------------------|----------|
| 1 | 1997–2029 | `updateHeaderSyncMeta()` | Header "Updated X ago" chip | **No** — not called from `switchToRealPerson` | **Critical** — after a switch the header still shows the previous person's sync timestamp |
| 2 | 2189–2430 | `renderUpdateMe()` | Full home-view card (name, summary, patterns, right-now line, banners) | **Yes** — called directly | ✅ No-op / covered |
| 3 | 2806–2812 | `firePatternAlertNotif()` | Alert key namespacing + notification insert | **No** — called from a polling loop, not the switcher | Minor — alert dedup key uses old person's ID if polling fires during switch; race window is small |
| 4 | 2903 | `renderTimeline()` | Timeline items from `liveEvents`/`liveMeds` | **Yes** — called directly | ✅ No-op / covered |
| 5 | 3976–3989 | `loadVisitSummary(encId, domId)` | Visit summary panel inside a detail overlay | **No** — called only when user opens an overlay | No-op — overlay is dismissed on switch; user must reopen |
| 6 | 4033–4068 | `openEhrDocument(encId, docId)` | Document viewer upload payload | **No** — called on user tap | No-op — overlay is dismissed on switch |
| 7 | 4698 | `openRecordsDetail(section)` | Records detail drawer (passes `currentPersonId` into `_rdDocsContent`) | **No** — called on user tap | No-op — drawer is dismissed on switch |
| 8 | 4730, 4928, 5034, 5104 | `openRecordsDetail()`, `openLabDetail()`, `openConditionDetail()`, `renderRecordsView()` | Records/labs/conditions sections | `renderRecordsView()` **Yes** (view-specific block) | ✅ Covered for the render; tap-opened overlays are no-ops |
| 9 | 5522–5579 | `renderRecordsView()` | Connect-screen status cards + Terra connections loader | **Yes** — view-specific block | ✅ No-op / covered |
| 10 | 5683–5694 | `toggleRecordSection()` | Collapse/expand state per section | **No** — called on user tap | No-op — section state is keyed by person so stale reads are harmless |
| 11 | 1481–1544 | `refreshConnectScreenStatus()` | Connect-screen card tick-marks (EHR, Apple, Terra) | **No** — called from a polling timer and from connect-callback | Minor — if the polling timer fires just after a switch, it may briefly show the wrong person's connection states on the Connect screen |
| 12 | 1675–1686 | `connectAppleHealth()` | Builds deep-link URL with `person_id=` | **No** — called on user tap | No-op — user must tap; if they tap immediately after switch it will use the newly-set ID |
| 13 | 8763–8799 | `renderSignalsView()` | CareSignals tiles (Terra data, Apple Health rhythm) | **Yes** — view-specific block | ✅ No-op / covered |
| 14 | 8549, 8563 | `(onboarding finish)` | `autoRefreshEhrIfNeeded(currentPersonId)` called from onboarding | **No** — onboarding code path; switcher never runs during onboarding | No-op |
| 15 | 6633–6709 | `addExtractedItem()`, `addAllExtractedFromOverlay()` | Document-extraction reconcile (meds / events) | **No** — called from overlay buttons | No-op — overlay is tied to the person it was opened for |
| 16 | 6889 | `startHealthImport()` | Captures `var personId = currentPersonId` at invocation time | **No** — triggered by user tap | No-op — captured correctly at tap time |
| 17 | 7199 | `openAddEvent(personId)` | Falls back to `currentPersonId` if no personId arg | **No** — user tap | No-op — called immediately after switch would use correct ID |
| 18 | 7216 | `submitHealthEvent()` | Reads `overlay.dataset.personId \|\| currentPersonId` | **No** — user form submit | No-op — overlay carries its own personId in dataset |
| 19 | 7315, 7356 | `openAddMed()`, `submitMedication()` | Looks up person name, submits med to `currentPersonId` | **No** — user tap / submit | No-op — overlay is re-opened after a switch |
| 20 | 3188–3190 | `removePersonCard()` (person delete) | Directly mutates `currentPersonId = currentPeople[0].id` then calls `loadPersonData` | **No** — delete path, not switcher | Minor — bypasses `setCurrentPersonId()`, so `localStorage` key not updated; also skips `evaluateReconnectBanner()` |
| 21 | 7744 | `(onboarding finish)` | Directly mutates `currentPersonId = data.id` | Onboarding path | Minor — same pattern as #20: direct write skips `setCurrentPersonId()` side-effects |
| 22 | 7901 | `(onboarding restore)` | Directly mutates `currentPersonId = obChat.personId` | Onboarding path | Minor — same as above |

---

## Critical Findings (ship-blockers, Betsy's call)

### CRIT-1 — `updateHeaderSyncMeta()` not wired to the switcher (line 1997)
**Problem:** After switching from Person A to Person B, the header still shows "Updated 3 hr ago" for Person A until something else triggers a refresh. There is no call to `updateHeaderSyncMeta()` anywhere inside `switchToRealPerson()`.  
**Why it matters:** The header freshness chip is a trust signal. Showing the wrong person's EHR timestamp after a switch is misleading.

---

## Minor Findings

### MINOR-1 — `removePersonCard()` direct mutation (line 3189)
`currentPersonId = currentPeople[0].id` bypasses `setCurrentPersonId()`, so:
- `localStorage.wellet_last_person_id` is not updated.
- `evaluateReconnectBanner()` is not called.

The next reload will restore the deleted person's ID from localStorage (stale), causing `loadPersonData` to 404 on Supabase until the app boots again.

### MINOR-2 — Onboarding direct mutations (lines 7744, 7901)
Same pattern: direct mutation bypasses `setCurrentPersonId()` side-effects. Low risk in practice because onboarding only runs once per user, but inconsistent.

### MINOR-3 — `refreshConnectScreenStatus()` polling + `firePatternAlertNotif()` race
Both use the module-level `currentPersonId` from a timer/polling closure. The race window is small (milliseconds), but technically a switch mid-poll would use the wrong ID for one cycle.

---

## No-ops (confirmed safe)

All tap-triggered overlay functions (`loadVisitSummary`, `openEhrDocument`, `openRecordsDetail`, `openAddEvent`, `submitHealthEvent`, `openAddMed`, `submitMedication`, `addExtractedItem`, `addAllExtractedFromOverlay`) read `currentPersonId` only at invocation time. Since overlays are universally dismissed on a person switch before the user can tap anything inside them, these are safe.

`renderPatterns()` reads only `liveEvents` and `liveMeds` (populated by `loadPersonData`), not `currentPersonId` directly — it is implicitly refreshed by the switcher's `loadPersonData` call.

---

## Recommended diff for Betsy's morning review

```diff
// In switchToRealPerson(), after the view-specific re-render block (~line 1915):

+  // Refresh the header sync chip for the new person
+  try { updateHeaderSyncMeta(); } catch (_e) {}
```

```diff
// In removePersonCard(), replace the direct mutation (~line 3188):
-  if (currentPersonId === _cardToRemoveId && currentPeople.length > 0) {
-    currentPersonId = currentPeople[0].id;
-    await loadPersonData(currentPersonId);
+  if (currentPersonId === _cardToRemoveId && currentPeople.length > 0) {
+    setCurrentPersonId(currentPeople[0].id);
+    await loadPersonData(currentPersonId);
```

The onboarding direct mutations (lines 7744, 7901) are lower priority — recommend reviewing in the next onboarding refactor rather than a hotfix.

---
*Audit is read-only. No code was modified. Betsy should verify and ship the recommended diff herself.*
