# 0005 — Связать MatchSnapshot с Three.js client

> Статус: выдана
> Приоритет: P0
> Фаза: 3 — Первый визуальный vertical slice
> Следующая приёмка: после отдельного commit и проверки штабом

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

После работы указать:

- изменённые файлы;
- команды и фактический результат;
- путь к screenshot;
- что осталось за пределами 0005;
- статус задачи: `на проверке` или `принята`.

До приёмки задача остаётся `[ ]` в `docs/PLAN.md`.
