// ── WELLET GUIDED DEMO ─────────────────────────────────────────────────────
// Self-playing walkthrough triggered by ?demo=guided
// Plays narration audio (ElevenLabs), shows captions, navigates the app
// Scroll-aware, audio-driven timing, end card overlay

if (new URLSearchParams(window.location.search).get('demo') === 'guided') {

  var _gd = {
    currentStep: -1,
    isPaused: false,
    audio: null,
    timer: null,
    typeInterval: null,
    captionInterval: null,
    started: false
  };

  // ── STEPS ──
  // duration = fallback if audio missing. With audio, auto-advances when clip ends + 800ms pause.
  var guidedSteps = [
    // 0 — INTRO (auth screen visible)
    {
      audio: '00-intro.mp3',
      caption: 'This is Wellet — a health companion for family caregivers. Let me show you how it works.',
      duration: 5500,
      action: function() { /* auth screen stays visible */ }
    },
    // 1 — Enter demo, land on Update Me
    {
      audio: '01-enter-demo.mp3',
      caption: 'We\'ll start with Dad\'s care view. His health data is already here — pulled from his EHR, his Apple Watch, and home sensors.',
      duration: 6500,
      action: function() {
        enterDemoMode();
        switchNavTo('home');
        document.querySelectorAll('.tab')[0].click();
        gdScrollTo('#tab-update .update-card', 200);
      }
    },
    // 2 — Summary highlight
    {
      audio: '02-update-me.mp3',
      caption: 'Summary is your home base. A plain-English summary of what\'s happening right now — no jargon, no portal-hopping.',
      duration: 7500,
      action: function() {
        switchNavTo('home');
        document.querySelectorAll('.tab')[0].click();
        gdHighlight('#tab-update .update-card');
        gdScrollTo('#tab-update .update-card', 100);
      }
    },
    // 3 — Timeline
    {
      audio: '03-timeline.mp3',
      caption: 'The Timeline shows everything in order — appointments, labs, medication changes, your own notes. Never reconstruct from memory again.',
      duration: 7500,
      action: function() {
        gdClearHighlight();
        document.querySelectorAll('.tab')[1].click();
        gdScrollTo('#tab-timeline', 100);
      }
    },
    // 4 — Patterns
    {
      audio: '04-patterns.mp3',
      caption: 'Wellet watches for patterns — like how a medication change affected blood pressure, or whether sleep is getting worse.',
      duration: 7500,
      action: function() {
        document.querySelectorAll('.tab')[2].click();
        gdScrollTo('#tab-patterns', 100);
      }
    },
    // 5 — People
    {
      audio: '05-people.mp3',
      caption: 'Everyone involved in care, in one place. Doctors, specialists, family members — contact info and notes.',
      duration: 5500,
      action: function() {
        gdClearHighlight();
        switchNavTo('people');
        gdScrollTo('#view-people', 100);
      }
    },
    // 6 — Records
    {
      audio: '06-records.mp3',
      caption: 'Upload a photo of a prescription or discharge summary. Wellet reads it and files it automatically.',
      duration: 6500,
      action: function() {
        switchNavTo('records');
        gdScrollTo('#view-records', 100);
      }
    },
    // 7 — CareSignals
    {
      audio: '07-caresignals.mp3',
      caption: 'CareSignals brings in wearable data and home sensors. Dad\'s heart rate, steps, sleep — and the medicine cabinet opened at 8:12 this morning.',
      duration: 8500,
      action: function() {
        switchNavTo('signals');
        gdScrollTo('#view-signals', 100);
      }
    },
    // 8 — Ask Wellet intro
    {
      audio: '08-ask-intro.mp3',
      caption: 'And then there\'s Ask Wellet. Ask anything about your family member\'s health — in plain language.',
      duration: 5500,
      action: function() {
        switchNavTo('ask');
        // Clear any previous chat for a clean demo
        var chatArea = document.getElementById('chat-area');
        if (chatArea) {
          var bubbles = chatArea.querySelectorAll('.chat-group');
          // Keep only the first welcome message if present
          for (var i = bubbles.length - 1; i > 0; i--) bubbles[i].remove();
        }
        var chips = document.getElementById('suggestion-chips');
        if (chips) chips.style.display = 'flex';
      }
    },
    // 9 — Type question
    {
      audio: '09-ask-question.mp3',
      caption: '"Is Dad\'s blood pressure getting better since the medication change?"',
      duration: 6500,
      action: function() {
        var chips = document.getElementById('suggestion-chips');
        if (chips) chips.style.display = 'none';
        var input = document.getElementById('ask-input');
        if (input) {
          input.value = '';
          input.focus();
          gdTypeText(input, "Is Dad's blood pressure getting better since the medication change?", 55);
        }
      }
    },
    // 10 — Send + show AI response
    {
      audio: '10-ask-response.mp3',
      caption: 'Wellet knows the full picture — medications, labs, wearable data, sensor patterns — and answers with real context.',
      duration: 10000,
      action: function() {
        gdClearTypeInterval();
        // Make sure the full question is in the input before sending
        var input = document.getElementById('ask-input');
        if (input) input.value = "Is Dad's blood pressure getting better since the medication change?";
        sendAskMessage();
      }
    },
    // 10.5 — ER summary one-tap demo
    {
      audio: '10b-emergency.mp3',
      caption: 'And if you ever need it \u2014 one tap gets you the ER summary. Everything a doctor needs to treat the person you care for, in seconds.',
      duration: 9000,
      action: function() {
        gdClearHighlight();
        openEmergencySummary();
        setTimeout(function() {
          closeSheet('emergency-overlay');
        }, 8600);  // audio is 8385ms — keep overlay visible through narration
      }
    },
    // 11 — Closing with end card
    {
      audio: '11-closing.mp3',
      caption: '',
      duration: 10000,
      action: function() {
        gdClearHighlight();
        gdShowEndCard();
      }
    }
  ];

  // ── DEMO RESPONSE INJECTION (5A) ───────────────────────────────────────────────────────────────────────
  function gdInjectDemoResponse(text) {
    // Show typing dots immediately so it feels like Wellet is "thinking"
    var typingId = (typeof showTyping === 'function') ? showTyping() : null;
    // Reveal the response at ~3.5s — realistic thinking delay
    setTimeout(function() {
      if (typingId && typeof removeTyping === 'function') {
        removeTyping(typingId);
      }
      // Belt-and-suspenders: remove any leftover typing indicators
      var dots = document.querySelectorAll('.typing-dot');
      dots.forEach(function(el) {
        var bubble = el.closest('.chat-group');
        if (bubble) bubble.remove();
      });
      if (typeof addWelletMessage === 'function') {
        addWelletMessage(text);
      }
    }, 3500);
  }

  // Patch sendAskMessage to inject canned response in guided demo
  var _gd_origSendAskMessage = typeof sendAskMessage !== 'undefined' ? sendAskMessage : null;
  if (typeof sendAskMessage !== 'undefined') {
    var _gd_wrappedSendAsk = sendAskMessage;
    sendAskMessage = function() {
      if (new URLSearchParams(window.location.search).get('demo') === 'guided') {
        gdInjectDemoResponse(
          "Yes \u2014 and the trend is encouraging. Since the lisinopril increase on March 18, " +
          "Dad\u2019s average systolic has dropped from 148 to 132 over 18 days. His Oura readings " +
          "show resting HR also down 6 bpm. Two readings last week were still above 140, both " +
          "on days with poor sleep. Worth mentioning to Dr. Chen on Thursday."
        );
        // Still call original to show user message in chat
        var input = document.getElementById('ask-input');
        var text = input ? input.value.trim() : '';
        if (text && typeof addUserMessage === 'function') {
          if (input) input.value = '';
          addUserMessage(text);
        }
        return;
      }
      _gd_wrappedSendAsk.apply(this, arguments);
    };
  }

  // ── INJECT UI ──
  function gdInjectUI() {
    // Caption bar (above bottom nav, below app content)
    var cap = document.createElement('div');
    cap.id = 'guided-caption';
    cap.style.cssText = 'position:fixed;bottom:84px;left:50%;transform:translateX(-50%);'
      + 'max-width:600px;width:calc(100% - 40px);background:rgba(20,20,20,0.88);color:white;'
      + 'padding:14px 22px;border-radius:14px;font-family:"DM Sans",sans-serif;font-size:15px;'
      + 'line-height:1.55;text-align:center;z-index:99999;opacity:0;transition:opacity 0.4s ease;'
      + 'pointer-events:none;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);'
      + 'box-shadow:0 4px 24px rgba(0,0,0,0.3);';
    document.body.appendChild(cap);

    // Progress bar
    var prog = document.createElement('div');
    prog.id = 'guided-progress';
    prog.style.cssText = 'position:fixed;top:0;left:0;height:3px;background:linear-gradient(90deg,#608F7C,#8BB5A2);'
      + 'z-index:99999;transition:width 0.6s ease;width:0;box-shadow:0 0 8px rgba(96,143,124,0.4);';
    document.body.appendChild(prog);

    // Controls
    var ctrl = document.createElement('div');
    ctrl.id = 'guided-controls';
    ctrl.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);'
      + 'display:flex;gap:6px;z-index:99999;font-family:"DM Sans",sans-serif;';
    ctrl.innerHTML = ''
      + '<button onclick="gdPrev()" style="background:rgba(0,0,0,0.7);color:white;border:none;border-radius:10px;padding:8px 14px;font-size:12px;cursor:pointer;font-family:inherit;backdrop-filter:blur(8px);transition:background 0.2s;">← Back</button>'
      + '<button id="gd-pause-btn" onclick="gdTogglePause()" style="background:#608F7C;color:white;border:none;border-radius:10px;padding:8px 18px;font-size:12px;cursor:pointer;font-family:inherit;transition:background 0.2s;">⏸ Pause</button>'
      + '<button onclick="gdNext()" style="background:rgba(0,0,0,0.7);color:white;border:none;border-radius:10px;padding:8px 14px;font-size:12px;cursor:pointer;font-family:inherit;backdrop-filter:blur(8px);transition:background 0.2s;">Next →</button>'
      + '<button onclick="gdExit()" style="background:rgba(0,0,0,0.45);color:rgba(255,255,255,0.65);border:none;border-radius:10px;padding:8px 12px;font-size:12px;cursor:pointer;font-family:inherit;backdrop-filter:blur(8px);">✕</button>';
    document.body.appendChild(ctrl);

    // End card overlay (hidden)
    var ec = document.createElement('div');
    ec.id = 'guided-endcard';
    ec.style.cssText = 'position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;'
      + 'background:linear-gradient(160deg,#3A6152 0%,#4F7A68 40%,#608F7C 100%);'
      + 'font-family:"DM Sans",sans-serif;flex-direction:column;padding:40px 24px;text-align:center;'
      + 'opacity:0;transition:opacity 0.6s ease;';
    ec.innerHTML = ''
      + '<div style="margin-bottom:16px;">'
      + '  <img src="/wellet-logo-white.png" alt="Wellet" style="height:48px;" onerror="this.style.display=\'none\'">'
      + '</div>'
      + '<p style="color:rgba(255,255,255,0.7);font-size:16px;margin-bottom:32px;">Your health companion for caregivers</p>'
      + '<h2 style="font-family:\'DM Serif Display\',serif;font-size:clamp(32px,6vw,52px);color:white;font-weight:400;margin-bottom:40px;line-height:1.15;">See what Wellet can do.</h2>'
      + '<div style="display:flex;flex-direction:column;gap:14px;width:100%;max-width:340px;margin-bottom:36px;">'
      + '  <a href="https://mywellet.com" style="display:flex;align-items:center;justify-content:center;gap:8px;background:white;color:#3A6152;border-radius:14px;padding:16px 24px;font-size:17px;font-weight:600;text-decoration:none;transition:transform 0.2s;">Try it yourself <span style="font-size:20px;">→</span></a>'
      + '  <span style="color:rgba(255,255,255,0.5);font-size:13px;">mywellet.com</span>'
      + '  <a href="https://getwellet.com" style="display:flex;align-items:center;justify-content:center;gap:8px;background:transparent;color:white;border:2px solid rgba(255,255,255,0.5);border-radius:14px;padding:14px 24px;font-size:17px;font-weight:500;text-decoration:none;transition:border-color 0.2s;">Join the waitlist <span style="font-size:20px;">→</span></a>'
      + '  <span style="color:rgba(255,255,255,0.5);font-size:13px;">getwellet.com</span>'
      + '</div>'
      + '<div style="display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-bottom:auto;">'
      + '  <span style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);border-radius:20px;padding:6px 14px;font-size:12px;color:rgba(255,255,255,0.7);">AI health summaries</span>'
      + '  <span style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);border-radius:20px;padding:6px 14px;font-size:12px;color:rgba(255,255,255,0.7);">EHR integration</span>'
      + '  <span style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);border-radius:20px;padding:6px 14px;font-size:12px;color:rgba(255,255,255,0.7);">Wearable tracking</span>'
      + '  <span style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);border-radius:20px;padding:6px 14px;font-size:12px;color:rgba(255,255,255,0.7);">Home sensors</span>'
      + '  <span style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);border-radius:20px;padding:6px 14px;font-size:12px;color:rgba(255,255,255,0.7);">HIPAA compliant</span>'
      + '</div>';
    document.body.appendChild(ec);
  }

  // ── STEP RUNNER ──
  function gdRunStep(idx) {
    if (idx < 0 || idx >= guidedSteps.length) return;
    _gd.currentStep = idx;

    // Cleanup
    if (_gd.timer) { clearTimeout(_gd.timer); _gd.timer = null; }
    if (_gd.audio) { _gd.audio.pause(); _gd.audio.currentTime = 0; _gd.audio = null; }
    gdClearTypeInterval();
    gdClearCaptionInterval();

    var step = guidedSteps[idx];
    var capEl = document.getElementById('guided-caption');
    var progEl = document.getElementById('guided-progress');

    // Hide end card if going backwards
    var ec = document.getElementById('guided-endcard');
    if (ec && idx < guidedSteps.length - 1) {
      ec.style.opacity = '0';
      setTimeout(function() { ec.style.display = 'none'; }, 400);
    }

    // Show controls (might be hidden from end card)
    var ctrl = document.getElementById('guided-controls');
    if (ctrl) ctrl.style.display = 'flex';

    // Progress
    if (progEl) progEl.style.width = ((idx + 1) / guidedSteps.length * 100) + '%';

    // Run action
    if (step.action) step.action();

    // Caption — word-by-word typewriter reveal
    if (capEl) {
      if (step.caption) {
        capEl.textContent = '';
        capEl.style.opacity = '1';
        gdTypeCaption(capEl, step.caption, step.duration);
      } else {
        gdClearCaptionInterval();
        capEl.style.opacity = '0';
      }
    }

    // Audio + auto-advance
    if (!_gd.isPaused) {
      gdPlayAndAdvance(idx, step);
    }
  }

  function gdPlayAndAdvance(idx, step) {
    var audioFile = '/narration/' + step.audio;
    var aud = new Audio(audioFile);
    _gd.audio = aud;
    var useAudioTiming = false; // true when real narration clips are present

    var advanced = false;
    function advance() {
      if (advanced) return;
      advanced = true;
      if (_gd.currentStep === idx && !_gd.isPaused) {
        _gd.timer = setTimeout(function() {
          if (idx < guidedSteps.length - 1) {
            gdRunStep(idx + 1);
          } else {
            var capEl = document.getElementById('guided-caption');
            if (capEl) capEl.style.opacity = '0';
          }
        }, 800);
      }
    }

    // Error fallback
    aud.addEventListener('error', function() {
      _gd.timer = setTimeout(advance, step.duration);
    });

    aud.play().then(function() {
      // Check audio length once metadata loads
      function checkDuration() {
        if (aud.duration && aud.duration > 2.5) {
          // Real narration clip — advance when it ends
          useAudioTiming = true;
          aud.addEventListener('ended', advance);
        } else {
          // Placeholder or very short — use step duration
          _gd.timer = setTimeout(advance, step.duration);
        }
      }
      if (aud.readyState >= 1) {
        checkDuration();
      } else {
        aud.addEventListener('loadedmetadata', checkDuration);
      }
    }).catch(function() {
      // Autoplay blocked — fall back to timer
      _gd.timer = setTimeout(advance, step.duration);
    });

    // Safety net: never hang longer than duration + 8s
    setTimeout(function() { advance(); }, step.duration + 8000);
  }

  // ── HIGHLIGHTS ──
  function gdHighlight(selector) {
    gdClearHighlight();
    var el = document.querySelector(selector);
    if (!el) return;
    el.style.transition = 'box-shadow 0.4s ease';
    el.style.boxShadow = '0 0 0 3px rgba(96,143,124,0.45), 0 0 24px rgba(96,143,124,0.15)';
    el.style.borderRadius = '14px';
    el.dataset.gdHighlight = '1';
  }

  function gdClearHighlight() {
    document.querySelectorAll('[data-gd-highlight]').forEach(function(el) {
      el.style.boxShadow = '';
      el.style.borderRadius = '';
      delete el.dataset.gdHighlight;
    });
  }

  // ── SCROLL ──
  function gdScrollTo(selector, delay) {
    setTimeout(function() {
      var el = document.querySelector(selector);
      if (!el) return;
      var header = document.querySelector('.app-header');
      var headerH = header ? header.offsetHeight : 0;
      var top = el.getBoundingClientRect().top + window.pageYOffset - headerH - 12;
      window.scrollTo({ top: top, behavior: 'smooth' });
    }, delay || 200);
  }

  // ── TYPING ──
  function gdTypeText(input, text, charDelay) {
    gdClearTypeInterval();
    var i = 0;
    input.value = '';
    input.focus();
    _gd.typeInterval = setInterval(function() {
      if (i < text.length) {
        input.value += text[i];
        i++;
      } else {
        gdClearTypeInterval();
      }
    }, charDelay);
  }

  function gdClearTypeInterval() {
    if (_gd.typeInterval) { clearInterval(_gd.typeInterval); _gd.typeInterval = null; }
  }

  function gdClearCaptionInterval() {
    if (_gd.captionInterval) { clearInterval(_gd.captionInterval); _gd.captionInterval = null; }
  }

  // Reveal caption word-by-word, finishing at ~75% of audio duration.
  // Falls back to full-text if duration is unknown or caption is very short.
  function gdTypeCaption(capEl, text, audioDurationMs) {
    gdClearCaptionInterval();
    var words = text.split(/\s+/);
    if (words.length <= 2 || !audioDurationMs) {
      capEl.textContent = text;
      return;
    }
    var targetMs = audioDurationMs * 0.75;
    var wordDelay = Math.max(80, Math.min(350, targetMs / words.length));
    var shown = 0;
    capEl.textContent = '';
    _gd.captionInterval = setInterval(function() {
      shown++;
      capEl.textContent = words.slice(0, shown).join(' ');
      if (shown >= words.length) {
        gdClearCaptionInterval();
      }
    }, wordDelay);
  }

  // ── END CARD ──
  function gdShowEndCard() {
    var ec = document.getElementById('guided-endcard');
    if (!ec) return;
    ec.style.display = 'flex';
    // Force reflow then animate
    ec.offsetHeight;
    ec.style.opacity = '1';
    // Hide controls behind end card
    var ctrl = document.getElementById('guided-controls');
    if (ctrl) ctrl.style.display = 'none';
  }

  // ── CONTROLS (global) ──
  window.gdNext = function() {
    _gd.isPaused = false;
    var btn = document.getElementById('gd-pause-btn');
    if (btn) btn.textContent = '⏸ Pause';
    gdRunStep(Math.min(_gd.currentStep + 1, guidedSteps.length - 1));
  };

  window.gdPrev = function() {
    _gd.isPaused = false;
    var btn = document.getElementById('gd-pause-btn');
    if (btn) btn.textContent = '⏸ Pause';
    gdRunStep(Math.max(_gd.currentStep - 1, 0));
  };

  window.gdTogglePause = function() {
    _gd.isPaused = !_gd.isPaused;
    var btn = document.getElementById('gd-pause-btn');
    if (_gd.isPaused) {
      if (btn) btn.textContent = '▶ Play';
      if (_gd.timer) { clearTimeout(_gd.timer); _gd.timer = null; }
      if (_gd.audio) _gd.audio.pause();
      gdClearTypeInterval();
      gdClearCaptionInterval();
    } else {
      if (btn) btn.textContent = '⏸ Pause';
      // Resume: replay current step's audio-advance logic
      var step = guidedSteps[_gd.currentStep];
      if (_gd.audio && _gd.audio.paused) {
        _gd.audio.play().catch(function(){});
      }
      gdPlayAndAdvance(_gd.currentStep, step);
    }
  };

  window.gdExit = function() {
    _gd.isPaused = true;
    if (_gd.timer) { clearTimeout(_gd.timer); _gd.timer = null; }
    if (_gd.audio) { _gd.audio.pause(); _gd.audio = null; }
    gdClearTypeInterval();
    gdClearCaptionInterval();
    gdClearHighlight();

    var cap = document.getElementById('guided-caption');
    if (cap) { cap.style.opacity = '0'; setTimeout(function() { cap.remove(); }, 500); }
    var ctrl = document.getElementById('guided-controls');
    if (ctrl) ctrl.remove();
    var prog = document.getElementById('guided-progress');
    if (prog) prog.remove();
    var ec = document.getElementById('guided-endcard');
    if (ec) { ec.style.opacity = '0'; setTimeout(function() { ec.remove(); }, 500); }

    // Drop the ?demo=guided param so refreshes don't restart
    if (window.history && window.history.replaceState) {
      var url = new URL(window.location);
      url.searchParams.delete('demo');
      window.history.replaceState({}, '', url);
    }
  };

  // ── START ──
  // Show a "tap to start" splash so the first audio.play() happens inside a
  // user-gesture handler. Browsers block autoplay without a gesture.
  window.addEventListener('load', function() {
    setTimeout(function() {
      gdInjectUI();
      // Build splash overlay
      var splash = document.createElement('div');
      splash.id = 'guided-splash';
      splash.style.cssText = 'position:fixed;inset:0;z-index:100001;display:flex;align-items:center;'
        + 'justify-content:center;flex-direction:column;gap:20px;'
        + 'background:linear-gradient(160deg,#3A6152 0%,#4F7A68 40%,#608F7C 100%);'
        + 'font-family:"DM Sans",sans-serif;text-align:center;padding:40px 24px;'
        + 'opacity:0;transition:opacity 0.4s ease;cursor:pointer;';
      splash.innerHTML = ''
        + '<div style="margin-bottom:8px;">'
        + '  <img src="/wellet-logo-white.png" alt="Wellet" style="height:40px;" onerror="this.style.display=\'none\'">'
        + '</div>'
        + '<h2 style="font-family:\'DM Serif Display\',serif;font-size:clamp(28px,5vw,44px);color:white;font-weight:400;line-height:1.2;margin:0;">Guided Demo</h2>'
        + '<p style="color:rgba(255,255,255,0.7);font-size:15px;max-width:320px;line-height:1.5;margin:0;">See how Wellet helps caregivers manage their loved one\u2019s health.</p>'
        + '<button id="gd-start-btn" style="margin-top:12px;display:flex;align-items:center;gap:10px;'
        + 'background:white;color:#3A6152;border:none;border-radius:14px;padding:16px 36px;'
        + 'font-size:17px;font-weight:600;cursor:pointer;font-family:inherit;'
        + 'transition:transform 0.15s;box-shadow:0 4px 20px rgba(0,0,0,0.2);">'
        + '<svg width="20" height="20" viewBox="0 0 24 24" fill="#3A6152" stroke="none"><polygon points="6,3 20,12 6,21"/></svg>'
        + 'Start demo</button>'
        + '<span style="color:rgba(255,255,255,0.45);font-size:12px;margin-top:4px;">About 2 minutes · with narration</span>';
      document.body.appendChild(splash);

      // Fade in
      requestAnimationFrame(function() {
        requestAnimationFrame(function() { splash.style.opacity = '1'; });
      });

      // Start on tap (user gesture unlocks audio)
      var startBtn = document.getElementById('gd-start-btn');
      function startDemo() {
        splash.style.opacity = '0';
        setTimeout(function() { splash.remove(); }, 400);
        gdRunStep(0);
      }
      startBtn.addEventListener('click', function(e) { e.stopPropagation(); startDemo(); });
      splash.addEventListener('click', startDemo);
    }, 1500);
  });

}
