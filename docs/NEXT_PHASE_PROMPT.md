# Mission : Phase de crédibilité — combler les manques de ProjectOS

> Prompt d'exécution post-baseline. Préconditions : l'eval 3× (6 tâches) et le
> premier run des tâches dures (06-07) sont terminés, leurs résultats sont dans
> `evals/results/`.

## Contexte

ProjectOS a son squelette complet (15 PRs + extras, 356 tests verts, validé
e2e sur des tâches simples). Les manques identifiés objectivement :

1. Variance des scores inconnue jusqu'au baseline 3× (en cours de résolution)
2. Coûts = estimations tarif-Anthropic, prompt caching non modélisé
3. Pas de compaction de contexte → les runs >30 steps finiront par déborder
4. Mode `--parallel` jamais exécuté en live
5. Cycle self-improve jamais confronté à des tâches qui échouent vraiment

## Tâches, dans l'ordre

### T1 — Analyser les résultats des runs terminés
- Lire `evals/results/2026-06-11/scores.json` (baseline 3×) et
  `evals/results/hard-tasks/` (tâches 06-07).
- Produire un tableau : taskId × passRate × coût moyen × variance.
- Si le baseline 3× est complet et cohérent, le stocker comme baseline v3
  (vérifier qu'il n'a pas déjà été stocké par `--no-baseline` absent).
- Identifier les patterns d'échec des tâches dures (escalation reasons, notes
  `verify=FAILED`).

### T2 — Modéliser le prompt caching dans computeCost
- `packages/telemetry` : étendre `computeCost` pour accepter
  `cacheReadTokens` / `cacheWriteTokens` (cache read ≈ 0.1× input price,
  cache write ≈ 1.25× input price chez Anthropic).
- `packages/core/agent-runner.ts` : récupérer `cache_read_input_tokens` /
  `cache_creation_input_tokens` depuis `usage` si le provider les renvoie,
  les propager dans les traces.
- Mettre à jour la Web UI (server.ts PRICE + affichage) pour montrer le
  coût cache-aware.
- Tests unitaires sur le nouveau computeCost.

### T3 — Compaction de contexte dans l'agent-runner
- Quand l'historique `messages` dépasse un seuil (configurable,
  défaut ~80k tokens estimés à 4 chars/token), compacter :
  garder le premier message (tâche), résumer les tool results anciens en
  une ligne chacun ("[tool X: ok, 2.3k chars omitted]"), garder intacts
  les N derniers tours (défaut 6).
- Option `compaction?: { maxChars: number; keepLastTurns: number }` dans
  `AgentRunnerOptions`, activée par défaut dans ProjectRun.
- Tests : vérifier que la compaction préserve le premier message, les
  derniers tours, et réduit la taille ; vérifier qu'un run scripté
  (fake createMessage) traverse une compaction sans erreur.

### T4 — Cycle self-improve v3 sur les nouvelles données
- Lancer `bun apps/cli/index.ts self-improve --runs 1` AVEC les 8 tâches
  (les tâches dures sont déjà enregistrées dans self-improve.ts).
- Si les tâches dures ont échoué dans T1, l'optimizer doit proposer un
  candidat ciblant leur pattern d'échec. Vérifier que le candidat est
  réellement appliqué pendant le benchmark (env vars PROJECTOS_*).
- Promotion uniquement si aucune régression sur les 8 tâches.
- Si promotion : ADR + vérifier que `loadPromotedConfig` la reflète.

### T5 — Test live du mode --parallel
- Tâche de test : "Create three independent utility modules: src/strings.ts
  (capitalize, slugify), src/numbers.ts (clamp, round2), src/dates.ts
  (isoDate, addDays) — each with its own bun:test file, all tests passing."
- Run 1 : séquentiel (`--parallel 0`), noter durée + coût.
- Run 2 : `--parallel 3`, noter durée + coût.
- Critère de succès : les deux runs COMPLETE, le parallèle est plus rapide,
  coût comparable (±20%). Documenter les chiffres dans le commit.
- Budget : ~$1 au total, modèle claude-sonnet-4-6, --yes.

### T6 — Rapport final
- Mettre à jour ROADMAP.md : section "Phase 2 — crédibilité" avec l'état
  de chaque item (variance, coût cache-aware, compaction, parallèle live,
  self-improve v3).
- Commit + push sur la branche de travail. NE PAS merger sans demander.

## Contraintes

- Modèle : claude-sonnet-4-6 partout (fable indisponible sur le proxy).
- Budget total API pour T4+T5 : 10 $ équivalent-Anthropic max — caper.
- Jamais de secrets dans les commits ; les credentials restent en env.
- `bun test` et `bunx tsc --noEmit` verts avant chaque commit.
- Commits atomiques par tâche (T2, T3 séparés).
