# Echoes of Burbenog — DECISIONS

> Append-only. Каждое новое решение добавляется в конец файла.

## 2026-09-25: Browser-first LLM-first baseline

**Контекст:** Go не является обязательным требованием, но его производительность и простота упаковки нравятся владельцу. Главный приоритет — максимально эффективная разработка с участием LLM: быстрый запуск, screenshots, browser automation и простые проверки.

**Решение:** Начать с TypeScript, Three.js и Vite. Использовать Playwright как основной инструмент browser QA. Node.js оставить локальным сервером и test runtime. Go/Wails отложить до стабилизации browser client и появления измеримой потребности в desktop packaging или dedicated server.

**Альтернативы:** Go-first client/server, Godot, Unity, Electron-first desktop application.

**Trade-off:** Позже потребуется отдельное решение для Go server или desktop shell; зато ранняя разработка и визуальная диагностика остаются в одном быстром контуре.

## 2026-09-25: Логические модули до распределённых сервисов

**Контекст:** Игровые части должны развиваться независимо, но на раннем этапе нет причин платить за сетевую сложность микросервисов.

**Решение:** Использовать модульный монорепозиторий с чистыми границами: game-core, client, server, protocol, content, assets и test harness. Физически разделять процессы только после появления самостоятельной необходимости.

**Альтернативы:** Отдельные репозитории и сервисы для каждого модуля; один монолитный клиент без границ.

**Trade-off:** В репозитории одновременно будут присутствовать несколько связанных слоёв, но их contracts останутся явными и тестируемыми.

## 2026-09-25: 3D-ready плоский прототип

**Контекст:** Первую реализацию планируется сделать визуально плоской, но игра должна развиваться к качественным 3D-моделям, освещению и анимациям.

**Решение:** Строить Three.js-сцену сразу в 3D-координатах XZ. Использовать OrthographicCamera и простые материалы для первого среза. Grid применять только к размещению объектов, а движение оставить непрерывным. Asset pipeline начать с glTF/GLB и WebGL2 baseline.

**Альтернативы:** Настоящий 2D Canvas/SVG renderer; editor-centric 3D scene; WebGPU-first renderer.

**Trade-off:** Потребуется немного больше начальной scene setup, но переход к 3D не будет переписыванием gameplay.

## 2026-09-25: Authoritative sessions как направление multiplayer

**Контекст:** В итоговой игре нужны offline singleplayer, cooperative и PvP режимы, а клиент не должен быть источником истины для экономики и боя.

**Решение:** Считать рабочим направлением authoritative simulation на сервере. Клиент отправляет commands, получает snapshots и events, а визуальные предсказания добавлять только после измерения задержки. Общие gameplay primitives переиспользовать между режимами, но mode-specific правила оформить отдельно.

**Альтернативы:** Client-authoritative multiplayer; deterministic lockstep; peer-to-peer без authoritative server.

**Trade-off:** Snapshots создают сетевой трафик и требуют серверной синхронизации, но упрощают защиту от cheating и согласование правил.

## 2026-09-25: Solo-first scope и schematic art

**Контекст:** Владелец определил Windows 10/11 как целевые платформы, solo как текущий режим, а multiplayer как будущее направление. Визуальные references показывают плотный Warcraft III/Burbenog-бой, build slots, несколько маршрутов, selection и HUD, но итоговые модели будут создаваться самостоятельно.

**Решение:** Первые вертикальные срезы строить как одиночную игру с собственными схематичными placeholder-assets. Сохранить session и protocol seams для будущего multiplayer, но не реализовывать network functionality до отдельного этапа. Визуальный референс использовать как guidance по читаемости и composition, без копирования сторонних моделей, карт и UI.

**Альтернативы:** Сразу реализовывать PvP/co-op; использовать только плоские спрайты; копировать Warcraft III assets и map elements.

**Trade-off:** Solo-first уменьшает стартовую сложность и ускоряет polishing, но часть будущего network design придётся подтверждать позднее.

## 2026-09-25: Оригинальный visual identity

**Контекст:** Burbenog/Warcraft III показывают желаемую плотность и читаемость, но проект не должен воспроизводить их appearance. Финальные модели, карта, палитра и HUD будут создаваться самостоятельно.

**Решение:** Использовать references только для извлечения principles: angled top-down composition, readable lanes, build slots, selection feedback и масштаб боя. Визуальный north-star — самостоятельный stylized 3D diorama с компактным контекстным HUD и читаемыми placeholder-объектами. Не копировать Warcraft III/Burbenog textures, UI, silhouettes, map topology или icons.

**Альтернативы:** Повторить Warcraft III UI и art direction; сделать нейтральные grey-box prototypes; отказаться от визуального reference вообще.

**Trade-off:** Меньше мгновенной узнаваемости на старте, но появляется пространство для собственного стиля и защищённая визуальная identity.

## 2026-09-25: Pure deterministic core boundary

**Контекст:** После browser bootstrap нужен первый gameplay-модуль, который можно проверять без DOM, Three.js и WebView, сохраняя возможность подключить его к client и будущему server.

**Решение:** Реализовать `src/game-core/` как pure TypeScript module с commands, state, events, fixed tick, seeded RNG, wave transitions и fail-fast content validation. Snapshot сделать defensive presentation projection. Bounty/repair начислять только при отсутствии leaks; splash фильтровать по target tags и центрировать на цели; strongest active slow побеждает более слабый.

**Альтернативы:** Начать gameplay внутри Three.js client; использовать client-side флаги вместо simulation state; ввести ECS или общую event bus до появления второй реализации.

**Trade-off:** Core требует отдельного слоя content и сценариев, но даёт headless-проверяемость и сохраняет seam для будущей authoritative session.

## 2026-09-26: Snapshot-driven presentation и fixed-step client clock

**Контекст:** Browser bootstrap создавал tower и enemy объекты вручную, дублируя то, что уже моделирует core. Solo-сессии нет, authoritative server отложен, но presentation не должна расходиться с simulation state.

**Решение:** Client держит ровно один `Simulation` из `createTrainingScenario()` и получает `MatchSnapshot` как единственный источник presentation state. Core тикает fixed-step accumulator, который накапливает реальное время в `requestAnimationFrame` и вызывает `step()` только целыми тиками; browser delta произвольной величины в core не попадает. Сцена, build pads, routes, core и ground строятся из `map` content. Towers и enemies — presentation-объекты в `Map` по `entityId`: создание при появлении в snapshot, обновление позиции и health, удаление с dispose при исчезновении. Cosmetic анимация не меняет snapshot. `window.__ECHOES_DEBUG__` отдаёт snapshot, rendered-счётчики, позиции и `dispatch` как QA seam для Playwright.

**Альтернативы:** Оставить ручные массивы и синхронизировать их вручную; тикать core по `requestAnimationFrame` напрямую; интерполировать snapshot по времени; перенести локальный core в отдельный worker сразу.

**Trade-off:** Появляется presentation-слой projection и debug-контракт, который нужно поддерживать, а client временно владеет simulation instance. Зато browser E2E может проверять gameplay детерминированно, а будущий server layer заменит источник snapshots, не трогая projection.

## 2026-09-26: Build palette по content id, единственный command path и reason как UI contract

**Контекст:** После `0005` build pads только отображались, а build palette хранила display name строкой. Player intent нельзя было превратить в `placeTower` command, и клиенту негде было взять текст отказа. Core уже возвращал `CommandResult.reason`, но эти строки нигде не были закреплены как contract.

**Решение:** Кнопки палитры хранят `data-tower-id` из content; client падает на старте, если кнопка ссылается на неизвестную башню или если для башни нет кнопки. Выбранный tower — одно значение `selectedTowerId`, отражённое через `aria-pressed`. Клик по pad определяется raycast по pad base/ring с позициями из content и мягким fallback на плоскость; клик отправляет `placeTower` через тот же `dispatchCommand`, что и QA seam, поэтому отдельного клиентского пути мутации state нет. `CommandResult.reason` считается UI contract: клиент показывает текст отказа и reason в DOM, pad мигает при отказе, а state не меняется.

**Альтернативы:** Клиентская мутация snapshot без command; предпросмотр занятости и стоимости до отправки command; отдельный `placeTowerAtPointer` command с мировыми координатами; параллельный `startWave`-путь.

**Trade-off:** Picking требует позиций pads из content и остаётся чувствительным к росту башен и будущему zoom камеры — фиксированный hit radius помечен `techdebt:`. Привязка к content id убирает статические mock-строки, но требует синхронизировать палитру и content. Причина отказа теперь часть UI, поэтому новые commands обязаны заводить стабильные reason-коды.
