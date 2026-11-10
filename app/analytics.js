/* ====================================================
   RappelConso — analytics.js (module analyse / graphiques)
   ==================================================== */

(function () {
  'use strict';

  const API_REMOTE = 'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/rappelconso-v2-gtin-espaces';

  // ---- PROXY DETECTION ----
  let _useProxy = false;
  fetch('/api/status').then(r => { if (r.ok) _useProxy = true; }).catch(() => {});

  // ---- CACHE 5 MIN ----
  const _cache = new Map();
  const CACHE_TTL = 5 * 60 * 1000;

  function cacheGet(key) {
    const entry = _cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return null; }
    return entry.data;
  }

  function cacheSet(key, data) {
    _cache.set(key, { ts: Date.now(), data });
  }

  // ---- FETCH WITH RETRY (503 → retry après retry_ms) ----
  async function fetchWithRetry(url, maxTries = 5) {
    for (let i = 0; i < maxTries; i++) {
      const resp = await fetch(url);
      if (resp.status === 503) {
        let wait = 3000;
        try { const j = await resp.json(); if (j.retry_ms) wait = j.retry_ms; } catch (_) {}
        await new Promise(res => setTimeout(res, wait));
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    }
    throw new Error('Trop de tentatives (503)');
  }

  // ---- API FETCH (proxy ou direct) ----
  async function apiFetch(path, params = {}) {
    let url;
    if (_useProxy) {
      const p = new URLSearchParams({ ...params, _path: path });
      url = `/api/proxy?${p.toString()}`;
    } else {
      const p = new URLSearchParams(params);
      url = `${API_REMOTE}${path}?${p.toString()}`;
    }

    const cached = cacheGet(url);
    if (cached) return cached;

    const data = await fetchWithRetry(url);
    cacheSet(url, data);
    return data;
  }

  // ---- API FACETS ----
  async function apiFacets(baseWhere, ...facetNames) {
    const params = { limit: '1', facet: facetNames.join(','), timezone: 'Europe/Paris' };
    if (baseWhere) params.where = baseWhere;
    return apiFetch('/facets', params);
  }

  // ---- API COUNT ----
  async function apiCount(baseWhere, extraWhere) {
    const clauses = [baseWhere, extraWhere].filter(Boolean);
    const where = clauses.join(' AND ');
    const params = { limit: '1', timezone: 'Europe/Paris', select: 'count(*) as cnt' };
    if (where) params.where = where;
    const data = await apiFetch('/records', params);
    return (data.results && data.results[0] && data.results[0].cnt != null)
      ? Number(data.results[0].cnt)
      : (data.total_count || 0);
  }

  // ---- MONTHLY TIMELINE (24 mois) ----
  async function apiMonthlyTimeline(baseWhere) {
    const params = {
      limit: '24',
      order_by: 'annee DESC, mois DESC',
      select: 'year(date_de_publication) as annee, month(date_de_publication) as mois, count(*) as cnt',
      group_by: 'annee, mois',
      timezone: 'Europe/Paris'
    };
    if (baseWhere) params.where = baseWhere;
    return apiFetch('/records', params);
  }

  // ---- BY REGION ----
  async function apiByRegion(baseWhere) {
    const params = { limit: '50', select: 'zone_geographique_de_vente, count(*) as cnt', group_by: 'zone_geographique_de_vente', timezone: 'Europe/Paris' };
    if (baseWhere) params.where = baseWhere;
    return apiFetch('/records', params);
  }

  // ---- TAB REFS ----
  const tabSearch    = document.getElementById('tab-search');
  const tabAnalytics = document.getElementById('tab-analytics');
  const tabAlerts    = document.getElementById('tab-alerts');
  const panelSearch  = document.getElementById('panel-search');
  const panelAnalytics = document.getElementById('panel-analytics');
  const panelAlerts  = document.getElementById('panel-alerts');

  let lastAnalyticsWhere = '__NONE__';

  function switchToAnalytics() {
    tabSearch.classList.remove('active');    tabSearch.setAttribute('aria-selected', 'false');
    tabAlerts.classList.remove('active');    tabAlerts.setAttribute('aria-selected', 'false');
    tabAnalytics.classList.add('active');    tabAnalytics.setAttribute('aria-selected', 'true');
    panelSearch.classList.add('hidden');
    panelAlerts.classList.add('hidden');
    panelAnalytics.classList.remove('hidden');

    const where = (typeof window.getSearchWhere === 'function') ? window.getSearchWhere() : '';
    if (where !== lastAnalyticsWhere) {
      lastAnalyticsWhere = where;
      loadAnalytics(where);
    }
  }

  tabAnalytics.addEventListener('click', switchToAnalytics);

  tabSearch.addEventListener('click', () => {
    tabAnalytics.classList.remove('active'); tabAnalytics.setAttribute('aria-selected', 'false');
    tabAlerts.classList.remove('active');    tabAlerts.setAttribute('aria-selected', 'false');
    tabSearch.classList.add('active');       tabSearch.setAttribute('aria-selected', 'true');
    panelAnalytics.classList.add('hidden');
    panelAlerts.classList.add('hidden');
    panelSearch.classList.remove('hidden');
  });

  // ---- RENDER FILTER CONTEXT ----
  function renderFilterContext(where) {
    const ctx    = document.getElementById('analytics-filter-context');
    const tagsEl = document.getElementById('analytics-filter-tags');

    if (!where) {
      ctx.className = 'analytics-filter-context analytics-filter-context--none';
      tagsEl.innerHTML = 'Aucun filtre — analyse globale';
      return;
    }

    ctx.className = 'analytics-filter-context analytics-filter-context--active';
    // Build readable tags from where clause
    const tags = [];
    const patterns = [
      { re: /categorie_de_produit = '([^']+)'/, label: cat => `Catégorie : ${cat}` },
      { re: /zone_geographique_de_vente = '([^']+)'/, label: z => `Zone : ${z}` },
      { re: /distributeurs_revendeurs LIKE '%([^%']+)%'/, label: d => `Distributeur : ${d}` },
      { re: /nom_de_la_marque_du_produit LIKE '%([^%']+)%'/, label: q => `Recherche : ${q}` },
      { re: /libelle_produit_type LIKE '%([^%']+)%'/, label: q => `Produit : ${q}` },
      { re: /date_de_publication >= '([^T']+)/, label: d => `Depuis : ${d}` },
      { re: /date_de_publication <= '([^T']+)/, label: d => `Jusqu'au : ${d}` }
    ];

    patterns.forEach(({ re, label }) => {
      const m = where.match(re);
      if (m) tags.push(label(m[1]));
    });

    if (!tags.length) tags.push('Filtre personnalisé');
    tagsEl.innerHTML = tags.map(t => `<span class="filter-tag">${escHtml(t)}</span>`).join('');
  }

  // ---- LOAD ANALYTICS ----
  async function loadAnalytics(baseWhere) {
    const loadingEl = document.getElementById('analytics-loading');
    loadingEl.classList.add('visible');
    resetKPIs();
    clearCharts();
    renderFilterContext(baseWhere);

    try {
      // Phase 1 : 3 requêtes parallèles
      const [facetData, totalCount, timelineData] = await Promise.all([
        apiFacets(baseWhere, 'categorie_de_produit', 'rappel_guid', 'nature_juridique_du_rappel', 'sous_categorie_de_produit', 'risques_encourus_par_le_consommateur'),
        apiCount(baseWhere, null),
        apiMonthlyTimeline(baseWhere)
      ]);

      loadingEl.classList.remove('visible');

      document.getElementById('kpi-total-val').textContent = totalCount.toLocaleString('fr-FR');

      // Catégories
      const catFacet = getFacetValues(facetData, 'categorie_de_produit');
      renderHBar('chart-categories', catFacet.slice(0, 10), '#e34b2a');

      // Sous-catégories
      const subFacet = getFacetValues(facetData, 'sous_categorie_de_produit');
      renderHBar('chart-subcategories', subFacet.slice(0, 10), '#7c3aed');

      // Risques / nature juridique
      const natFacet = getFacetValues(facetData, 'nature_juridique_du_rappel');
      renderHBar('chart-risks', natFacet.slice(0, 8), '#f59e0b');

      // Nature du risque → donut
      const riskFacet = getFacetValues(facetData, 'risques_encourus_par_le_consommateur');
      renderDonut('chart-nature', riskFacet.slice(0, 6), totalCount);

      // Courbe temporelle
      renderLineChart('chart-timeline', timelineData.results || []);

      // Phase 2 : KPI supplémentaires en background
      Promise.all([
        apiCount(baseWhere, "risques_encourus_par_le_consommateur LIKE '%grave%' OR risques_encourus_par_le_consommateur LIKE '%mort%' OR risques_encourus_par_le_consommateur LIKE '%danger%'"),
        apiCount(baseWhere, `date_de_publication >= '${recentDate()}'`),
        apiCount(baseWhere, "nature_juridique_du_rappel LIKE '%imposé%' OR nature_juridique_du_rappel LIKE '%ordonnance%'"),
        apiByRegion(baseWhere)
      ]).then(([dangerCount, recentCount, imposedCount, regionData]) => {
        document.getElementById('kpi-danger-val').textContent = dangerCount.toLocaleString('fr-FR');
        document.getElementById('kpi-recent-val').textContent = recentCount.toLocaleString('fr-FR');
        document.getElementById('kpi-imposed-val').textContent = imposedCount.toLocaleString('fr-FR');
        renderFranceMap('chart-map', buildRegionCounts(regionData.results || []));
      }).catch(err => console.warn('Phase 2 analytics:', err));

    } catch (err) {
      loadingEl.classList.remove('visible');
      document.getElementById('charts-row').innerHTML = `<div class="empty-state" style="grid-column:1/-1">⚠️ Erreur chargement : ${escHtml(err.message)}</div>`;
    }
  }

  function resetKPIs() {
    ['kpi-total-val','kpi-danger-val','kpi-recent-val','kpi-imposed-val'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '—';
    });
  }

  function clearCharts() {
    ['chart-categories','chart-risks','chart-timeline','chart-subcategories','chart-nature','chart-map'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:10px">Chargement…</div>';
    });
  }

  function getFacetValues(data, facetName) {
    if (!data || !data.facets) return [];
    const f = data.facets.find(x => x.name === facetName);
    return f && f.facets ? f.facets.map(v => ({ label: v.value, count: v.count })) : [];
  }

  function recentDate() {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  }

  // ---- RENDER HBAR ----
  function renderHBar(containerId, data, color) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!data.length) { el.innerHTML = '<span style="color:var(--muted);font-size:12px">Pas de données</span>'; return; }

    const max = Math.max(...data.map(d => d.count), 1);
    el.innerHTML = `<div class="hbar-chart">` +
      data.map(d => {
        const pct = (d.count / max * 100).toFixed(1);
        return `<div class="hbar-row">
          <span class="hbar-label" title="${escAttr(d.label)}">${escHtml(d.label)}</span>
          <div class="hbar-track"><div class="hbar-fill" style="width:${pct}%;background:${color}"></div></div>
          <span class="hbar-count">${Number(d.count).toLocaleString('fr-FR')}</span>
        </div>`;
      }).join('') +
      `</div>`;
  }

  // ---- RENDER LINE CHART ----
  function renderLineChart(containerId, months) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!months.length) { el.innerHTML = '<span style="color:var(--muted);font-size:12px">Pas de données</span>'; return; }

    // Trier chronologiquement
    const sorted = [...months].sort((a, b) => {
      if (a.annee !== b.annee) return a.annee - b.annee;
      return a.mois - b.mois;
    });

    const W = 580, H = 180, PAD = { top: 16, right: 16, bottom: 36, left: 44 };
    const inner_w = W - PAD.left - PAD.right;
    const inner_h = H - PAD.top - PAD.bottom;

    const counts = sorted.map(m => m.cnt);
    const maxVal = Math.max(...counts, 1);
    const n = sorted.length;

    const xPos = i => PAD.left + (n <= 1 ? inner_w / 2 : (i / (n - 1)) * inner_w);
    const yPos = v => PAD.top + inner_h - (v / maxVal) * inner_h;

    const moisNames = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];

    // Area path
    let area = `M ${xPos(0)} ${PAD.top + inner_h}`;
    sorted.forEach((_, i) => { area += ` L ${xPos(i)} ${yPos(counts[i])}`; });
    area += ` L ${xPos(n-1)} ${PAD.top + inner_h} Z`;

    // Line path
    let line = `M ${xPos(0)} ${yPos(counts[0])}`;
    sorted.forEach((_, i) => { if (i > 0) line += ` L ${xPos(i)} ${yPos(counts[i])}`; });

    const dots = sorted.map((m, i) => {
      const lbl = `${moisNames[(m.mois || 1) - 1]} ${m.annee}`;
      return `<circle cx="${xPos(i)}" cy="${yPos(counts[i])}" r="3" fill="#e34b2a" stroke="#fff" stroke-width="1.5">
        <title>${escHtml(lbl)} : ${Number(counts[i]).toLocaleString('fr-FR')}</title>
      </circle>`;
    }).join('');

    // X labels (every 4 or every 6)
    const step = n <= 12 ? 2 : 4;
    const xLabels = sorted.map((m, i) => {
      if (i % step !== 0 && i !== n - 1) return '';
      const lbl = `${moisNames[(m.mois || 1) - 1]} ${String(m.annee).slice(2)}`;
      return `<text x="${xPos(i)}" y="${H - 6}" text-anchor="middle" font-size="10">${escHtml(lbl)}</text>`;
    }).join('');

    // Y labels
    const yStep = Math.ceil(maxVal / 4);
    const yLabels = [0, 1, 2, 3, 4].map(k => {
      const val = k * yStep;
      if (val > maxVal) return '';
      const y = yPos(val);
      return `<text x="${PAD.left - 4}" y="${y + 4}" text-anchor="end" font-size="10">${val}</text>
              <line x1="${PAD.left}" y1="${y}" x2="${PAD.left + inner_w}" y2="${y}" stroke="#e2e5ea" stroke-width="1"/>`;
    }).join('');

    el.innerHTML = `
      <svg class="line-chart-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#e34b2a" stop-opacity="0.25"/>
            <stop offset="100%" stop-color="#e34b2a" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        ${yLabels}
        <path d="${area}" fill="url(#areaGrad)"/>
        <path d="${line}" fill="none" stroke="#e34b2a" stroke-width="2" stroke-linejoin="round"/>
        ${dots}
        ${xLabels}
      </svg>`;
  }

  // ---- RENDER DONUT ----
  const DONUT_COLORS = ['#e34b2a','#f59e0b','#2563eb','#10b981','#7c3aed','#ec4899'];

  function renderDonut(containerId, data, total) {
    const el = document.getElementById(containerId);
    if (!el || !data.length) { if (el) el.innerHTML = '<span style="color:var(--muted);font-size:12px">Pas de données</span>'; return; }

    const cx = 70, cy = 70, R = 52, r = 32;
    let cumAngle = -Math.PI / 2;
    const slices = data.map((d, i) => {
      const angle = (d.count / total) * 2 * Math.PI;
      const x1 = cx + R * Math.cos(cumAngle);
      const y1 = cy + R * Math.sin(cumAngle);
      cumAngle += angle;
      const x2 = cx + R * Math.cos(cumAngle);
      const y2 = cy + R * Math.sin(cumAngle);
      const xi1 = cx + r * Math.cos(cumAngle);
      const yi1 = cy + r * Math.sin(cumAngle);
      const xi2 = cx + r * Math.cos(cumAngle - angle);
      const yi2 = cy + r * Math.sin(cumAngle - angle);
      const large = angle > Math.PI ? 1 : 0;
      const path = `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${xi1.toFixed(2)} ${yi1.toFixed(2)} A ${r} ${r} 0 ${large} 0 ${xi2.toFixed(2)} ${yi2.toFixed(2)} Z`;
      return { path, color: DONUT_COLORS[i % DONUT_COLORS.length], label: d.label, count: d.count };
    });

    const svgSlices = slices.map(s =>
      `<path d="${s.path}" fill="${s.color}" stroke="#fff" stroke-width="1.5" opacity="0.9"><title>${escHtml(s.label)}: ${Number(s.count).toLocaleString('fr-FR')}</title></path>`
    ).join('');

    const legend = slices.map(s => {
      const pct = total > 0 ? ((s.count / total) * 100).toFixed(1) : 0;
      return `<div class="donut-legend-item">
        <div class="donut-legend-dot" style="background:${s.color}"></div>
        <span class="donut-legend-label">${escHtml(s.label.slice(0, 28))}</span>
        <span class="donut-legend-pct">${pct}%</span>
      </div>`;
    }).join('');

    el.innerHTML = `
      <div class="donut-wrap">
        <svg class="donut-svg" viewBox="0 0 140 140" xmlns="http://www.w3.org/2000/svg">
          ${svgSlices}
        </svg>
        <div class="donut-legend">${legend}</div>
      </div>`;
  }

  // ---- REGIONS SVG ----
  const REGIONS_SVG = [
    {
      id: 'hauts-de-france',
      name: 'Hauts-de-France',
      lx: 390, ly: 98,
      path: 'M370,60 L430,58 L445,78 L440,105 L415,112 L390,108 L365,95 L362,72 Z'
    },
    {
      id: 'normandie',
      name: 'Normandie',
      lx: 247, ly: 155,
      path: 'M200,80 L290,76 L298,100 L285,130 L255,145 L220,140 L195,118 L188,98 Z'
    },
    {
      id: 'bretagne',
      name: 'Bretagne',
      lx: 103, ly: 207,
      path: 'M80,165 L155,158 L165,185 L140,210 L95,225 L68,212 L70,188 Z'
    },
    {
      id: 'ile-de-france',
      name: 'Île-de-France',
      lx: 365, ly: 172,
      path: 'M345,155 L385,152 L392,175 L378,190 L350,188 L338,172 Z'
    },
    {
      id: 'grand-est',
      name: 'Grand Est',
      lx: 512, ly: 175,
      path: 'M450,105 L540,100 L558,128 L555,195 L510,210 L468,198 L448,170 L452,130 Z'
    },
    {
      id: 'pays-de-la-loire',
      name: 'Pays de la Loire',
      lx: 208, ly: 258,
      path: 'M155,215 L245,210 L255,248 L235,275 L195,278 L158,265 L148,242 Z'
    },
    {
      id: 'centre-val-de-loire',
      name: 'Centre-Val de Loire',
      lx: 317, ly: 245,
      path: 'M258,200 L360,196 L368,240 L350,270 L295,272 L258,255 Z'
    },
    {
      id: 'bourgogne-franche-comte',
      name: 'Bourgogne-Franche-Comté',
      lx: 472, ly: 258,
      path: 'M420,198 L520,195 L528,245 L510,285 L460,290 L425,268 L418,230 Z'
    },
    {
      id: 'nouvelle-aquitaine',
      name: 'Nouvelle-Aquitaine',
      lx: 243, ly: 388,
      path: 'M148,285 L300,280 L318,340 L305,420 L245,445 L175,430 L138,380 L140,325 Z'
    },
    {
      id: 'auvergne-rhone-alpes',
      name: 'Auvergne-Rhône-Alpes',
      lx: 465, ly: 372,
      path: 'M368,280 L480,275 L502,310 L505,390 L472,418 L415,415 L368,385 L360,330 Z'
    },
    {
      id: 'occitanie',
      name: 'Occitanie',
      lx: 335, ly: 472,
      path: 'M175,435 L370,425 L385,460 L360,510 L275,525 L195,510 L162,478 Z'
    },
    {
      id: 'provence-alpes-cote-d-azur',
      name: "Provence-Alpes-Côte d'Azur",
      lx: 530, ly: 455,
      path: 'M455,410 L548,405 L562,428 L550,470 L508,482 L468,468 L448,445 Z'
    },
    {
      id: 'corse',
      name: 'Corse',
      lx: 548, ly: 535,
      path: 'M548,512 L560,510 L568,530 L558,555 L546,558 L538,542 L540,520 Z'
    }
  ];

  const DOMTOM_SVG = [
    { id: 'guadeloupe', name: 'Guadeloupe', x: 20, y: 570, w: 40, h: 20 },
    { id: 'martinique', name: 'Martinique', x: 68, y: 570, w: 40, h: 20 },
    { id: 'guyane',     name: 'Guyane',     x: 116, y: 570, w: 40, h: 20 },
    { id: 'reunion',    name: 'La Réunion', x: 164, y: 570, w: 40, h: 20 }
  ];

  const REGION_API_NAMES = {
    'hauts-de-france': ['Hauts-de-France'],
    'normandie': ['Normandie'],
    'bretagne': ['Bretagne'],
    'ile-de-france': ['Île-de-France', 'Ile-de-France'],
    'grand-est': ['Grand Est'],
    'pays-de-la-loire': ['Pays de la Loire'],
    'centre-val-de-loire': ['Centre-Val de Loire'],
    'bourgogne-franche-comte': ['Bourgogne-Franche-Comté', 'Bourgogne-Franche-Comte'],
    'nouvelle-aquitaine': ['Nouvelle-Aquitaine'],
    'auvergne-rhone-alpes': ['Auvergne-Rhône-Alpes', 'Auvergne-Rhone-Alpes'],
    'occitanie': ['Occitanie'],
    'provence-alpes-cote-d-azur': ["Provence-Alpes-Côte d'Azur", "Provence-Alpes-Cote d'Azur"],
    'corse': ['Corse']
  };

  function buildRegionCounts(results) {
    const counts = {};
    results.forEach(r => {
      const zone = r.zone_geographique_de_vente || '';
      const cnt  = Number(r.cnt) || 0;
      for (const [regionId, aliases] of Object.entries(REGION_API_NAMES)) {
        if (aliases.some(a => zone.toLowerCase() === a.toLowerCase())) {
          counts[regionId] = (counts[regionId] || 0) + cnt;
        }
      }
    });
    return counts;
  }

  // ---- RENDER FRANCE MAP ----
  function renderFranceMap(containerId, regionCounts) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const maxCount = Math.max(...Object.values(regionCounts), 1);

    function heatColor(count) {
      if (!count) return '#f0f0f0';
      const t = count / maxCount;
      // Blanc → rouge (#e34b2a)
      const r = Math.round(255 - (255 - 227) * t);
      const g = Math.round(255 - (255 - 75) * t);
      const b = Math.round(255 - (255 - 42) * t);
      return `rgb(${r},${g},${b})`;
    }

    const regionPaths = REGIONS_SVG.map(reg => {
      const count = regionCounts[reg.id] || 0;
      const fill = heatColor(count);
      const lbl = count > 0 ? `${reg.name}: ${count.toLocaleString('fr-FR')} rappel(s)` : reg.name;
      return `<path class="map-region" d="${reg.path}" fill="${fill}" stroke="#fff" stroke-width="1.5" stroke-linejoin="round">
        <title>${escHtml(lbl)}</title>
      </path>
      <text x="${reg.lx}" y="${reg.ly}" text-anchor="middle" font-size="9" fill="${count > maxCount * 0.5 ? '#fff' : '#555'}" pointer-events="none">${escHtml(reg.name.length > 12 ? reg.name.slice(0,12)+'…' : reg.name)}</text>`;
    }).join('');

    const domtomPaths = DOMTOM_SVG.map(d => {
      const count = regionCounts[d.id] || 0;
      const fill  = heatColor(count);
      return `<rect x="${d.x}" y="${d.y}" width="${d.w}" height="${d.h}" fill="${fill}" stroke="#fff" stroke-width="1" rx="2">
        <title>${escHtml(d.name)}: ${count.toLocaleString('fr-FR')}</title>
      </rect>
      <text x="${d.x + d.w/2}" y="${d.y + d.h/2 + 4}" text-anchor="middle" font-size="8" fill="#555" pointer-events="none">${escHtml(d.name.slice(0,8))}</text>`;
    }).join('');

    // Classement régions
    const sorted = REGIONS_SVG
      .map(reg => ({ name: reg.name, count: regionCounts[reg.id] || 0 }))
      .filter(x => x.count > 0)
      .sort((a, b) => b.count - a.count);

    const rankingRows = sorted.slice(0, 8).map((r, i) =>
      `<div class="map-ranking-row">
        <span class="map-rank-num">${i+1}.</span>
        <span class="map-rank-name">${escHtml(r.name)}</span>
        <span class="map-rank-val">${r.count.toLocaleString('fr-FR')}</span>
      </div>`
    ).join('');

    el.innerHTML = `
      <div class="map-wrap">
        <svg class="map-svg" viewBox="0 0 620 600" xmlns="http://www.w3.org/2000/svg">
          ${regionPaths}
          <text x="12" y="565" font-size="8" fill="#999">DOM-TOM</text>
          ${domtomPaths}
        </svg>
        <div>
          <div class="map-legend">
            <div>Rappels par région</div>
            <div class="map-legend-gradient" style="background:linear-gradient(to right,#f0f0f0,#e34b2a)"></div>
            <div style="display:flex;justify-content:space-between">
              <span>0</span><span>${maxCount.toLocaleString('fr-FR')}</span>
            </div>
          </div>
          ${sorted.length ? `<div class="map-ranking">${rankingRows}</div>` : ''}
        </div>
      </div>`;
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
