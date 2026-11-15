if (location.protocol === 'https:' || location.protocol === 'http:') {
  document.getElementById('get-app-link').hidden = false;
  document.getElementById('get-the-app').hidden = false;
  document.getElementById('chrome-install').hidden = matchMedia('(display-mode: standalone)').matches;

  const installButton = document.getElementById('install-app');
  const installStatus = document.getElementById('install-status');
  let installPrompt;

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    installButton.hidden = false;
  });

  installButton.addEventListener('click', async () => {
    const prompt = installPrompt;
    installPrompt = undefined;
    installButton.hidden = true;
    if (prompt) await prompt.prompt();
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = undefined;
    installButton.hidden = true;
    installStatus.hidden = false;
  });
}
