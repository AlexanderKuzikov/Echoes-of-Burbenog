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
