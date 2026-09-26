# Echoes of Burbenog — CONTEXT

> Последнее обновление: 2026-09-26 12:20

## Статус

| Компонент | Статус | Версия/Заметка |
|-----------|--------|----------------|
| Концепция | В работе | Получены визуальные и системные references Burbenog/Warcraft III; полный brief сохранён в Old-Burbenog; ассеты не копируются |
| Репозиторий | Создан | Приватный GitHub remote, ветка `main` синхронизирована; visibility не является требованием |
| Документация | Базовая завершена | Созданы README, инструкции, архитектура, решения и план |
| Целевая платформа | Зафиксирована | Windows 10/11; performance budgets уточняются |
| Gameplay prototype | Полный цикл в браузере | Bootstrap, pure simulation, placement по pads и combat presentation: запуск волны, движение, targeting, damage, victory/defeat в одном сценарии |
| Client | Привязан к core | Один `Simulation` из training scenario; сцена, pads, path, core, towers и enemies строятся из `MatchSnapshot`; HUD (phase, timer, hostiles, objective, result) — проекция snapshot; ручных tower/enemy массивов нет |
| Simulation | Проверен | Pure core: commands, state, events, fixed tick, seeded RNG, wave transitions; reason-коды `placeTower` и `startWave` закреплены pure check; значения victory не менялись (tick 323, gold 229); в `0008` core не менялся |
| Build palette | Content-bound | Кнопки хранят `data-tower-id`, selection идёт через `aria-pressed`; canvas-клик по pad шлёт `placeTower` тем же `dispatchCommand`, что и debug |
| Combat presentation | Событийная | `drainEvents` даёт typed-счётчики, bounded combat log и transient 3D feedback: наведение и вспышка башни (`towerFired`), burst-ring (`enemyKilled`), flash core (`coreDamaged`); события не меняют state |
| Pause/resume | Проверен | Pause — только control часов: `step()` не вызывается, accumulator хранит дробную часть, поэтому tick и позиции замерли, а resume продолжил с того же тика без fast-forward; команды при паузе доходят до core |
| Replay | Проверен | Pause/resume проверены; replay-инвариант держит `dispatchPlayerCommand`: во время replay любая player-команда (pad-клик, Start Wave, QA seam) отклоняется с `replay-in-progress`, не пишется в log и не доходит до core; `EOB-015` закрыт |
| Terminal feedback | Проверен | После victory/defeat приоритет результата работает; copy правдивый — `restart repeats this run exactly`, а не обещание другого исхода; blocked-copy во время replay не предлагает «другой ра» |
| Preparation display | Правдивый | При `preparationTicksLeft === 0` phase clock показывает `Awaiting start`, а не замороженный `T-00:00`; решение по `EOB-013` принято в пользу display |
| Reduced motion | Проверен | `prefers-reduced-motion: reduce` гасит burst-ring, наведение и вспышку башни, scale-пульс core и ambient-анимацию; позиции, health bars, материалы, combat log и HUD остаются читаемыми |
| Multiplayer | Отложен | Solo-first; session и protocol seams сохраняются |
| Asset pipeline | В работе | `0009` принята; `0010` сдана повторно после точечного fix: клиентский отказ по превышению бюджета теперь закрыт негативным E2E, а digest в статусной строке сокращён и подпись сектора не перекрывается |
| Asset validator и budgets | На проверке | Бюджеты в одном модуле `src/asset-budgets.ts` (без Three.js, DOM и Node API), который импортируют и генератор, и клиент: ни в `build-assets.ts`, ни в `main.ts` нет числовых лимитов. Генератор меряет модель и отказывается писать артефакт и манифест при нарушении контракта или бюджета; клиент сверяет `bytes` всегда и `contentHash` при наличии `crypto.subtle`, отклоняет несовместимые типы узлов до инстанцирования и отказывает локально, по одной модели. Debug seam публикует бюджеты, измеренные величины (`renderer.info`, время загрузки, суммы по реестру) и флаги выполненных проверок. Причина отказа живёт в двух формах: полная в `assets.error` и `assetBudgets.failures`, сокращённая (`sha256:<8 hex>…`) в строке `scene-status`. Геометрические границы (высота, footprint, pivot Y) проверяет генератор на сборке, picking опирается на pad hit radius из content. Задача `0010` сдана, штаб ещё не принял |
| Desktop packaging | Отложен | Wails/Go после стабилизации browser client |
| QA/agent harness | Проверен | 14 Playwright-сценариев, включая two-phase подмену модели (gated на маршруте GLB), fail-fast при недоступном манифесте, сцену в бюджетах, отказ по подмене `contentHash` и отказ по превышению бюджета модели (gated на `page.route`); красные проги всех четырёх механик подтверждены, включая снятый клиентский `checkModelContract` |

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
| EOB-002 | P1 | Performance budgets заданы предварительно под класс GT 1030 / UHD 620 и проверяются в сборке и на клиенте; осталось выбрать и зафиксировать минимальное тестовое железо, на котором они замеряются |
| EOB-003 | P1 | Выбрать приоритетный subset механик из research brief для первого прототипа |
| EOB-004 | P1 | Multiplayer отложен; позже определить co-op/PvP и общую или раздельную экономику |
| EOB-005 | P1 | Art direction и сеттинг отложены; первый прототип использует собственные схематичные assets и visual language |
| EOB-007 | P1 | Вернуться к accounts, matchmaking, editor и mods после solo-версии |
| EOB-008 | P1 | Зафиксировать лицензию и правила использования внешних ассетов |
| EOB-009 | P1 | Решить, остаётся ли Go/Wails только упаковкой или также используется для dedicated server |
| EOB-010 | P2 | Session-level replay (restore из snapshot против command log) не решён: client QA replay уже работает на command log + seed, но для server-сессии нужен отдельный выбор |
| EOB-011 | P2 | `favicon.ico` даёт 404 в browser console; отдельная задача на favicon или inline data-URL icon |
| EOB-012 | P2 | Усилить E2E: content-bound selectors, entityId-сопоставление позиций, реальные route-счётчики, typed event и console assertions |
| EOB-014 | P2 | Разнести монолитный `src/main.ts` на presentation/input/HUD модули после приёмки vertical slice |
| EOB-016 | P2 | Asset contract валидирует только модели, собранные генератором, и проверяет структуру, а не источник; модели из внешнего редактора потребуют отдельного контура проверки и provenance |
| EOB-017 | P2 | Замер fixed-step clock в E2E идёт сразу за fullPage screenshot: stall >500 ms даёт ложный fast-forward. Наблюдалось один раз на холодном прогоне; нужно унести замер от скриншота или считать по page-time |

## Журнал работ

| Дата | Изменение |
|------|-----------|
| 2026-09-25 | Создана концепция LLM-first, зафиксированы целевая архитектура, план и открытые вопросы |
| 2026-09-25 | Создан приватный GitHub remote, первый commit отправлен в `main` |
| 2026-09-25 | Добавлен базовый `.gitignore` для секретов и build/test-артефактов |
| 2026-09-25 | Зафиксированы Windows 10/11, solo-first scope, schematic art и визуальные references Burbenog |
| 2026-09-25 | Зафиксирован visual north-star: Burbenog/Warcraft III — reference principles, не clone; отчёт по механикам ожидается позже |
| 2026-09-25 | Создан Three.js/Vite browser bootstrap со schematic сценой, HUD и Playwright smoke test |
| 2026-09-25 | Проверены typecheck, production build, E2E и визуальный screenshot; browser console очищен от deprecated warnings |
| 2026-09-25 | Собран и сохранён подробный research brief по Burbenog TD в `Old-Burbenog/BURBENOG-TD-RESEARCH.md`; закрыт вопрос о точном референсе |
| 2026-09-25 | План переведён на следующий этап: выбор mechanics subset и pure deterministic simulation core |
| 2026-09-25 | Реализован и проверен pure simulation core; добавлены content validation, wave transitions и focused scenario checks |
| 2026-09-26 | План переведён в формат штаба с сквозными заданиями и отметками `[x]/[ ]`; следующая задача `0005` |
| 2026-09-26 | Выдано задание `0005` кодовой сессии: привязка `MatchSnapshot` к Three.js client |
| 2026-09-26 | Принято задание `0005`: client синхронизируется с `MatchSnapshot`, сцена строится из content, HUD берёт значения из snapshot; Playwright проверяет projection до victory |
| 2026-09-26 | Штаб независимо проверил `0005`, screenshots и regression suite; blockers не найдены, follow-up тестов вынесен в `EOB-012` |
| 2026-09-26 | Выдано задание `0006` кодовой сессии: placement по build pads через commands и snapshot |
| 2026-09-26 | Кодовая сессия сдала `0006`: build palette привязан к content `towerId`, canvas picking по pad, единственный command path, feedback accepted/rejected с reason; typecheck, build, test:core и 3 Playwright прошли, screenshot `test-results/build-pad-placement.png`; задача на проверке штаба |
| 2026-09-26 | Штаб принял `0006` после независимой проверки; blockers — 0, screenshot-evidence уточнён, follow-up тестов оставлен в `EOB-012` |
| 2026-09-26 | Выдано задание `0007` кодовой сессии: запуск волны и combat presentation |
| 2026-09-26 | Кодовая сессия сдала `0007`: Start Wave через общий `dispatchCommand`, HUD phase/timer/hostiles/objective/result как проекция snapshot, combat log и transient feedback из `drainEvents`, typed `eventCounts` в debug seam; typecheck, build, test:core и 5 Playwright прошли, screenshots mid-wave/victory/defeat; задача на проверке штаба |
| 2026-09-26 | Штаб принял `0007` после независимой проверки; blockers — 0, countdown evidence уточнён, follow-ups `EOB-012` и `EOB-013` |
| 2026-09-26 | Выдано задание `0008` кодовой сессии: pause/resume, replay и приёмка vertical slice |
| 2026-09-26 | Кодовая сессия сдала `0008`: Pause как control часов без fast-forward и drift, Restart с replay tick-упорядоченного command log по тому же seed, terminal feedback с приоритетом над command feedback, `Awaiting start` вместо `T-00:00`, `prefers-reduced-motion` без transient-эффектов; typecheck, build, test:core и 8 Playwright прошли, два terminal-отчёта прогона и replay совпали (victory, tick 304, gold 229); screenshots paused/replay/reduced-motion прочитаны; core без изменений; задача на проверке штаба |
| 2026-09-26 | Штаб вернул `0008` на точечный fix: replay-инвариант через QA seam и paused+replay presentation; `0009` не выдаётся |
| 2026-09-26 | Кодовая сессия закрыла точечный fix `0008`: guard `replaying` перенесён в `dispatchPlayerCommand` (pad-клик, Start Wave и QA seam отклоняются одной причиной `replay-in-progress`, log и core не трогаются), replay/restart copy заменён на правдивый, badge получил состояние `paused-replay`; добавлен regression-тест на QA-инъекцию во время replay — с временно убранным guard он красный; typecheck, build, test:core и 9 Playwright (41 s) зелёные, `repeat-each=2` по replay — 4/4; core без изменений; `0008` принята |
| 2026-09-26 | Продолжение сессии независимо перепроверило закрытый `0008`: typecheck, build, test:core (tick 323, gold 229) и 9/9 Playwright зелёные, guard подтверждён в `dispatchPlayerCommand`; `HANDOFF.md` удалён отдельным commit, документация признана актуальной |
| 2026-09-26 | Штаб принял решение по инструменту подготовки моделей: собственная генерация GLB вместо DCC, модели как текст в репозитории, артефакты генерируются и не коммитятся, реестр моделей — data-контракт; `EOB-006` закрыт, `0012` добавлена в фазу 4 под skeletal animation |
| 2026-09-26 | Выдано задание `0009` кодовой сессии: asset pipeline с первой GLB-моделью вместо placeholder |
| 2026-09-26 | Кодовая сессия сдала `0009`: генератор glTF 2.0 binary на голом Node с примитивами, структурной самопроверкой (magic, chunks, accessor↔bufferView, диапазон индексов, winding против нормалей, emissive-узел, `bytes`/`contentHash`) и красными прогонами на битом файле; `manifest.json` как data-контракт и `src/asset-registry.ts` без Three.js и DOM; two-phase подмена `pulse-spire` на месте с сохранением entity, позиции и idle bob от базовой Y crystal; per-view копии материалов при общей геометрии реестра; fail-fast `data-assets="error"` с читаемой причиной и процедурным продолжением; IBL через `RoomEnvironment` с `environmentIntensity = 0.5`; typecheck, build, test:core (tick 323, gold 229) и 11 Playwright (46 s) зелёные, два прогона генератора побайтово идентичны, `git status` после `npm test` чистый; core и content без изменений; задача на проверке штаба |
| 2026-09-26 | Штаб принял `0009` (`518d480`) после независимой проверки: `typecheck`, `build`, `test:core` (tick 323, gold 229), `test:assets` (5 красных проверок) и 11 Playwright зелёные, 22/22 в нагрузочном прогоне, screenshots перечитаны, A/B против pre-0009 подтвердил довод о `environmentIntensity`; оба self-decision сессии (глобальный `environmentIntensity = 0.5` и per-view копии материалов) приняты — первое с пересмотром в `0011`, второе следует из решения клиента анимировать `crystal`; blockers — 0. Заведено: `EOB-017` (замер clock сразу за screenshot даёт ложный fast-forward, воспроизвелось один раз на холодном прогоне) и три неблокирующих пункта в `0010` — сверка `bytes`/`contentHash`, отклонение несовместимых типов узлов, измерение бюджетов |
| 2026-09-26 | Невыданный хвост roadmap перенумерован монотонно 0010–0022 после приёмки `0009`: `0021` (skeletal) стал `0012`, IBL-вопрос вынесен в `0011`, validator с бюджетами остался `0010`; правило в PLAN: номер совпадает с порядком выдачи |
| 2026-09-26 | Выдано задание `0010` кодовой сессии: budgets в одном общем модуле `src/asset-budgets.ts`, проверка в сборке и на клиенте, сверка `bytes`/`contentHash`, отказ на несовместимых типах узлов, измерение сцены в debug seam |
| 2026-09-26 | Кодовая сессия сдала `0010`: бюджеты и предикаты в единственном модуле без дублирования лимитов, отказ генератора до записи артефакта, локальный отказ по модели на клиенте, seam публикует бюджеты и `renderer.info`; `typecheck`, `build`, `test:core` (tick 323, gold 229), `test:assets` (8 красных проверок) и 13 Playwright зелёные, артефакт побайтово прежний, core и content без изменений |
| 2026-09-26 | Штаб вернул `0010` на точечный fix: клиентский `checkModelContract` берёт числа из манифеста, поэтому отказ по превышению бюджета воспроизводится подменой ответа и должен быть покрыт E2E — сейчас правка бюджета доказана ломающей только сборку; и полный digest в статусной строке перекрывает подпись сектора на refusal-скриншоте. Без блокеров: геометрические границы проверяются только генератором, это фиксируется в архитектуре; E2E на отказ по типу узла уходит в `0012` |
| 2026-09-26 | Кодовая сессия сдала `0010`: единый модуль `src/asset-budgets.ts` (лимиты на модель, реестр и сцену + предикаты `checkModelContract`, `checkNodeTypes`, `checkRegistryBudgets`, `checkSceneBudget`) без Three.js, DOM и Node API; генератор меряет модель по тем же округлённым массивам, что попадают в accessors, и отказывается писать артефакт и манифест при нарушении; клиент сверяет `bytes` всегда и `contentHash` при наличии `crypto.subtle`, обходит дерево до инстанцирования и отказывает локально по одной модели; `renderer.info` и время загрузки публикуются в seam вместе с бюджетами и флагами выполненных проверок. Красные проги: превышение бюджета в генераторе (exit 1, артефакт не записан), снятая проверка бюджета в `assemble` (красный `test:assets`), снятая сверка `contentHash` (красный негативный E2E, `data-assets` = `ready`). `typecheck`, `build`, `test:core` (tick 323, gold 229), `test:assets` (8 красных проверок) и 13 Playwright (45 s) зелёные, `git status` после `npm test` чистый, артефакт побайтово тот же (`sha256:25b4af43…`), core и content без изменений; визуал не тронут. Измеренная сцена: 70/400 draw calls, 3 794/250 000 треугольников, 7/32 программы, 418 мс/1 500 мс загрузки, реестр 1/64 модели, 17 996/8 388 608 байт, 580/150 000 треугольников. Задача на проверке штаба |
| 2026-09-26 | Кодовая сессия закрыла точечный fix `0010`: добавлен негативный E2E `refuses a model whose manifest claims more triangles than the model budget allows` — подмена ответа манифеста одним полем `triangles = MODEL_BUDGET.triangles + 1` даёт `data-assets="error"`, причину с именем модели, измеренным значением и лимитом, procedural placeholder, играбельную сцену и пустые `pageErrors`; красный прогон обязателен и подтверждён: со снятым клиентским `checkModelContract` тест красный (`data-assets` = `ready`). В статусной строке digest сокращён до `sha256:<8 hex>…` через `viewportRefusal` в `main.ts`, полная причина осталась в `assets.error` и `assetBudgets.failures`; «подпись сектора читается» закрыто измерением `getClientRects()` против прямоугольника chip'а, а не просмотром. Из `src/asset-budgets.ts` убрано слово «штаб» из английского комментария; в `docs/ARCHITECTURE.md` записано, что геометрические границы (высота, footprint, pivot Y) проверяет генератор на сборке, а picking опирается на pad hit radius из content. `typecheck`, `build`, `test:core` (tick 323, gold 229), `test:assets` (8 красных проверок) и 14 Playwright (45.1 s) зелёные, артефакт побайтово прежний, `git status` чистый, core и content без изменений, визуал не тронут. Задача на проверке штаба |

## Структура проекта

Текущая:

- `README.md` — точка входа.
- `AGENTS.md` — инструкции для AI-агентов.
- `docs/CONTEXT.md` — состояние и открытые вопросы.
- `docs/DECISIONS.md` — append-only решения.
- `docs/ARCHITECTURE.md` — архитектура и границы модулей.
- `docs/PLAN.md` — этапы разработки и критерии готовности.
- `Old-Burbenog/BURBENOG-TD-RESEARCH.md` — исследовательский brief по оригинальной карте и рекомендации для ремейка.
- `src/main.ts` — browser bootstrap, presentation entry point, snapshot projection, build palette, pad picking, запуск волны, combat presentation, pause/resume, replay по command log с guard в `dispatchPlayerCommand`, reduced-motion guard, IBL и two-phase подмена tower view на загруженную модель, сверка `bytes`/`contentHash`, отказ на несовместимых типах узлов и измерение бюджетов сцены.
- `src/game-core/` — pure deterministic simulation, content validation и training scenario.
- `src/asset-registry.ts` — data-слой реестра моделей: типы, fail-fast валидация manifest, resolve по towerId, кэш загрузок, `assetStatus`, измеренные величины и факт выполнения каждой проверки; без Three.js и DOM.
- `src/asset-budgets.ts` — единственный источник бюджетов и предикатов asset contract: лимиты на модель, реестр и сцену, тексты причин отказа; общий модуль для генератора и клиента, без Three.js, DOM и Node API.
- `scripts/check-simulation.ts` — один runnable core check.
- `scripts/build-assets.ts` — генератор собственных GLB, реестр моделей и самопроверка артефактов (задача `0009`).
- `tests/smoke.spec.ts` — browser E2E: bootstrap smoke, snapshot binding contract, placement contract, полный цикл до victory и defeat, pause/resume без drift, replay determinism, отклонение команд во время replay, prefers-reduced-motion, two-phase подмена GLB, fail-fast при недоступном реестре моделей, сцена в бюджетах, отказ по подмене `contentHash` и отказ по превышению бюджета модели.
- `docs/tasks/0005-client-snapshot-binding.md` — принятое задание.
- `docs/tasks/0006-build-pad-placement.md` — принятое задание.
- `docs/tasks/0007-wave-combat-presentation.md` — принятое задание.
- `docs/tasks/0008-vertical-slice-acceptance.md` — принятое задание (включая точечный fix).
- `docs/tasks/0009-asset-pipeline.md` — принятое задание.
- `docs/tasks/0010-asset-validator-budgets.md` — выданное задание (сдано, включая точечный fix).

Планируемая:

- `src/client/` — выделенный Three.js client, input и presentation.
- `src/server/` — sessions и transport.
- `src/protocol/` — versioned network contract.
- `content/` — карты, башни, враги и волны.
- `public/models/` — генерируемые GLB и `manifest.json`, под `.gitignore`; исходник моделей — `scripts/build-assets.ts`.
- `tools/` — asset validation и agent utilities.

Замечание по консоли: IBL добавил один драйверный warning `THREE.WebGLProgram: warning X4122 ... double precision` от компиляции PMREM-шейдера. Это не ошибка и не влияет на рендер; кладётся рядом с известными `[vite]` сообщениями и favicon 404 (`EOB-011`).
