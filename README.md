# RappelConso — Surveillance des rappels produits France

Application web de recherche et d'analyse des rappels produits officiels DGCCRF, basée sur l'API [data.economie.gouv.fr](https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/rappelconso-v2-gtin-espaces).

Créée par **IBM Bob / Arrow ECS France**.

---

## Fonctionnalités

- 🔍 **Recherche** : texte libre, catégorie, zone géographique, distributeur, dates, tri
- 📊 **Analyse** : KPI, graphiques par catégorie, évolution 12 mois, carte choroplèthe France
- 🔔 **Alertes email** : notification automatique des nouveaux rappels selon critères

---

## Lancer en local

### Prérequis
- Python 3.9+

### Installation

```bash
git clone https://github.com/VOTRE_COMPTE/rappelconso.git
cd rappelconso
cp .env.example .env
# Éditer .env avec vos identifiants
pip install -r requirements.txt
python server.py
```

L'application s'ouvre automatiquement sur [http://localhost:8080](http://localhost:8080).

**Identifiants par défaut** : `admin` / `rappelconso2024`

---

## Déployer sur Render (gratuit)

### 1. Pousser sur GitHub

```bash
git add -A
git commit -m "feat: RappelConso prêt pour déploiement"
git push origin main
```

### 2. Créer le service sur Render

1. Aller sur [render.com](https://render.com) → **New → Web Service**
2. Connecter votre dépôt GitHub `rappelconso`
3. Render détecte automatiquement `render.yaml` — cliquer **Apply**
4. Dans **Environment Variables**, renseigner :
   - `APP_USER` : identifiant de connexion
   - `APP_PASS` : mot de passe de connexion
   - `SMTP_HOST` : `smtp.gmail.com`
   - `SMTP_USER` : votre adresse Gmail
   - `SMTP_PASS` : mot de passe d'application Gmail (16 caractères)
5. Cliquer **Deploy**

L'URL publique sera du type `https://rappelconso.onrender.com`.

> ⚠️ Sur le plan gratuit Render, le service se met en veille après 15 min d'inactivité (premier chargement ~30s). La base de données SQLite est **éphémère** (réinitialisée à chaque déploiement). Pour la persistance, ajouter un disque Render ou utiliser une base PostgreSQL externe.

---

## Variables d'environnement

| Variable | Description | Défaut |
|---|---|---|
| `PORT` | Port d'écoute | `8080` |
| `APP_USER` | Identifiant web | `admin` |
| `APP_PASS` | Mot de passe web | `rappelconso2024` |
| `SMTP_HOST` | Serveur SMTP | — |
| `SMTP_PORT` | Port SMTP | `587` |
| `SMTP_USER` | Email expéditeur | — |
| `SMTP_PASS` | Mot de passe SMTP | — |
| `SMTP_FROM` | Adresse d'envoi | = `SMTP_USER` |
| `DB_PATH` | Chemin SQLite | `./alerts.db` |

---

## Architecture

```
rappelconso/
├── server.py          # Serveur HTTP Python (stdlib uniquement)
│                      # → proxy API, alertes SQLite, scheduler email
├── app/
│   ├── index.html     # Interface 3 onglets
│   ├── style.css      # Styles principaux
│   ├── app.js         # Onglet Recherche
│   ├── analytics.js   # Onglet Analyse (graphiques + carte)
│   ├── analytics.css
│   ├── alerts.js      # Onglet Alertes
│   ├── alerts.css
│   ├── regions.json   # Paths SVG France (GeoJSON IGN simplifié)
│   ├── logo-arrow.png
│   └── logo-ibmbob.png
├── render.yaml        # Configuration Render
├── requirements.txt
└── .env.example
```

---

*Données officielles DGCCRF — [rappelconso.beta.gouv.fr](https://rappelconso.beta.gouv.fr)*
