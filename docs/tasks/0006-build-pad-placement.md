# 0006 — Сделать placement по build pads

> Статус: на проверке
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

### Изменённые файлы

- `index.html` — build buttons получили `data-tower-id` из content; selection card привязан к выбранной башне; `command-feedback` с `data-feedback`/`data-reason`.
- `src/main.ts` — build options из content с fail-fast сверкой, single `selectedTowerId`, raycast по pad base/ring с plane fallback, единственный `dispatchCommand` для клика и debug, reason → текст, error flash pad, debug-проброс `selectedTowerId`/`feedback`/`padScreenPositions`.
- `src/styles.css` — цвета feedback `accepted`/`rejected`, dim невыбранных build cards.
- `tests/smoke.spec.ts` — E2E placement contract реальными canvas-кликами.
- `scripts/check-simulation.ts` — pure check на reason-коды placement.
- `docs/ARCHITECTURE.md`, `docs/PLAN.md`, `docs/CONTEXT.md`, этот файл — контракт QA seam, статус и evidence.

`src/game-core/*` не менялся: размещение использует существующий `placeTower` и его reason-коды.

### Scenario и значения

Pure check (`npm run test:core`), отдельный `Simulation`, стартовое золото 220:

| Шаг | Команда | Ожидается | Результат |
|-----|---------|-----------|-----------|
| 1 | `pad-nowhere` + `pulse-spire` | reject | `unknown-pad` |
| 2 | `pad-east` + `ghost-spire` | reject | `unknown-tower` |
| 3 | `pad-east` + `pulse-spire` (50) | accept | gold 170, `pads['pad-east']='pulse-spire'`, 1 entity |
| 4 | `pad-east` + `frost-relay` | reject | `pad-occupied`, gold 170, 1 entity |
| 5 | `pad-north`, `pad-south` + `pulse-spire` | accept | gold 120 → 70 |
| 6 | `pad-core` + `grove-lens` (70) | accept | gold 0 — cost совпадает с остатком точно |
| 7 | `pad-west` + `pulse-spire` | reject | `not-enough-gold`, `pads['pad-west']=null`, gold 0 |

E2E placement contract, реальные клики мыши по canvas (seed 1337, viewport 1280×720):

| Шаг | Действие | Ожидается | Получено |
|-----|----------|-----------|----------|
| 1 | выбрать Grove Lens, кликнуть `pad-east` | accept, gold 150 | gold 150, 1 tower, проекция tower на позиции pad, feedback `accepted` |
| 2 | кликнуть `pad-east` ещё раз | `pad-occupied` | reason `pad-occupied`, 1 tower, gold 150, pad мигает красным |
| 3 | Frost Relay → `pad-north` | accept, gold 90 | gold 90 |
| 4 | Pulse Spire → `pad-south` | accept, gold 40 | gold 40, 3 towers |
| 5 | Grove Lens → `pad-core` при 40 золота | `not-enough-gold` | reason `not-enough-gold`, `pads['pad-core']=null`, 3 towers, gold 40 |

Стоимости считаются из content (`pulse-spire` 50, `frost-relay` 60, `grove-lens` 70), а не из literals в тесте.

### Команды и результат

```text
npm run typecheck   ok
npm run build       ok (11 modules, 567 kB js; warning о chunk size — pre-existing от three)
npm run test:core   ok (victory tick 323, gold 229 — прежние значения не изменились)
npm test            3 passed: bootstrap smoke, placement contract, snapshot binding до victory
```

Console: только `[vite] connecting/connected` и известный favicon 404 (`EOB-011`); новых warnings и errors нет. Проверено временным прогоном console-проверки, файл удалён.

### Screenshot

`test-results/build-pad-placement.png` — три башни на `pad-east`/`pad-north`/`pad-south`, свободный `pad-core` подсвечен ошибкой, Aether 40, `Grove Lens ready` + `NOT ENOUGH AETHER`, выбранный card `Range 2.4 · Damage 10` из content.

### За пределами 0006

- Start-wave, движение, targeting, damage и win/lose presentation — 0007.
- Selling, upgrade, repair, transfer.
- Новые tower/enemy types, waves, economy, assets.
- Hover-подсветка pad, drag-rotate и zoom камеры, выбор башни кликом.
- Keyboard-размещение по pad — не сделано, pointer-only как указано в задании; кандидат на отдельное решение вместе с остальными controls.
- Console-проверки в постоянном E2E остаются в `EOB-012`.
- Фиксированный hit radius 0.85 без occlusion помечен `techdebt:` в коде.

### Статус

`на проверке`. `docs/PLAN.md` держит `[ ]` до приёмки штабом.
