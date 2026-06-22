// Click any token code/value to copy.
(function () {
  function copy(text) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).catch(function () {});
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t) return;
    var copyable = t.closest('code, .swatch-meta span, .sem code, .pill');
    if (!copyable) return;
    var text = copyable.textContent.trim();
    if (!text) return;
    copy(text);
    var original = copyable.dataset.original || copyable.textContent;
    copyable.dataset.original = original;
    copyable.textContent = 'copied';
    setTimeout(function () {
      copyable.textContent = copyable.dataset.original;
    }, 900);
  });

  // Smooth scroll
  document.querySelectorAll('.nav a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = a.getAttribute('href').slice(1);
      var el = document.getElementById(id);
      if (!el) return;
      e.preventDefault();
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.pushState(null, '', '#' + id);
    });
  });
})();
