# 0009 — Asset pipeline: GLB из собственного генератора и первая модель вместо placeholder

> Статус: выдана кодовой сессии
> Приоритет: P0
> Фаза: 4 — Asset pipeline и 3D polish
> Следующая приёмка: `0010`; skeletal animation вынесена в `0021`

## Контекст

`0008` принят, фаза 3 закрыта: vertical slice играется, replay-инвариант держится, core не менялся с `0004`. Фаза 4 в PLAN сформулирована как «GLB/glTF, PBR-материалы, освещение, skeletal animation», но фактический разрыв уже, чем эта формулировка: PBR (`MeshStandardMaterial`), `ACESFilmicToneMapping`, `SRGBColorSpace`, shadow map и световая схема (hemisphere + key directional с тенями + fill point) реализованы с `0003`. Не хватает трёх вещей: в репозитории нет ни одного glTF-файла, нет asset contract, и нет seam между content id и визуальным ассетом — каждая башня сейчас это набор примитивов в `createTowerView`.

Модели нужно производять, а Blender в системе нет, `EOB-006` открыт. Штаб принял решение: собственный zero-dependency генератор glTF в репозитории вместо DCC-инструмента. Это не уступка качеству, а сознательный выбор: модели становятся текстом, который читает и правит агент, а не бинарными blob'ами без provenance.

## Цель

Появился воспроизводимый asset pipeline, который производит собственные схематичные GLB детерминированно из исходника в репозитории, и один placeholder-объект заменён реальной загруженной моделью. Core, content и все gameplay-значения не меняются.

## Решения штаба (приняты, не переигрываются)

1. **Источник моделей** — `scripts/build-assets.ts`: генератор glTF 2.0 binary на голом Node, без npm-пакетов. DCC не используется. `EOB-006` этим решением закрывается; Blender позже может стать редактором поверх того же glTF-контракта, но это не блокирует фазу 4.
2. **Артефакты не коммитятся.** `public/models/*.glb` и `public/models/manifest.json` — под `.gitignore`, в git живёт генератор. Сборка идёт через `predev` и `prebuild`, а в `npm test` добавляется шаг `test:assets`, поэтому Playwright физически не может увидеть устаревшие модели. Причина: параметры модели меняются часто, а бинарный дифф в git нечитаем и не несёт смысла.
3. **Реестр моделей — data-контракт**, а не путь в коде: `manifest.json` описывает `id`, `file`, `bytes`, `contentHash`, `triangles`, `emissiveNode`. Hardcoded путь в `main.ts` запрещён — это тот же class of debt, что и display-name строки вместо content id в `0006`.
4. **Только несжатый GLB**: геометрия, PBR factors, без текстур, без Draco/meshopt/KTX2. Декодеры лежат в `three/examples/jsm/libs`, но требуют копирования wasm в `public` и ломают zero-dependency до появления измеримой потребности. Сжатие — follow-up, не эта задача.
5. **Skeletal animation вынесена в `0021`.** `SkeletonUtils.clone` при restart/replay, `AnimationMixer` в reduced-motion и отсутствие состояния анимации в snapshot — это отдельная сложность, не связанная с критерием приёмки 0009. В моделях запрещены `SkinnedMesh`, morph targets и любые animation clips.
6. **PBR доводится IBL.** `MeshStandardMaterial` без environment даёт плоский `metalness`; добавляется `RoomEnvironment` + PMREM из `three/examples/jsm` (новая зависимость не требуется). Световая схема и exposure не перенастраиваются.
7. **Fallback против fail-fast.** Tower id без записи в манифесте остаётся процедурным — это норма. Ошибка контракта (нет манифеста, нет файла, битый GLB, нет обязательного emissive-узла) — fail-fast с видимым состоянием в UI, а не тихая деградация до placeholder.

Техническая база, на которую опирается задание (проверено в репозитории): `three@0.186.1` содержит `examples/jsm/loaders/GLTFLoader.js`, `examples/jsm/utils/SkeletonUtils.js` и `examples/jsm/environments/RoomEnvironment.js`. `vite.config.ts` в проекте нет, статикой служит дефолтный `public/`. `SkinnedMesh` в `0009` не используется, `SkeletonUtils` — тоже.

## Asset contract

Минимальные требования к модели, которые проверяются и попадают в `docs/ARCHITECTURE.md`:

- glTF 2.0, Y-up, right-handed, +Z forward, 1 unit = 1 world unit.
- Pivot в центре основания, модель ставится на pad без дополнительных смещений.
- Габарит сопоставим с процедурной башней: высота около 1.6, footprint в пределах pad hit radius 0.85 — подмена модели не должна менять читаемость сцены и picking.
- Обязательный узел `crystal`: клиент анимирует его `emissiveIntensity` и `scale` при выстреле и его `position.y` при idle bob. Отсутствие узла — ошибка контракта, а не повод гасить выстрел.
- Остальные узлы именуются `base`, `stem`, `roof`, `aura` — это делает диффы читаемыми.
- Один материал на узел, `baseColorFactor` + `metallicFactor` + `roughnessFactor`, без текстур.
- Цветовые роли совпадают с `towerVisuals['pulse-spire']`, чтобы GLB читалась как та же башня, а не как чужой объект.
- Запрещены: сжатие, внешние URI, `extensions`, `SkinnedMesh`, morph targets, animation.

## Входит в задачу

- `scripts/build-assets.ts` — генератор GLB (JSON + BIN, выравнивание до 4 байт, accessors с min/max, нормали, индексы), описание моделей, запись `manifest.json` и структурная самопроверка результата.
- `package.json` — скрипты `build:assets` и `test:assets`, hooks `predev` и `prebuild`, `test` = `test:core` + `test:assets` + `playwright test`.
- `.gitignore` — `public/models/`.
- `src/asset-registry.ts` — типы, fail-fast валидация манифеста, resolve по towerId, кэш загруженных GLTF, `assetStatus` (`loading` / `ready` / `error`). Модуль не импортирует Three.js и не содержит DOM-логики — это data-слой.
- `src/main.ts` — `GLTFLoader`, two-phase обновление tower views, `data-assets` на viewport, asset status в `scene-status`, idle bob от запомненной базовой Y crystal, разделение «своих» и «заимствованных» ресурсов при dispose, поля в debug seam.
- `index.html` — атрибут `data-assets` на `viewport-shell` по существующему образцу `data-phase` / `data-paused` / `data-replay`; никакого нового UI chrome.
- `tests/smoke.spec.ts` — два новых сценария (см. Acceptance) и единый helper ожидания `data-assets="ready"` для screenshot-сценариев.
- `docs/PLAN.md`, `docs/CONTEXT.md`, `docs/ARCHITECTURE.md`, этот файл — статус, contract и evidence.
- `src/game-core/*` и content — только чтение.

## Порядок работы

1. Написать генератор: примитивы (цилиндр, конус, октаэдр, тор) в позициях, повторяющих процедурную башню, сборка accessor'ов с min/max, `MeshStandardMaterial`-совместимые PBR factors, узлы `base`/`stem`/`roof`/`crystal`/`aura`, JSON и BIN chunks с выравниванием, запись `.glb`.
2. Сделать самопроверку генератора: после записи перечитать файл, проверить magic `glTF`, версию, длину, границы chunks, валидность JSON, соответствие accessor bufferView и диапазона индексов, наличие узла `crystal`, совпадение `bytes` и `contentHash` с манифестом. Проверка обязана быть runnable и падать на битом файле.
3. Писать `manifest.json` из того же прогона: `id`, `file`, `bytes`, `contentHash`, `triangles`, `emissiveNode`. Один tower id в этой задаче — `pulse-spire`.
4. Вынести data-слой в `src/asset-registry.ts`: типы, fail-fast парсинг манифеста, `resolveModel(towerId)`, кэш GLTF, `assetStatus`. Модуль не знает про Three.js и сцену.
5. Подключить в `src/main.ts`: boot-time загрузка манифеста и GLB, `data-assets` на viewport, текст asset status в существующий `scene-status`, fail-fast с видимой ошибкой при нарушении контракта.
6. Реализовать two-phase обновление views. Tower view, созданный до загрузки модели, остаётся процедурным; когда модель загрузилась, все существующие views этой башни заменяются на GLB без пересоздания entities, без изменения позиции и без скачка в snapshot. Это критично: асинхронная загрузка не должна делать два replay визуально разными в зависимости от тайминга.
7. Сохранить combat presentation. `crystal` из GLB получает тот же `emissiveIntensity` при выстреле и то же idle-поведение, что процедурный; bob считается от базовой Y, записанной при создании view, а не от захардкоженного `1.43`.
8. Разделить владение ресурсами: геометрия и материалы загруженной модели принадлежат реестру и не должны освобождаться при удалении одного tower view, иначе следующий view получит disposed geometry. Процедурные объекты dispose-ятся как раньше. На restart/replay, где удаляются все башни, модели остаются валидными.
9. Добавить IBL через `RoomEnvironment` + PMREM. Не трогать свет, exposure, тени и тон-маппинг.
10. Запись hook'ов: `predev` и `prebuild` вызывают `build:assets`, `npm test` выполняет `test:assets` перед Playwright. Убедиться, что после `npm test` в рабочем дереве нет изменений — артефакты генерируются, а не редактируются.
11. Обновить `docs/ARCHITECTURE.md` разделом asset contract по факту реализованного, а не по замыслу.

## Acceptance

- `npm run typecheck` проходит.
- `npm run build` проходит и включает генерацию assets до `vite build`.
- `npm test` проходит: `test:core`, `test:assets` и все 11 Playwright-сценариев.
- `scripts/build-assets.ts` детерминирован: два прогона дают побайтово одинаковые `.glb` и `manifest.json`; после `npm test` рабочее дерево остаётся чистым, потому что `public/models` под `.gitignore`.
- Самопроверка генератора красная на битом файле: сломанный magic, обрезанный chunk или выход индекса за accessor — падение с внятным сообщением, а не тихий выход.
- Первая модель грузится в браузере: viewport получает `data-assets="ready"`, `scene-status` это отражает, debug seam отдаёт статус и список загруженных моделей.
- Tower id без модели в манифесте остаётся процедурным и не ломает сцену.
- Нарушение контракта видно: при недоступном манифесте viewport получает `data-assets="error"`, в HUD есть читаемое сообщение, сцена продолжает рендериться процедурными placeholder'ами, и в console нет unhandled rejection.
- `pulse-spire` на pad отрисован загруженной GLB: у её view ненулевое число mesh-узлов, node `crystal` существует и анимируется при выстреле (эмиссия и scale меняются), idle bob не сбрасывает crystal в другую позицию.
- Placeholder-замена не ломает gameplay: `npm run test:core` даёт те же `status victory, tick 323, gold 229`, E2E-значения gold, pad occupancy и terminal-отчёты не изменились; snapshot-контракт и `commandLog` не тронуты.
- Никаких SkinnedMesh, animation clips и морфов в загруженной модели; `SkeletonUtils` не используется.
- Новых npm-зависимостей нет: `package.json` меняется только скриптами. `git diff` по `package-lock.json` пуст.
- Собственные ассеты: геометрия и материалы сгенерированы в проекте, ничего не скачано и не скопировано из сторонних источников.
- Скриншоты: `vertical-slice-asset-swap.png` (GLB-башня на pad), плюс перечитанные существующие `wave-combat-midwave.png`, `wave-combat-victory.png`, `wave-combat-defeat.png`, `vertical-slice-paused.png`, `vertical-slice-replay-reset.png`, `build-pad-placement.png` — композиция, читаемость маршрутов и HUD не пострадали.
- Console чистый: только известные `[vite]` сообщения и favicon 404 (`EOB-011`).
- `docs/ARCHITECTURE.md` содержит asset contract; `docs/CONTEXT.md`, этот файл и `docs/PLAN.md` обновлены; решение о генераторе зафиксировано в `docs/DECISIONS.md`.

Красный прогон обязателен: с временно отключённым шагом asset status или с подменой `emissiveNode` на несуществующий узел новый сценарий должен падать, иначе тест ничего не проверяет.

## Не входит

- Skeletal animation, morph targets, animation states — `0021`.
- Asset validator и performance budgets — `0010`.
- Сжатие (Draco, meshopt, KTX2, basis), текстуры, LOD, `KTX2Loader` — follow-up.
- Модели enemies, core, build pads и декора — только `pulse-spire`.
- Новые tower/enemy types, waves, economy, balance и любое изменение content.
- Art direction, сеттинг и финальный стиль — `EOB-005` не трогается.
- Разбивка `src/main.ts` на `src/client/` — `EOB-014`.
- Save/restore, multiplayer, Wails, server и transport.

## Проверка

```text
npm run typecheck
npm run build
npm test
```

E2E обязателен реальными canvas-кликами по pad и Start Wave, как в `0006`–`0008`. Отдельная проверка детерминизма генератора: два прогона `npm run build:assets` подряд дают одинаковые хеши в `manifest.json`, и `git status` после них пуст.

## Отчёт сессии

После работы указать:

- изменённые файлы и почему каждый менялся;
- содержимое `manifest.json` и параметры модели;
- доказательство детерминизма генератора и красного прогона;
- `data-assets` в каждом затронутом сценарии, `crystal`-анимация и отсутствие скачка при two-phase подмене;
- значения `test:core` до и после (должны совпасть) и подтверждение, что gameplay-контракты не изменились;
- команды и результат, список screenshots с путями;
- остаток проблем: что осталось за пределами `0009` и куда уходит;
- статус задачи: `на проверке` или `принята`.

До приёмки задача остаётся без `[x]` в `docs/PLAN.md`.

## За пределами 0009

- `0021` — skeletal animation и animation states: `SkeletonUtils.clone` при restart/replay, `AnimationMixer`, reduced-motion для клипов.
- `0010` — asset validator и performance budgets: минимальный Windows 10/11 (`EOB-002`), отклонение несовместимого ассета, проверка manifest и geometry.
- Сжатие и текстуры — отдельная задача фазы 4, когда число моделей перестанет помещаться в несжатый GLB.
- `EOB-014` — разбивка монолитного `src/main.ts`; новая точка входа asset-загрузки должна проектироваться с учётом будущего `src/client/`, но сам split не делается.
