# 0007 — Подключить запуск волны и combat presentation

> Статус: принята
> Приоритет: P0
> Фаза: 3 — Первый визуальный vertical slice
> Следующая приёмка: закрыта; следующая задача `0008`

## Контекст

`0006` принят: placement работает через реальные canvas-клики, content-bound build palette и единственный command path. Core уже умеет двигать enemies, выбирать targets, считать damage, leaks и victory/defeat. Client пока не даёт запустить wave и не показывает combat feedback.

## Цель

Добавить один игровой цикл: реально разместить towers через build pads, нажать Start Wave, дождаться движения и боя, увидеть HUD и итог victory/defeat. Core не меняется; client только отправляет `startWave`, читает snapshot/events и представляет их.

## Входит в задачу

- `src/main.ts` — start-wave input, sync wave/combat status, transient event feedback и debug seam для typed events.
- `index.html` — Start Wave button и DOM hooks для wave/phase/result/enemy count.
- `src/styles.css` — active wave, victory и defeat presentation states.
- `tests/smoke.spec.ts` — E2E полного игрового цикла реальными кликами.
- `docs/PLAN.md`, `docs/CONTEXT.md`, этот файл — статус и evidence.
- `src/game-core/*` — только чтение; не менять simulation behavior или content.

## Порядок работы

1. Добавить Start Wave control, который отправляет только `{ type: 'startWave' }` через общий `dispatchCommand`.
2. Показывать phase из snapshot: preparation с countdown, active wave с `waveTick`, victory или defeat.
3. Показывать enemy count, core integrity и итоговый status из snapshot; не считать их в DOM вручную.
4. Использовать существующую entity projection: enemy positions/health и tower positions должны обновляться из snapshot без отдельной combat state.
5. Сделать transient feedback из `drainEvents`: wave started, spawn, tower fired, enemy killed, core damaged, wave cleared, victory/defeat. События не должны менять state.
6. В debug seam отдавать typed event types или counts, чтобы E2E не проверял только суммарное число событий.
7. Не добавлять новые attacks, waves, tower types или экономику — они уже заданы content/core.

## Acceptance

- Start Wave активируется реальным button click и command проходит через тот же `dispatchCommand`, что и placement.
- После старта `snapshot.status === 'wave'`, enemy count растёт, enemy positions меняются, а HUD показывает active phase.
- Tower/enemy projection и health изменяются только из snapshot; при victory enemies удаляются, tower objects остаются на pads.
- E2E дожидается typed events `waveStarted`, `enemySpawned`, `enemyKilled`, `waveCleared`, `victory` и проверяет итоговый HUD.
- Проверяется defeat-сценарий или детерминированный equivalent без ручного изменения DOM.
- `npm run typecheck` проходит.
- `npm run build` проходит.
- `npm test` проходит, включая `npm run test:core` и Playwright.
- Screenshots mid-wave и result-state показывают читаемую композицию и feedback.
- Console не получает новых warnings/errors; favicon 404 остаётся `EOB-011`.

## Не входит

- Pause/resume, replay UI и seed reset — 0008.
- Selling, upgrade, repair, transfer.
- Новые tower/enemy types, waves, economy, abilities и assets.
- Multiplayer, sessions, persistence и Wails.
- Hover-камера, zoom, drag-rotate и keyboard controls.

## Проверка

```text
npm run typecheck
npm run build
npm test
```

E2E должен использовать реальные click по pad и Start Wave button. Debug dispatch допускается только для дополнительной проверки, не вместо input path.

## Отчёт сессии

### Изменённые файлы

- `index.html` — Start Wave button в dock, `data-phase` у viewport, блок Match phase
  (`match-phase`, `phase-timer`, `enemy-count`), result banner, combat log, `objective-detail`.
- `src/main.ts` — `attemptWaveStart` через общий `dispatchCommand`, HUD-проекция phase/timer/
  enemy count/result, `consumeEvents` с typed-счётчиками, transient feedback (наведение и вспышка
  башни по `towerFired`, burst-ring по `enemyKilled`, flash core по `coreDamaged`), debug seam
  `eventCounts` и `recentEvents`.
- `src/styles.css` — состояния viewport `data-phase="wave|victory|defeat"`, Start Wave button,
  блок Match phase, combat log, result banner, `prefers-reduced-motion` guard.
- `tests/smoke.spec.ts` — атомарный `readHud` (DOM + snapshot в одной task), E2E полного цикла
  реальными кликами и E2E defeat.
- `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/PLAN.md`, `docs/CONTEXT.md`, этот файл —
  контракт seam, решение, статус и evidence.

`src/game-core/*` и `scripts/check-simulation.ts` не менялись: клиент использует существующие
`startWave`, `drainEvents` и reason-коды. Значения pure check не изменились: victory tick 323, gold 229.

### Scenario и значения

Training scenario, seed 1337, viewport 1280×720. Размещение — реальными canvas-кликами:
`pulse-spire` → `pad-east`, `grove-lens` → `pad-north`, `frost-relay` → `pad-south`
(cost 50 + 70 + 60 = 180, gold 220 → 40). Старт волны — реальный click по Start Wave.

E2E victory (3 теста, реальные клики, без ручного изменения DOM):

| Шаг | Действие | Ожидается | Получено |
|-----|----------|-----------|----------|
| 1 | три canvas-клика по pads | accept, 3 towers | `towerPlaced` × 3, gold 40, 3 tower-объекта на pads |
| 2 | HUD до старта | preparation | `data-phase="preparation"`, `T-00:00` (prep countdown уже истёк), `Hostiles 0`, banner скрыт, button enabled |
| 3 | click Start Wave | `status = 'wave'` | `waveStarted` × 1, `W+00:00`, button disabled, feedback `Wave 1 started` |
| 4 | первый spawn | enemies > 0, позиция растёт | `enemySpawned` × 5+, `snapshot.enemies[0].distance` и `x` меняются, projection == snapshot |
| 5 | первая атака | `towerFired` > 0, health падает | у отслеживаемого врага `distance` вырос, `x` уменьшился, есть враг с `health < maxHealth` |
| 6 | итог | victory | `enemySpawned` 16, `enemyKilled` 16, `waveCleared` 1, `victory` 1, `coreDamaged` 0, gold 229, integrity 100%, towers 3, enemies 0, banner `Sector secured` |

Волна детерминирована относительно момента `startWave`: победа наступает через 293 wave-тик
(absolute tick зависит от момента клика), это тот же исход, что и в pure check на tick 323
(`startWave` там на tick 30). Награды и bounty считаются из content: 7×10 + 6×8 + 3×12 = 154,
bounty 35, итог 40 + 154 + 35 = 229.

E2E defeat (тот же content, ноль башен — детерминированный эквивалент, без правки DOM):

| Шаг | Действие | Ожидается | Получено |
|-----|----------|-----------|----------|
| 1 | click Start Wave без башен | `status = 'wave'`, `towerFired` 0 | `waveStarted` × 1, 0 towers |
| 2 | ждать терминальный статус | defeat | `coreDamaged` × 10 (`coreHealth` 10), `leaksThisWave` 10, `enemyKilled` 0, `waveCleared` 0, `defeat` 1, `victory` 0 |
| 3 | HUD | defeat | `data-phase="defeat"`, `Breached`, integrity `0%`, `Core lost on wave 1`, banner `Core breached` |

Debug seam отдаёт `eventCounts` (по типам, не суммарно) и `recentEvents`; E2E проверяет
конкретные типы (`waveStarted`, `enemySpawned`, `towerFired`, `enemyKilled`, `waveCleared`,
`victory`, `coreDamaged`, `defeat`) и сверяет HUD со snapshot в одной task, чтобы не ловить гонку
с fixed-step циклом.

### Команды и результат

```text
npm run typecheck   ok
npm run build       ok (11 modules, 571 kB js; warning о chunk size — pre-existing от three)
npm run test:core   ok (victory tick 323, gold 229 — значения не изменились)
npm test            5 passed: bootstrap smoke, placement contract, snapshot binding до victory,
                    полный цикл до victory реальными кликами, defeat без башен
```

Playwright запускался с локальным Chromium через `PLAYWRIGHT_EXECUTABLE_PATH`
(managed-сборка 1243 не установлена); путь в проекте не сохранён.

Console: только `[vite] connecting/connected` и известный favicon 404 (`EOB-011`); новых
warnings и errors нет. Проверено временным прогоном console-проверки, файл удалён.

### Screenshot

- `test-results/wave-combat-midwave.png` — активная волна: три башни, пять врагов на маршрутах,
  combat log (`Husk/Runner inbound`), `Wave active`, `W+00:01`, `Hostiles 5`, Start Wave disabled.
- `test-results/wave-combat-victory.png` — `Sector secured`, teal-рамка viewport, лог
  `Sector secured` / `Wave 1 cleared · leaks 0 · bounty 35`, `Victory`, `Cleared`, `Hostiles 0`,
  Aether 229, `Objective complete`; башни остались на pads, burst-ring от последнего убийства виден.
- `test-results/wave-combat-defeat.png` — `Core breached`, красная рамка и красные core-кольцо и
  кристалл, лог `Core hit · -1 integrity`, `Defeat`, `Breached`, integrity `0%`, Aether 220.

## Независимая приёмка штабом

- Проверен commit `03e22dd` и чистое рабочее дерево.
- `npm run typecheck` — зелёный.
- `npm run build` — зелёный; остаётся только известное предупреждение Vite о chunk > 500 kB из-за Three.js.
- `npm test` — `npm run test:core` и 5 Playwright-тестов зелёные.
- Screenshots mid-wave, victory и defeat проверены визуально: phase, hostiles, combat log, result banners и transient feedback читаются.
- Code review: blockers — 0; task verdict — принята.
- Follow-ups: `EOB-012` (E2E hardening) и `EOB-013` (preparation countdown semantics); terminal feedback и canvas reduced-motion guard входят в `0008`.

### За пределами 0007

- Pause/resume, seed replay и reset — 0008.
- Selling, upgrade, repair, transfer; новые tower/enemy types, waves, economy, assets.
- Multiplayer, sessions, persistence, Wails; hover-камера, zoom, drag-rotate, keyboard controls.
- `towerFired` намеренно не попадает в combat log: вспышка и наведение башни показывают выстрел
  в сцене, иначе лог состоит только из повторных выстрелов. Событие полностью видно в
  `eventCounts`/`recentEvents`.
- Tower разворачивается к цели мгновенно на время вспышки, без интерполяции — кандидат на
  polish вместе с asset pipeline.
- Console-assertions остаются в `EOB-012`.

### Статус

`принята`. `docs/PLAN.md` переведён на следующую задачу `0008`.
