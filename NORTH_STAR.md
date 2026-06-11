# North Star — à quoi sert ProjectOS

> Défini le 2026-06-11. Toute décision (feature, dépense, priorité) se
> juge contre cette page. Si ça ne sert pas le but, ça attend.

## Le but

**ProjectOS est MON assistant de dev quotidien.** Dans 1 mois, il me
fait gagner du temps sur de vraies tâches, ou il a échoué.

## Les tâches que je lui délègue

1. **Features et fixes sur mes repos existants** — "ajoute cette
   commande", "corrige ce bug", "refactore ce module". C'est l'usage
   n°1 et le critère de succès principal.
2. **Créer des petits projets** — prototypes, scripts, outils.
3. **Automatisations / scraping** — tâches navigateur répétitives
   (les Playwright tools restent actifs pour ça).

## Budget

**$30-100/mois.** Règles de dépense :
- Runs de production : sans limite tant que sous le budget mensuel.
- Benchmarks/evals : uniquement quand une eval échoue naturellement
  en usage réel, ou sur décision explicite.
- Opus réservé aux phases de réflexion (design, review) — déjà câblé.

## Ce qui est GELÉ

- **Self-improve automatique** : plus aucun cycle de benchmark tant
  qu'une tâche réelle n'échoue pas. Les échecs réels (escalades de
  runs de prod) sont la SEULE matière première légitime.
- Pas de nouvelles features sans besoin issu de l'usage réel.

## Critère de succès du mois

ProjectOS livre avec succès **5 tâches réelles sur mes repos** (feature
ou fix, suite de tests verte, diff utilisable) pour moins de $25 au
total. Le dogfooding (docs/DOGFOOD_TASK.md) est la première des cinq.

## Anti-patterns à refuser

- Construire une feature "parce qu'on peut".
- Benchmarker pour confirmer ce qu'on sait déjà.
- Optimiser des evals qui passent à 100%.
- Toute dépense > $5 sans question posée d'abord.
