# 0008 — Принять vertical slice: pause/resume, seed replay и regression

> Статус: выдана
> Приоритет: P0
> Фаза: 3 — Первый визуальный vertical slice
> Следующая приёмка: после приёмки vertical slice

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
