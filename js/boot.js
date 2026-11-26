'use strict';
/* ---------------------------------------------------------------------
   17. Boot
   The app shell starts hidden (see index.html) so the case-naming step
   is the very first thing shown -- the board only appears once a case
   name exists. If the OPSEC vault is on, unlocking it comes first: the
   password prompt blocks even that, since loadEverything() has nothing
   readable to load until the vault is decrypted back into the plain
   localStorage keys it expects.
   --------------------------------------------------------------------- */
requireVaultUnlock(() => {
  ensureWorkspaceRegistry();
  loadEverything();
  ensureCaseOnboarding(() => {
    renderCaseButton();
    logEvent('Opened LinkTrace case', ltCase.name);
    render();
    $('app').style.visibility = 'visible';
  });
});
