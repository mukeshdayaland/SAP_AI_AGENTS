// Applies the saved theme before first paint to avoid a flash of the wrong theme.
(function () {
  try {
    var t = localStorage.getItem('prowess-theme');
    document.documentElement.dataset.theme = t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    document.documentElement.dataset.theme = 'system';
  }
})();
