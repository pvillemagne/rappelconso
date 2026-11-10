/* ====================================================
   RappelConso — app.js (module recherche principale)
   ==================================================== */

(function () {
  'use strict';

  const API_BASE = 'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/rappelconso-v2-gtin-espaces';

  // ---- STATE ----
  const state = {
    query: '',
    categorie: '',
    zone: '',
    distributeur: '',
    dateDebut: '',
    dateFin: '',
    orderBy: 'date_de_publication DESC',
    page: 0,
    total: 0
  };

  // ---- DOM REFS ----
  const form          = document.getElementById('search-form');
  const inputQ        = document.getElementById('input-q');
  const selCategorie  = document.getElementById('sel-categorie');
  const selZone       = document.getElementById('sel-zone');
  const selDistributeur = document.getElementById('sel-distributeur');
  const inputDebut    = document.getElementById('input-debut');
  const inputFin      = document.getElementById('input-fin');
  const selTri        = document.getElementById('sel-tri');
  const btnSearch     = document.getElementById('btn-search');
  const btnReset      = document.getElementById('btn-reset');
  const statusBar     = document.getElementById('status-bar');
  const resultsGrid   = document.getElementById('results-grid');
  const pagination    = document.getElementById('pagination');
  const modal         = document.getElementById('modal');
  const modalOverlay  = document.getElementById('modal-overlay');
  const modalClose    = document.getElementById('modal-close');
  const modalContent  = document.getElementById('modal-content');

  // ---- BUILD WHERE CLAUSE ----
  function buildQuery() {
    const clauses = [];

    if (state.query) {
      const q = state.query.replace(/'/g, "\\'");
      clauses.push(
        `(libelle_produit_type LIKE '%${q}%' OR nom_de_la_marque_du_produit LIKE '%${q}%' OR modeles_ou_references LIKE '%${q}%' OR motif_du_rappel LIKE '%${q}%')`
      );
    }

    if (state.categorie) {
      const c = state.categorie.replace(/'/g, "\\'");
      clauses.push(`categorie_de_produit = '${c}'`);
    }

    if (state.zone) {
      const z = state.zone.replace(/'/g, "\\'");
      clauses.push(`zone_geographique_de_vente = '${z}'`);
    }

    if (state.distributeur) {
      const d = state.distributeur.replace(/'/g, "\\'");
      clauses.push(`distributeurs_revendeurs LIKE '%${d}%'`);
    }

    if (state.dateDebut) {
      clauses.push(`date_de_publication >= '${state.dateDebut}T00:00:00'`);
    }

    if (state.dateFin) {
      clauses.push(`date_de_publication <= '${state.dateFin}T23:59:59'`);
    }

    return clauses.join(' AND ');
  }

  // ---- FETCH RECORDS ----
  async function fetchRecords() {
    const where = buildQuery();
    const params = new URLSearchParams({
      limit: '20',
      offset: String(state.page * 20),
      order_by: state.orderBy,
      timezone: 'Europe/Paris'
    });
    if (where) params.set('where', where);

    const url = `${API_BASE}/records?${params.toString()}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`API error ${resp.status}`);
    return resp.json();
  }

  // ---- SEARCH ----
  async function search() {
    showLoading();
    try {
      const data = await fetchRecords();
      state.total = data.total_count || 0;
      renderCards(data.results || []);
      renderPagination();
      updateStatusBar();
    } catch (err) {
      showError(err.message);
    }
  }

  // ---- SHOW/HIDE LOADING ----
  function showLoading() {
    resultsGrid.innerHTML = `
      <div class="loading-spinner">
        <div class="spinner"></div>
        <span>Chargement des rappels…</span>
      </div>`;
    pagination.innerHTML = '';
  }

  function showError(msg) {
    resultsGrid.innerHTML = `
      <div class="empty-state">
        <span style="font-size:32px">⚠️</span>
        <span>Erreur lors du chargement : ${escHtml(msg)}</span>
      </div>`;
    pagination.innerHTML = '';
  }

  // ---- CARD HTML ----
  function cardHTML(r) {
    const brand    = r.nom_de_la_marque_du_produit || 'Marque inconnue';
    const title    = r.libelle_produit_type || r.noms_des_modeles_ou_references || 'Produit sans nom';
    const cat      = r.categorie_de_produit || '';
    const motif    = r.motif_du_rappel || '';
    const dateRaw  = r.date_de_publication || '';
    const date     = dateRaw ? new Date(dateRaw).toLocaleDateString('fr-FR') : '';
    const imgUrl   = r.liens_vers_les_images && r.liens_vers_les_images.trim()
                     ? r.liens_vers_les_images.split(/[\n,;]+/)[0].trim()
                     : null;

    const imgHtml = imgUrl
      ? `<img class="card-image" src="${escAttr(imgUrl)}" alt="${escAttr(title)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="card-image--placeholder" style="display:none">📦</div>`
      : `<div class="card-image--placeholder">📦</div>`;

    return `
      <article class="card" tabindex="0" role="listitem" data-guid="${escAttr(r.guid_rappel || '')}">
        ${imgHtml}
        <div class="card-header">
          <span class="card-brand">${escHtml(brand)}</span>
          <span class="card-date">${escHtml(date)}</span>
        </div>
        <div class="card-title">${escHtml(title)}</div>
        ${cat ? `<div class="card-category">${escHtml(cat)}</div>` : ''}
        <div class="card-motif">${escHtml(motif)}</div>
      </article>`;
  }

  // ---- RENDER CARDS ----
  let _lastRecords = [];

  function renderCards(records) {
    _lastRecords = records;

    if (!records.length) {
      resultsGrid.innerHTML = `
        <div class="empty-state">
          <span style="font-size:36px">🔍</span>
          <span>Aucun rappel trouvé pour ces critères.</span>
        </div>`;
      return;
    }

    resultsGrid.innerHTML = records.map(cardHTML).join('');

    resultsGrid.querySelectorAll('.card').forEach(card => {
      card.addEventListener('click', () => openModal(card.dataset.guid));
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openModal(card.dataset.guid);
        }
      });
    });
  }

  // ---- BUILD PAGE RANGE ----
  function buildPageRange(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i);
    const pages = [];
    const delta = 2;
    const left = Math.max(0, current - delta);
    const right = Math.min(total - 1, current + delta);

    pages.push(0);
    if (left > 1) pages.push('…');
    for (let i = left; i <= right; i++) {
      if (i !== 0 && i !== total - 1) pages.push(i);
    }
    if (right < total - 2) pages.push('…');
    pages.push(total - 1);
    return pages;
  }

  // ---- RENDER PAGINATION ----
  function renderPagination() {
    const totalPages = Math.ceil(state.total / 20);
    if (totalPages <= 1) { pagination.innerHTML = ''; return; }

    const range = buildPageRange(state.page, totalPages);
    let html = `<button ${state.page === 0 ? 'disabled' : ''} id="pg-prev">← Préc.</button>`;

    range.forEach(p => {
      if (p === '…') {
        html += `<button disabled>…</button>`;
      } else {
        html += `<button class="${p === state.page ? 'active' : ''}" data-page="${p}">${p + 1}</button>`;
      }
    });

    html += `<button ${state.page >= totalPages - 1 ? 'disabled' : ''} id="pg-next">Suiv. →</button>`;
    pagination.innerHTML = html;

    document.getElementById('pg-prev').addEventListener('click', () => { state.page--; search(); window.scrollTo(0, 0); });
    document.getElementById('pg-next').addEventListener('click', () => { state.page++; search(); window.scrollTo(0, 0); });
    pagination.querySelectorAll('[data-page]').forEach(btn => {
      btn.addEventListener('click', () => { state.page = parseInt(btn.dataset.page, 10); search(); window.scrollTo(0, 0); });
    });
  }

  // ---- STATUS BAR ----
  function updateStatusBar() {
    const count = state.total;
    const page  = state.page + 1;
    const total = Math.ceil(count / 20) || 1;

    if (count === 0) {
      statusBar.textContent = '';
      statusBar.classList.add('hidden');
      return;
    }
    statusBar.textContent = `${count.toLocaleString('fr-FR')} rappel(s) trouvé(s) — page ${page}/${total}`;
    statusBar.classList.remove('hidden');
  }

  // ---- OPEN MODAL ----
  function openModal(guid) {
    const r = _lastRecords.find(x => x.guid_rappel === guid);
    if (!r) return;
    modalContent.innerHTML = buildModalHTML(r);
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    modalClose.focus();
  }

  function closeModal() {
    modal.classList.remove('open');
    document.body.style.overflow = '';
  }

  function buildModalHTML(r) {
    const brand    = r.nom_de_la_marque_du_produit || 'Marque inconnue';
    const title    = r.libelle_produit_type || r.noms_des_modeles_ou_references || 'Produit sans nom';
    const cat      = r.categorie_de_produit || '';
    const motif    = r.motif_du_rappel || '';
    const risques  = r.risques_encourus_par_le_consommateur || '';
    const conduite = r.conduite_a_tenir_par_le_consommateur || '';
    const distrib  = r.distributeurs_revendeurs || '';
    const dateRaw  = r.date_de_publication || '';
    const date     = dateRaw ? new Date(dateRaw).toLocaleDateString('fr-FR', { year:'numeric', month:'long', day:'numeric' }) : '';
    const refs     = r.modeles_ou_references || r.noms_des_modeles_ou_references || '';
    const gtins    = r.gtins || r.gtin || '';
    const imgUrl   = r.liens_vers_les_images && r.liens_vers_les_images.trim()
                     ? r.liens_vers_les_images.split(/[\n,;]+/)[0].trim()
                     : null;
    const pdfLinks = r.liens_vers_les_informations_complementaires || '';

    const imgSection = imgUrl
      ? `<img src="${escAttr(imgUrl)}" alt="${escAttr(title)}" style="max-width:100%;max-height:260px;object-fit:contain;border-radius:6px;border:1px solid var(--border);padding:8px;display:block;margin:0 auto 20px" onerror="this.style.display='none'" />`
      : '';

    const row = (label, val) => val
      ? `<tr><th style="width:40%;text-align:left;padding:6px 10px;font-weight:600;color:var(--muted);font-size:12px;vertical-align:top;white-space:nowrap">${escHtml(label)}</th><td style="padding:6px 10px;font-size:13px">${escHtml(val)}</td></tr>`
      : '';

    const pdfSection = pdfLinks
      ? `<div style="margin-top:14px"><strong style="font-size:12px;color:var(--muted)">LIENS UTILES</strong><div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:8px">` +
        pdfLinks.split(/[\n,;]+/).filter(l => l.trim()).map(l => {
          const lbl = l.trim().endsWith('.pdf') ? '📄 Document PDF' : '🔗 Informations';
          return `<a href="${escAttr(l.trim())}" target="_blank" rel="noopener" style="font-size:12.5px">${lbl}</a>`;
        }).join('') +
        `</div></div>`
      : '';

    return `
      <h2 id="modal-title" style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:4px">${escHtml(title)}</h2>
      <p style="font-size:13px;color:var(--accent);font-weight:600;margin-bottom:16px">${escHtml(brand)}${cat ? ' — ' + escHtml(cat) : ''}</p>
      ${imgSection}
      <table style="width:100%;border-collapse:collapse;border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-bottom:14px">
        <tbody>
          ${row('Date de publication', date)}
          ${row('Catégorie', cat)}
          ${row('Marque', brand)}
          ${row('Modèles / Références', refs)}
          ${row('GTIN / EAN', gtins)}
          ${row('Distributeurs', distrib)}
        </tbody>
      </table>
      ${motif ? `<div style="margin-bottom:12px"><strong style="font-size:12px;color:var(--muted)">MOTIF DU RAPPEL</strong><p style="margin-top:4px;font-size:13px;line-height:1.6">${escHtml(motif)}</p></div>` : ''}
      ${risques ? `<div style="margin-bottom:12px;background:#fff5f3;border:1px solid #fca5a5;border-radius:6px;padding:12px"><strong style="font-size:12px;color:var(--accent)">⚠️ RISQUES POUR LE CONSOMMATEUR</strong><p style="margin-top:4px;font-size:13px;line-height:1.6">${escHtml(risques)}</p></div>` : ''}
      ${conduite ? `<div style="margin-bottom:12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:12px"><strong style="font-size:12px;color:var(--blue)">ℹ️ CONDUITE À TENIR</strong><p style="margin-top:4px;font-size:13px;line-height:1.6">${escHtml(conduite)}</p></div>` : ''}
      ${pdfSection}`;
  }

  // ---- ESCAPE HELPERS ----
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escAttr(str) { return escHtml(str); }

  // ---- FORM EVENTS ----
  form.addEventListener('submit', e => {
    e.preventDefault();
    state.query       = inputQ.value.trim();
    state.categorie   = selCategorie.value;
    state.zone        = selZone.value;
    state.distributeur = selDistributeur.value;
    state.dateDebut   = inputDebut.value;
    state.dateFin     = inputFin.value;
    state.orderBy     = selTri.value;
    state.page        = 0;
    search();
  });

  btnReset.addEventListener('click', () => {
    form.reset();
    Object.assign(state, { query:'', categorie:'', zone:'', distributeur:'', dateDebut:'', dateFin:'', orderBy:'date_de_publication DESC', page:0, total:0 });
    search();
  });

  // ---- MODAL EVENTS ----
  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', closeModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // ---- TAB SWITCHING (géré par analytics.js / alerts.js, exposé ici) ----
  window._switchToSearch = function () {
    document.getElementById('tab-search').classList.add('active');
    document.getElementById('tab-analytics').classList.remove('active');
    document.getElementById('tab-alerts').classList.remove('active');
    document.getElementById('panel-search').classList.remove('hidden');
    document.getElementById('panel-analytics').classList.add('hidden');
    document.getElementById('panel-alerts').classList.add('hidden');
  };

  // ---- EXPOSE POUR ANALYTICS ----
  window.getSearchWhere = buildQuery;
  window.getSearchState = () => ({ ...state });

  // ---- CHARGEMENT INITIAL ----
  search();

})();
