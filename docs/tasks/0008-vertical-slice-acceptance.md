# 0008 — Принять vertical slice: pause/resume, seed replay и regression

> Статус: принята
> Приоритет: P0
> Фаза: 3 — Первый визуальный vertical slice
> Приёмка: replay-инвариант и terminal/restart polish закрыты точечным fix

## Контекст

`0007` принят: реальный Start Wave, snapshot-driven HUD, transient combat feedback, victory и defeat воспроизводятся в браузере. Vertical slice функционально играется, но ещё не имеет честной паузы, повторного deterministic сценария и финального polish/regression слоя.

## Цель

Принять vertical slice как первый baseline: добавить pause/resume, детерминированный replay/reset по seed, корректное terminal-state feedback и reduced-motion поведение. Не менять core mechanics или content balance.

## Входит в задачу

- `src/main.ts` — pause/resume state, deterministic reset/replay seam, terminal feedback precedence, canvas reduced-motion guard.
- `index.html` — Pause/Resume/Restart controls и DOM hooks для paused/replay state.
- `src/styles.css` — paused/result presentation и reduced-motion states.
- `tests/smoke.spec.ts` — pause/resume, replay determinism и final vertical-slice regression.
- `docs/PLAN.md`, `docs/CONTEXT.md`, этот файл — статус и evidence.
- `src/game-core/*` — только чтение; не менять simulation algorithm или content.

## Порядок работы

1. Добавить Pause/Resume, который останавливает fixed-step вызовы `simulation.step()`, но сохраняет текущий snapshot и positions.
2. Проверить, что resume не создаёт drift: после паузы wave продолжается с того же tick и даёт тот же terminal result.
3. Добавить Restart/Replay по тому же seed и фиксированной последовательности placement/start-wave commands. Replay должен быть client-side QA mechanism, не новой network protocol.
4. Не показывать `T-00:00` как полноценный countdown, если preparation уже истёк; показать нейтральное `Awaiting start` или принять отдельное content-решение по `EOB-013`.
5. Сбрасывать/переводить command feedback в terminal state при victory/defeat, чтобы прошлый `Wave started` не выглядел текущим результатом.
6. Проверять `prefers-reduced-motion` и отключать transient canvas feedback/ambient motion, оставляя статическое состояние читаемым.
7. Сохранить typed `eventCounts`, snapshot contract и projection без ручных parallel-state arrays.

## Acceptance

- Pause во время active wave замораживает `snapshot.tick`, enemy positions и projection; Resume продолжает без скачка и drift.
- Restart/Replay с тем же seed и той же command sequence даёт одинаковые final gold, event counts и victory/defeat status.
- HUD не показывает stale command feedback после terminal state.
- Preparation display truthful: `Awaiting start` или явно принятое content duration, без вводящего в заблуждение `T-00:00`.
- `prefers-reduced-motion` отключает transient combat effects и ambient motion в canvas.
- `npm run typecheck` проходит.
- `npm run build` проходит.
- `npm test` проходит: core check, все существующие E2E и новые pause/replay tests.
- Mid-wave, paused и result screenshots визуально читаемы.
- Core остаётся без изменений; новые зависимости не добавляются.

## Не входит

- Новые waves, towers, enemies, abilities, economy или balance.
- Save/restore, persistence, accounts, multiplayer и Wails.
- Полноценный level editor и asset pipeline.
- Массовый рефакторинг `main.ts` в `src/client/` — отдельный follow-up после приёмки slice.

## Проверка

```text
npm run typecheck
npm run build
npm test
```

E2E должен использовать реальные click по pads и Start Wave. Pause/Resume/Restart проверяются через DOM controls, а не прямым вызовом `simulation.step()`.

## Отчёт сессии

После работы указать:

- изменённые файлы;
- pause tick до/после и replay final values;
- команды и результат;
- пути к screenshots;
- что осталось за пределами 0008;
- статус задачи: `на проверке` или `принята`.

До приёмки задача остаётся `[ ]` в `docs/PLAN.md`.

## Отчёт кодовой сессии

**Статус сдачи: на проверке** (первая сдача версии 1; вердикт и доработки — в отчёте по точечному fix ниже). Штаб не принимал задачу в этой части; `[x]` в `docs/PLAN.md` и статус `принята` проставлены после приёмки.

### Изменённые файлы

- `src/main.ts` — pause/resume, `commandLog` и restart/replay, `matchReports`, terminal feedback precedence, `Awaiting start` в preparation clock, `prefers-reduced-motion` guard, DOM hooks для paused/replay и расширенный debug seam.
- `index.html` — Pause/Resume и Restart controls, `state-badge`, `data-paused`/`data-replay` на viewport, нейтральный стартовый phase clock.
- `src/styles.css` — paused и replay presentation, ghost-контролы, terminal feedback, disabled palette, остановка pulse-dot на паузе.
- `tests/smoke.spec.ts` — три новых сценария (pause/resume, replay determinism, reduced motion), правка проверки phase timer и terminal feedback в существующих сценариях.
- `docs/PLAN.md`, `docs/CONTEXT.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, этот файл — статус и evidence.
- `src/game-core/*` — не менялись; `package.json` не менялся, зависимостей нет.

### Pause tick до/после

- Заморозка на активной волне: `tick 47`, `waveTick` и positions enemy зафиксированы.
- Через 1.2 s паузы: `tick 47`, `waveTick` тот же, `rngState` тот же, `enemyPositions`, `towerPositions`, `rendered`, `eventCounts` и `recentEvents` совпадают с моментом паузы; `snapshot` совпадает с projection.
- Сразу после Resume: `tick 47` — fast-forward нет. За следующую 1.0 s: `+21` тик (20 тиков в секунду, без stall и без двойного шага).

### Replay final values

Restart пересоздал `Simulation` из того же `config` (seed 1337) и проигрывает 4 записанные команды на исходных тиках. Terminal-отчёты двух прогонов совпали полностью:

```text
status victory, tick 304, gold 229, integrity 10/10, leaks 0
eventCounts: towerPlaced 3, waveStarted 1, enemySpawned 16,
             towerFired 65, enemyKilled 16, waveCleared 1, victory 1,
             coreDamaged 0, defeat 0
```

### Команды и результат

- `npm run typecheck` — ok.
- `npm run build` — ok (tsc + vite build).
- `npm test` — ok: core check (`simulation check: ok`, victory tick 323, gold 229) и 8 Playwright-сценариев, 41 s.
- `npx playwright test --repeat-each=3 -g "freezes and resumes|restarts from the same seed|reduced-motion"` — 9/9 ok, тайминги паузы не плавают.

### Screenshots

- `test-results/vertical-slice-paused.png` — пауза на активной волне: badge `PAUSED`, амберовый контур viewport, `RESUME`, замороженные hostiles.
- `test-results/vertical-slice-replay-reset.png` — сброшенный матч перед replay: aether 220, башни и enemies убраны, badge `REPLAY · 0 / 4 COMMANDS`, палитра и Start Wave disabled.
- `test-results/vertical-slice-replay-victory.png` — replay дошёл до того же результата, terminal feedback в HUD.
- `test-results/vertical-slice-reduced-motion.png` — kills идут, burst-ring и bob отсутствуют, health bars и HUD читаемы.
- Прежние `wave-combat-midwave.png`, `wave-combat-victory.png`, `wave-combat-defeat.png` — композиция не пострадала после добавления контролов.

### За пределами 0008

- Разбивка `src/main.ts` на `src/client/` (`EOB-014`).
- Console-assertions и content-bound selectors в E2E (`EOB-012`).
- Session-level replay и transport (`EOB-010`), save/restore, accounts, multiplayer, Wails.
- Изменение content: длина `prepTicks` остаётся балансным решением, display-семантика закрыта в `0008`.
- Favicon (`EOB-011`).

## Решение штаба

- Task verdict: **на исправлении**, blockers — 0, но replay-инвариант пока не закрыт.
- Root cause: `dispatchPlayerCommand` логирует команды без проверки `replaying`; QA seam может добавить команду вне tick-order и тихо изменить следующий replay.
- Required fix: перенести guard в `dispatchPlayerCommand`, покрыть его тестом инъекции во время replay и проверить неизменность command log/match report.
- Required polish: исправить misleading text про «restart again to change the run» и сделать состояние `replaying + paused` явным в badge/status.
- После fix повторно прогнать `typecheck`, `build`, `npm test` и 0008 screenshots; `0009` до этого не выдаётся.

## Отчёт сессии по точечному fix

**Статус: исправлено, task verdict — принята.**

### Root cause и fix

- `dispatchPlayerCommand` — единственный путь и в `commandLog`, и в core для player-команд, поэтому replay-guard перенесён туда и удалён из `attemptPlacement`/`attemptWaveStart`. Пока `replaying`, команда возвращает `{ accepted: false, reason: 'replay-in-progress' }`, не пишется в log и не доходит до core — одинаково для pad-клика, Start Wave и QA seam.
- Вызывающие только докладывают core-отказы и не перетирают feedback guard-а; pad не мигает при replay-отказе, потому что build не доходил до проверки.
- Copy: blocked-feedback `Recorded run is replaying · commands are locked until it finishes` вместо ложного «restart again to change the run»; terminal-feedback `Sector secured / Core breached · restart repeats this run exactly` вместо «restart replays the same seed», который на defeat читался как шанс на другой исход.
- Presentation: badge различает `paused + replay` — `data-state="paused-replay"`, текст `Replay paused · n / m commands`, amber outline paused и teal label replay. `data-paused`/`data-replay` на viewport не менялись: пауза и replay — независимые часы.
- Core не менялся, `package.json` не менялся, зависимостей нет.

### Regression-тест

`tests/smoke.spec.ts` — «rejects commands injected during replay and keeps the recorded run identical»:

- на paused replay (`replayIndex 0`, tick 0) QA-инъекция `placeTower pad-core` и `startWave` возвращают `replay-in-progress`; реальный canvas-клик по `pad-core` отклоняется тем же кодом; `commandCount` остаётся 4, gold 220, `pads['pad-core']` и `pads['pad-east']` пусты, `towers` пуст, `eventCounts` пустые, `feedback.state` — `rejected`;
- в середине replay (`0 < replayIndex < 4`) повторная инъекция снова отклоняется, log не растёт, башни на `pad-core` не появляется;
- после terminal оба `matchReports` совпадают полностью, `commandCount` = 4, победный gold и статус те же.

Красный прогон подтверждён: с временно убранным guard тест падает на первой же инъекции (`accepted: true` вместо `replay-in-progress`).

### Команды и результат

- `npm run typecheck` — ok.
- `npm run build` — ok.
- `npm run test:core` — ok: `simulation check: ok`, victory tick 323, gold 229.
- `npm test` (9 Playwright, 6 workers) — 9/9 ok, 41 s.
- `npx playwright test --repeat-each=2 -g "restarts from the same seed|injected during replay"` — 4/4 ok, 36 s.
- Playwright шёл через `PLAYWRIGHT_EXECUTABLE_PATH` на локальный `chromium-1208`: bundled headless shell 1243 не установлен, путь в проекте не сохранён.

### Screenshots

- `test-results/vertical-slice-replay-reset.png` — paused replay читается однозначно: badge `REPLAY PAUSED · 0 / 4 COMMANDS`, amber outline viewport, `RESUME`, палитра и Start Wave disabled, aether 220.
- `test-results/wave-combat-defeat.png` — terminal copy `CORE BREACHED · RESTART REPEATS THIS RUN EXACTLY` вместо устаревшего command feedback.
- `test-results/vertical-slice-paused.png`, `vertical-slice-replay-victory.png`, `vertical-slice-reduced-motion.png`, `wave-combat-midwave.png`, `wave-combat-victory.png`, `build-pad-placement.png` — композиция не пострадала.

### За пределами fix

- Разбивка `src/main.ts` на `src/client/` (`EOB-014`), console-assertions и content-bound selectors (`EOB-012`).
- Session-level replay и server-owned причины отказа вместо client-guard (`EOB-010`, `0016`).
- Favicon (`EOB-011`); `0009` не выдавалась.
