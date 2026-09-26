# 0005 — Связать MatchSnapshot с Three.js client

> Статус: принята
> Приоритет: P0
> Фаза: 3 — Первый визуальный vertical slice
> Следующая приёмка: закрыта; следующая задача `0006`

## Контекст

`src/game-core/` уже содержит pure deterministic simulation и training scenario. Browser bootstrap пока создаёт часть Three.js-объектов вручную и не читает `MatchSnapshot`. Задача — убрать это расхождение и сделать snapshot единственным источником presentation state.

## Цель

Client должен создать один `Simulation` из `createTrainingScenario()`, получать `MatchSnapshot` и синхронизировать с ним Three.js presentation. Никаких параллельных ручных массивов tower/enemy state не остаётся.

## Входит в задачу

- `src/main.ts` — подключить `Simulation`, `createTrainingScenario`, `TICK_RATE` и snapshot projection.
- `src/game-core/*` — только чтение; менять core запрещено без отдельного решения штаба.
- `index.html`, `src/styles.css` — только если требуется DOM/status hook для проверки.
- `tests/smoke.spec.ts` — расширить smoke test детерминированным snapshot-контрактом.
- `scripts/check-simulation.ts` — не менять без необходимости.

## Порядок работы

1. Создать единственный экземпляр `Simulation` из training scenario.
2. Заменить ручные tower/enemy arrays на projection по `entityId` из `MatchSnapshot`.
3. Строить initial presentation из `map.routes`, `map.buildPads`, `map.corePosition`; не дублировать координаты отдельно от content.
4. Обновлять projection после каждого simulation tick и удалять исчезнувшие objects.
5. Использовать `requestAnimationFrame` только для render и fixed-step accumulator; не вызывать `step()` с произвольным browser delta.
6. Сохранить `window.__ECHOES_DEBUG__` и расширить его tick/status/entity counters для E2E.
7. Проверить, что resize, camera, schematic materials и общий визуальный язык не регрессировали.

## Acceptance

- `npm run typecheck` проходит.
- `npm run build` проходит.
- `npm test` проходит, включая `npm run test:core` и Playwright.
- Playwright проверяет, что `__ECHOES_DEBUG__` отражает `MatchSnapshot`.
- На screenshot видны data-driven core, pads и path; нет старых вручную созданных tower/enemy объектов.
- Console не содержит новых warnings и errors.
- Изменения ограничены задачей; `git diff --stat` содержит только ожидаемые файлы.

## Не входит

- Новые tower/enemy types, waves, economy или abilities.
- Кликовый placement, start-wave button и combat loop — это задачи 0006 и 0007.
- Pause/resume, save/restore, multiplayer, Wails и новые assets.
- Рефакторинг всего client в `src/client/`, если он не нужен для snapshot projection.

## Проверка

```text
npm run typecheck
npm run build
npm test
```

При отсутствии Playwright-managed Chromium допускается офлайн-проверка через `PLAYWRIGHT_EXECUTABLE_PATH`; путь не сохранять в проекте.

## Отчёт сессии

Изменённые файлы:

- `src/main.ts` — один `Simulation` из `createTrainingScenario()`, fixed-step accumulator, projection по `entityId`, сцена из `map.routes`, `map.buildPads`, `map.corePosition`, `map.width/depth`, расширенный `__ECHOES_DEBUG__`.
- `index.html` — два `data-testid` для проверки HUD-привязки (`gold-value`, `core-integrity`), стартовые значения совпадают со snapshot.
- `tests/smoke.spec.ts` — новый E2E `drives presentation from MatchSnapshot without duplicated state`.
- `docs/PLAN.md`, `docs/CONTEXT.md`, этот файл — статусы и evidence.
- `src/game-core/*` не менялись.

Команды и результат:

- `npm run typecheck` — зелёный.
- `npm run build` — зелёный; остаётся прежнее предупреждение Vite о chunk > 500 kB (three.js).
- `npm run test:core` — `simulation check: ok` (victory, tick 323, gold 229).
- `npm test` — `npm run test:core` плюс 2 Playwright теста, оба зелёные; snapshot binding тест идёт 16.8 s реального времени, потому что ждёт victory на фиксированном seed.
- Playwright запускался офлайн через `PLAYWRIGHT_EXECUTABLE_PATH` на установленный chromium; путь в проекте не сохранён.

Screenshots:

- `test-results/bootstrap.png` — стартовое состояние: data-driven core, 5 pads, два route; ручных tower/enemy объектов нет.
- `test-results/snapshot-binding.png` — три башни на занятых pads и enemies с health bars в середине волны.

Что проверено в E2E:

- `__ECHOES_DEBUG__` отражает `MatchSnapshot`: content identity (seed, map, routes, pads, waves), `preparationTicksLeft === max(0, prepTicks - tick)`, `rngState` до first RNG use.
- Projection: `rendered.pads/towers/enemies` равны snapshot, позиции enemies совпадают с `enemy.x/z`, башни стоят на координатах pads из content.
- Создание, обновление и удаление объектов: волна доходит до victory, `rendered.enemies` становится 0, `gold` совпадает с детерминированным значением 229.
- HUD: Aether, Integrity и Wave берутся из snapshot.

## Независимая приёмка штабом

- Проверен commit `572ee8c` и чистое рабочее дерево.
- `npm run typecheck` — зелёный.
- `npm run build` — зелёный; остаётся только известное предупреждение Vite о chunk > 500 kB из-за Three.js.
- `npm test` — `npm run test:core` и 2 Playwright-теста зелёные.
- Screenshots `test-results/bootstrap.png` и `test-results/snapshot-binding.png` проверены визуально: data-driven core, pads, routes, towers и enemies читаются.
- Code review: blockers — 0; task verdict — принята.
- Follow-up качества тестов вынесен в `EOB-012`: entityId-сопоставление позиций, реальные route-счётчики, typed event assertions и console assertions.

Что осталось за пределами 0005:

- Кликовый placement и стоимость — 0006.
- Start-wave кнопка, targeting, damage, win/lose в HUD, countdown objective — 0007.
- Pause/resume, seed replay, screenshot baseline — 0008.
- `favicon.ico` даёт 404 в console; это состояние было до задания, отмечено как EOB-011.

Статус задачи: принята.
