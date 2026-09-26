# Echoes of Burbenog — Plan (штаб)

> Веду я (штаб). Каждый пункт — одно будущее задание кодовой сессии: отдельно сдаётся, отдельно тестируется и отдельно откатывается.
> Статусы: `[ ]` — не начато или сдано и ждёт приёмки, `[x]` — принято штабом после проверки. Номера заданий сквозные и монотонные: номер совпадает с порядком выдачи, поэтому список внутри фазы читается как порядок работы.
> Следующая задача: `0010` — выдана кодовой сессии. Текущий этап: фаза 4 в работе, `0009` принята.

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
| 4. Asset pipeline и 3D polish | В работе | 0009 — asset pipeline и первая GLB-модель; `0010` выдана |
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

- [x] 0009 — Собственный asset pipeline: генерация GLB, первая модель вместо placeholder (критерий: placeholder заменён моделью без изменения gameplay; `test:core` даёт те же tick 323 и gold 229)
  - Выдана кодовой сессии. Решения штаба: модели производит zero-dep генератор `scripts/build-assets.ts`, а не DCC — `EOB-006` закрывается этим выбором; артефакты `public/models` генерируются и не коммитятся, `npm test` содержит шаг `test:assets`; реестр моделей — data-контракт `manifest.json`, не путь в коде; только несжатый GLB без текстур; skeletal animation вынесена в `0012`; PBR доводится IBL через `RoomEnvironment`.
  - PBR, тени, свет и tone mapping уже реализованы с `0003`, поэтому в задании только IBL и GLB-часть, а не переработка освещения.
  - Реестр номеров приведён в порядок после приёмки `0009`: невыданный хвост перенумерован монотонно, `0021` стал `0012`, а IBL-вопрос вынесен в отдельную `0011`, потому что у него другой критерий и другая проверка.
  - Сдано кодовой сессией: `scripts/build-assets.ts` (генератор glTF 2.0 binary на голом Node, примитивы cylinder/cone/octahedron/torus, узлы `base`/`stem`/`roof`/`crystal`/`aura`, структурная самопроверка артефакта и детерминизм), `manifest.json` как data-контракт, `src/asset-registry.ts` без Three.js и DOM, two-phase подмена `pulse-spire` на месте, IBL через `RoomEnvironment` с `environmentIntensity = 0.5`, hooks `predev`/`prebuild` и шаг `test:assets` в `npm test`. Evidence: `typecheck` и `build` зелёные, `test:core` — те же `status victory, tick 323, gold 229`, 11 Playwright (46 s), два прогона `build:assets` побайтово идентичны, `git status` после `npm test` чистый, красные проги: сломанный magic, обрезанный chunk, индекс вне accessor, неверная версия контейнера, несовпадение длины — и красный E2E-прогон с отключённым asset status и с отключённой two-phase подменой. Core и content без изменений. Screenshots: `vertical-slice-asset-swap.png` плюс перечитанные `wave-combat-midwave/victory/defeat`, `vertical-slice-paused`, `vertical-slice-replay-reset`, `build-pad-placement`.
  - Штаб принял `0009` (`518d480`): 11/11 Playwright и нагрузочные 22/22, оба self-decision сессии приняты, blockers — 0. Неблокирующие находки: `EOB-017` (замер clock сразу за screenshot), а в `0010` — сверка `bytes`/`contentHash`, отклонение `SkinnedMesh` и измерение бюджетов, в `0011` — область действия IBL.
- [ ] 0010 — Asset validator и performance budgets: несовместимый ассет отклоняется в сборке и на клиенте (критерий: превышение бюджета или нарушение контракта даёт внятный отказ, а не тихую деградацию)
  - Выдана кодовой сессии. Обязательный scope из приёмки `0009`: сверка `bytes` и `contentHash` при загрузке, отклонение `SkinnedMesh` и прочих узлов, которые `cloneModelNode` не умеет воспроизвести, и измерение draw calls, треугольников, shader-программ и времени загрузки в debug seam.
  - Бюджеты живут в одном общем модуле `src/asset-budgets.ts`, который импортируют и генератор, и клиент: одна правка бюджета обязана ломать и сборку, и рантайм-проверку. Числа предварительные, рассчитаны на класс GT 1030 / UHD 620, и остаются предметом пересмотра, пока владелец не зафиксирует минимальное тестовое железо (`EOB-002`).
  - Сдано кодовой сессией, на проверке: `src/asset-budgets.ts` как единственный источник лимитов (модель 5 000 tris / 1 MiB / 32 узла / 32 меша / 16 материалов / 0 текстур / 0 скинов, морфов и клипов / высота 4.0 / footprint 0.85 / pivot Y 0 ± 0.01; реестр 8 MiB / 150 000 tris / 64 модели; сцена 400 calls / 250 000 tris / 32 программы / 1 500 мс) с предикатами `checkModelContract`, `checkNodeTypes`, `checkRegistryBudgets`, `checkSceneBudget`; генератор меряет модель и отказывается писать артефакт и манифест при нарушении, проверка идёт до первого `writeFileSync`; клиент сверяет `bytes` всегда и `contentHash` при наличии `crypto.subtle`, обходит дерево модели до инстанцирования и отказывает локально по одной модели, не роняя остальной реестр; seam публикует бюджеты, `renderer.info`, время загрузки, суммы по реестру и флаг каждой выполненной проверки. Evidence: `typecheck` и `build` зелёные, `test:core` — те же `status victory, tick 323, gold 229`, `test:assets` — 8 красных проверок, 13 Playwright (45 s), `git status` после `npm test` чистый, артефакт побайтово тот же (`sha256:25b4af43…`), core и content без изменений, визуал не тронут. Измерено: 70/400 calls, 3 794/250 000 tris, 7/32 программы, 418 мс/1 500 мс, реестр 1/64, 17 996/8 388 608 байт, 580/150 000 tris. Красные проги: временно сниженный лимит треугольников → `build:assets` и `test:assets` красные с exit 1 и без записи артефакта; снятый `gateModel` в `assemble` → красный `test:assets`; снятая сверка `contentHash` → красный негативный E2E (`data-assets` = `ready` вместо `error`). Screenshots: `asset-budgets-scene.png`, `asset-refused-content-hash.png`.
  - Отклонение от п.7 задания: негативный E2E один и проверяет отказ по `contentHash`, а не два отказа (превышенный бюджет и `contentHash`) — по прямому порядку владельца «два E2E: сцена в бюджете и отказ по подмене манифеста» и потому что именно снятая сверка `contentHash` даёт требуемый красный прогон. Клиентский отказ по превышению бюджета реализован и покрыт красным прогоном в генераторе; на клиенте те же числа проверяются в позитивном E2E. Отдельная причина отказа по узлу непокрыта E2E и закрывается вместе с `0012`.
- [ ] 0011 — Область действия IBL и material pass: per-material `envMapIntensity` вместо глобального `environmentIntensity = 0.5` (критерий: ground возвращается к pre-IBL тону, а GLB-материалы читаются как металл)
- [ ] 0012 — Skeletal animation и animation states: `SkeletonUtils.clone` при restart/replay, `AnimationMixer`, reduced-motion для клипов (критерий: рестарт с анимированной башней не ломает скелет и не двоит анимацию)

## Фаза 5 — Offline singleplayer — ожидает

- [ ] 0013 — Добавить сохранение и восстановление match state/progress (критерий: restart не теряет состояние)
- [ ] 0014 — Провести полный E2E от меню до victory/defeat (критерий: сценарий проходит без ручных шагов)

## Фаза 6 — Local cooperative mode — ожидает

- [ ] 0015 — Добавить server session и private rooms для двух client context (критерий: оба клиента видят одно состояние)
- [ ] 0016 — Проверить permissions, reconnect и late join (критерий: описаны и проверены правила)

## Фаза 7 — PvP и mode-specific rules — ожидает

- [ ] 0017 — Разделить co-op и PvP victory/economy rules без дублирования transport (критерий: один session layer, разные match rules)
- [ ] 0018 — Проверить versioned handshake, replay и anti-cheat boundary (критерий: client не меняет server-owned результат)

## Фаза 8 — Internet services — ожидает

- [ ] 0019 — Добавить identity, rooms, matchmaking и persistence (критерий: threat model и reconnect определены)
- [ ] 0020 — Проверить content/version mismatch и rate limits (критерий: некорректная версия отклоняется понятной ошибкой)

## Фаза 9 — Desktop release — ожидает

- [ ] 0021 — Собрать Wails/Go shell с embedded frontend и native settings/saves (критерий: browser smoke повторяется в WebView2)
- [ ] 0022 — Подготовить release pipeline и desktop regression (критерий: сборка воспроизводима и документирована)

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
