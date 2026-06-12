# Dogfooding : Tests unitaires de la mémoire sémantique et de l'auto-critique

> Test de fiabilité et d'auto-test : l'agent doit concevoir et implémenter des tests unitaires robustes pour les nouvelles fonctionnalités d'intelligence de ProjectOS.

## La tâche donnée à l'agent

Créer les tests unitaires complets avec `bun:test` pour valider le comportement des nouveaux modules d'intelligence de l'agent.

Fichiers cibles à tester :
1. `packages/core/auto-steering.ts`
2. `packages/memory/embeddings.ts`

Consignes de test :
* Pour **`auto-steering.ts`** :
  * Tester que le critique renvoie des instructions de steering appropriées lorsque des anomalies sont injectées (ex: boucle infinie détectée, scope creep).
  * Tester le comportement de fallback si l'appel d'auto-steering échoue ou est désactivé.
* Pour **`embeddings.ts`** :
  * Mocker l'appel à l'API d'embeddings OpenAI pour éviter des appels réels coûteux et fragiles durant les tests.
  * Tester le stockage et la recherche de vecteurs dans `SimpleVectorIndex` (cosine similarity).
  * Tester le cycle complet de `SemanticIndex` (`upsert` et `search`).
  * Tester la factory `createSemanticIndex` avec et sans la variable d'environnement `PROJECTOS_EMBEDDINGS_API_KEY`.
* Exécuter `bun test` pour s'assurer que les nouveaux tests s'exécutent avec succès et qu'aucune régression n'est introduite sur les tests existants.

## Préparation du run

L'agent doit tourner sur une COPIE du repo :

```bash
cp -r /home/user/Syllabe /tmp/dogfood-tests-workspace
cd /tmp/dogfood-tests-workspace
rm -rf .projectos .git && git init -q && git add -A && git commit -qm seed
```

## Commande de lancement

```bash
cd /home/user/Syllabe
bun apps/cli/index.ts build \
  --task "Create unit tests for auto-steering.ts (in packages/core/auto-steering.test.ts) and embeddings.ts (in packages/memory/embeddings.test.ts). Mock API calls where necessary. Ensure bun test passes." \
  --workspace /tmp/dogfood-tests-workspace \
  --db /tmp/dogfood-tests-workspace/.projectos/runs.db \
  --traces /tmp/dogfood-tests-workspace/.projectos/traces.jsonl \
  --model-override claude-sonnet-4-6 \
  --yes
```

## Critères de succès (vérification objective)

1. Le run atteint `COMPLETE` sans escalade.
2. Les fichiers `packages/core/auto-steering.test.ts` et `packages/memory/embeddings.test.ts` sont créés.
3. `cd /tmp/dogfood-tests-workspace && bun test` → 100% des tests passent (y compris les nouveaux tests créés).
4. La couverture de code sur `auto-steering.ts` et `embeddings.ts` est élevée (≥ 80%).
