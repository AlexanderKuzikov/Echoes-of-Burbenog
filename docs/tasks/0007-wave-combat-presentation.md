# 0007 — Подключить запуск волны и combat presentation

> Статус: выдана
> Приоритет: P0
> Фаза: 3 — Первый визуальный vertical slice
> Следующая приёмка: 0008

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

После работы указать:

- изменённые файлы;
- deterministic scenario и фактические snapshot values;
- команды и результат;
- пути к screenshots;
- что осталось за пределами 0007;
- статус задачи: `на проверке` или `принята`.

До приёмки задача остаётся `[ ]` в `docs/PLAN.md`.
