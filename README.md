# RappelConso

Application web de surveillance des rappels produits en France.  
Données officielles DGCCRF via l'API [data.economie.gouv.fr](https://data.economie.gouv.fr).

Créée par **IBM Bob / Arrow ECS France**.

---

## Description

RappelConso permet de :
- **Rechercher** des rappels de produits par mot-clé, catégorie, zone géographique, distributeur ou plage de dates
- **Analyser** les tendances via des graphiques SVG (courbe temporelle, barres, donut, carte choroplèthe)
- **Créer des alertes email** pour être notifié automatiquement des nouveaux rappels correspondant à vos critères

L'application embarque un serveur Python autonome (stdlib uniquement) qui sert les fichiers statiques, proxifie l'API externe, gère la base SQLite des alertes et planifie les envois d'emails.

---

## Fonctionnalités

| Module | Fonctionnalités |
|--------|-----------------|
| Recherche | Filtres libres, catégorie, zone, distributeur, dates, tri ; pagination ; fiche détail modale |
| Analyse | 4 KPI, 6 graphiques SVG (barres, courbe 24 mois, donut, carte France par région) |
| Alertes | Formulaire de création/édition, validation email, sauvegarde localStorage + SQLite, envoi SMTP planifié |
| Serveur | Proxy API avec cache 10 min, authentification Basic Auth, planificateur email (horaire) |

---

## Lancement local

### Prérequis
- Python 3.8+

### Installation

```bash
# Cloner le dépôt
git clone https://github.com/VOTRE_USERNAME/rappelconso.git
cd rappelconso

# Copier et configurer les variables d'environnement
cp .env.example .env
# Éditer .env avec vos identifiants SMTP et vos credentials

# Lancer le serveur
python server.py
```

Le navigateur s'ouvre automatiquement sur `http://localhost:8080`.

Le serveur demande un **login/mot de passe** (par défaut : `admin` / `rappelconso2024`).

### Changer le port

```bash
python server.py 9000
# ou via variable d'environnement
PORT=9000 python server.py
```

---

## Configuration SMTP (alertes email)

Les alertes sont envoyées via SMTP avec STARTTLS. Paramètres dans `.env` :

| Variable | Description | Exemple |
|----------|-------------|---------|
| `SMTP_HOST` | Serveur SMTP | `smtp.gmail.com` |
| `SMTP_PORT` | Port SMTP | `587` |
| `SMTP_USER` | Identifiant | `votre@gmail.com` |
| `SMTP_PASS` | Mot de passe / app password | `xxxx xxxx xxxx xxxx` |
| `SMTP_FROM` | Expéditeur affiché | `RappelConso <votre@gmail.com>` |

> **Gmail** : créer un [App Password](https://myaccount.google.com/apppasswords) (authentification à 2 facteurs requise).

---

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT` | `8080` | Port d'écoute du serveur |
| `APP_USER` | `admin` | Login Basic Auth |
| `APP_PASS` | `rappelconso2024` | Mot de passe Basic Auth |
| `SMTP_HOST` | — | Hôte SMTP |
| `SMTP_PORT` | `587` | Port SMTP |
| `SMTP_USER` | — | Compte SMTP |
| `SMTP_PASS` | — | Mot de passe SMTP |
| `SMTP_FROM` | = `SMTP_USER` | Expéditeur email |

---

## Déploiement Render

Le fichier `render.yaml` est inclus pour un déploiement one-click.

### Étapes

1. Créer un compte sur [render.com](https://render.com)
2. **New → Web Service → Connect GitHub** → sélectionner ce dépôt
3. Render détecte automatiquement `render.yaml`
4. Dans **Environment → Environment Variables**, ajouter :
   - `APP_USER`, `APP_PASS`
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
5. Cliquer **Deploy**

> L'URL de déploiement ressemblera à `https://rappelconso.onrender.com`.

### Manuel (sans render.yaml)

| Champ | Valeur |
|-------|--------|
| Environment | Python |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `python -u server.py` |
| Port | `10000` |

---

## Structure du projet

```
rappelconso/
├── app/
│   ├── index.html       # Interface principale
│   ├── style.css        # Styles globaux
│   ├── analytics.css    # Styles onglet Analyse
│   ├── alerts.css       # Styles onglet Alertes
│   ├── app.js           # Module recherche
│   ├── analytics.js     # Module graphiques
│   ├── alerts.js        # Module alertes email
│   ├── logo-arrow.png   # Logo Arrow ECS
│   └── logo-ibmbob.png  # Logo IBM Bob
├── server.py            # Serveur Python
├── requirements.txt     # Dépendances Python
├── Dockerfile           # Image Docker
├── render.yaml          # Config déploiement Render
├── .env.example         # Template variables d'env
├── .gitignore
└── README.md
```

---

## Licence

Usage interne Arrow ECS France / IBM Bob.  
Données : © DGCCRF — [Licence Ouverte v2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence).
