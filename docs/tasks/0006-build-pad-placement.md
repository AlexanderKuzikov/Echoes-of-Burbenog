# 0006 — Сделать placement по build pads

> Статус: выдана
> Приоритет: P0
> Фаза: 3 — Первый визуальный vertical slice
> Следующая приёмка: 0007

## Контекст

`0005` принят: Three.js presentation уже читает `MatchSnapshot` и core является единственным источником state. Следующий разрыв — игрок не может отправить `placeTower` command через UI, а build pads пока только отображаются.

## Цель

Сделать полноценный placement: выбрать tower в build palette, кликнуть свободный build pad, отправить `placeTower` в `Simulation`, получить snapshot и увидеть tower на том же pad. Core не должен получать отдельный клиентский путь изменения state.

## Входит в задачу

- `src/main.ts` — pointer/picking по pad, selected tower state, dispatch command, success/error feedback.
- `index.html` — стабильный `data-tower-id` у build buttons и DOM hooks для feedback.
- `src/styles.css` — selected/free/occupied/error states, если нужны.
- `tests/smoke.spec.ts` — E2E placement contract.
- `docs/PLAN.md`, `docs/CONTEXT.md`, этот файл — статус и evidence.
- `src/game-core/*` — только чтение; не менять behavior или data без отдельного решения штаба.

## Порядок работы

1. Связать каждую build button с её content `towerId`, а не с display name строкой.
2. Хранить выбранный tower id в одном client state и явно отражать его через `aria-pressed`.
3. Реализовать raycast/pointer hit-test по pad base/ring; hit-test должен использовать pad position из content.
4. При клике отправлять только `placeTower` command через общий `dispatchCommand`/`Simulation`.
5. После accepted command обновлять snapshot, gold HUD, pad state и selection feedback из snapshot.
6. После rejected command показывать reason (`pad-occupied`, `not-enough-gold`, `unknown-*`) без изменения state.
7. Не вызывать `startWave` и не добавлять combat behavior — это задача 0007.

## Acceptance

- Клик по свободному pad размещает выбранную tower: `snapshot.pads[padId]` содержит tower id, `snapshot.towers` содержит entity, gold уменьшается на content cost.
- Повторный клик по занятому pad отклоняется и не создаёт entity.
- Placement без достаточного gold отклоняется с reason `not-enough-gold`.
- Build palette и feedback отражают selected/rejected state через DOM.
- Core не получает отдельный mutation path; E2E использует тот же command contract.
- `npm run typecheck` проходит.
- `npm run build` проходит.
- `npm test` проходит, включая `npm run test:core` и Playwright.
- Screenshot после placement показывает tower на выбранном pad и обновлённый HUD.
- Console не получает новых warnings/errors; известный favicon 404 учитывается отдельно.

## Не входит

- Start-wave button и wave countdown — 0007.
- Targeting, damage, projectiles и win/lose presentation — 0007.
- Selling, transferring, upgrading или repair.
- Новые tower/enemy types, waves, economy и assets.
- Pause/resume, save/restore, multiplayer и Wails.

## Проверка

```text
npm run typecheck
npm run build
npm test
```

E2E должен использовать реальный canvas click/picking, а не только вызов `dispatch()` из `page.evaluate`. Для устойчивого клика разрешается добавить debug helper с экранными координатами pad, но он не должен использоваться как игровой input path.

## Отчёт сессии

После работы указать:

- изменённые файлы;
- фактический pad/tower scenario и ожидаемые/полученные значения;
- команды и результат;
- путь к screenshot;
- что осталось за пределами 0006;
- статус задачи: `на проверке` или `принята`.

До приёмки задача остаётся `[ ]` в `docs/PLAN.md`.
