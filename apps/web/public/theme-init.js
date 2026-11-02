// Applies the saved theme and language before first paint, so the page never flashes in the wrong theme or direction.
(function () {
  var root = document.documentElement;
  try {
    var t = localStorage.getItem('prowess-theme');
    root.dataset.theme = t === 'light' || t === 'dark' ? t : 'system';
    if (localStorage.getItem('prowess-lang') === 'ar') {
      root.lang = 'ar';
      root.dir = 'rtl';
    }
  } catch {
    root.dataset.theme = 'system';
  }
})();
