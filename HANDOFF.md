# HANDOFF — Echoes of Burbenog

> Создан: 2026-09-26 08:30
> Причина: передача контекста между сессиями

## Текущая задача

`0008` — vertical slice acceptance. Задача функционально реализована в commit `fe2668b`, но штаб вернул её на точечный fix из-за нарушения replay-инварианта через QA seam.

## Что сделано в этой сессии

- Приняты задачи `0001`–`0007`: repository, bootstrap, pure core, snapshot binding, placement и combat presentation.
- Кодовая сессия реализовала pause/resume, restart/replay по command log, terminal feedback, `Awaiting start` и reduced-motion guard.
- Штаб независимо прогнал `typecheck`, `build`, `npm test` и проверил 8 Playwright-сценариев и screenshots.
- Найдено: `dispatchPlayerCommand` логирует команды без проверки `replaying`; QA dispatch во время replay может изменить следующий replay и нарушить tick-order.
- Задача `0008` переведена в состояние «на исправлении», `0009` не выдаётся.

## Что осталось сделать

- [ ] Перенести `replaying` guard в центральный `dispatchPlayerCommand`.
- [ ] Добавить regression-тест инъекции команды через `__ECHOES_DEBUG__.dispatch` во время replay.
- [ ] Исправить misleading copy про restart/replay.
- [ ] Сделать состояние `replaying + paused` явным в badge/status.
- [ ] Повторно прогнать `typecheck`, `build`, `npm test` и screenshots `0008`.
- [ ] После успешной приёмки поставить `0008` в `[x]`, обновить CONTEXT/PLAN и выдать `0009`.

## Ключевые файлы

- `docs/tasks/0008-vertical-slice-acceptance.md` — полный scope, evidence и решение штаба.
- `docs/PLAN.md` — текущий трекер; `0008` оставлен `[ ]`.
- `docs/CONTEXT.md` — статус, `EOB-015` и follow-ups.
- `src/main.ts` — client, snapshot projection, pause/replay, `dispatchPlayerCommand` и debug seam.
- `tests/smoke.spec.ts` — 8 browser E2E, включая replay determinism.
- `src/game-core/*` — pure simulation, не менять без отдельного решения.
- `scripts/check-simulation.ts` — core check.

## Контекст

- Core не изменяется в `0008`; версия victory: tick `323`, gold `229`.
- Replay — client-side QA mechanism: новый `Simulation` из того же seed и tick-упорядоченный command log; session-level replay остаётся `EOB-010`.
- `EOB-015` — replay guard и paused+replay presentation.
- `EOB-012` — отложенное усиление E2E; `EOB-014` — разделение монолитного `main.ts` после приёмки.
- Playwright-managed Chromium может отсутствовать; проверенный локальный fallback задаётся через `PLAYWRIGHT_EXECUTABLE_PATH` и не сохраняется в проекте.

## Команды для проверки

```text
npm run typecheck
npm run build
$env:PLAYWRIGHT_EXECUTABLE_PATH='C:\Users\alexa\AppData\Local\ms-playwright\chromium-1208\chrome-win64\chrome.exe'
npm test
```

## Следующий шаг

Дождаться завершения текущей кодовой сессии, проверить её diff, исправить `dispatchPlayerCommand` и replay presentation, прогнать полный suite, отметить `0008` принятой и выдать задачу `0009`. После продолжения удалить этот `HANDOFF.md` отдельным commit.
