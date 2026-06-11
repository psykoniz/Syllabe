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

## Quand déléguer une tâche à ProjectOS (test des 4 conditions)

Avant de lancer un run, la tâche doit passer LES QUATRE :

1. **Répétition** — la tâche (ou sa famille) revient au moins chaque semaine.
2. **Vérification automatique** — tests, typecheck ou linter peuvent valider
   le résultat sans moi.
3. **Budget absorbable** — le coût du run reste dans le budget mensuel.
4. **Outils suffisants** — l'agent a accès à ce qu'un dev senior utiliserait
   (logs, environnement de repro, suite de tests du projet).

Si une condition manque : faire la tâche à la main, c'est plus rapide.

## Backlog (en attente d'un besoin réel)

- **Déclencheur CI** : étendre la GitHub Action pour qu'un échec CI sur main
  lance automatiquement un run de triage. À implémenter le jour où un CI
  cassé m'aura réellement coûté du temps — pas avant.

## Anti-patterns à refuser

- Construire une feature "parce qu'on peut".
- Benchmarker pour confirmer ce qu'on sait déjà.
- Optimiser des evals qui passent à 100%.
- Toute dépense > $5 sans question posée d'abord.
