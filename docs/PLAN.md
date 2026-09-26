# Echoes of Burbenog — Plan (штаб)

> Веду я (штаб). Каждый пункт — одно будущее задание кодовой сессии: отдельно сдаётся, отдельно тестируется и отдельно откатывается.
> Статусы: `[ ]` — не начато или сдано и ждёт приёмки, `[x]` — принято штабом после проверки. Номера заданий сквозные.
> Следующая задача: `0009` — сдана кодовой сессией, ждёт приёмки. Текущий этап: фаза 3 закрыта, фаза 4 (asset pipeline) в работе.

## Принципы

- Сначала web и browser QA, потом desktop packaging.
- Gameplay отделён от rendering и transport.
- Каждая задача имеет один измеримый критерий и одну проверку.
- Новая задача не начинается, пока предыдущая не принята и не отмечена `[x]`.
- Visual screenshot дополняет state check, но не заменяет его.
- Сторонние Warcraft III/Burbenog assets, UI и map topology не копируются.

## Текущий статус

| Фаза | Статус | Последнее принятое задание |
|------|--------|---------------------------|
| 0. Repository и contracts | Принята | 0002 — visual identity и scope |
| 1. Browser bootstrap | Принята | 0003 — Three.js scene и QA |
| 2. Pure simulation core | Принята | 0004 — deterministic core |
| 3. Первый визуальный vertical slice | Принята | 0008 — pause/replay и приёмка slice; принят после точечного fix |
| 4. Asset pipeline и 3D polish | В работе | 0009 — выдана |
| 5. Offline singleplayer | Ожидает | — |
| 6. Local cooperative mode | Ожидает | — |
| 7. PvP и mode-specific rules | Ожидает | — |
| 8. Internet services | Ожидает | — |
| 9. Desktop release | Ожидает | — |

## Фаза 0 — Repository и contracts — принята

- [x] 0001 — Создать GitHub-репозиторий, документационную систему и research brief (принято: `main` синхронизирован, brief сохранён)
- [x] 0002 — Зафиксировать solo-first scope, Windows 10/11, browser-first stack и оригинальный visual identity (принято: решения в `docs/DECISIONS.md`)

## Фаза 1 — Browser bootstrap — принята

- [x] 0003 — Собрать TypeScript + Vite + Three.js сцену, schematic build pads, HUD и Playwright smoke test (принято: typecheck, build, E2E и screenshot review)

## Фаза 2 — Pure simulation core — принята

- [x] 0004 — Реализовать pure core: commands, state, events, fixed tick, seeded RNG, маршруты, волны, economy и win/lose (принято: core scenario, two-wave determinism, focused checks и review)

## Фаза 3 — Первый визуальный vertical slice — принята

- [x] 0005 — Связать `MatchSnapshot` с Three.js objects: синхронизировать core, build pads, towers и enemies (принято штабом: typecheck, build, core check, Playwright snapshot contract до victory, screenshots и независимый review; blockers — 0)
- [x] 0006 — Сделать placement по build pads: выбор tower, command в core, стоимость и занятость pad (принято штабом: typecheck, build, test:core, 3 Playwright, реальные canvas-клики, screenshot и независимый review; blockers — 0; follow-up тестов — `EOB-012`)
- [x] 0007 — Подключить запуск волны, движение enemies, targeting, damage и win/lose к HUD (принято штабом: typecheck, build, test:core, 5 Playwright, victory и defeat реальными кликами, typed event counts, 3 screenshot и независимый review; blockers — 0; follow-ups — `EOB-012`/`EOB-013`)
- [x] 0008 — Принять vertical slice: pause/resume, seed replay, core check, Playwright E2E и screenshot review (принято штабом после точечного fix; критерий: все проверки зелёные, визуальная композиция читаема)
  - Кодовая сессия сдала `0008`: Pause как control часов без fast-forward и drift, Restart с replay tick-упорядоченного command log по тому же seed, terminal feedback с приоритетом над command feedback, `Awaiting start` вместо `T-00:00`, `prefers-reduced-motion` без transient-эффектов; typecheck, build, test:core и 8 Playwright прошли, два terminal-отчёта прогона и replay совпали (victory, tick 304, gold 229); screenshots paused/replay/reduced-motion прочитаны; core без изменений.
  - Штаб вернул задачу на точечный fix: `dispatchPlayerCommand` должен блокировать QA-инъекции во время replay, а misleading replay/restart text и paused+replay badge должны быть исправлены. `0009` не выдаётся.
  - Точечный fix сдан: `replaying`-guard живёт в `dispatchPlayerCommand` и закрывает pad-клик, Start Wave и QA seam одним кодом с client-причиной `replay-in-progress`; blocked и terminal copy больше не обещают другой исход; badge получил состояние `paused-replay` с текстом `Replay paused · n / m`. Новый Playwright-сценарий инъекции на tick 0 и в середине replay держит `commandCount` = 4 и два идентичных `matchReports`; с временно убранным guard тест красный. `typecheck`, `build`, `test:core` (tick 323, gold 229) и 9 Playwright (41 s) зелёные, `repeat-each=2` по replay — 4/4; screenshots replay-reset и defeat перечитаны. Core без изменений.

## Фаза 4 — Asset pipeline и 3D polish — в работе

- [ ] 0009 — Собственный asset pipeline: генерация GLB, первая модель вместо placeholder (критерий: placeholder заменён моделью без изменения gameplay; `test:core` даёт те же tick 323 и gold 229)
  - Выдана кодовой сессии. Решения штаба: модели производит zero-dep генератор `scripts/build-assets.ts`, а не DCC — `EOB-006` закрывается этим выбором; артефакты `public/models` генерируются и не коммитятся, `npm test` содержит шаг `test:assets`; реестр моделей — data-контракт `manifest.json`, не путь в коде; только несжатый GLB без текстур; skeletal animation вынесена в `0021`; PBR доводится IBL через `RoomEnvironment`.
  - PBR, тени, свет и tone mapping уже реализованы с `0003`, поэтому в задании только IBL и GLB-часть, а не переработка освещения.
  - Реестр номеров сквозной, но не монотонно-по-этапам: новые задачи получают следующий свободный номер и вставляются в нужную фазу, поэтому `0021` стоит в фазе 4.
  - Сдано кодовой сессией: `scripts/build-assets.ts` (генератор glTF 2.0 binary на голом Node, примитивы cylinder/cone/octahedron/torus, узлы `base`/`stem`/`roof`/`crystal`/`aura`, структурная самопроверка артефакта и детерминизм), `manifest.json` как data-контракт, `src/asset-registry.ts` без Three.js и DOM, two-phase подмена `pulse-spire` на месте, IBL через `RoomEnvironment` с `environmentIntensity = 0.5`, hooks `predev`/`prebuild` и шаг `test:assets` в `npm test`. Evidence: `typecheck` и `build` зелёные, `test:core` — те же `status victory, tick 323, gold 229`, 11 Playwright (46 s), два прогона `build:assets` побайтово идентичны, `git status` после `npm test` чистый, красные проги: сломанный magic, обрезанный chunk, индекс вне accessor, неверная версия контейнера, несовпадение длины — и красный E2E-прогон с отключённым asset status и с отключённой two-phase подменой. Core и content без изменений. Screenshots: `vertical-slice-asset-swap.png` плюс перечитанные `wave-combat-midwave/victory/defeat`, `vertical-slice-paused`, `vertical-slice-replay-reset`, `build-pad-placement`.
- [ ] 0021 — Skeletal animation и animation states: `SkeletonUtils.clone` при restart/replay, `AnimationMixer`, reduced-motion для клипов (критерий: рестарт с анимированной башней не ломает скелет и не двоит анимацию)
- [ ] 0010 — Добавить asset validator и performance budgets для минимального Windows 10/11 железа (критерий: несовместимый asset отклоняется)

## Фаза 5 — Offline singleplayer — ожидает

- [ ] 0011 — Добавить сохранение и восстановление match state/progress (критерий: restart не теряет состояние)
- [ ] 0012 — Провести полный E2E от меню до victory/defeat (критерий: сценарий проходит без ручных шагов)

## Фаза 6 — Local cooperative mode — ожидает

- [ ] 0013 — Добавить server session и private rooms для двух client context (критерий: оба клиента видят одно состояние)
- [ ] 0014 — Проверить permissions, reconnect и late join (критерий: описаны и проверены правила)

## Фаза 7 — PvP и mode-specific rules — ожидает

- [ ] 0015 — Разделить co-op и PvP victory/economy rules без дублирования transport (критерий: один session layer, разные match rules)
- [ ] 0016 — Проверить versioned handshake, replay и anti-cheat boundary (критерий: client не меняет server-owned результат)

## Фаза 8 — Internet services — ожидает

- [ ] 0017 — Добавить identity, rooms, matchmaking и persistence (критерий: threat model и reconnect определены)
- [ ] 0018 — Проверить content/version mismatch и rate limits (критерий: некорректная версия отклоняется понятной ошибкой)

## Фаза 9 — Desktop release — ожидает

- [ ] 0019 — Собрать Wails/Go shell с embedded frontend и native settings/saves (критерий: browser smoke повторяется в WebView2)
- [ ] 0020 — Подготовить release pipeline и desktop regression (критерий: сборка воспроизводима и документирована)

## Заморожено / не делаем сейчас

- Multiplayer, accounts, matchmaking, editor и mods — до стабильной solo-версии.
- Полный roster башен, heroes и точное копирование числовых формул Burbenog.
- Level editor до появления рабочего map contract.
- Wails и dedicated Go server — до измеримой потребности.
- Новые art assets и final art direction — до стабильного schematic placeholder pipeline.

## Правила штаба

1. Сессия читает `AGENTS.md`, `docs/CONTEXT.md` и этот файл.
2. Берётся только следующая `[ ]` задача; задачи выполняются последовательно.
3. После проверки задача получает `[x]`, а рядом фиксируется evidence: команды, тесты, screenshot или причина отказа.
4. После каждого задания обновляются `docs/CONTEXT.md`, этот Plan и commit в `main`.
5. «Заодно» не делать: не расширять scope, новые зависимости и соседние рефакторинги — отдельные задачи.
6. Следующая задача не выдаётся, пока текущая не прошла typecheck/test/build и визуальную проверку, где она применима.

## Источники решений

- `docs/CONTEXT.md` — живое состояние, glossary и open-проблемы.
- `docs/DECISIONS.md` — append-only архитектурные решения.
- `docs/ARCHITECTURE.md` — границы модулей и runtime contract.
- `Old-Burbenog/BURBENOG-TD-RESEARCH.md` — вспомогательный research brief, не план.
