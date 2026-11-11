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
    // Construire l'URL avec URLSearchParams pour gérer les params répétés (facet)
    let url;
    const p = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (Array.isArray(v)) v.forEach(vi => p.append(k, vi));
      else p.append(k, v);
    });
    if (_useProxy) {
      p.append('_path', path);
      url = `/api/proxy?${p.toString()}`;
    } else {
      url = `${API_REMOTE}${path}?${p.toString()}`;
    }

    const cached = cacheGet(url);
    if (cached) return cached;

    const data = await fetchWithRetry(url);
    cacheSet(url, data);
    return data;
  }

  // ---- API FACETS ----
  // L'API n'accepte pas facet=X,Y — il faut répéter le paramètre : facet=X&facet=Y
  async function apiFacets(baseWhere, ...facetNames) {
    const params = { limit: '1', facet: facetNames, timezone: 'Europe/Paris' };
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

  // ---- MONTHLY TIMELINE (12 derniers mois) ----
  // group_by et order_by doivent utiliser les expressions complètes (pas les alias)
  async function apiMonthlyTimeline(baseWhere) {
    // Calculer la date il y a 12 mois
    const since = new Date();
    since.setMonth(since.getMonth() - 11);
    since.setDate(1);
    const sinceStr = since.toISOString().slice(0, 10) + 'T00:00:00';

    const clauses = [`date_publication >= '${sinceStr}'`];
    if (baseWhere) clauses.push(baseWhere);

    const params = {
      limit: '12',
      order_by: 'year(date_publication) DESC, month(date_publication) DESC',
      select: 'year(date_publication) as annee, month(date_publication) as mois, count(*) as cnt',
      group_by: 'year(date_publication), month(date_publication)',
      timezone: 'Europe/Paris',
      where: clauses.join(' AND ')
    };
    return apiFetch('/records', params);
  }

  // ---- BY REGION ----
  // Stratégie : une requête count par région + une pour "france entière"
  // (2095 zones distinctes → impossible de tout récupérer en une requête)
  async function apiByRegion(baseWhere) {
    const regionNames = [
      'île-de-france', 'centre-val de loire', 'bourgogne-franche-comté',
      'normandie', 'hauts-de-france', 'grand-est', 'pays-de-la-loire',
      'bretagne', 'nouvelle-aquitaine', 'occitanie', 'auvergne-rhône-alpes',
      "provence-alpes-côte d'azur", 'corse',
      'guadeloupe', 'martinique', 'guyane', 'réunion', 'reunion'
    ];

    // Construire une requête unique qui compte par région avec LIKE
    // On utilise des requêtes SELECT CASE pour grouper les zones
    const requests = regionNames.map(name => {
      const escaped = name.replace(/'/g, "\\'");
      const clauses = [
        `zone_geographique_de_vente LIKE '%${escaped}%'`,
        `NOT (zone_geographique_de_vente LIKE '%france entière%')`
      ];
      if (baseWhere) clauses.push(baseWhere);
      return apiCount(clauses.join(' AND '), null).then(cnt => ({
        zone_geographique_de_vente: name,
        cnt
      }));
    });

    // Requête séparée pour "france entière"
    const franceWhere = [
      `zone_geographique_de_vente = 'france entière'`,
      baseWhere
    ].filter(Boolean).join(' AND ');
    requests.push(
      apiCount(franceWhere, null).then(cnt => ({
        zone_geographique_de_vente: 'france entière',
        cnt
      }))
    );

    const results = await Promise.all(requests);
    return { results: results.filter(r => r.cnt > 0) };
  }

  // ---- TAB REFS ----
  const tabSearch    = document.getElementById('tab-search');
  const tabAnalytics = document.getElementById('tab-analytics');
  const tabAlerts    = document.getElementById('tab-alerts');
  const panelSearch  = document.getElementById('panel-search');
  const panelAnalytics = document.getElementById('panel-analytics');
  const panelAlerts  = document.getElementById('panel-alerts');

  let lastAnalyticsWhere = '__NONE__';
  let _analyticsToken = 0; // incrémenté à chaque loadAnalytics pour annuler les phases en retard

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
      { re: /categorie_produit = '([^']+)'/, label: cat => `Catégorie : ${cat}` },
      { re: /zone_geographique_de_vente = '([^']+)'/, label: z => `Zone : ${z}` },
      { re: /distributeurs LIKE '%([^%']+)%'/, label: d => `Distributeur : ${d}` },
      { re: /marque_produit LIKE '%([^%']+)%'/, label: q => `Recherche : ${q}` },
      { re: /libelle LIKE '%([^%']+)%'/, label: q => `Produit : ${q}` },
      { re: /date_publication >= '([^T']+)/, label: d => `Depuis : ${d}` },
      { re: /date_publication <= '([^T']+)/, label: d => `Jusqu'au : ${d}` }
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
    const token = ++_analyticsToken; // chaque appel a son propre token
    const loadingEl = document.getElementById('analytics-loading');
    loadingEl.classList.add('visible');
    resetKPIs();
    clearCharts();
    renderFilterContext(baseWhere);

    try {
      // Phase 1 : 3 requêtes parallèles
      const [facetData, totalCount, timelineData] = await Promise.all([
        apiFacets(baseWhere, 'categorie_produit', 'rappel_guid', 'nature_juridique_rappel', 'sous_categorie_produit', 'risques_encourus'),
        apiCount(baseWhere, null),
        apiMonthlyTimeline(baseWhere)
      ]);

      if (token !== _analyticsToken) return; // filtre changé entre-temps

      loadingEl.classList.remove('visible');

      document.getElementById('kpi-total-val').textContent = totalCount.toLocaleString('fr-FR');

      // Catégories
      const catFacet = getFacetValues(facetData, 'categorie_produit');
      renderHBar('chart-categories', catFacet.slice(0, 10), '#e34b2a');

      // Sous-catégories
      const subFacet = getFacetValues(facetData, 'sous_categorie_produit');
      renderHBar('chart-subcategories', subFacet.slice(0, 10), '#7c3aed');

      // Risques / nature juridique
      const natFacet = getFacetValues(facetData, 'nature_juridique_rappel');
      renderHBar('chart-risks', natFacet.slice(0, 8), '#f59e0b');

      // Nature du risque → donut
      const riskFacet = getFacetValues(facetData, 'risques_encourus');
      renderDonut('chart-nature', riskFacet.slice(0, 6), totalCount);

      // Courbe temporelle
      renderLineChart('chart-timeline', timelineData.results || []);

      // Phase 2 : KPI + carte en background
      Promise.all([
        apiCount(baseWhere, "risques_encourus LIKE '%grave%' OR risques_encourus LIKE '%mort%' OR risques_encourus LIKE '%danger%'"),
        apiCount(baseWhere, `date_publication >= '${recentDate()}'`),
        apiCount(baseWhere, "nature_juridique_rappel LIKE '%imposé%' OR nature_juridique_rappel LIKE '%ordonnance%'"),
        apiByRegion(baseWhere)
      ]).then(([dangerCount, recentCount, imposedCount, regionData]) => {
        if (token !== _analyticsToken) return; // filtre changé entre-temps
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

    // Normaliser les champs (l'API retourne "year(date_publication)" comme clé, pas "annee")
    const normalized = months.map(m => ({
      annee: m.annee ?? m['year(date_publication)'] ?? 0,
      mois:  m.mois  ?? m['month(date_publication)'] ?? 1,
      cnt:   Number(m.cnt) || 0
    }));

    // Compléter avec les 12 derniers mois (mois sans données → cnt = 0)
    const lookup = new Map(normalized.map(m => [`${m.annee}-${m.mois}`, m.cnt]));
    const sorted = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const a = d.getFullYear(), mo = d.getMonth() + 1;
      sorted.push({ annee: a, mois: mo, cnt: lookup.get(`${a}-${mo}`) || 0 });
    }

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

    // X labels — tous les mois (12 points)
    const xLabels = sorted.map((m, i) => {
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
  // Pas de données statiques — carte chargée depuis GeoJSON officiel France (geo.api.gouv.fr)
  const DOMTOM_SVG = [
    { id: 'guadeloupe', name: 'Guadeloupe', x: 14,  y: 500, w: 52, h: 24 },
    { id: 'martinique', name: 'Martinique', x: 74,  y: 500, w: 52, h: 24 },
    { id: 'guyane',     name: 'Guyane',     x: 134, y: 500, w: 52, h: 24 },
    { id: 'reunion',    name: 'La Réunion', x: 194, y: 500, w: 52, h: 24 }
  ];

  // Map nom région API (minuscules) → code INSEE région
  const REGION_CODE = {
    'île-de-france': '11', 'ile-de-france': '11',
    'centre-val de loire': '24',
    'bourgogne-franche-comté': '27', 'bourgogne-franche-comte': '27',
    'normandie': '28',
    'hauts-de-france': '32',
    'grand-est': '44',
    'pays-de-la-loire': '52',
    'bretagne': '53',
    'nouvelle-aquitaine': '75',
    'occitanie': '76',
    'auvergne-rhône-alpes': '84', 'auvergne-rhone-alpes': '84',
    "provence-alpes-côte d'azur": '93', "provence-alpes-cote d'azur": '93',
    'corse': '94'
  };
  const CODE_NAME = {
    '11':'Île-de-France','24':'Centre-Val de Loire','27':'Bourgogne-Franche-Comté',
    '28':'Normandie','32':'Hauts-de-France','44':'Grand Est',
    '52':'Pays de la Loire','53':'Bretagne','75':'Nouvelle-Aquitaine',
    '76':'Occitanie','84':'Auvergne-Rhône-Alpes',"93":"PACA",'94':'Corse'
  };
  const REGIONS_SVG = []; // vide — la carte GeoJSON remplace

  // Correspondance avec les valeurs réelles de l'API (minuscules)
  const REGION_API_NAMES = {
    'hauts-de-france':           ['hauts-de-france'],
    'normandie':                 ['normandie'],
    'bretagne':                  ['bretagne'],
    'ile-de-france':             ['île-de-france', 'ile-de-france'],
    'grand-est':                 ['grand-est'],
    'pays-de-la-loire':          ['pays-de-la-loire'],
    'centre-val-de-loire':       ['centre-val de loire'],
    'bourgogne-franche-comte':   ['bourgogne-franche-comté', 'bourgogne-franche-comte'],
    'nouvelle-aquitaine':        ['nouvelle-aquitaine'],
    'auvergne-rhone-alpes':      ['auvergne-rhône-alpes', 'auvergne-rhone-alpes'],
    'occitanie':                 ['occitanie'],
    'provence-alpes-cote-d-azur':["provence-alpes-côte d'azur", "provence-alpes-cote d'azur"],
    'corse':                     ['corse'],
    'guadeloupe':                ['guadeloupe (971)', 'guadeloupe'],
    'martinique':                ['martinique (972)', 'martinique'],
    'guyane':                    ['guyane (973)', 'guyane'],
    'reunion':                   ['reunion (974)', 'réunion', 'la réunion']
  };

  function buildRegionCounts(results) {
    // Retourne { regionId → count } + clé spéciale '__france__' pour les rappels "france entière"
    const counts = {};
    results.forEach(r => {
      const zone = (r.zone_geographique_de_vente || '').toLowerCase();
      const cnt  = Number(r.cnt) || 0;
      // Rappels valables pour toute la France → stocker séparément
      if (zone === 'france entière' || zone === 'france entiere' || zone === '') {
        counts['__france__'] = (counts['__france__'] || 0) + cnt;
        return;
      }
      for (const [regionId, aliases] of Object.entries(REGION_API_NAMES)) {
        if (aliases.some(a => zone === a || zone.includes(a))) {
          counts[regionId] = (counts[regionId] || 0) + cnt;
        }
      }
    });
    return counts;
  }

  // ---- RENDER FRANCE MAP (paths pré-calculés depuis GeoJSON IGN simplifié) ----
  // Généré depuis github.com/gregoiredavid/france-geojson — projection lon/lat linéaire W=500 H=460
  const METRO_REGIONS = null; // chargé depuis regions.json au premier appel
  let _regionsData = null;

  function renderFranceMap(containerId, regionCounts) {
    const el = document.getElementById(containerId);
    if (!el) return;

    if (_regionsData) {
      _drawMap(el, _regionsData, regionCounts);
      return;
    }

    el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:300px;color:var(--muted);font-size:13px">
      <div class="spinner" style="width:20px;height:20px;border-width:2px;margin-right:8px"></div>Chargement…</div>`;

    fetch('regions.json')
      .then(r => r.json())
      .then(data => { _regionsData = data; _drawMap(el, data, regionCounts); })
      .catch(() => {
        el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:20px;text-align:center">Carte indisponible</div>';
      });
  }

  function _drawMap(el, regions, regionCounts) {
    const W = 520, H = 480;

    // byCode = counts régionaux réels (sans france entière)
    // byCodeDisplay = counts pour la chaleur de la carte (inclut france entière distribué)
    const byCode = {};
    const franceTotal = regionCounts['__france__'] || 0;
    const francePart  = Math.round(franceTotal / 13);

    Object.entries(regionCounts).forEach(([apiName, cnt]) => {
      if (apiName === '__france__') return;
      const code = REGION_CODE[apiName];
      if (code) byCode[code] = (byCode[code] || 0) + cnt;
    });

    // Pour l'affichage de la chaleur, ajouter la part nationale à chaque région
    const byCodeDisplay = {};
    regions.forEach(r => {
      byCodeDisplay[r.code] = (byCode[r.code] || 0) + francePart;
    });

    const maxCount = Math.max(...Object.values(byCodeDisplay), 1);

    function heatColor(count) {
      if (!count) return '#dde8f0';
      const t = Math.pow(count / maxCount, 0.5);
      const r = Math.round(255 - (255 - 227) * t);
      const g = Math.round(255 - (255 - 75) * t);
      const b = Math.round(255 - (255 - 42) * t);
      return `rgb(${r},${g},${b})`;
    }

    // Abréviations pour les noms longs
    const ABBR = {
      "Bourgogne-Franche-Comté":   "Bourgogne\nF.-Comté",
      "Auvergne-Rhône-Alpes":      "Auvergne\nRhône-A.",
      "Provence-Alpes-Côte d'Azur":"PACA",
      "Centre-Val de Loire":       "Centre\nVal de Loire",
      "Hauts-de-France":           "Hauts-de-\nFrance",
      "Pays de la Loire":          "Pays de\nla Loire",
      "Nouvelle-Aquitaine":        "Nouvelle-\nAquitaine"
    };

    // Construire les paths + labels (multilines)
    const regionPaths = regions.map(reg => {
      const count    = byCodeDisplay[reg.code] || 0;  // inclut part nationale
      const realCount = byCode[reg.code] || 0;        // rappels régionaux seuls
      const fill     = heatColor(count);
      const tooltipVal = franceTotal > 0
        ? `${reg.nom} : ~${count.toLocaleString('fr-FR')} rappel(s) (dont ${francePart.toLocaleString('fr-FR')} nationaux)`
        : (realCount > 0 ? `${reg.nom} : ${realCount.toLocaleString('fr-FR')} rappel(s)` : reg.nom);
      const tooltip  = tooltipVal;
      const isDark   = count > maxCount * 0.4;
      const txtFill  = isDark ? '#fff' : '#1a202c';
      const lines    = (ABBR[reg.nom] || reg.nom).split('\n');
      const lineH    = 10;
      const startY   = reg.cy - ((lines.length - 1) * lineH) / 2;
      const tspans   = lines.map((l, i) =>
        `<tspan x="${reg.cx}" dy="${i === 0 ? 0 : lineH}">${escHtml(l)}</tspan>`
      ).join('');

      // Fond blanc semi-transparent derrière le label
      const bgW  = Math.max(...lines.map(l => l.length)) * 5.5 + 6;
      const bgH  = lines.length * lineH + 4;
      const bgX  = reg.cx - bgW / 2;
      const bgY  = startY - 8;
      const bgEl = `<rect x="${bgX.toFixed(1)}" y="${bgY.toFixed(1)}" width="${bgW.toFixed(1)}" height="${bgH.toFixed(1)}"
        fill="${isDark ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.55)'}" rx="2" pointer-events="none"/>`;

      return `<path d="${reg.d}" fill="${fill}" stroke="#fff" stroke-width="0.8" stroke-linejoin="round">
        <title>${escHtml(tooltip)}</title>
      </path>
      ${bgEl}
      <text x="${reg.cx}" y="${startY}" text-anchor="middle" dominant-baseline="middle"
        font-size="9" font-weight="700" fill="${txtFill}" pointer-events="none"
        font-family="-apple-system,'Segoe UI',sans-serif">${tspans}</text>`;
    }).join('');

    // DOM-TOM : petits rectangles en bas avec séparateur
    const domtomY = H - 44;
    const domtomPaths = DOMTOM_SVG.map(d => {
      const count = regionCounts[d.id] || 0;
      const fill  = heatColor(count);
      return `<rect x="${d.x}" y="${domtomY}" width="${d.w}" height="22" fill="${fill}"
        stroke="#fff" stroke-width="0.7" rx="3">
        <title>${escHtml(d.name)} : ${count.toLocaleString('fr-FR')}</title>
      </rect>
      <text x="${d.x + d.w/2}" y="${domtomY + 11}" text-anchor="middle" dominant-baseline="middle"
        font-size="7.5" font-weight="600" fill="#1a202c" pointer-events="none">${escHtml(d.name.split(' ')[0])}</text>`;
    }).join('');

    // Classement — basé sur byCodeDisplay (inclut part nationale) pour avoir toutes les régions
    const ranking = [...regions]
      .map(r => ({ nom: r.nom, count: byCodeDisplay[r.code] || 0 }))
      .filter(x => x.count > 0)
      .sort((a, b) => b.count - a.count);

    const rankRows = ranking.slice(0, 10).map((r, i) => {
      const pct = Math.round((r.count / ranking[0].count) * 100);
      return `<div class="map-ranking-row">
        <span class="map-rank-num">${i+1}</span>
        <span class="map-rank-name">${escHtml(r.nom)}</span>
        <span class="map-rank-bar" style="width:${pct}%"></span>
        <span class="map-rank-val">${r.count.toLocaleString('fr-FR')}</span>
      </div>`;
    }).join('');

    el.innerHTML = `
      <div class="map-wrap">
        <svg class="map-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
          <rect width="${W}" height="${H}" fill="#c8daea" rx="8"/>
          ${regionPaths}
          <line x1="10" y1="${domtomY - 7}" x2="${W - 10}" y2="${domtomY - 7}"
            stroke="#9ab8ce" stroke-width="0.8" stroke-dasharray="3,3"/>
          <text x="12" y="${domtomY - 1}" font-size="8" fill="#5a7a90"
            font-style="italic" font-family="-apple-system,'Segoe UI',sans-serif">DOM-TOM</text>
          ${domtomPaths}
        </svg>
        <div class="map-side">
          <div class="map-legend">
            <div style="font-size:11px;font-weight:700;margin-bottom:6px;color:var(--text)">Rappels par région</div>
            <div style="background:linear-gradient(to right,#dde8f0,#e34b2a);height:8px;border-radius:4px;border:1px solid #ddd"></div>
            <div style="display:flex;justify-content:space-between;font-size:10px;margin-top:3px;color:var(--muted)">
              <span>0</span><span>${maxCount.toLocaleString('fr-FR')}</span>
            </div>
          </div>
          ${ranking.length
            ? `<div class="map-ranking">${rankRows}</div>`
            : '<p style="font-size:11px;color:var(--muted);margin-top:8px">Aucune donnée régionale disponible</p>'}
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
