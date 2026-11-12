#!/usr/bin/env python3
"""
RappelConso — server.py
Serveur HTTP local + proxy API + envoi d'alertes email
Authentification : Basic Auth (APP_USER / APP_PASS)
"""

import http.server
import socketserver
import os
import sys
import json
import sqlite3
import smtplib
import threading
import time
import webbrowser
import urllib.request
import urllib.parse
import urllib.error
import ssl
import pathlib
import base64
from datetime import datetime, timezone, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import socket

# Certificats SSL via certifi
try:
    import certifi
    _SSL_CAFILE = certifi.where()
except ImportError:
    _SSL_CAFILE = None

# requests pour les appels API sortants (meilleure gestion TCP que urllib sur Render)
try:
    import requests as _requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
    _session = _requests.Session()
    _retry = Retry(total=3, backoff_factor=1, status_forcelist=[500, 502, 503, 504])
    _adapter = HTTPAdapter(max_retries=_retry, pool_connections=4, pool_maxsize=8)
    _session.mount('https://', _adapter)
    _session.mount('http://', _adapter)
    _USE_REQUESTS = True
    print('[server] requests disponible — utilisation pour les appels API', file=sys.stderr)
except ImportError:
    _USE_REQUESTS = False
    print('[server] requests non disponible — fallback urllib', file=sys.stderr)

# Forcer IPv4 sur Render (évite [Errno 101] Network is unreachable sur IPv6)
if os.environ.get('RENDER') == 'true':
    _orig_getaddrinfo = socket.getaddrinfo
    def _ipv4_getaddrinfo(host, port, family=0, *args, **kwargs):
        return _orig_getaddrinfo(host, port, socket.AF_INET, *args, **kwargs)
    socket.getaddrinfo = _ipv4_getaddrinfo
    print('[server] IPv4 uniquement (Render)', file=sys.stderr)


# ──────────────────────────────────────────────
# HELPERS
# ──────────────────────────────────────────────

def utcnow():
    return datetime.now(timezone.utc)


# ──────────────────────────────────────────────
# PROXY CACHE
# ──────────────────────────────────────────────

REMOTE_API    = 'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/rappelconso-v2-gtin-espaces'
PROXY_TTL     = 600  # secondes
_proxy_cache  = {}   # url -> (timestamp, data_bytes)
_proxy_pending = set()

def _make_ssl_ctx():
    """Crée un contexte SSL avec certifi si disponible, sinon désactive la vérification."""
    if _SSL_CAFILE:
        return ssl.create_default_context(cafile=_SSL_CAFILE)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode    = ssl.CERT_NONE
    return ctx

_ssl_ctx_proxy = _make_ssl_ctx()


def _normalize_url(url):
    """Trier les paramètres pour une clé de cache stable."""
    parsed = urllib.parse.urlparse(url)
    params = sorted(urllib.parse.parse_qsl(parsed.query))
    new_query = urllib.parse.urlencode(params)
    return parsed._replace(query=new_query).geturl()


def _http_get(url, timeout=60):
    """Appel HTTP GET — utilise requests si disponible, sinon urllib."""
    headers = {'Accept': 'application/json', 'Accept-Encoding': 'identity'}
    if _USE_REQUESTS:
        resp = _session.get(url, headers=headers, timeout=timeout,
                            verify=_SSL_CAFILE or True)
        resp.raise_for_status()
        return resp.content
    else:
        ctx = _make_ssl_ctx()
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
            return r.read()


def _do_fetch(url, cache_key):
    """Fetch HTTP bloquant, stocke en cache."""
    try:
        data = _http_get(url, timeout=60)
        _proxy_cache[cache_key] = (time.time(), data)
    except Exception as exc:
        print(f'[proxy] fetch error {url}: {type(exc).__name__}: {exc}', file=sys.stderr)
    finally:
        _proxy_pending.discard(cache_key)


def proxy_fetch_async(url):
    """
    Retourne (data_bytes, from_cache) si en cache valide.
    Sinon lance un fetch en background et retourne (None, False).
    """
    key = _normalize_url(url)
    if key in _proxy_cache:
        ts, data = _proxy_cache[key]
        if time.time() - ts < PROXY_TTL:
            return data, True
    if key not in _proxy_pending:
        _proxy_pending.add(key)
        threading.Thread(target=_do_fetch, args=(url, key), daemon=True).start()
    return None, False


PRELOAD_URLS = [
    f'{REMOTE_API}/records?limit=20&order_by=date_publication+DESC&timezone=Europe%2FParis',
    f'{REMOTE_API}/facets?limit=1&facet=categorie_produit&facet=nature_juridique_rappel&timezone=Europe%2FParis',
]


def preload_cache():
    for url in PRELOAD_URLS:
        proxy_fetch_async(url)


# ──────────────────────────────────────────────
# CONFIG
# ──────────────────────────────────────────────

PORT    = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get('PORT', 8080))
APP_DIR = pathlib.Path(__file__).parent / 'app'
# En production (Render), la DB est dans /tmp (éphémère) sauf si un disque persistant est monté
DB_PATH = pathlib.Path(os.environ.get('DB_PATH', str(pathlib.Path(__file__).parent / 'alerts.db')))


def load_env():
    """Lit .env si présent et injecte dans os.environ."""
    env_path = pathlib.Path(__file__).parent / '.env'
    if not env_path.exists():
        return
    with open(env_path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, val = line.partition('=')
            os.environ.setdefault(key.strip(), val.strip())


load_env()

SMTP_HOST      = os.environ.get('SMTP_HOST', '')
SMTP_PORT      = int(os.environ.get('SMTP_PORT', 587))
SMTP_USER      = os.environ.get('SMTP_USER', '')
SMTP_PASS      = os.environ.get('SMTP_PASS', '')
SMTP_FROM      = os.environ.get('SMTP_FROM', SMTP_USER)
SENDGRID_KEY   = os.environ.get('SENDGRID_API_KEY', '')

APP_USER  = os.environ.get('APP_USER', 'admin')
APP_PASS  = os.environ.get('APP_PASS', 'rappelconso2024')

API_BASE  = REMOTE_API

SCHEDULER_INTERVAL = 3600  # secondes

_ssl_ctx = _make_ssl_ctx()


# ──────────────────────────────────────────────
# SQLITE
# ──────────────────────────────────────────────

def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS alerts (
                id          TEXT PRIMARY KEY,
                email       TEXT NOT NULL,
                name        TEXT NOT NULL,
                zone        TEXT,
                distributeur TEXT,
                categorie   TEXT,
                keywords    TEXT,
                freq        TEXT DEFAULT "weekly",
                next_send   TEXT,
                created_at  TEXT,
                last_sent   TEXT
            )
        ''')
        conn.commit()


def db_upsert(alert):
    # Normaliser next_send / nextSend et created_at / createdAt (front envoie camelCase)
    d = dict(alert)
    d.setdefault('next_send', d.pop('nextSend', None))
    d.setdefault('created_at', d.pop('createdAt', None))
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute('''
            INSERT INTO alerts (id, email, name, zone, distributeur, categorie, keywords, freq, next_send, created_at)
            VALUES (:id, :email, :name, :zone, :distributeur, :categorie, :keywords, :freq, :next_send, :created_at)
            ON CONFLICT(id) DO UPDATE SET
                email=excluded.email, name=excluded.name,
                zone=excluded.zone, distributeur=excluded.distributeur,
                categorie=excluded.categorie, keywords=excluded.keywords,
                freq=excluded.freq, next_send=excluded.next_send
        ''', d)
        conn.commit()


def db_delete(alert_id):
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute('DELETE FROM alerts WHERE id = ?', (alert_id,))
        conn.commit()


def db_all():
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute('SELECT * FROM alerts').fetchall()
    return [dict(r) for r in rows]


def db_mark_sent(alert_id, next_send):
    now = utcnow().isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            'UPDATE alerts SET last_sent=?, next_send=? WHERE id=?',
            (now, next_send, alert_id)
        )
        conn.commit()


# ──────────────────────────────────────────────
# RAPPELS API
# ──────────────────────────────────────────────

def fetch_rappels(alert):
    clauses = []
    if alert.get('categorie'):
        c = alert['categorie'].replace("'", "\\'")
        clauses.append(f"categorie_produit = '{c}'")
    if alert.get('zone'):
        z = alert['zone'].replace("'", "\\'")
        clauses.append(f"zone_geographique_de_vente LIKE '%{z}%'")
    if alert.get('distributeur'):
        d = alert['distributeur'].replace("'", "\\'")
        clauses.append(f"distributeurs LIKE '%{d}%'")
    if alert.get('keywords'):
        for kw in alert['keywords'].split(','):
            kw = kw.strip().replace("'", "\\'")
            if kw:
                clauses.append(
                    f"(libelle LIKE '%{kw}%' OR motif_rappel LIKE '%{kw}%' OR marque_produit LIKE '%{kw}%')"
                )

    # Filtre sur les 7 derniers jours
    since = (utcnow() - timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%S')
    clauses.append(f"date_publication >= '{since}'")

    where_str = ' AND '.join(clauses)
    params = urllib.parse.urlencode({
        'limit':    '50',
        'order_by': 'date_publication DESC',
        'timezone': 'Europe/Paris',
        'where':    where_str
    })
    url = f'{API_BASE}/records?{params}'

    # 2 tentatives avec timeout progressif
    for attempt, timeout in enumerate([45, 90], 1):
        try:
            data = json.loads(_http_get(url, timeout=timeout))
            return data.get('results', [])
        except Exception as exc:
            print(f'[fetch_rappels] tentative {attempt} ({type(exc).__name__}: {exc})', file=sys.stderr)
            if attempt < 2:
                time.sleep(5)
    return []


# ──────────────────────────────────────────────
# SCHEDULER
# ──────────────────────────────────────────────

def next_send(freq):
    now = utcnow()
    if freq == 'daily':
        return (now + timedelta(days=1)).isoformat()
    if freq == 'weekly':
        return (now + timedelta(weeks=1)).isoformat()
    if freq == 'monthly':
        # +30 jours
        return (now + timedelta(days=30)).isoformat()
    return (now + timedelta(weeks=1)).isoformat()


def scheduler_loop():
    while True:
        time.sleep(SCHEDULER_INTERVAL)
        now_str = utcnow().isoformat()
        try:
            alerts = db_all()
        except Exception:
            continue
        for a in alerts:
            ns = a.get('next_send') or ''
            if ns and ns <= now_str:
                try:
                    rappels = fetch_rappels(a)
                    if rappels:
                        html = build_email_html(a, rappels)
                        subject = f"[RappelConso] {len(rappels)} nouveau(x) rappel(s) — {a.get('name', '')}"
                        send_email(a['email'], subject, html)
                    db_mark_sent(a['id'], next_send(a.get('freq', 'weekly')))
                except Exception as exc:
                    print(f'[scheduler] alerte {a["id"]} : {exc}', file=sys.stderr)


# ──────────────────────────────────────────────
# EMAIL
# ──────────────────────────────────────────────

def build_email_html(alert, rappels):
    rows = ''
    for r in rappels[:30]:
        brand   = r.get('marque_produit', '—')
        product = r.get('libelle') or r.get('modeles_ou_references', '—')
        motif   = r.get('motif_rappel', '—')
        date    = (r.get('date_publication') or '')[:10]
        cat     = r.get('categorie_produit', '')
        fiche   = r.get('lien_vers_la_fiche_rappel', '')
        product_cell = f'<a href="{esc(fiche)}" style="color:#2563eb;text-decoration:none">{esc(product)}</a>' if fiche else esc(product)
        rows += f'''
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px">{esc(brand)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px">{product_cell}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:12px;color:#57606a">{esc(cat)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:12px;color:#57606a;white-space:nowrap">{esc(date)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:12px;color:#57606a">{esc((motif or '')[:120])}</td>
        </tr>'''

    filters_html = ''
    for key, label in [('zone','Zone'), ('distributeur','Distributeur'), ('categorie','Catégorie'), ('keywords','Mots-clés')]:
        val = alert.get(key)
        if val:
            filters_html += f'<li style="margin:2px 0;font-size:13px"><strong>{esc(label)} :</strong> {esc(val)}</li>'

    return f'''<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><title>RappelConso — Alerte</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',sans-serif">
<div style="max-width:700px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e2e5ea">
  <div style="background:#1c2128;padding:16px 24px">
    <span style="color:#fff;font-size:20px;font-weight:700">RappelConso</span>
    <span style="color:#8b949e;font-size:13px;margin-left:12px">Alerte : {esc(alert.get("name",""))}</span>
  </div>
  <div style="padding:20px 24px">
    <p style="font-size:15px;color:#1c2128;margin:0 0 16px">
      <strong>{len(rappels)}</strong> nouveau(x) rappel(s) correspond(ent) à votre alerte.
    </p>
    {f'<ul style="margin:0 0 16px;padding-left:18px">{filters_html}</ul>' if filters_html else ''}
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e5ea;border-radius:6px;overflow:hidden">
      <thead>
        <tr style="background:#f4f5f7">
          <th style="padding:8px 10px;text-align:left;font-size:12px;color:#57606a;font-weight:600">Marque</th>
          <th style="padding:8px 10px;text-align:left;font-size:12px;color:#57606a;font-weight:600">Produit</th>
          <th style="padding:8px 10px;text-align:left;font-size:12px;color:#57606a;font-weight:600">Catégorie</th>
          <th style="padding:8px 10px;text-align:left;font-size:12px;color:#57606a;font-weight:600">Date</th>
          <th style="padding:8px 10px;text-align:left;font-size:12px;color:#57606a;font-weight:600">Motif</th>
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
    <p style="margin-top:20px;font-size:12px;color:#57606a">
      Données officielles DGCCRF — <a href="https://rappelconso.beta.gouv.fr" style="color:#2563eb">rappelconso.beta.gouv.fr</a>
    </p>
  </div>
  <div style="background:#f4f5f7;padding:12px 24px;border-top:1px solid #e2e5ea;font-size:11px;color:#8b949e;text-align:center">
    Application créée par IBM Bob / Arrow ECS France
  </div>
</div>
</body></html>'''


def send_email(to, subject, html):
    """Envoie un email — SendGrid API (HTTPS) en priorité, fallback SMTP."""

    # ── SendGrid via HTTPS (fonctionne sur Render même si ports SMTP bloqués) ──
    if SENDGRID_KEY:
        _send_via_sendgrid(to, subject, html)
        return

    # ── Fallback SMTP ──
    if not SMTP_HOST or not SMTP_USER:
        raise RuntimeError('Aucun moyen d\'envoi configuré (SENDGRID_API_KEY ou SMTP_HOST manquant)')

    _send_via_smtp(to, subject, html)


def _send_via_sendgrid(to, subject, html):
    """Envoi via l'API HTTP SendGrid (port 443 — toujours ouvert)."""
    # Adresse expéditeur : utiliser SMTP_FROM/SMTP_USER si défini,
    # sinon l'adresse par défaut SendGrid vérifiée
    from_addr = SMTP_FROM or SMTP_USER or ''
    payload_dict = {
        'personalizations': [{'to': [{'email': to}]}],
        'from':    {'email': from_addr, 'name': 'RappelConso'},
        'subject': subject,
        'content': [{'type': 'text/html', 'value': html}]
    }
    if from_addr:
        payload_dict['reply_to'] = {'email': from_addr}

    payload = json.dumps(payload_dict).encode('utf-8')
    print(f'[sendgrid] envoi de={from_addr} à={to} sujet={subject[:50]}', file=sys.stderr)

    req = urllib.request.Request(
        'https://api.sendgrid.com/v3/mail/send',
        data=payload,
        headers={
            'Authorization': f'Bearer {SENDGRID_KEY}',
            'Content-Type':  'application/json'
        },
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, context=_make_ssl_ctx(), timeout=30) as resp:
            status = resp.status
        print(f'[sendgrid] HTTP {status} — envoyé via SendGrid → {to}', file=sys.stderr)
        if status not in (200, 202):
            raise RuntimeError(f'SendGrid HTTP {status}')
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        print(f'[sendgrid] erreur HTTP {e.code} : {body}', file=sys.stderr)
        raise RuntimeError(f'SendGrid erreur {e.code} : {body}')


def _send_via_smtp(to, subject, html):
    """Envoi via SMTP avec fallback SSL:465 / STARTTLS:587."""
    msg = MIMEMultipart('alternative')
    msg['Subject'] = subject
    msg['From']    = SMTP_FROM or SMTP_USER
    msg['To']      = to
    msg.attach(MIMEText(html, 'html', 'utf-8'))

    ssl_ctx   = _make_ssl_ctx()
    from_addr = SMTP_FROM or SMTP_USER
    last_exc  = None

    strategies = [('ssl', 465), ('starttls', 587)] if SMTP_PORT == 465 \
            else [('starttls', 587), ('ssl', 465)]

    for method, port in strategies:
        try:
            if method == 'ssl':
                with smtplib.SMTP_SSL(SMTP_HOST, port, timeout=20, context=ssl_ctx) as smtp:
                    smtp.login(SMTP_USER, SMTP_PASS)
                    smtp.sendmail(from_addr, to, msg.as_string())
            else:
                with smtplib.SMTP(SMTP_HOST, port, timeout=20) as smtp:
                    smtp.ehlo(); smtp.starttls(context=ssl_ctx); smtp.ehlo()
                    smtp.login(SMTP_USER, SMTP_PASS)
                    smtp.sendmail(from_addr, to, msg.as_string())
            print(f'[email] envoyé via SMTP {method}:{port} → {to}', file=sys.stderr)
            return
        except smtplib.SMTPAuthenticationError as e:
            raise RuntimeError(f'Authentification SMTP échouée : {e}')
        except Exception as e:
            print(f'[smtp] échec {method}:{port} — {type(e).__name__}: {e}', file=sys.stderr)
            last_exc = e

    raise RuntimeError(f'SMTP échoué sur tous les ports : {last_exc}')


def esc(s):
    """Échappe le HTML pour les emails."""
    return str(s).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;').replace('"','&quot;')


# ──────────────────────────────────────────────
# HTTP HANDLER
# ──────────────────────────────────────────────

class Handler(http.server.SimpleHTTPRequestHandler):

    def log_message(self, fmt, *args):
        pass  # silencieux

    # ── AUTH ──────────────────────────────────

    def _check_auth(self):
        """Vérifie l'authentification Basic. Retourne True si ok."""
        auth_header = self.headers.get('Authorization', '')
        if not auth_header.startswith('Basic '):
            return False
        try:
            decoded = base64.b64decode(auth_header[6:]).decode('utf-8')
            user, _, pwd = decoded.partition(':')
            return user == APP_USER and pwd == APP_PASS
        except Exception:
            return False

    def _require_auth(self):
        """Envoie une réponse 401 avec WWW-Authenticate."""
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="RappelConso"')
        self._cors_headers()
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.end_headers()
        self.wfile.write(b'Authentication required')

    # ── CORS ──────────────────────────────────

    def _cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type,Authorization')

    # ── HELPERS ───────────────────────────────

    def read_json(self):
        length = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(length) or b'{}')

    def json_response(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self._cors_headers()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def error_response(self, msg, status=400):
        self.json_response({'error': msg}, status)

    def _serve_index(self):
        """Sert index.html en injectant window._appCreds pour les appels API authentifiés."""
        index_path = APP_DIR / 'index.html'
        try:
            html = index_path.read_text(encoding='utf-8')
        except OSError:
            self.error_response('index.html introuvable', 404)
            return
        inject = f'<script>window._appCreds="{APP_USER}:{APP_PASS}";</script>'
        html = html.replace('</head>', inject + '\n</head>', 1)
        body = html.encode('utf-8')
        self.send_response(200)
        self._cors_headers()
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ── GET ───────────────────────────────────

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path   = parsed.path

        # Assets statiques → demander auth
        if not path.startswith('/api/'):
            if not self._check_auth():
                self._require_auth()
                return
            # Pour index.html : injecter window._appCreds pour que le JS puisse appeler /api/*
            if path in ('/', '/index.html', ''):
                self._serve_index()
                return
            super().do_GET()
            return

        # /api/status
        if path == '/api/status':
            self.json_response({
                'ok':      True,
                'smtp':    bool(SENDGRID_KEY or (SMTP_HOST and SMTP_USER)),
                'sendgrid': bool(SENDGRID_KEY),
                'time':    utcnow().isoformat()
            })
            return

        # /api/alerts
        if path == '/api/alerts':
            if not self._check_auth():
                self._require_auth()
                return
            try:
                self.json_response(db_all())
            except Exception as e:
                self.error_response(str(e), 500)
            return

        # /api/proxy
        if path == '/api/proxy':
            qs     = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            p_path = qs.get('_path', ['/records'])[0]
            # Reconstituer les params sans _path — conserver les params multi-valeurs (ex: facet=X&facet=Y)
            pairs = [(k, vi) for k, vs in qs.items() if k != '_path' for vi in vs]
            # Détection facets
            has_facet = any(k == 'facet' for k, _ in pairs)
            if p_path == '/facets' or has_facet:
                endpoint = '/facets'
            else:
                endpoint = '/records'
            remote_url = f'{REMOTE_API}{endpoint}?{urllib.parse.urlencode(pairs)}'

            data, from_cache = proxy_fetch_async(remote_url)
            if data is None:
                # Pas encore en cache → 503 retry
                self.json_response({'error': 'loading', 'retry_ms': 3000}, 503)
            else:
                self.send_response(200)
                self._cors_headers()
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            return

        self.error_response('Not found', 404)

    # ── POST ──────────────────────────────────

    def do_POST(self):
        if not self._check_auth():
            self._require_auth()
            return

        parsed = urllib.parse.urlparse(self.path)
        path   = parsed.path

        # /api/alerts/:id/send
        # Le navigateur envoie les rappels dans le body (JSON) — le serveur envoie juste le SMTP
        if path.startswith('/api/alerts/') and path.endswith('/send'):
            alert_id = path.split('/')[-2]
            alerts   = db_all()
            alert    = next((a for a in alerts if a['id'] == alert_id), None)
            if not alert:
                self.error_response('Alerte introuvable', 404)
                return

            try:
                body = self.read_json()
                rappels = body.get('rappels', [])
            except Exception:
                rappels = []

            if not rappels:
                # Fallback : le serveur essaie lui-même de récupérer les rappels
                try:
                    rappels = fetch_rappels(alert)
                except Exception as exc:
                    print(f'[send] fetch_rappels: {exc}', file=sys.stderr)

            if not rappels:
                self.json_response({'ok': False, 'error': 'Aucun rappel trouvé'}, 200)
                return

            try:
                html    = build_email_html(alert, rappels)
                subject = f"[RappelConso] {len(rappels)} rappel(s) — {alert.get('name','')}"
                send_email(alert['email'], subject, html)
                db_mark_sent(alert['id'], next_send(alert.get('freq', 'weekly')))
                self.json_response({'ok': True, 'sent': len(rappels)})
            except Exception as exc:
                print(f'[send] {exc}', file=sys.stderr)
                self.error_response(str(exc), 500)
            return

        # /api/alerts (upsert)
        if path == '/api/alerts':
            try:
                data = self.read_json()
                db_upsert(data)
                self.json_response({'ok': True})
            except Exception as e:
                self.error_response(str(e), 500)
            return

        self.error_response('Not found', 404)

    # ── PUT ───────────────────────────────────

    def do_PUT(self):
        if not self._check_auth():
            self._require_auth()
            return

        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/alerts':
            try:
                data = self.read_json()
                db_upsert(data)
                self.json_response({'ok': True})
            except Exception as e:
                self.error_response(str(e), 500)
        else:
            self.error_response('Not found', 404)

    # ── DELETE ────────────────────────────────

    def do_DELETE(self):
        if not self._check_auth():
            self._require_auth()
            return

        parsed   = urllib.parse.urlparse(self.path)
        parts    = parsed.path.strip('/').split('/')
        # /api/alerts/:id
        if len(parts) == 3 and parts[0] == 'api' and parts[1] == 'alerts':
            alert_id = parts[2]
            try:
                db_delete(alert_id)
                self.json_response({'ok': True})
            except Exception as e:
                self.error_response(str(e), 500)
        else:
            self.error_response('Not found', 404)

    # ── OPTIONS ───────────────────────────────

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()


# ──────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────

def main():
    init_db()
    os.chdir(APP_DIR)

    # Scheduler
    t_sched = threading.Thread(target=scheduler_loop, daemon=True)
    t_sched.start()

    # Préchargement cache proxy
    threading.Thread(target=preload_cache, daemon=True).start()

    url = f'http://localhost:{PORT}'
    print(f'\n🚀 RappelConso démarre sur {url}')
    print(f'   Authentification : {APP_USER} / {"*" * len(APP_PASS)}')
    print(f'   Dossier app      : {APP_DIR}')
    print(f'   Base de données  : {DB_PATH}')
    print(f'   SMTP             : {SMTP_HOST or "(non configuré)"}')
    print(f'\n   → Ouvrir dans le navigateur : {url}\n')

    # Ouvre le navigateur uniquement en local (pas sur un serveur sans écran)
    if os.environ.get('RENDER') != 'true' and sys.stdout.isatty():
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('', PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n⏹  Serveur arrêté.')


if __name__ == '__main__':
    main()
