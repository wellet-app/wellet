/* ============================================================
 * Wellet Internal Timeline Audit Dashboard
 * ============================================================
 * NOT caregiver-facing. Mounted only when:
 *   - URL contains ?debug=timeline-cards
 *   - localStorage.WELLET_INTERNAL === '1'
 *
 * Renders a full-screen overlay with:
 *   A. Fixtures grid — 15 hardcoded sample events covering every
 *      source type the Timeline supports. Each row shows the
 *      resolved onclick string + source pill side by side, and
 *      has a "Fire" button that actually invokes the onclick so
 *      you can verify the destination in production.
 *   B. Live-data audit — scans liveEvents for the current loved
 *      one (when a person is selected and timeline data is
 *      loaded), groups by source type, and flags two failure
 *      modes Betsy specifically called out:
 *        - Orphan EHR rows (source='ehr', no connection_id,
 *          no _hospital_name)  → pills as "From your records",
 *          may indicate a broken provenance join
 *        - Missing refId on voice/document/ehr rows → these
 *          fall back to edit modal or Records hub instead of
 *          their proper deep-link
 *
 * Voice rule: brief, no exclamation points, no emojis.
 * ============================================================ */

(function() {
  'use strict';

  // ── Gating ──────────────────────────────────────────────────
  function shouldMount() {
    try {
      var qp = new URLSearchParams(window.location.search || '');
      if (qp.get('debug') !== 'timeline-cards') return false;
      if (window.localStorage && window.localStorage.WELLET_INTERNAL !== '1') {
        // Print a hint to the console so a curious developer can flip it on.
        console.info(
          '[wellet-internal] timeline-cards dashboard gated. ' +
          'Run: localStorage.WELLET_INTERNAL = "1"; then reload.'
        );
        return false;
      }
      return true;
    } catch (_e) {
      return false;
    }
  }

  // ── Fixtures: one event of every source type ────────────────
  // Order chosen to mirror the smoke test, so a reader can scan
  // this list and the smoke test output side by side.
  var FIXTURES = [
    {
      name: 'voice + refId',
      ev: { id: 'fx-voice-1', source: 'voice', _refId: 'voice-abc123',
            event_type: 'note', title: 'Voice note · clinic visit',
            event_date: '2026-06-22', notes: 'recorded after Wednesday appointment' }
    },
    {
      name: 'voice (no refId)',
      ev: { id: 'fx-voice-2', source: 'voice',
            event_type: 'note', title: 'Voice note · no ref',
            event_date: '2026-06-21', notes: 'expected: falls back to edit modal' }
    },
    {
      name: 'document + refId',
      ev: { id: 'fx-doc-1', source: 'document', _refId: 'doc-after-visit',
            event_type: 'document', title: 'After-visit summary',
            event_date: '2026-06-20' }
    },
    {
      name: 'care_circle',
      ev: { id: 'fx-cc-1', source: 'care_circle',
            event_type: 'note', title: 'Marcus added a note',
            event_date: '2026-06-20' }
    },
    {
      name: 'share',
      ev: { id: 'fx-share-1', source: 'share',
            event_type: 'note', title: 'You shared the summary with Sarah',
            event_date: '2026-06-19' }
    },
    {
      name: 'care_signal v1',
      ev: { id: 'fx-cs1-1', source: 'care_signal',
            event_type: 'note', title: 'Wellet noticed: blood pressure trend',
            _caresignal_chip: 'Apple Health',
            event_date: '2026-06-19', notes: 'Three readings above your usual range.' }
    },
    {
      name: 'care_signal v2 (attention)',
      ev: { id: 'fx-cs2-1', source: 'care_signal', _caresignal_v2: true,
            _caresignal_v2_severity: 'attention',
            _caresignal_v2_sources: ['Medications', 'Apple Health'],
            _caresignal_v2_occurrence: 3,
            event_type: 'note', title: 'Medication gap pattern',
            event_date: '2026-06-18' }
    },
    {
      name: 'med_log',
      ev: { id: 'fx-med-1', source: 'med_log',
            event_type: 'medication', title: 'Logged: lisinopril 10mg',
            event_date: '2026-06-22' }
    },
    {
      name: 'check_in',
      ev: { id: 'fx-ci-1', source: 'check_in',
            event_type: 'note', title: 'Daily check-in',
            event_date: '2026-06-22' }
    },
    {
      name: 'manual note',
      ev: { id: 'fx-manual-1', source: 'manual', entered_by: 'user',
            event_type: 'note', title: 'Mom mentioned dizziness',
            event_date: '2026-06-21' }
    },
    {
      name: 'EHR lab (Duke)',
      ev: { id: 'fx-ehr-lab', source: 'ehr', event_type: 'lab_result',
            _refId: 'lab-9', _hospital_name: 'Duke', connection_id: 'conn-duke',
            title: 'Hemoglobin A1c · 6.1', event_date: '2026-06-15' }
    },
    {
      name: 'EHR medication (orphan provenance)',
      ev: { id: 'fx-ehr-med', source: 'ehr', event_type: 'medication',
            _refId: 'med-2', title: 'Atorvastatin 20mg',
            event_date: '2026-06-12' }
    },
    {
      name: 'EHR appointment (no provider)',
      ev: { id: 'fx-ehr-appt', source: 'ehr', event_type: 'appointment',
            _refId: 'enc-4', connection_id: null,
            title: 'Cardiology follow-up', event_date: '2026-06-26' }
    },
    {
      name: 'EHR unknown event_type',
      ev: { id: 'fx-ehr-weird', source: 'ehr', event_type: 'something_weird',
            _refId: 'x', title: 'Unknown EHR row',
            event_date: '2026-06-10' }
    },
    {
      name: 'manual_visit (ER)',
      ev: { id: 'fx-mv-1', source: 'manual_visit', manual_service_type: 'er',
            event_type: 'visit', title: 'Outside ER visit',
            event_date: '2026-06-05' }
    }
  ];

  // ── Quality flags for fixtures + live rows ──────────────────
  function qualityFlags(ev) {
    var flags = [];
    if (ev.source === 'ehr') {
      var hasName = !!(ev._hospital_name || ev._ehrProvider);
      var hasConn = !!ev.connection_id;
      if (!hasName && !hasConn) flags.push('orphan-ehr');
    }
    if ((ev.source === 'voice' || ev.source === 'document' || ev.source === 'ehr')
        && !ev._refId) {
      flags.push('missing-refId');
    }
    return flags;
  }

  function flagBadgeHtml(flags) {
    if (!flags.length) return '<span class="iaud-ok">clean</span>';
    return flags.map(function(f) {
      return '<span class="iaud-flag iaud-flag-' + f + '">' + f + '</span>';
    }).join(' ');
  }

  // ── Pretty-print a resolved onclick string ──────────────────
  function prettyClick(clickAttr) {
    if (!clickAttr) return '<em>no onclick (intentional)</em>';
    // The helper returns ' onclick="..." style="..."' — strip leading space.
    return escHtmlSafe(clickAttr.replace(/^\s+/, ''));
  }

  function escHtmlSafe(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Extract callable handler from an onclick attribute ──────
  // Example input: ' onclick="openTimelineItem(\'labs\',\'lab-9\')" style="cursor:pointer;"'
  // We yank the inner JS and Function() it, then invoke.
  function fireOnclick(clickAttr) {
    if (!clickAttr) {
      return { ok: false, error: 'no onclick on this card (intentional for share)' };
    }
    var m = clickAttr.match(/onclick="([^"]+)"/);
    if (!m) return { ok: false, error: 'could not parse onclick attribute' };
    var jsBody = m[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    try {
      // Run in global scope so openTimelineItem/switchView/etc. resolve.
      // eslint-disable-next-line no-new-func
      (new Function(jsBody))();
      return { ok: true, fired: jsBody };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err), fired: jsBody };
    }
  }

  // ── Live-data audit ─────────────────────────────────────────
  function scanLiveData() {
    // Both are module-level vars in wellet.js, not on window. Access via
    // the global eval-scope; if they're not in scope yet (page just loaded,
    // no person selected) we degrade gracefully.
    var events = null;
    var personId = null;
    try { events = (typeof liveEvents !== 'undefined') ? liveEvents : null; } catch (_e) {}
    try { personId = (typeof currentPersonId !== 'undefined') ? currentPersonId : null; } catch (_e) {}

    if (!events) {
      return { ok: false, reason: 'liveEvents not in scope. Open the app, select a loved one, then reload with ?debug=timeline-cards.' };
    }
    if (!events.length) {
      return { ok: true, personId: personId, total: 0, bySource: {}, flagged: [] };
    }

    var bySource = {};
    var flagged = [];
    events.forEach(function(ev) {
      var src = ev.source || '(no source)';
      bySource[src] = (bySource[src] || 0) + 1;
      var flags = qualityFlags(ev);
      if (flags.length) {
        flagged.push({
          id: ev.id,
          source: src,
          event_type: ev.event_type,
          title: ev.title,
          event_date: ev.event_date,
          flags: flags,
          connection_id: ev.connection_id || null,
          _hospital_name: ev._hospital_name || null,
          _refId: ev._refId || null
        });
      }
    });

    return { ok: true, personId: personId, total: events.length, bySource: bySource, flagged: flagged };
  }

  // ── Style block ─────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('iaud-styles')) return;
    var css = ''
      + '#iaud-overlay { position: fixed; inset: 0; z-index: 99999; '
      +   'background: #FAF8F3; color: #1A1816; overflow-y: auto; '
      +   'font-family: "Public Sans", system-ui, sans-serif; }'
      + '#iaud-overlay header { position: sticky; top: 0; background: #11443B; '
      +   'color: #E8E6E0; padding: 14px 20px; display: flex; align-items: center; '
      +   'gap: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }'
      + '#iaud-overlay header h1 { font-family: Gambetta, Georgia, serif; '
      +   'font-size: 20px; font-weight: 500; margin: 0; letter-spacing: 0.01em; }'
      + '#iaud-overlay header .iaud-sub { font-size: 12px; opacity: 0.75; }'
      + '#iaud-overlay header .iaud-close { margin-left: auto; background: transparent; '
      +   'border: 1px solid rgba(232,230,224,0.4); color: #E8E6E0; padding: 6px 12px; '
      +   'border-radius: 6px; font-size: 12px; cursor: pointer; }'
      + '#iaud-overlay .iaud-section { max-width: 1100px; margin: 0 auto; padding: 24px 20px; }'
      + '#iaud-overlay .iaud-section h2 { font-family: Gambetta, Georgia, serif; '
      +   'font-size: 22px; font-weight: 500; margin: 0 0 4px 0; color: #11443B; }'
      + '#iaud-overlay .iaud-section .iaud-section-sub { color: #5F5A52; font-size: 13px; margin-bottom: 16px; }'
      + '#iaud-overlay table.iaud-grid { width: 100%; border-collapse: collapse; '
      +   'background: #FFFFFF; border-radius: 12px; overflow: hidden; '
      +   'box-shadow: 0 1px 2px rgba(22,19,18,0.04), 0 6px 18px rgba(22,19,18,0.04); '
      +   'font-size: 12px; }'
      + '#iaud-overlay table.iaud-grid th { text-align: left; padding: 10px 12px; '
      +   'background: #F0EDE5; color: #5F5A52; font-weight: 600; letter-spacing: 0.04em; '
      +   'text-transform: uppercase; font-size: 11px; border-bottom: 1px solid #DAD6CB; }'
      + '#iaud-overlay table.iaud-grid td { padding: 10px 12px; border-bottom: 1px solid #F0EDE5; '
      +   'vertical-align: top; }'
      + '#iaud-overlay table.iaud-grid tr:last-child td { border-bottom: none; }'
      + '#iaud-overlay .iaud-name { font-weight: 600; color: #11443B; }'
      + '#iaud-overlay .iaud-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; '
      +   'font-size: 11px; font-weight: 500; }'
      + '#iaud-overlay .iaud-click { font-family: ui-monospace, "SF Mono", Menlo, monospace; '
      +   'font-size: 11px; color: #1A1816; word-break: break-all; }'
      + '#iaud-overlay .iaud-flag { display: inline-block; padding: 2px 8px; border-radius: 4px; '
      +   'font-size: 10px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }'
      + '#iaud-overlay .iaud-flag-orphan-ehr { background: #FAEDE5; color: #B8392B; }'
      + '#iaud-overlay .iaud-flag-missing-refId { background: #FFF4D6; color: #8A6A00; }'
      + '#iaud-overlay .iaud-ok { display: inline-block; padding: 2px 8px; border-radius: 4px; '
      +   'background: #E6F2DE; color: #2C5E1F; font-size: 10px; font-weight: 600; '
      +   'letter-spacing: 0.04em; text-transform: uppercase; }'
      + '#iaud-overlay button.iaud-fire { background: #11443B; color: #E8E6E0; border: none; '
      +   'padding: 6px 12px; border-radius: 6px; font-size: 11px; font-weight: 600; '
      +   'cursor: pointer; letter-spacing: 0.02em; }'
      + '#iaud-overlay button.iaud-fire:hover { background: #0E3A33; }'
      + '#iaud-overlay button.iaud-fire:disabled { background: #B8C9CE; cursor: not-allowed; }'
      + '#iaud-overlay .iaud-fire-result { font-size: 11px; margin-top: 6px; }'
      + '#iaud-overlay .iaud-fire-ok { color: #2C5E1F; }'
      + '#iaud-overlay .iaud-fire-err { color: #B8392B; }'
      + '#iaud-overlay .iaud-summary-grid { display: grid; '
      +   'grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; '
      +   'margin-bottom: 16px; }'
      + '#iaud-overlay .iaud-stat { background: #FFFFFF; border: 1px solid #DAD6CB; '
      +   'border-radius: 8px; padding: 10px 12px; }'
      + '#iaud-overlay .iaud-stat-label { font-size: 10px; color: #5F5A52; '
      +   'text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }'
      + '#iaud-overlay .iaud-stat-value { font-family: Gambetta, Georgia, serif; '
      +   'font-size: 22px; color: #11443B; }'
      + '#iaud-overlay .iaud-empty { padding: 24px; text-align: center; color: #5F5A52; '
      +   'background: #FFFFFF; border-radius: 12px; font-style: italic; }'
      + '';
    var style = document.createElement('style');
    style.id = 'iaud-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── Render: fixtures grid ───────────────────────────────────
  function renderFixturesGrid() {
    if (typeof window._tlClickAttrForEvent !== 'function' ||
        typeof window._tlSourcePillForEvent !== 'function') {
      return '<div class="iaud-empty">Timeline helpers not loaded. ' +
             'wellet.js may not have parsed yet.</div>';
    }
    var rows = FIXTURES.map(function(fx, idx) {
      var ev = fx.ev;
      var click = window._tlClickAttrForEvent(ev);
      var pill = window._tlSourcePillForEvent(ev);
      var flags = qualityFlags(ev);
      var pillHtml = '<span class="iaud-pill" style="color:' + pill.color + ';' + pill.style + '">'
                  + escHtmlSafe(pill.label) + '</span>';
      return '<tr data-fx-idx="' + idx + '">'
        + '<td><div class="iaud-name">' + escHtmlSafe(fx.name) + '</div>'
        +   '<div style="font-size:11px;color:#5F5A52;margin-top:2px;">'
        +   escHtmlSafe(ev.title || '') + '</div></td>'
        + '<td>' + pillHtml + '</td>'
        + '<td><code class="iaud-click">' + prettyClick(click) + '</code></td>'
        + '<td>' + flagBadgeHtml(flags) + '</td>'
        + '<td><button class="iaud-fire" data-fx-idx="' + idx + '">Fire</button>'
        +     '<div class="iaud-fire-result" data-fire-result="' + idx + '"></div></td>'
        + '</tr>';
    }).join('');
    return ''
      + '<table class="iaud-grid">'
      +   '<thead><tr>'
      +     '<th style="width:25%;">Fixture</th>'
      +     '<th style="width:15%;">Pill</th>'
      +     '<th style="width:35%;">Resolved onclick</th>'
      +     '<th style="width:12%;">Quality</th>'
      +     '<th style="width:13%;">Action</th>'
      +   '</tr></thead>'
      +   '<tbody>' + rows + '</tbody>'
      + '</table>';
  }

  // ── Render: live-data audit ─────────────────────────────────
  function renderLiveAudit() {
    var scan = scanLiveData();
    if (!scan.ok) {
      return '<div class="iaud-empty">' + escHtmlSafe(scan.reason) + '</div>';
    }
    if (scan.total === 0) {
      return '<div class="iaud-empty">No timeline events loaded for the current loved one.</div>';
    }
    var stats = '<div class="iaud-summary-grid">'
      + '<div class="iaud-stat"><div class="iaud-stat-label">Total events</div>'
      +   '<div class="iaud-stat-value">' + scan.total + '</div></div>'
      + '<div class="iaud-stat"><div class="iaud-stat-label">Flagged</div>'
      +   '<div class="iaud-stat-value" style="color:' + (scan.flagged.length ? '#B8392B' : '#11443B') + ';">'
      +   scan.flagged.length + '</div></div>'
      + Object.keys(scan.bySource).sort().map(function(src) {
          return '<div class="iaud-stat"><div class="iaud-stat-label">'
            + escHtmlSafe(src) + '</div>'
            + '<div class="iaud-stat-value">' + scan.bySource[src] + '</div></div>';
        }).join('')
      + '</div>';

    var flaggedTable;
    if (!scan.flagged.length) {
      flaggedTable = '<div class="iaud-empty">No quality flags. Every row has either a connection_id+hospital name (for EHR) or a valid refId.</div>';
    } else {
      var rows = scan.flagged.map(function(f) {
        return '<tr>'
          + '<td><div class="iaud-name">' + escHtmlSafe(f.title || '(no title)') + '</div>'
          +   '<div style="font-size:11px;color:#5F5A52;">' + escHtmlSafe(f.event_type || '') + ' · '
          +   escHtmlSafe(f.event_date || '') + '</div></td>'
          + '<td>' + escHtmlSafe(f.source) + '</td>'
          + '<td>' + flagBadgeHtml(f.flags) + '</td>'
          + '<td><code class="iaud-click">' + escHtmlSafe(f.id || '') + '</code></td>'
          + '<td><code class="iaud-click">conn=' + escHtmlSafe(String(f.connection_id))
          +   ' · hosp=' + escHtmlSafe(String(f._hospital_name))
          +   ' · refId=' + escHtmlSafe(String(f._refId)) + '</code></td>'
          + '</tr>';
      }).join('');
      flaggedTable = '<table class="iaud-grid">'
        + '<thead><tr><th>Event</th><th>Source</th><th>Flags</th><th>id</th><th>Provenance</th></tr></thead>'
        + '<tbody>' + rows + '</tbody></table>';
    }

    return stats + flaggedTable;
  }

  // ── Mount ───────────────────────────────────────────────────
  function mount() {
    if (document.getElementById('iaud-overlay')) return;
    injectStyles();
    var root = document.createElement('div');
    root.id = 'iaud-overlay';
    root.innerHTML = ''
      + '<header>'
      +   '<h1>Timeline audit</h1>'
      +   '<span class="iaud-sub">internal · gated by ?debug=timeline-cards + WELLET_INTERNAL</span>'
      +   '<button class="iaud-close" type="button">Close</button>'
      + '</header>'
      + '<div class="iaud-section">'
      +   '<h2>A. Fixtures — every source type</h2>'
      +   '<div class="iaud-section-sub">Resolved onclick and pill for each fixture. ' +
            'Fire button invokes the real onclick so you can confirm the destination opens.</div>'
      +   '<div id="iaud-fixtures">' + renderFixturesGrid() + '</div>'
      + '</div>'
      + '<div class="iaud-section">'
      +   '<h2>B. Live data audit</h2>'
      +   '<div class="iaud-section-sub">Scans liveEvents for the current loved one. ' +
            'Flags: orphan EHR rows (no connection_id, no hospital name) and missing refId on voice/document/ehr rows.</div>'
      +   '<div id="iaud-live">' + renderLiveAudit() + '</div>'
      +   '<div style="margin-top:12px;"><button class="iaud-fire" id="iaud-rescan">Re-scan live data</button></div>'
      + '</div>';
    document.body.appendChild(root);

    // Wire close
    root.querySelector('.iaud-close').addEventListener('click', function() {
      var qp = new URLSearchParams(window.location.search || '');
      qp.delete('debug');
      var newSearch = qp.toString();
      window.location.search = newSearch ? '?' + newSearch : '';
    });

    // Wire re-scan
    root.querySelector('#iaud-rescan').addEventListener('click', function() {
      document.getElementById('iaud-live').innerHTML = renderLiveAudit();
    });

    // Wire fire buttons
    root.querySelectorAll('button.iaud-fire[data-fx-idx]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var idx = parseInt(btn.getAttribute('data-fx-idx'), 10);
        var ev = FIXTURES[idx].ev;
        var click = window._tlClickAttrForEvent(ev);
        var result = fireOnclick(click);
        var msgEl = root.querySelector('[data-fire-result="' + idx + '"]');
        if (!msgEl) return;
        if (result.ok) {
          msgEl.innerHTML = '<span class="iaud-fire-ok">fired: ' + escHtmlSafe(result.fired) + '</span>';
        } else {
          msgEl.innerHTML = '<span class="iaud-fire-err">' + escHtmlSafe(result.error) + '</span>'
            + (result.fired ? '<br><span style="color:#5F5A52;">attempted: ' + escHtmlSafe(result.fired) + '</span>' : '');
        }
      });
    });
  }

  // ── Init ────────────────────────────────────────────────────
  function init() {
    if (!shouldMount()) return;
    // Wait for wellet.js to define the helpers on window. They're defined
    // as plain function declarations, so we re-expose them here defensively.
    function tryExposeHelpers() {
      // Pull from global scope (function declarations land on globalThis in browsers).
      try {
        if (typeof _tlClickAttrForEvent === 'function' && !window._tlClickAttrForEvent) {
          window._tlClickAttrForEvent = _tlClickAttrForEvent;
        }
      } catch (_e) {}
      try {
        if (typeof _tlSourcePillForEvent === 'function' && !window._tlSourcePillForEvent) {
          window._tlSourcePillForEvent = _tlSourcePillForEvent;
        }
      } catch (_e) {}
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        tryExposeHelpers();
        // Small delay so wellet.js init completes.
        setTimeout(function() { tryExposeHelpers(); mount(); }, 400);
      });
    } else {
      tryExposeHelpers();
      setTimeout(function() { tryExposeHelpers(); mount(); }, 400);
    }
  }

  init();
})();
