# Echoes of Burbenog — Plan (штаб)

> Веду я (штаб). Каждый пункт — одно будущее задание кодовой сессии: отдельно сдаётся, отдельно тестируется и отдельно откатывается.
> Статусы: `[ ]` — не начато, `[x]` — принято штабом после проверки. Номера заданий сквозные.
> Следующая задача: `0006`. Текущий этап: первый визуальный vertical slice.

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
| 3. Первый визуальный vertical slice | В работе | 0005 — snapshot binding; следующая: 0006 |
| 4. Asset pipeline и 3D polish | Ожидает | — |
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

## Фаза 3 — Первый визуальный vertical slice — следующая

- [x] 0005 — Связать `MatchSnapshot` с Three.js objects: синхронизировать core, build pads, towers и enemies (принято: typecheck, build, core check, Playwright snapshot contract до victory и screenshot review; `__ECHOES_DEBUG__` отдаёт snapshot, rendered-счётчики и позиции)
- [ ] 0006 — Сделать placement по build pads: выбор tower, command в core, стоимость и занятость pad (критерий: placement проходит pure check и E2E)
- [ ] 0007 — Подключить запуск волны, движение enemies, targeting, damage и win/lose к HUD (критерий: полный игровой цикл воспроизводится в браузере)
- [ ] 0008 — Принять vertical slice: pause/resume, seed replay, core check, Playwright E2E и screenshot review (критерий: все проверки зелёные, визуальная композиция читаема)

## Фаза 4 — Asset pipeline и 3D polish — ожидает

- [ ] 0009 — Подключить GLB/glTF, PBR-материалы, освещение и skeletal animation (критерий: placeholder заменяется моделью без изменения gameplay)
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
