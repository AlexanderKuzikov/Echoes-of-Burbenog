# Echoes of Burbenog — CONTEXT

> Последнее обновление: 2026-09-25 16:59

## Статус

| Компонент | Статус | Версия/Заметка |
|-----------|--------|----------------|
| Концепция | В работе | Получены визуальные references Burbenog/Warcraft III; ассеты не копируются |
| Репозиторий | Создан | Приватный GitHub remote, ветка `main` синхронизирована; visibility не является требованием |
| Документация | Базовая завершена | Созданы README, инструкции, архитектура, решения и план |
| Целевая платформа | Зафиксирована | Windows 10/11; performance budgets уточняются |
| Gameplay prototype | Не начат | Будет 3D-ready, сначала визуально плоский |
| Client | Не начат | TypeScript + Three.js |
| Simulation | Не начат | Чистый core с deterministic fixed tick |
| Multiplayer | Отложен | Solo-first; session и protocol seams сохраняются |
| Asset pipeline | Не начат | Первые assets — собственные схематичные placeholder-модели |
| Desktop packaging | Отложен | Wails/Go после стабилизации browser client |
| QA/agent harness | Не начат | Playwright, screenshots, structured state |

## Глоссарий

- **Match** — одна игровая сессия с определёнными картой, режимом, правилами, seed и версией content.
- **Player** — участник матча с правами на команды и состояние экономики.
- **Team** — группа игроков, для которой действуют общие или раздельные игровые правила.
- **Command** — намерение игрока, например построить башню или начать волну.
- **Snapshot** — сериализуемое состояние матча, достаточное для восстановления presentation и проверки результата.
- **Event** — краткоживущее событие для анимации или звука, например попадание или постройка.
- **Wave** — последовательность спавнов и условий одной атаки.
- **Tower** — оборонная сущность, которую игрок размещает на карте.
- **Enemy** — атакующая сущность, движущаяся по карте и наносящая урон защите.
- **Map** — версионированное описание игрового пространства, маршрутов и точек взаимодействия.
- **Content version** — версия данных, на которой основаны карта, башни, враги и волны.

## Open-проблемы

| # | Priority | Описание |
|---|----------|----------|
| EOB-002 | P1 | Уточнить performance budgets для Windows 10/11 после выбора минимального тестового железа |
| EOB-003 | P0 | Уточнить точный референс Burbenog и список желаемых механик |
| EOB-004 | P1 | Multiplayer отложен; позже определить co-op/PvP и общую или раздельную экономику |
| EOB-005 | P1 | Art direction и сеттинг отложены; первый прототип использует собственные схематичные assets и visual language |
| EOB-006 | P1 | Выбрать инструмент подготовки собственных 3D-моделей и анимаций |
| EOB-007 | P1 | Вернуться к accounts, matchmaking, editor и mods после solo-версии |
| EOB-008 | P1 | Зафиксировать лицензию и правила использования внешних ассетов |
| EOB-009 | P1 | Решить, остаётся ли Go/Wails только упаковкой или также используется для dedicated server |

## Журнал работ

| Дата | Изменение |
|------|-----------|
| 2026-09-25 | Создана концепция LLM-first, зафиксированы целевая архитектура, план и открытые вопросы |
| 2026-09-25 | Создан приватный GitHub remote, первый commit отправлен в `main` |
| 2026-09-25 | Добавлен базовый `.gitignore` для секретов и build/test-артефактов |
| 2026-09-25 | Зафиксированы Windows 10/11, solo-first scope, schematic art и визуальные references Burbenog |
| 2026-09-25 | Зафиксирован visual north-star: Burbenog/Warcraft III — reference principles, не clone; отчёт по механикам ожидается позже |

## Структура проекта

Текущая:

- `README.md` — точка входа.
- `AGENTS.md` — инструкции для AI-агентов.
- `docs/CONTEXT.md` — состояние и открытые вопросы.
- `docs/DECISIONS.md` — append-only решения.
- `docs/ARCHITECTURE.md` — архитектура и границы модулей.
- `docs/PLAN.md` — этапы разработки и критерии готовности.

Планируемая:

- `src/client/` — Three.js client, input и presentation.
- `src/game-core/` — pure simulation.
- `src/server/` — sessions и transport.
- `src/protocol/` — versioned network contract.
- `content/` — карты, башни, враги и волны.
- `assets/` — модели, текстуры и анимации.
- `tests/` — unit, E2E и deterministic scenarios.
- `tools/` — asset validation и agent utilities.
