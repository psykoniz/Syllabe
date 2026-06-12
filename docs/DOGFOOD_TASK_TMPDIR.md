# Dogfooding : Migration de /tmp vers os.tmpdir()

> Test de portabilité et de refactoring de bas niveau : l'agent doit modifier les chemins de fichiers temporaires codés en dur dans les tests unitaires pour assurer la compatibilité Windows, macOS, et Linux.

## La tâche donnée à l'agent

Refactoriser tous les fichiers de tests unitaires du projet situés dans `packages/` pour remplacer l'utilisation de chemins absolus de type `/tmp/...` codés en dur par `os.tmpdir()` (via le module `os` de Node.js).

Fichiers cibles identifiés :
- `packages/tools/shell/bash.test.ts`
- `packages/tools/git/git-tools.test.ts`
- `packages/tools/filesystem/fs-tools.test.ts`
- `packages/telemetry/traces.test.ts`
- `packages/sandbox/sandbox.test.ts`
- `packages/memory/memory.test.ts`
- `packages/core/project-run.test.ts`
- `packages/core/agent-runner.test.ts`
- `packages/agents/interview.test.ts`
- `packages/agents/reviewer.test.ts`
- `packages/agents/harness-optimizer.test.ts`
- `packages/agents/architect.test.ts`

Consignes :
1. Importer `tmpdir` depuis `os` (ou `import os from "os"`).
2. Utiliser `join(tmpdir(), "nom-du-test-unique")` pour créer les répertoires de travail temporaires.
3. S'assurer que les imports sont propres et que les répertoires sont correctement nettoyés après chaque test.
4. Lancer `bun test` pour s'assurer qu'aucun test ne casse sous Windows et autres plateformes.

## Préparation du run

L'agent doit tourner sur une COPIE du repo :

```bash
cp -r /home/user/Syllabe /tmp/dogfood-tmpdir-workspace
cd /tmp/dogfood-tmpdir-workspace
rm -rf .projectos .git && git init -q && git add -A && git commit -qm seed
```

## Commande de lancement

```bash
cd /home/user/Syllabe
bun apps/cli/index.ts build \
  --task "Replace all hardcoded /tmp path strings in all test files inside packages/ with os.tmpdir() to ensure cross-platform compatibility (especially for Windows). Run bun test to verify that the tests pass." \
  --workspace /tmp/dogfood-tmpdir-workspace \
  --db /tmp/dogfood-tmpdir-workspace/.projectos/runs.db \
  --traces /tmp/dogfood-tmpdir-workspace/.projectos/traces.jsonl \
  --model-override claude-sonnet-4-6 \
  --yes
```

## Critères de succès (vérification objective)

1. Le run atteint `COMPLETE` sans escalade.
2. `cd /tmp/dogfood-tmpdir-workspace && bun test` → 100% des tests passent (incluant `fs-tools.test.ts` et `bash.test.ts` qui échouaient sur Windows).
3. Une recherche de `"/tmp/"` dans le code des tests de `packages/` ne retourne plus aucun résultat de chemin en dur.
