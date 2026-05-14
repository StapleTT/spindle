document.addEventListener('DOMContentLoaded', () => {
  MobileNav.init();
  document.getElementById('btn-compose').onclick     = () => Composer.open();
  document.getElementById('btn-search').onclick      = () => Search.toggle();
  document.getElementById('btn-logout').onclick      = () => App.logout();
  document.getElementById('sys-compose').onclick     = () => Composer.open();
  document.getElementById('sys-admin').onclick       = () => Admin.toggle();
  document.getElementById('sys-settings').onclick    = () => Settings.toggle();
  document.getElementById('btn-add-account').onclick = () => Accounts.openAddModal();
});
