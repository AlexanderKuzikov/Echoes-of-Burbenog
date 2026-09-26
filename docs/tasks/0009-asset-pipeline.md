# 0009 — Asset pipeline: GLB из собственного генератора и первая модель вместо placeholder

> Статус: сдана кодовой сессией, на проверке штаба
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
- `0010` — asset validator и performance budgets: минимальное Windows 10/11 (`EOB-002`), отклонение несовместимого ассета, проверка manifest и geometry.
- Сжатие и текстуры — отдельная задача фазы 4, когда число моделей перестанет помещаться в несжатый GLB.
- `EOB-014` — разбивка монолитного `src/main.ts`; новая точка входа asset-загрузки должна проектироваться с учётом будущего `src/client/`, но сам split не делается.

## Отчёт сессии

### Изменённые файлы

- `scripts/build-assets.ts` (новый) — генератор GLB, описание модели, запись `manifest.json`, структурная самопроверка, детерминизм и красные прогоны на битом файле.
- `src/asset-registry.ts` (новый) — data-контракт реестра: типы, fail-fast парсинг манифеста, resolve по `towerId`, кэш загрузок по файлу, `assetStatus`. Без Three.js, DOM и сцены.
- `src/main.ts` — IBL (`RoomEnvironment` + PMREM, `environmentIntensity = 0.5`), boot-загрузка реестра, two-phase подмена tower view, per-view копии материалов при общей геометрии, `release()` вместо общего dispose для башен, `data-assets` в viewport и статус в `scene-status`, idle bob от запомненной базовой Y crystal, поля `assets` и `towerModels` в debug seam.
- `index.html` — атрибут `data-assets="loading"` на `viewport-shell` по образцу `data-phase`/`data-paused`/`data-replay`; нового UI chrome нет.
- `tests/smoke.spec.ts` — два новых сценария, единый helper `waitForAssetsReady` во всех screenshot-сценариях, чтение `assets`/`towerModels` из debug seam, проверка model-source после victory.
- `package.json` — `build:assets`, `test:assets`, hooks `predev` и `prebuild`, `test` = `test:core` + `test:assets` + `playwright test`. Новых зависимостей нет, `package-lock.json` не тронут.
- `.gitignore` — `public/models/`.
- `docs/ARCHITECTURE.md`, `docs/CONTEXT.md`, `docs/PLAN.md`, `docs/DECISIONS.md`, этот файл — asset contract, статус и evidence.
- `src/game-core/*`, `content` (внутри `src/game-core/scenario.ts`) — только чтение.

### Модель и манифест

```json
{
  "version": 1,
  "models": [
    {
      "id": "pulse-spire",
      "file": "pulse-spire.glb",
      "bytes": 17996,
      "contentHash": "sha256:25b4af43806b6fc65fcfee270ab85d8e717df47999a1cb10af3ad9271068eac5",
      "triangles": 580,
      "emissiveNode": "crystal"
    }
  ]
}
```

Параметры `pulse-spire` (узлы — прямые потомки корня, pivot в центре основания, высота ≈ 1.61, footprint 0.57 против pad hit radius 0.85):

| Узел | Геометрия | Node Y | Треугольников | Цвет (sRGB) | metallic | roughness | emissive |
|------|-----------|--------|--------------|-------------|----------|-----------|----------|
| `base` | cylinder 0.46/0.56 × 0.3, 6 сегментов | 0.15 | 24 | `0x1d4651` | 0.34 | 0.46 | — |
| `stem` | cylinder 0.2/0.28 × 0.78, 6 сегментов | 0.5 | 24 | `0x346f75` | 0.5 | 0.34 | — |
| `roof` | cone 0.45 × 0.42, 6 сегментов | 1.08 | 12 | `0xd29b62` | 0.3 | 0.3 | — |
| `crystal` | octahedron 0.18 | 1.43 | 8 | `0x6ee2cf` | 0.15 | 0.18 | `0x6ee2cf` |
| `aura` | torus 0.57/0.025, 8×32 | 0.18 | 512 | `0x6ee2cf`, alpha 0.7, `BLEND` | 0 | 0.25 | `0x6ee2cf` |

Цвета совпадают с `towerVisuals['pulse-spire']` и с материалами процедурной башни; sRGB-значения переводятся в линейные факторы генератором, поэтому GLB читается как та же башня. `aura` — единственное отступление от процедурного вида: glTF не имеет unlit-материала, поэтому кольцо аппроксимировано blended emissive PBR с тем же силуэтом и той же прозрачностью.

### Детерминизм и красные прогоны

- Два прогона `npm run build:assets` подряд: `pulse-spire.glb` — одинаковый SHA-256, `manifest.json` — побайтово идентичен. Отдельный verify-only прогон `npx tsx scripts/build-assets.ts --check` перечитывает артефакты с диска и сверяет их с манифестом.
- Детерминизм проверяется и внутри генератора: `test:assets` собирает модель второй раз в том же процессе и сравнивает байты и хеш с записанным файлом.
- Самопроверка красная на пяти видах поломки, каждая падает с внятным сообщением и печатается в лог `test:assets`:
  - сломанный magic → `pulse-spire.glb: bad magic, expected glTF`;
  - обрезанный chunk → `chunk 0x4e4942 runs past the end of the file`;
  - индекс вне accessor → `mesh 0 primitive 0: triangle 0 references vertex 37 of a 30 vertex accessor`;
  - неверная версия контейнера → `unsupported container version 1`;
  - несовпадение длины в заголовке → `header length 18000 does not match the 17996 bytes on disk`.
  Каждый битый файл перед проверкой перехешируется под манифест, иначе сработала бы более ранняя проверка байтов и целевая проверка не была бы проверена.
- Дополнительно самопроверка сверяет winding каждого треугольника с вершинными нормалями (все 580), границы `bufferView` внутри буфера, выравнивание accessor'ов, наличие `emissiveFactor` у узла `crystal` и совпадение `triangles` с манифестом.
- Красный прогон E2E: с временно отключённым шагом asset status (`viewportShell.dataset.assets`) оба новых сценария красные (`data-assets` остаётся `loading`); с временно отключённой two-phase подменой (`upgradeTowerViews`) красный сценарий подмены на `['procedural', 'procedural', 'procedural']` вместо `['model', ...]`. В обоих случаях правка снята.

### Сценарии и two-phase подмена

- `swaps a placed placeholder for the generated GLB without touching the snapshot` — маршрут `**/models/*.glb` удерживает ответ, поэтому башни гарантированно строятся процедурными. До разблокировки: `data-assets="loading"`, `source: 'procedural'`, `modelId: null`. После: тот же `entityId`, та же позиция на pad, тот же gold, `source: 'model'`, `modelId: 'pulse-spire'`, `meshCount: 5`, `crystalBaseY: 1.43`; два соседних башни без модели остались процедурными. Idle bob не уводит crystal от базовой Y (|Δ| ≤ 0.08) и продолжает двигаться; при выстреле снят кадр прямо в странице, где `crystalEmissive > 2.4` и `crystalScale > 1`, после чего эмиссия возвращается к idle. Скриншот `test-results/vertical-slice-asset-swap.png`.
- `keeps the match playable and names the failure when the model registry is unavailable` — манифест отдаёт 404: `data-assets="error"`, в `scene-status` читается `model registry failed: model registry responded 404`, `assets.error` заполнен, башня остаётся процедурной, Start Wave проходит, `pageerror` пуст — unhandled rejection нет.
- Остальные девять сценариев не потеряли проверок; `data-assets="ready"` добавлен единым helper'ом во все screenshot-сценарии, а полный прогон до victory теперь дополнительно утверждает, что spire на pad — загруженная модель.

### Gameplay-контракты

- `test:core` до и после: `{ status: victory, tick: 323, gold: 229, towers: 3, enemies: 0, coreHealth: 10 }` — совпадает.
- E2E-значения не изменились: gold 229 при полном заходе, `pad` occupancy из snapshot, terminal-отчёты двух прогонов replay идентичны, `commandCount` = 4, snapshot-контракт и `commandLog` не тронуты.
- SkinnedMesh, animation clips и морфов в модели нет; `SkeletonUtils` не импортируется; `package.json` изменён только скриптами, `package-lock.json` пуст в diff.

### Команды и результат

| Команда | Результат |
|---------|-----------|
| `npm run typecheck` | ok |
| `npm run build` | ok, `prebuild` сгенерировал assets, `dist/models` содержит `manifest.json` и `pulse-spire.glb` |
| `npm run test:core` | victory, tick 323, gold 229 |
| `npm run test:assets` | ok + 5 красных проверок |
| `npx playwright test` | 11 passed (46 s) |
| `npm run build:assets` × 2 | одинаковые хеши, `git status` чистый |

Screenshots: `test-results/vertical-slice-asset-swap.png` (GLB-башня на pad), перечитаны `wave-combat-midwave.png`, `wave-combat-victory.png`, `wave-combat-defeat.png`, `vertical-slice-paused.png`, `vertical-slice-replay-reset.png`, `build-pad-placement.png`. Композиция, маршруты и HUD сохранились; IBL добавил один драйверный warning `X4122` от компиляции PMREM-шейдера — не ошибка, вместе с favicon 404 (`EOB-011`) он единственный не-`[vite]` вывод в консоли.

### Остаток проблем

- `0010` — asset validator и performance budgets: минимальное железо (`EOB-002`), отклонение несовместимого ассета, проверка manifest и geometry; там же пересмотр `environmentIntensity`.
- `0021` — skeletal animation и animation states.
- `EOB-016` — provenance моделей из внешнего редактора: контракт валидирует только то, что собрал генератор.
- Сжатие и текстуры — отдельная задача фазы 4.

Статус задачи: `на проверке`.
