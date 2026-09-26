# Echoes of Burbenog — Instructions for AI Agents

## Project

Проект — оригинальная 3D Tower Defense игра с LLM-first рабочим процессом. Browser bootstrap, pure simulation core, vertical slice (pause/resume, replay по command log) и asset pipeline с генератором GLB, budgets, per-material IBL и skeletal animation приняты; текущий шаг — фаза 4, задача `0013` выдана кодовой сессии, на ней фаза закрывается. Текущий product scope — solo; multiplayer пока только учитывать в архитектурных seams.

## Commands

- Кодовые команды bootstrap: `npm run dev`, `npm test`, `npm run test:core`, `npm run typecheck`, `npm run build`, `npx playwright test`.
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
