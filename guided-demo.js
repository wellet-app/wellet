// ── WELLET GUIDED DEMO ─────────────────────────────────────────────────────
// Self-playing walkthrough triggered by ?demo=guided
// Plays narration audio (ElevenLabs), shows captions, navigates the app
// Each step: { audio, caption, duration (ms), action (fn) }

(function() {
  'use strict';

  if (new URLSearchParams(window.location.search).get('demo') !== 'guided') return;

  // ── CONFIG ──
  var AUDIO_BASE = '/narration/';  // folder for mp3 clips
  var CAPTION_ID = 'guided-caption';
  var OVERLAY_ID = 'guided-overlay';
  var PROGRESS_ID = 'guided-progress';
  var CONTROLS_ID = 'guided-controls';

  // ── STEPS ──
  // duration = time before auto-advancing (ms). Set to match audio length + pause.
  var steps = [
    // 0 — INTRO (on auth/landing screen)
    {
      audio: '00-intro.mp3',
      caption: 'This is Wellet — a health companion for family caregivers. Let me show you how it works.',
      duration: 6000,
      action: function() { /* stays on auth screen */ }
    },
    // 1 — Enter demo
    {
      audio: '01-enter-demo.mp3',
      caption: 'We\'ll start with Dad\'s care view. His health data is already here — pulled from his EHR, his Apple Watch, and home sensors.',
      duration: 7000,
      action: function() {
        enterDemoMode();
        switchNavTo('home');
        document.querySelectorAll('.tab')[0].click();
      }
    },
    // 2 — Update Me
    {
      audio: '02-update-me.mp3',
      caption: 'Update Me is your home base. It\'s a plain-English summary of what\'s happening right now — no medical jargon, no digging through portals.',
      duration: 8000,
      action: function() {
        switchNavTo('home');
        document.querySelectorAll('.tab')[0].click();
        highlightEl('#tab-update .update-card');
      }
    },
    // 3 — Timeline
    {
      audio: '03-timeline.mp3',
      caption: 'The Timeline shows everything in order — appointments, lab results, medication changes, your own notes. You\'ll never have to reconstruct it from memory.',
      duration: 8000,
      action: function() {
        document.querySelectorAll('.tab')[1].click();
        highlightEl('#tab-timeline');
      }
    },
    // 4 — Patterns
    {
      audio: '04-patterns.mp3',
      caption: 'Wellet watches for patterns — like how a medication change affected blood pressure, or whether sleep is getting worse. It surfaces what matters.',
      duration: 8000,
      action: function() {
        document.querySelectorAll('.tab')[2].click();
        highlightEl('#tab-patterns');
      }
    },
    // 5 — People
    {
      audio: '05-people.mp3',
      caption: 'Everyone involved in care, in one place. Doctors, specialists, family members — with contact info and notes.',
      duration: 6000,
      action: function() {
        clearHighlight();
        switchNavTo('people');
      }
    },
    // 6 — Records
    {
      audio: '06-records.mp3',
      caption: 'Upload a photo of a prescription, discharge summary, or insurance card. Wellet reads it and files it automatically.',
      duration: 7000,
      action: function() {
        switchNavTo('records');
      }
    },
    // 7 — CareSignals
    {
      audio: '07-caresignals.mp3',
      caption: 'CareSignals brings in wearable data and home sensors. You can see Dad\'s heart rate, steps, sleep — and know that the medicine cabinet was opened at 8:12 this morning.',
      duration: 9000,
      action: function() {
        switchNavTo('signals');
      }
    },
    // 8 — Ask Wellet (navigate)
    {
      audio: '08-ask-intro.mp3',
      caption: 'And then there\'s Ask Wellet. Ask anything about your family member\'s health — in plain language.',
      duration: 6000,
      action: function() {
        switchNavTo('ask');
      }
    },
    // 9 — Ask Wellet (type a question)
    {
      audio: '09-ask-question.mp3',
      caption: 'Let\'s try: "Is Dad\'s blood pressure getting better since the medication change?"',
      duration: 7000,
      action: function() {
        var input = document.getElementById('ask-input');
        var question = "Is Dad's blood pressure getting better since the medication change?";
        input.value = '';
        typeText(input, question, 60);
      }
    },
    // 10 — Ask Wellet (send + wait for response)
    {
      audio: '10-ask-response.mp3',
      caption: 'Wellet knows the full picture — medications, labs, wearable data, sensor patterns — and answers with real context, not a generic search result.',
      duration: 10000,
      action: function() {
        sendAskMessage();
      }
    },
    // 11 — Closing
    {
      audio: '11-closing.mp3',
      caption: 'That\'s Wellet. One place to remember what matters. Try it yourself at mywellet.com — or join the waitlist at getwellet.com.',
      duration: 8000,
      action: function() {
        clearHighlight();
      }
    }
  ];

  var currentStep = -1;
  var isPaused = false;
  var currentAudio = null;
  var stepTimer = null;

  // ── UI SETUP ──
  function injectUI() {
    // Caption bar
    var caption = document.createElement('div');
    caption.id = CAPTION_ID;
    caption.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);'
      + 'max-width:640px;width:calc(100% - 32px);background:rgba(0,0,0,0.82);color:white;'
      + 'padding:14px 20px;border-radius:14px;font-family:"DM Sans",sans-serif;font-size:15px;'
      + 'line-height:1.55;text-align:center;z-index:99999;opacity:0;transition:opacity 0.4s;'
      + 'pointer-events:none;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);';
    document.body.appendChild(caption);

    // Progress bar
    var progress = document.createElement('div');
    progress.id = PROGRESS_ID;
    progress.style.cssText = 'position:fixed;top:0;left:0;height:3px;background:#608F7C;'
      + 'z-index:99999;transition:width 0.5s ease;width:0;';
    document.body.appendChild(progress);

    // Controls
    var controls = document.createElement('div');
    controls.id = CONTROLS_ID;
    controls.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);'
      + 'display:flex;gap:8px;z-index:99999;font-family:"DM Sans",sans-serif;';
    controls.innerHTML = ''
      + '<button id="guided-prev" style="background:rgba(0,0,0,0.7);color:white;border:none;border-radius:10px;padding:8px 16px;font-size:13px;cursor:pointer;font-family:inherit;backdrop-filter:blur(8px);" onclick="guidedPrev()">← Back</button>'
      + '<button id="guided-pause" style="background:#608F7C;color:white;border:none;border-radius:10px;padding:8px 20px;font-size:13px;cursor:pointer;font-family:inherit;" onclick="guidedTogglePause()">⏸ Pause</button>'
      + '<button id="guided-next" style="background:rgba(0,0,0,0.7);color:white;border:none;border-radius:10px;padding:8px 16px;font-size:13px;cursor:pointer;font-family:inherit;backdrop-filter:blur(8px);" onclick="guidedNext()">Next →</button>'
      + '<button id="guided-exit" style="background:rgba(0,0,0,0.5);color:rgba(255,255,255,0.7);border:none;border-radius:10px;padding:8px 14px;font-size:13px;cursor:pointer;font-family:inherit;backdrop-filter:blur(8px);" onclick="guidedExit()">✕ Exit</button>';
    document.body.appendChild(controls);
  }

  // ── STEP RUNNER ──
  function runStep(idx) {
    if (idx < 0 || idx >= steps.length) return;
    currentStep = idx;

    // Clear previous
    if (stepTimer) clearTimeout(stepTimer);
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }

    var step = steps[idx];
    var caption = document.getElementById(CAPTION_ID);
    var progress = document.getElementById(PROGRESS_ID);

    // Progress
    progress.style.width = ((idx + 1) / steps.length * 100) + '%';

    // Action
    if (step.action) step.action();

    // Caption
    caption.textContent = step.caption;
    caption.style.opacity = '1';

    // Audio
    if (step.audio) {
      currentAudio = new Audio(AUDIO_BASE + step.audio);
      currentAudio.play().catch(function(e) { console.log('Audio play blocked:', e); });
    }

    // Auto-advance
    if (!isPaused) {
      stepTimer = setTimeout(function() {
        if (idx < steps.length - 1) {
          runStep(idx + 1);
        } else {
          // Demo complete
          caption.textContent = 'Demo complete. Use the controls below or explore on your own.';
          setTimeout(function() { caption.style.opacity = '0'; }, 5000);
        }
      }, step.duration);
    }
  }

  // ── HIGHLIGHT HELPERS ──
  function highlightEl(selector) {
    clearHighlight();
    var el = document.querySelector(selector);
    if (el) {
      el.style.transition = 'box-shadow 0.3s';
      el.style.boxShadow = '0 0 0 3px rgba(96,143,124,0.4), 0 0 20px rgba(96,143,124,0.15)';
      el.style.borderRadius = '12px';
      el.dataset.guidedHighlight = '1';
    }
  }

  function clearHighlight() {
    document.querySelectorAll('[data-guided-highlight]').forEach(function(el) {
      el.style.boxShadow = '';
      delete el.dataset.guidedHighlight;
    });
  }

  // ── TYPE ANIMATION ──
  function typeText(input, text, charDelay) {
    var i = 0;
    input.value = '';
    input.focus();
    var interval = setInterval(function() {
      if (i < text.length) {
        input.value += text[i];
        i++;
      } else {
        clearInterval(interval);
      }
    }, charDelay);
  }

  // ── CONTROLS ──
  window.guidedNext = function() { runStep(Math.min(currentStep + 1, steps.length - 1)); };
  window.guidedPrev = function() { runStep(Math.max(currentStep - 1, 0)); };
  window.guidedTogglePause = function() {
    isPaused = !isPaused;
    var btn = document.getElementById('guided-pause');
    if (isPaused) {
      btn.textContent = '▶ Play';
      if (stepTimer) clearTimeout(stepTimer);
      if (currentAudio) currentAudio.pause();
    } else {
      btn.textContent = '⏸ Pause';
      // Resume from current step
      var remaining = steps[currentStep].duration * 0.5; // rough remaining
      if (currentAudio) currentAudio.play().catch(function(){});
      stepTimer = setTimeout(function() {
        if (currentStep < steps.length - 1) runStep(currentStep + 1);
      }, remaining);
    }
  };
  window.guidedExit = function() {
    isPaused = true;
    if (stepTimer) clearTimeout(stepTimer);
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    var caption = document.getElementById(CAPTION_ID);
    if (caption) caption.style.opacity = '0';
    var controls = document.getElementById(CONTROLS_ID);
    if (controls) controls.style.display = 'none';
    var progress = document.getElementById(PROGRESS_ID);
    if (progress) progress.style.display = 'none';
    clearHighlight();
  };

  // ── INIT ──
  // Wait for app load, then start
  window.addEventListener('load', function() {
    setTimeout(function() {
      injectUI();
      runStep(0);
    }, 1500); // let the app render first
  });

})();
