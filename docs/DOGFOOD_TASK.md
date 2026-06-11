# Dogfooding : ProjectOS travaille sur son propre repo

> Test de maturité : l'agent doit livrer une feature dans un codebase
> existant de ~30 modules, en respectant les conventions et sans casser
> les 370 tests. À lancer après le merge de la phase de crédibilité.

## La tâche donnée à l'agent

Ajouter une commande CLI `projectos stats` qui agrège les coûts depuis
un fichier traces.jsonl :

- `projectos stats [--traces .projectos/traces.jsonl] [--json]`
- Sortie par défaut : tableau par modèle (appels, input tokens, output
  tokens, cache read/write, coût USD cache-aware) + ligne TOTAL
- `--json` : même donnée en JSON sur stdout
- Doit réutiliser `computeCost` de `@projectos/telemetry` (PAS de table
  de prix dupliquée)
- Tests unitaires sur un traces.jsonl de fixture (tmpdir)
- Enregistrer la commande dans apps/cli/index.ts

## Préparation du run

L'agent tourne sur une COPIE du repo (jamais sur le repo de travail) :

```bash
cp -r /home/user/Syllabe /tmp/dogfood-workspace
cd /tmp/dogfood-workspace
rm -rf .projectos .git && git init -q && git add -A && git commit -qm seed
```

## Commande de lancement

```bash
cd /home/user/Syllabe
ANTHROPIC_BASE_URL=... ANTHROPIC_AUTH_TOKEN=... \
bun apps/cli/index.ts build \
  --task "Add a 'stats' command to the CLI in apps/cli/commands/stats.ts: 'projectos stats [--traces <path>] [--json]' reads a traces.jsonl file (default .projectos/traces.jsonl) and prints a per-model cost table: calls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd (cache-aware), plus a TOTAL row. With --json it prints the same data as JSON. It MUST reuse computeCost from @projectos/telemetry — do not duplicate the price table. Register the command in apps/cli/index.ts following the existing pattern (see eval.ts, replay.ts). Add unit tests with a fixture traces.jsonl in a temp dir. Run bun test to make sure the whole suite still passes." \
  --workspace /tmp/dogfood-workspace \
  --db /tmp/dogfood-workspace/.projectos/runs.db \
  --traces /tmp/dogfood-workspace/.projectos/traces.jsonl \
  --model-override claude-sonnet-4-6 \
  --yes
```

## Critères de succès (vérification objective)

1. Run atteint COMPLETE sans escalade
2. `cd /tmp/dogfood-workspace && bun test` → tous les tests passent
   (les ~370 existants + les nouveaux)
3. `bun apps/cli/index.ts stats --traces <fixture>` produit le tableau
4. `grep -r "input.*10.0\|PRICE" apps/cli/commands/stats.ts` → aucune
   table de prix dupliquée (réutilise bien computeCost)
5. Budget : ≤ $3 équivalent-Anthropic

## Si succès

Porter la feature dans le vrai repo (cherry-pick du diff de l'agent ou
réimplémentation rapide), documenter le résultat dans ROADMAP.md
(section dogfooding : coût, steps, qualité du diff).

## Si échec

Analyser l'escalade/échec : c'est exactement la matière première du
prochain cycle self-improve. Les patterns "travailler dans du code
existant" deviennent la cible des candidats suivants.
