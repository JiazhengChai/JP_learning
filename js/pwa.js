/* Installation is always initiated by a user gesture; updates never reload edits. */
(() => {
    const button = document.getElementById('btn-install');
    const status = document.getElementById('pwa-status');
    const help = document.getElementById('install-help');
    const displayMode = window.matchMedia('(display-mode: standalone)');
    let installPrompt = null;
    const installed = () => displayMode.matches || navigator.standalone === true;
    const showStatus = message => {
        status.textContent = message;
        status.hidden = false;
    };
    const refreshButton = () => { button.hidden = installed(); };
    refreshButton();
    displayMode.addEventListener('change', refreshButton);

    window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        installPrompt = event;
        refreshButton();
    });
    window.addEventListener('appinstalled', () => {
        installPrompt = null;
        button.hidden = true;
        if (help.open) help.close();
    });
    button.addEventListener('click', async () => {
        if (installPrompt) {
            const prompt = installPrompt;
            installPrompt = null;
            try {
                await prompt.prompt();
                const choice = await prompt.userChoice;
                if (choice.outcome === 'accepted') button.hidden = true;
                return;
            } catch { /* Fall back to the browser's menu instructions. */ }
        }
        const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
            || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        document.getElementById('install-instructions').textContent = ios
            ? 'On iPhone or iPad, open the Share menu and choose Add to Home Screen. If this option is missing in Chrome, open this same address in Safari and use Share → Add to Home Screen.'
            : 'In Chrome, open the ⋮ menu and choose Add to home screen → Install (or Install app). If Install is not available yet, browse the app briefly and try again.';
        help.showModal();
    });
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    window.addEventListener('load', async () => {
        try {
            const registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
            const updateStatus = () => showStatus('Update ready · close all LangLens windows and reopen to update.');
            if (registration.waiting) updateStatus();
            registration.addEventListener('updatefound', () => {
                const worker = registration.installing;
                worker?.addEventListener('statechange', () => {
                    if (worker.state === 'installed' && registration.waiting && navigator.serviceWorker.controller) updateStatus();
                });
            });
            await navigator.serviceWorker.ready;
            if (!registration.waiting) showStatus('Ready for offline use');
        } catch (error) {
            showStatus('Offline setup unavailable · reconnect and reopen to retry.');
            console.warn('Offline setup failed:', error);
        }
    });
})();
