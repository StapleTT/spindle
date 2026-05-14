(function () {
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  document.documentElement.dataset.theme = mq.matches ? 'dark' : 'light';
  mq.addEventListener('change', function (e) {
    document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
  });
})();
