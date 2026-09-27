# Echoes of Burbenog — Instructions for AI Agents

## Project

Проект — оригинальная 3D Tower Defense игра с LLM-first рабочим процессом. Browser bootstrap, pure simulation core, vertical slice (pause/resume, replay по command log), asset pipeline с генератором GLB, budgets, per-material IBL, skeletal animation, сохранение матча, экран входа и authoritative session с местами и ролями приняты; текущий шаг — фаза 6, задача `0018` (права в комнате, reconnect, late join) принята штабом по механике и по первому fix'у, задача на втором, последнем круге правок в `tests/smoke.spec.ts`; после него `0019` выдаётся и фаза 6 закрывается. Solo остаётся режимом по умолчанию; multiplayer в работе, и второй реализации правил быть не может.

## Где искать файлы

Рабочий каталог сессии — корень этого репозитория, `D:\GitHub\Echoes-of-Burbenog`. Все пути ниже
относительные и от него; если сессия стартовала выше по дереву, относительные пути не резолвятся, а
`AGENTS.md` может достаться соседний, из `D:\GitHub`, — это другой файл с общими правилами.

- `AGENTS.md` — эти инструкции.
- `docs/CONTEXT.md` — состояние проекта, журнал, открытые проблемы.
- `docs/PLAN.md` — трекер штаба: брать только следующую `[ ]` задачу.
- `docs/tasks/NNNN-<slug>.md` — задание текущей задачи; имя файла задаёт штаб, не искать наугад.
- `docs/DECISIONS.md` — append-only решения, включая те, что объясняют «почему так».
- `docs/ARCHITECTURE.md` — границы модулей и runtime contract.
- `docs/screenshots/` — копии E2E-снимков, на которые ссылается `README.md`.

Код и проверки: `src/main.ts` (client), `src/game-core/` (pure core, только чтение без отдельного
решения), `src/protocol/` (версионированный контракт сессии), `src/server/` (комната и транспорт),
`src/asset-registry.ts`, `src/asset-budgets.ts`, `scripts/build-assets.ts` (генератор GLB),
`scripts/check-simulation.ts` (core check), `scripts/serve-session.ts` (сервер сессии),
`tests/smoke.spec.ts` (Playwright E2E).

## Commands

- Кодовые команды bootstrap: `npm run dev`, `npm test`, `npm run test:core`, `npm run typecheck`, `npm run build`, `npx playwright test`.
- Сервер сессий: `npm run server` (порт из `--port`, `PORT` или общего дефолта в `src/protocol/index.ts`). `npx playwright test` поднимает его сам вместе с Vite — вручную запускать не нужно.
- `npm install` запускать только после отдельного разрешения владельца.
- Для офлайн-проверки Playwright можно передать путь к установленному Chromium через `PLAYWRIGHT_EXECUTABLE_PATH`; путь не сохранять в проекте.
- Для desktop проверять тот же frontend-сценарий отдельно в Wails/WebView2.

## Scope

- Рабочая область проекта — корень этого репозитория.
- Не изменять соседние проекты в `D:\GitHub`.
- Не добавлять игровые фичи, зависимости или файлы за пределами согласованного этапа.
- Не использовать секреты, токены и внешние credentials в коде или документации.
- Не копировать Warcraft III/Burbenog assets, UI, map topology или silhouettes; использовать только извлечённые design principles.

## Architecture boundaries

- `game-core` должен быть чистым модулем simulation: без DOM, Three.js, WebView и сетевого transport.
- Client отвечает за Three.js, input, UI, animation и presentation.
- Server отвечает за sessions, transport и authoritative state; он использует тот же core, пока не принято отдельное решение.
- Content и assets версионируются отдельно от runtime-кода.
- Wails/Go — desktop shell, а не канал для высокочастотного gameplay state.

## LLM workflow

- Каждая gameplay-изменение должна иметь детерминированный сценарий или проверяемый результат.
- Не использовать визуальные проверки как единственный критерий correctness.
- Для browser QA использовать фиксированные seed, camera, viewport и tick.
- Сначала проверять pure logic, затем E2E, затем screenshots.

## Documentation rules

- Перед работой прочитать `AGENTS.md`, `docs/CONTEXT.md` и `docs/PLAN.md`.
- `docs/PLAN.md` — рабочий трекер штаба: брать только следующую `[ ]` задачу, после проверки ставить `[x]` и фиксировать evidence.
- После работы обновить `docs/CONTEXT.md`.
- Архитектурные решения добавлять append-only в `docs/DECISIONS.md`.
- Не создавать новые `.md` файлы без явного разрешения владельца.
- Изменения API, протоколов или asset pipeline отражать в проектной документации.

## Git

- Коммиты и push выполняются только по явному поручению владельца.
- Рабочая ветка — `main`.
- Сообщения коммитов — кратко, на русском или английском, в повелительном наклонении.
- Перед commit проверять status, diff и последние коммиты.
- Не выполнять force push или hard reset без отдельного подтверждения.
