/* ====================================================
   RappelConso — alerts.js (module alertes email)
   ==================================================== */

(function () {
  'use strict';

  const ALERTS_KEY = 'rappelconso_alerts';
  const API_ALERTS = '/api/alerts';

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  // ---- STORAGE ----
  function loadAlerts() {
    try {
      return JSON.parse(localStorage.getItem(ALERTS_KEY) || '[]');
    } catch (_) {
      return [];
    }
  }

  function saveAlerts(alerts) {
    localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts));
  }

  // ---- HELPERS ----
  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function nextSendDate(freq) {
    const d = new Date();
    if (freq === 'daily')   d.setDate(d.getDate() + 1);
    if (freq === 'weekly')  d.setDate(d.getDate() + 7);
    if (freq === 'monthly') d.setMonth(d.getMonth() + 1);
    return d.toISOString();
  }

  function fmtFreq(freq) {
    return { daily: 'Quotidien', weekly: 'Hebdomadaire', monthly: 'Mensuel' }[freq] || freq;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ---- DOM REFS ----
  const tabSearch    = document.getElementById('tab-search');
  const tabAnalytics = document.getElementById('tab-analytics');
  const tabAlerts    = document.getElementById('tab-alerts');
  const panelSearch  = document.getElementById('panel-search');
  const panelAnalytics = document.getElementById('panel-analytics');
  const panelAlerts  = document.getElementById('panel-alerts');

  const alertForm         = document.getElementById('alert-form');
  const alertIdInput      = document.getElementById('alert-id');
  const alertEmailInput   = document.getElementById('alert-email');
  const alertNameInput    = document.getElementById('alert-name');
  const alertZoneSel      = document.getElementById('alert-zone');
  const alertDistribSel   = document.getElementById('alert-distributeur');
  const alertCategorieSel = document.getElementById('alert-categorie');
  const alertKeywordsInput = document.getElementById('alert-keywords');
  const alertFeedback     = document.getElementById('alert-feedback');
  const alertCountBadge   = document.getElementById('alert-count-badge');
  const alertsList        = document.getElementById('alerts-list');
  const serverStatusBar   = document.getElementById('server-status-bar');

  // ---- TAB SWITCHING ----
  tabAlerts.addEventListener('click', () => {
    tabSearch.classList.remove('active');    tabSearch.setAttribute('aria-selected', 'false');
    tabAnalytics.classList.remove('active'); tabAnalytics.setAttribute('aria-selected', 'false');
    tabAlerts.classList.add('active');       tabAlerts.setAttribute('aria-selected', 'true');
    panelSearch.classList.add('hidden');
    panelAnalytics.classList.add('hidden');
    panelAlerts.classList.remove('hidden');
    renderAlertsList();
    checkServerStatus();
  });

  // ---- VALIDATION ----
  function clearErrors() {
    document.getElementById('err-email').textContent = '';
    document.getElementById('err-name').textContent  = '';
    alertEmailInput.classList.remove('field-invalid');
    alertNameInput.classList.remove('field-invalid');
  }

  function validate() {
    clearErrors();
    let valid = true;

    if (!EMAIL_RE.test(alertEmailInput.value.trim())) {
      document.getElementById('err-email').textContent = 'Adresse email invalide.';
      alertEmailInput.classList.add('field-invalid');
      valid = false;
    }

    if (!alertNameInput.value.trim()) {
      document.getElementById('err-name').textContent = 'Le nom est obligatoire.';
      alertNameInput.classList.add('field-invalid');
      valid = false;
    }

    return valid;
  }

  // ---- FORM SUBMIT ----
  alertForm.addEventListener('submit', e => {
    e.preventDefault();
    if (!validate()) return;

    const freq = alertForm.querySelector('input[name="freq"]:checked');
    const alerts = loadAlerts();
    const existingId = alertIdInput.value;

    const alertData = {
      id:           existingId || genId(),
      email:        alertEmailInput.value.trim(),
      name:         alertNameInput.value.trim(),
      zone:         alertZoneSel.value,
      distributeur: alertDistribSel.value,
      categorie:    alertCategorieSel.value,
      keywords:     alertKeywordsInput.value.trim(),
      freq:         freq ? freq.value : 'weekly',
      createdAt:    existingId ? (alerts.find(a => a.id === existingId) || {}).createdAt || new Date().toISOString() : new Date().toISOString(),
      nextSend:     nextSendDate(freq ? freq.value : 'weekly')
    };

    if (existingId) {
      const idx = alerts.findIndex(a => a.id === existingId);
      if (idx >= 0) alerts[idx] = alertData;
      else alerts.push(alertData);
    } else {
      alerts.push(alertData);
    }

    saveAlerts(alerts);
    syncAlertToBackend(alertData);
    showFeedback(existingId ? 'Alerte mise à jour.' : 'Alerte créée avec succès.', 'success');
    resetForm();
    renderAlertsList();
  });

  // ---- RESET FORM ----
  function resetForm() {
    alertForm.reset();
    alertIdInput.value = '';
    clearErrors();
    hideFeedback();
  }

  document.getElementById('btn-alert-reset').addEventListener('click', resetForm);

  // ---- FEEDBACK ----
  function showFeedback(msg, type) {
    alertFeedback.textContent = msg;
    alertFeedback.className = `alert-feedback ${type}`;
    alertFeedback.classList.remove('hidden');
    setTimeout(hideFeedback, 4000);
  }

  function hideFeedback() {
    alertFeedback.classList.add('hidden');
    alertFeedback.textContent = '';
  }

  // ---- RENDER ALERTS LIST ----
  function renderAlertsList() {
    const alerts = loadAlerts();
    alertCountBadge.textContent = alerts.length;

    if (!alerts.length) {
      alertsList.innerHTML = '<div class="empty-state">Aucune alerte configurée.</div>';
      return;
    }

    alertsList.innerHTML = alerts.map(a => {
      const tags = [
        a.zone        && `<span class="tag">📍 ${escHtml(a.zone)}</span>`,
        a.distributeur && `<span class="tag">🏪 ${escHtml(a.distributeur)}</span>`,
        a.categorie   && `<span class="tag">📦 ${escHtml(a.categorie)}</span>`,
        a.keywords    && `<span class="tag tag--grey">🔍 ${escHtml(a.keywords)}</span>`
      ].filter(Boolean).join('');

      return `
        <div class="alert-item" data-id="${escAttr(a.id)}">
          <div class="alert-item-header">
            <span class="alert-item-name" title="${escAttr(a.email)}">${escHtml(a.name)}</span>
            <div class="alert-item-actions">
              <button class="btn-alert-send" data-id="${escAttr(a.id)}" title="Envoyer maintenant">📤 Envoyer</button>
              <button class="btn-alert-edit" data-id="${escAttr(a.id)}" title="Modifier">✏️</button>
              <button class="btn-alert-delete" data-id="${escAttr(a.id)}" title="Supprimer">🗑️</button>
            </div>
          </div>
          ${tags ? `<div class="alert-item-tags">${tags}</div>` : ''}
          <div class="alert-item-meta">
            <span class="alert-item-freq">${escHtml(fmtFreq(a.freq))}</span>
            <span class="alert-item-next">Prochain envoi : ${escHtml(fmtDate(a.nextSend))}</span>
            <span style="color:var(--muted);font-size:11px">✉️ ${escHtml(a.email)}</span>
          </div>
        </div>`;
    }).join('');

    // Bind actions
    alertsList.querySelectorAll('.btn-alert-send').forEach(btn => {
      btn.addEventListener('click', () => sendNow(btn.dataset.id, btn));
    });
    alertsList.querySelectorAll('.btn-alert-edit').forEach(btn => {
      btn.addEventListener('click', () => editAlert(btn.dataset.id));
    });
    alertsList.querySelectorAll('.btn-alert-delete').forEach(btn => {
      btn.addEventListener('click', () => deleteAlert(btn.dataset.id));
    });
  }

  // ---- EDIT ALERT ----
  function editAlert(id) {
    const alerts = loadAlerts();
    const a = alerts.find(x => x.id === id);
    if (!a) return;

    alertIdInput.value          = a.id;
    alertEmailInput.value       = a.email;
    alertNameInput.value        = a.name;
    alertZoneSel.value          = a.zone || '';
    alertDistribSel.value       = a.distributeur || '';
    alertCategorieSel.value     = a.categorie || '';
    alertKeywordsInput.value    = a.keywords || '';

    const freqRadio = alertForm.querySelector(`input[name="freq"][value="${escAttr(a.freq)}"]`);
    if (freqRadio) freqRadio.checked = true;

    alertForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    alertEmailInput.focus();
  }

  // ---- DELETE ALERT ----
  function deleteAlert(id) {
    if (!confirm('Supprimer cette alerte ?')) return;
    const alerts = loadAlerts().filter(a => a.id !== id);
    saveAlerts(alerts);
    syncDeleteToBackend(id);
    renderAlertsList();
    showFeedback('Alerte supprimée.', 'success');
  }

  // ---- SEND NOW ----
  async function sendNow(id, btn) {
    btn.disabled = true;
    btn.textContent = '⏳';

    try {
      const resp = await fetch(`${API_ALERTS}/${id}/send`, { method: 'POST' });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) {
        showFeedback('Email envoyé avec succès !', 'success');
      } else {
        showFeedback(`Erreur : ${data.error || resp.status}`, 'error');
      }
    } catch (_) {
      showFeedback('Serveur inaccessible.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '📤 Envoyer';
    }
  }

  // ---- SYNC TO BACKEND ----
  function syncAlertToBackend(alertData) {
    fetch(API_ALERTS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alertData)
    }).catch(() => {}); // silencieux si serveur absent
  }

  function syncDeleteToBackend(id) {
    fetch(`${API_ALERTS}/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  // ---- CHECK SERVER STATUS ----
  async function checkServerStatus() {
    try {
      const resp = await fetch('/api/status', { signal: AbortSignal.timeout(4000) });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) {
        serverStatusBar.className = 'alert-info-box ok';
        serverStatusBar.textContent = `✅ Serveur connecté${data.smtp ? ' — SMTP actif' : ' — SMTP non configuré (emails désactivés)'}`;
      } else {
        serverStatusBar.className = 'alert-info-box warn';
        serverStatusBar.textContent = '⚠️ Serveur en erreur.';
      }
    } catch (_) {
      serverStatusBar.className = 'alert-info-box error';
      serverStatusBar.textContent = '🔴 Serveur non disponible. Les alertes sont sauvegardées localement.';
    }
  }

  // ---- HELPERS ----
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escAttr(str) { return escHtml(str); }

})();
