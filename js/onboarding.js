'use strict';
/* ---------------------------------------------------------------------
   0. Onboarding: name the case before the workflow starts.
   Deliberately does not use the shared modal system -- there is no
   Escape/backdrop-click dismissal here, since a case name is required
   before anything else can happen.
   --------------------------------------------------------------------- */
function showCaseOnboarding(onDone) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML =
    '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="onboardTitle">' +
      '<h2 id="onboardTitle">Name this case</h2>' +
      '<p>Give this investigation a name before you start. You can rename it anytime from the case workspace button.</p>' +
      '<label>Case name</label><input id="onboardCaseName" placeholder="e.g. Acme phishing incident" autocomplete="off">' +
      '<label>Description (optional)</label><textarea id="onboardCaseDesc" placeholder="What is this case about?" autocomplete="off"></textarea>' +
      '<div class="actions"><button class="primary" id="onboardStart">Start investigation</button></div>' +
    '</div>';
  document.body.append(back);

  const input = back.querySelector('#onboardCaseName');
  input.focus();
  const submit = () => {
    const name = input.value.trim();
    if (!name) { input.style.borderColor = 'var(--danger)'; input.focus(); return; }
    ltCase.name = name;
    ltCase.description = back.querySelector('#onboardCaseDesc').value.trim();
    localStorage.setItem(CASE_INIT_KEY, '1');
    saveCaseData();
    back.remove();
    onDone();
  };
  back.querySelector('#onboardStart').onclick = submit;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function ensureCaseOnboarding(onDone) {
  if (localStorage.getItem(CASE_INIT_KEY)) return onDone();
  showCaseOnboarding(onDone);
}
