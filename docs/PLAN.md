# Echoes of Burbenog — PLAN

## Цель плана

Развивать игру вертикальными срезами: каждый этап заканчивается работающим и проверяемым результатом, а будущие компоненты не блокируют текущий. Главный приоритет — короткий LLM-driven feedback loop.

## Принципы

- Сначала измеримый vertical slice, потом расширение.
- Gameplay отделён от rendering и transport.
- Каждая функция имеет deterministic scenario или тест.
- Новые зависимости добавляются только после подтверждения необходимости.
- Визуальная проверка дополняет, но не заменяет проверку состояния.

## Этап 0: Репозиторий и контракты

**Результат:** создан репозиторий, документация, целевая архитектура и список открытых решений.

**Готово, когда:**

- README, AGENTS, CONTEXT, DECISIONS, ARCHITECTURE и PLAN доступны в репозитории;
- remote настроен на GitHub.com;
- ветка `main` содержит первый commit.

## Этап 1: Browser bootstrap

**Результат:** минимальный TypeScript + Vite client с Three.js scene и Playwright smoke test.

**Готово, когда:**

- приложение запускается одной документированной командой;
- WebGL2 context и renderer инициализируются;
- typecheck и production build проходят;
- Playwright открывает приложение, проверяет canvas и сохраняет screenshot;
- ошибки и состояние доступны без ручного поиска по исходникам.

## Этап 2: Pure simulation core

**Результат:** headless simulation одного матча.

**Готово, когда:**

- есть versioned commands, state и events;
- fixed tick и seeded random дают одинаковый результат при одном scenario;
- движение, placement, waves и win/lose не зависят от браузера;
- один маленький runnable check покрывает ключевой сценарий.

## Этап 3: Первый визуальный vertical slice

**Результат:** одна карта, одна волна, placeholder towers и enemies, orthographic camera.

**Готово, когда:**

- можно разместить башню, запустить волну, увидеть бой и получить результат;
- grid используется только для placement;
- можно pause/resume и повторить сценарий с тем же seed;
- screenshots подтверждают читаемую композицию и UI.

## Этап 4: Asset pipeline и 3D polish

**Результат:** GLB-модели, PBR-материалы, освещение, camera и animation states.

**Готово, когда:**

- модель имеет корректные pivot, scale, forward axis и animation clips;
- idle, move, attack, hit и death не ломают gameplay state;
- asset validator отклоняет несовместимые файлы;
- определены draw-call, triangle, texture и memory budgets для минимального железа.

## Этап 5: Offline singleplayer

**Результат:** полноценная локальная сессия с сохранением прогресса и restart.

**Готово, когда:**

- match state восстанавливается из snapshot или save;
- UI не зависит от внутренних структур simulation;
- прогресс не теряется при перезапуске;
- E2E проходит от главного меню до результата матча.

## Этап 6: Local cooperative mode

**Результат:** два независимых client context, одна server session, private room.

**Готово, когда:**

- оба клиента видят согласованное состояние;
- permissions и ownership экономики определены;
- reconnect и late join имеют явное поведение;
- Playwright проверяет оба клиента и network traffic.

## Этап 7: PvP и mode-specific rules

**Результат:** отдельные правила победы и экономики для PvP при общих gameplay primitives.

**Готово, когда:**

- co-op и PvP используют одну transport/session основу;
- client не может изменить server-owned результат;
- match rules версионируются и отображаются в handshake;
- replay или deterministic scenario воспроизводит матч.

## Этап 8: Internet services

**Результат:** internet rooms, identity, matchmaking и persistence.

**Готово, когда:**

- определены threat model и rate limits;
- reconnect не допускает duplicate commands;
- content/version mismatch отклоняется понятной ошибкой;
- matchmaking не становится частью Game Core.

## Этап 9: Desktop release

**Результат:** Wails/Go package с embedded frontend и desktop settings.

**Готово, когда:**

- browser client и WebView2 проходят одинаковые smoke scenarios;
- settings, saves и crash recovery работают через native adapter;
- release process воспроизводим и документирован;
- Go используется только там, где профиль или packaging это оправдывают.

## Информация, которую нужно уточнить у владельца

- Публичный или private remote.
- Первые платформы и минимальные требования к GPU/RAM.
- Точная версия или видео Burbenog, а также список механик, которые обязательно нужно сохранить.
- Art direction, сеттинг и допустимый уровень оригинальности.
- Первый multiplayer mode и правила общей/раздельной экономики.
- Источник моделей, текстур и анимаций.
- Нужны ли в первой публичной версии accounts, matchmaking, editor и mods.
- Лицензия проекта.

## Следующий шаг

Уточнить P0-вопросы в `docs/CONTEXT.md`, затем перейти к этапу Browser bootstrap без добавления лишних игровых систем.
