# Echoes of Burbenog — ARCHITECTURE

## Цели

- Сохранить независимые границы gameplay, presentation, content и networking.
- Сохранять solo-first product scope, не закрывая будущие multiplayer seams.
- Сделать разработку проверяемой LLM через deterministic scenarios и browser automation.
- Позволить первому прототипу быть плоским, не блокируя переход к 3D.
- Не вводить распределённые сервисы, ECS, physics или account system без измеримой потребности.

## Целевая схема

```text
Content + Assets
       │
       ▼
Game Core (pure simulation)
       ▲
       │
Session / Server
       ▲
       │ versioned protocol
       │
Three.js Client
       ▲
       │
Wails desktop shell (later)
```

Game Core получает команды, выполняет фиксированный simulation step и формирует snapshots и events. Он не знает о DOM, Three.js, Wails, WebView или WebSocket.

## Модули

### Game Core

Отвечает за:

- сущности и устойчивые IDs;
- движение и navigation;
- targeting, attacks, damage и effects;
- экономику и permissions игроков;
- waves, objectives и win/lose;
- server-owned random и fixed tick.

Текущий simulation contract:

- `dispatch(command)` принимает intent и возвращает accept/reason;
- `step()` и `advance(ticks)` выполняют fixed tick;
- `getSnapshot()` возвращает defensive presentation projection;
- `drainEvents()` отдаёт transient события для animation/audio;
- content проходит fail-fast validation до запуска match;
- wave bounty и repair начисляются только при отсутствии leaks.

Snapshot restore и command-log replay в core сознательно отложены до решения перед session layer. Client-side QA replay мага существует только в presentation-слое и core не меняет.

Не отвечает за:

- модели, textures, lights и animation playback;
- DOM, input devices и camera;
- persistent storage, accounts и matchmaking;
- transport-specific serialization.

### Client

Отвечает за:

- Three.js scene, camera и renderer;
- input и selection;
- DOM UI;
- presentation states и animations;
- interpolation snapshots;
- cosmetic effects, которые не меняют authoritative state.

Текущая solo-обвязка:

- Client держит один локальный `Simulation` и тикает его fixed-step accumulator, который накапливает реальное время в `requestAnimationFrame`; core получает только целые тики.
- `MatchSnapshot` — единственный источник presentation state. Towers и enemies — presentation-объекты, адресуемые по `entityId`; они создаются, обновляются и удаляются вместе с snapshot.
- HUD (phase, phase clock, enemy count, objective, result) — проекция snapshot. DOM не считает значения сам и не дублирует счётчики; `data-phase`, `data-kind`, `data-paused` и `data-replay` зеркалят `snapshot.status` и client clock state как проверяемый contract.
- Preparation clock показывает `Awaiting start`, когда `preparationTicksLeft === 0`: content prep-окно короткое, и замороженный `T-00:00` читался как живой таймер.
- Pause — только control часов клиента: `step()` не вызывается, accumulator сохраняет дробную часть, поэтому resume продолжает с того же тика без fast-forward и drift. Commands при паузе продолжают доходить до core.
- Restart — client-side QA replay: новый `Simulation` из того же `config` плюс tick-упорядоченный `commandLog`, который проигрывается тем же `dispatchCommand` на исходных тиках. Пока replay идёт, player-команды заблокированы. Persistence и network replay в это не входят.
- `dispatchPlayerCommand` — единственный путь player-команды и в `commandLog`, и в core, поэтому replay-guard (`replaying`) живёт там же: во время replay команда отклоняется с client-причиной `replay-in-progress`, не пишется в log и не доходит до core. Pad-клик, Start Wave и QA seam `dispatch` не могут разойтись в правилах.
- Каждый terminal-матч пишет один `matchReport` (status, tick, gold, integrity, leaks, `eventCounts`), поэтому повторный прогон сравнивается с исходным напрямую.
- Terminal feedback имеет приоритет над command feedback: после victory/defeat строка статуса описывает результат, а не последнюю команду.
- Events из `drainEvents` — только transient presentation: typed-счётчики, bounded combat log, вспышка и наведение башни, burst-ring убийства, flash core. События не меняют state и не используются как источник значений.
- `prefers-reduced-motion: reduce` отключает transient-эффекты и ambient-анимацию в canvas, сохраняя статичное читаемое состояние из snapshot. Скелетный клип в том же списке и не замедляется, а не играет: action не запускается вовсе, кости стоят в rest-позе первого ключа.
- Command events потребляются в той же task, что и сам command, поэтому feedback и счётчики не отстают от ввода на кадр.
- Позднее источник snapshots заменяется на session, а projection остаётся прежней.
- `window.__ECHOES_DEBUG__` — QA seam для browser E2E: snapshot, rendered-счётчики, позиции, screen-координаты build pads, выбранный tower, feedback, `eventCounts` по типам, `recentEvents`, clock/replay state, `matchReports`, `motion` (включая число mixer'ов и число играющих клипов), asset status со списком загруженных моделей, `assetBudgets` (бюджеты, измеренные величины, флаги выполненных проверок и текущие нарушения), `towerModels` (источник view, id модели, число mesh-узлов, узел crystal, его базовая Y, scale, emissive и состояние клипа: имя, длительность, фаза, время, playing и поза кости) и dispatch. Это не gameplay API.

### Server и Session

Отвечает за:

- lifecycle матча;
- command validation и permissions;
- simulation ticks;
- client connections и transport;
- room state и later matchmaking;
- persistence adapters.

Server и dedicated server должны использовать одну реализацию Game Core. Нельзя одновременно поддерживать две независимые версии правил.

### Protocol

Версионированный boundary между client и server:

- `Command` — намерение игрока;
- `Snapshot` — полное или частичное состояние для presentation;
- `Event` — краткоживущий визуальный факт;
- handshake с protocol version, content version, map version и seed.

Формат сериализации выбирается после измерения размера и частоты snapshots. На раннем этапе приоритет — читаемость и диагностика.

### Content и Assets

Content включает data-driven описания карт, башен, врагов, волн и баланса. Assets включают GLB-модели, textures, materials и animation clips.

Модели производятся собственным генератором `scripts/build-assets.ts` и не коммитятся: `public/models/` под `.gitignore`, сборка идёт через `predev`/`prebuild`, а `npm test` содержит шаг `test:assets`, поэтому Playwright физически не может увидеть устаревшие артефакты.

Asset contract, как реализовано в `0009`:

- glTF 2.0, Y-up, right-handed, +Z forward, 1 unit = 1 world unit, pivot в центре основания: модель ставится на pad без дополнительных смещений;
- узлы — прямые потомки корня сцены с именами `base`, `stem`, `roof`, `crystal`, `aura`; обязательный узел `crystal` несёт эмиссию и idle bob, остальные имена делают дифф модели читаемым;
- габарит сопоставим с процедурной башней: высота около 1.6, footprint в пределах pad hit radius 0.85, чтобы подмена модели не меняла читаемость сцены и picking;
- один материал на узел: `baseColorFactor` + `metallicFactor` + `roughnessFactor`, `emissiveFactor` у emissive-узла, без текстур; факторы линейные, sRGB-цвета кода конвертирует генератор;
- запрещены сжатие, внешние URI, `extensions` и morph targets;
- скелет и анимация разрешены в узкой форме: один `skin`, один `SkinnedMesh` (узел `crystal`), кости — узлы без mesh, один `AnimationClip` длиной до 2 секунд, каналы только `translation`, `rotation` и `scale` весом `LINEAR`; клик — `crystal-sway` в иерархии `crystal-root > crystal-sway`, поэтому кости достигаются из корня сцены, а `SkeletonUtils.clone` получает их вместе с копией;
- веса кожи считает генератор из своих же массивов: каждая вершина `crystal` привязана к `crystal-sway` с весом 1, `JOINTS_0`/`WEIGHTS_0` — VEC4, то есть 4 слота и 4 влияния против бюджета 4;
- `manifest.json` — единственный источник ожиданий: `id`, `file`, `bytes`, `contentHash`, `triangles`, `emissiveNode`; `file` — имя файла без пути. Скелет в манифест не входит и не должен: клиент меряет его по загруженному дереву, и декларация была бы числом, которому никто не может соответствовать.

Performance budgets и отклонение несовместимого ассета — задача `0010`: лимиты живут в одном модуле `src/asset-budgets.ts`, который проверяется и в сборке, и на клиенте, а числа предварительные до фиксации минимального тестового железа (`EOB-002`).

Все лимиты, их значения и тексты причин отказа живут в одном модуле `src/asset-budgets.ts` — чистые данные и предикаты без Three.js, DOM и Node API, потому что его импортируют и генератор (`scripts/build-assets.ts`), и браузерный клиент. Одна правка лимита обязана ломать и `build:assets`, и рантайм-проверку, поэтому ни в генераторе, ни в `main.ts` нет ни одного числового лимита: только импорт. **Числа предварительные** — заданы штабом под класс встроенной графики (GT 1030 / UHD 620, WebGL2, 8 GB RAM) и пересматриваются после выбора минимального тестового железа (`EOB-002`); до этого решения бюджет ловит грубые нарушения и не ловит плавную деградацию.

Бюджет на модель: 5 000 треугольников, 1 MiB несжатых байт, 32 узла, 32 меша, 16 материалов, 0 текстур, 1 скин, 0 морфов, 1 animation clip, 24 кости, 4 слота веса и 4 влияющих кости на вершину, длина клипа 2 секунды, высота 4.0 world units, footprint-радиус 0.85, pivot по Y — 0 с допуском 0.01. Бюджет на реестр: 8 MiB, 150 000 треугольников, не более 64 моделей. Бюджет сцены в рантайме: 400 draw calls, 250 000 отрисованных треугольников, 32 shader-программы, 1 500 мс на суммарную загрузку ассетов.

Проверка двухуровневая, и обе точки обязаны ловить одно и то же:

- **В сборке.** Генератор измеряет модель (те же округлённые массивы, что попадают в accessors) и прогоняет `checkModelContract`, `checkNodeTypes`, `checkClipTargets` и `checkRegistryBudgets` до первого `writeFileSync`. Нарушение — отказ с ненулевым кодом выхода и внятной причиной; ни артефакт, ни запись в манифест не пишутся, поэтому битая модель не может оказаться рядом со здоровой. Скелет проверяется как структура, а не как число: `verifySkeleton` требует ровно один `skin`, ровно один skinned-узел, длину `inverseBindMatrices` по числу костей, веса в `[0, 1]` с суммой 1 на вершину, `JOINTS_0`/`WEIGHTS_0` типа VEC4 и клип, который адресует только кости и только воспроизводимые каналы.
- **В рантайме.** Клиент сверяет фактическую длину буфера с `entry.bytes` всегда, а `contentHash` — при наличии `crypto.subtle`; расхождение — `AssetContractError` с названием модели и ожидаемым/полученным значением. Дерево загруженной модели проверяется до инстанцирования: любой узел, который client не воспроизводит, — отказ с названием типа узла и путём до него, и то же дерево меряется на скелет. `loadModel` — единственное место, где модель принимается.

Границы различаются по тому, кто может их измерить, и это осознанная граница охвата, а не пробел. Счётчики, которых нет в дереве сцены и которые манифест объявляет — `triangles` и `bytes`, — клиент сверяет с артефактом: `bytes` измеряется, `triangles` берётся из манифеста, и подменой ответа такой отказ воспроизводится. Скелет, наоборот, выводится из того, что загрузилось: число костей — это `Bone` в дереве, слоты и влияния — `skinWeight` геометрии, клипы и длина — `gltf.animations`, а каналы читаются как `gltf`-пути через `gltfPathForTrack` (Three.js называет трек свойством, которое пишет миксер: `crystal-sway.quaternion` — это `rotation`). Поэтому манифест про скелет молчит, а seam публикует измеренное: иначе подмена манифеста не могла бы доказать отказ по костям, а декларация, которой никто не сверяет, выглядела бы как проверка. Геометрические границы — высота, `footprintRadius` и `pivotY` — клиент по-прежнему не меряет: они не выводятся ни из манифеста, ни из дерева сцены, поэтому подменой ответа такой отказ не воспроизвести, а писать непроверяемый клиентский код значило бы создать видимость защиты. Их проверяет генератор на сборке, а в рантайме за ту же границу отвечает picking: клик по pad'у опирается на pad hit radius из content, и бюджет `footprintRadius` существует ровно затем, чтобы модель не могла вылезти за радиус, по которому её выбирают.

`bytes` проверяется всегда, `contentHash` — только при доступном `crypto.subtle`, потому что он требует secure context: localhost и https его дают, голый http по LAN — нет. Молча пропустить проверку нельзя, и сломать легальный dev-сетап тоже нельзя, поэтому seam публикует, какие проверки фактически выполнены, а `scene-status` говорит это текстом: `integrity checked` или `content hash not checked (<причина>)`.

Отказ локальный: одна битая модель не роняет остальной реестр — остальные модели всё равно подменяют placeholder'ы, а отказ называет конкретную модель. Нарушение бюджета сцены не мешает рендерить (сцена уже на экране), поэтому оно публикуется в seam и в диагностике под dev-флагом, но не в строке статуса: бюджет считается на машине, где сцена собрана, и на медленной сети игрок увидел бы «over budget» там, где всё работает.

Причина отказа показывается в трёх формах, и это три разных адресата. Полная — в `assets.error` и в `assetBudgets.failures`, потому что сверять digest нужно с полным значением. В отдельном блоке отказа (`scene-report`, атрибут `data-reason`) та же причина целиком: она переносится по словам и никогда не обрезается, потому что блок для того и существует — одной строке chip'а нечего растягивать, а оператору нужно само значение. В `scene-status` причина сокращена до `sha256:<8 hex>…`, всё остальное без изменений: строка остаётся строкой и говорит, что именно случилось, одной фразой. Сокращение — правило отображения на стороне DOM, а не усечение самой причины, поэтому seam, атрибут и тест остаются точными.

### Две поверхности viewport chrome

Задача `0013` развела то, что видно игроку, и то, что нужно разработчику. Правило простое: **значение, посчитанное на этой машине, не показывается человеку, играющему на своей.**

| Поверхность | Что несёт | Когда появляется |
|------------|-----------|-----------------|
| `scene-status` (одна строка) | состояние загрузки, состав моделей, целостность артефакта, при отказе — короткая причина | всегда |
| `scene-report` (блок) | полная причина отказа с полным digest, в переносе по словам | при `data-assets="error"` |
| `scene-diagnostics` (блок) | бюджеты, измеренные значения, флаги выполненных и пропущенных проверок | только при `?dev` в query |
| seam `assetBudgets` | то же, что диагностика, плюс счётчики `renderer.info` и время загрузки | всегда, в `window.__ECHOES_DEBUG__` |

Флаг диагностики — query-параметр `dev` (`?dev`, `?dev=1`; `?dev=0` и `?dev=false` выключают), а не элемент управления в HUD: панель, свотч и дебаг-оверлей в этой игре не появляются. Элемент `scene-diagnostics` **создаётся** `main.ts` только когда флаг есть, поэтому без флага его нет в DOM вообще — не скрыт и не пуст, а отсутствует, и скриншот без флага не может его показать. `viewport[data-diagnostics]` говорит, какое из двух состояний сейчас. Диагностика перерисовывается вслед за измерением, а не за вердиктом, иначе блок мог бы показывать более старое чтение, чем seam, и сравнивать два момента; игровая строка переписывается только когда меняется причина.

Читаемость проверяется измерением, а не просмотром (`0010`, `0011`, `0013`): «подпись сектора не перекрыта» — это «ни один прямоугольник видимого блока chrome не накрывает ни одного глифа подписи», где подпись меряется через `Range.getClientRects()` по текстовым узлам (сравнение bounding box строк с боксом грид-элемента даёт ложное перекрытие), а «причина видна целиком» — это «каждый глиф причины лежит внутри padding box её блока, блок не обрезан, `text-overflow` не `ellipsis` и `overflow` не scroll». Это одновременно проверка и красного прогона: вернуть `over budget` в строку или обрезать digest в блоке — соответствующая проверка становится красной.

`scene-report` и `scene-diagnostics` — `pointer-events: none`, как остальной chrome: HUD не должен перехватывать клик по pad'у, и в негативных сценариях игрок по-прежнему ставит башню на плитку под блоком.

Favicon объявлен inline data-URL в `index.html` (`EOB-011`): без объявленной иконки браузер сам запрашивает `/favicon.ico`, а отсутствующий файл печатает в консоль `404` на каждом запуске. Проверяется это не запросом (в headless запрос favicon не виден вовсе), а тишиной загрузки: `404` приходит в консоль без URL в тексте, поэтому красным становится проверка «в консоли нет ни одного сообщения уровня error» плюс требование, что объявленная иконка — data-URL.

`renderer.info` и время загрузки — единственные недетерминированные величины: `renderer.info` читается сразу после `render()` (он сбрасывается каждый кадр), а сценовый бюджет пересчитывается только когда хотя бы одно число сдвинулось. Поэтому тест проверяет попадание в бюджет, а не значение.

### Asset Registry

Data-слой реестра (`src/asset-registry.ts`) отвечает за fail-fast парсинг манифеста, resolve tower id → запись, кэш загрузок по файлу и `assetStatus` (`loading` / `ready` / `error`). Он не импортирует Three.js и не знает про DOM или сцену: загрузчик GLB и инстанцирование view живут в client, а путь к файлу модели получается только через `resolveModelUrl`.

Отсутствие записи для tower id — нормальный ответ, а не ошибка: такой tower остаётся процедурным. Нарушение контракта (нет манифеста, нет файла, битый GLB, нет emissive-узла, несовпадение `bytes` или `contentHash`, несовместимый тип узла, превышение бюджета) — fail-fast: viewport получает `data-assets="error"`, причина читается в `scene-status`, сцена продолжает рендериться процедурными placeholder'ами. Реестр хранит измеренные величины и факт выполнения каждой проверки, но не решает, что́ отклонять: политика в `asset-budgets.ts` и в `loadModel`, чтобы data-слой оставался без Three.js и DOM.

Владение ресурсами: загруженная сцена — единственный владелец своей геометрии, своих исходных материалов и своих клипов. Tower view получает общую геометрию и собственные копии материалов, потому что `emissiveIntensity` узла `crystal` — per-tower presentation state, и на общем материале вспышка одной башни зажигала бы все башни этого типа. `release()` view освобождает только то, чем view владеет, поэтому следующий view той же модели не получает disposed geometry.

Скелетная модель клонируется `SkeletonUtils.clone`: он пересобирает `Skeleton` и перепривязывает копию к собственным костям, а геометрию и материалы отдаёт по ссылке — поэтому копии материалов делаются после клона. `Material.copy` переносит и `envMap`, и `envMapIntensity`, и `userData`, так что per-view копия наследует владение пробой и роль `0011` без отдельного кода. Копия mixer'а и его actions снимаются в том же `release()`: mixer держит bindings и actions живыми сам по себе, и тридцать удалённых башен оставили бы тридцать mixer'ов на скелетах, которые никто не рисует.

Two-phase обновление: view, созданный до ответа реестра, остаётся процедурным; когда модель загрузилась, все существующие views этой башни заменяются на GLB на месте — entity, позиция, rotation и snapshot не меняются, поэтому момент появления модели не может сделать два replay визуально разными.

### Wails и Go

Wails — поздний desktop adapter: окно, fullscreen, settings, saves и упаковка web assets. Go не должен использоваться для высокочастотного gameplay channel. Dedicated server на Go появляется только после измерения Node.js или по решению владельца.

## 3D-ready rendering

- Первый renderer — Three.js WebGL2.
- Первая камера — OrthographicCamera.
- Мир — XZ plane с высотой по Y, даже когда визуальные объекты плоские.
- Grid — placement layer, а не система координат движения.
- Временные placeholder meshes заменяются GLB без изменения simulation contracts.
- PBR доводится IBL: `RoomEnvironment` + PMREM дают `scene.environment`. Проба — новый источник света, поэтому её вклад задаётся на материале, а не на сцене; lights, exposure и tone mapping не перенастраиваются.
- WebGPU и тяжёлые post-processing остаются последующими оптимизациями.

### Часы клипа: presentation clock, а не wall-clock

Состояние анимации живёт в presentation-слое и не попадает ни в `MatchSnapshot`, ни в `commandLog`, ни в `matchReports`: `AnimationMixer` и `action.time` — такое же presentation state, как `crystalBaseY` или `towerSlot`. Snapshot остаётся defensive projection core, а критерий детерминизма replay не меняется — «тот же seed и та же command sequence дают тот же отчёт».

Фаза клипа считается от **presentation clock**: время presentation — это `snapshot.tick * STEP_SECONDS`, то есть ровно то время, на которое матч продвинулся. Не от `elapsed` (это wall time, и он продолжает идти на паузе, как нужно ambient-bob'у), не от `performance.now()` (случайный старт дал бы визуально разный кадр на том же тике — тот самый дефект, который `0009` закрыл для моделей), не от числа кадров. Из этого следуют три свойства, и все три проверяются тестом, а не комментарием:

- **Пауза останавливает клип.** Пока `step()` не вызывается, presentation clock не растёт, разница, которую добавляет mixer, равна нулю, и поза держится: снимок на паузе и скриншот на паузе показывают одну и ту же позу.
- **Restart и replay воспроизводят позу.** Часы матча начинаются с нуля, башня появляется на своём тике (`applySnapshot` во время replay-а вызывается после шага симуляции, и `applied` view'а — это тот же тик), поэтому поза является функцией тика, а не момента, когда браузер добрался до кадра. Конечный тик матча — идеальная точка сравнения: он одинаков в обоих прогонах, и `test:core`/`matchReports` это уже доказывают.
- **Reduced-motion останавливает клип целиком.** Action не запускается (`playing: false`, `time: 0`), кости стоят в rest-позе первого ключа, который у клипа совпадает с bind-позой, поэтому читаемость позы, health bars, материалов и HUD не меняется. Включение `prefers-reduced-motion` на живом матче возвращает кости в rest-позу (`mixer.setTime(0)` до `action.stop()`) и останавливает действие.

Фаза старта клипа — слот сущности: `slot * 0.37` секунды, где slot — порядок, в котором башни построены. Две башни одной модели поэтому не стоят в одной позе, а смещение воспроизводится вместе с порядком постройки. Окно между башней и её вилкой не зависит от кадра: mixer приводится к presentation clock разницей (`applied` держит последнюю отметку), а не прибавлением дельты кадра.

Подсистема анимации — это тип `TowerClip` и три функции (`startTowerClip`, `readTowerClip`, `presentationTime`) плюс строка в `TowerView`; ни одна из них не знает про snapshot, core или DOM. Это и есть seam для будущей разбивки `src/main.ts` на `src/client/` (`EOB-014`): переносить её можно целиком, не переписывая.

### Вес environment probe — свойство материала



Сцена намеренно тёмная tactical read, поэтому проба не применяется к ней целиком. Доля пробы задаётся
`material.envMapIntensity` на каждом материале, который её видит, и объявлена одним списком
`PROBE_WEIGHTS` в `main.ts`: земля и маршруты почти не берут пробы (0.1 и 0.15 — грубая
почти-диэлектрическая поверхность не выигрывает от мягкой комнаты и только теряет свой slate),
доля растёт с metalness детали, а загруженная GLB-модель забирает пробу целиком — ради неё проба и
введена. Множителя на уровне сцены в коде нет.

Одна строка в `withProbeWeight` несущая, и её нельзя «чистить»:

```ts
material.envMap = environmentTarget.texture;
```

Three.js читает `material.envMapIntensity` **только если материал сам владеет `envMap`**. При
`envMap === null` и пробе на `scene.environment` renderer перезаписывает этот uniform значением
`scene.environmentIntensity`, и объявленный вес молча игнорируется. Это не опечатка, а правило
движка (`WebGLRenderer` при `material.envMap === null` и `MaterialProperties` для node-пути), и
проверяется только измерением: без этой строки земля на замороженном midwave-кадре светлеет примерно
на 16 единиц люминации вместо потемнения, при том что seam продолжает показывать вес как
объявленный. Поэтому seam публикует не только вес, но и `ownsProbe`, и E2E требует его у каждого
стандартного материала: отчёт не может сертифицировать значение, которого картинка не видела.

Побочный эффект, который и был целью: когда каждый стандартный материал читает пробу сам, сценовый
множитель теряет последний объект приложения и становится инертным. Возврат
`scene.environmentIntensity` в коде ничего не меняет — измерено на одинаковом кадре.

`MeshBasicMaterial` веса не несёт и не читает `envMapIntensity` вовсе: для него renderer вызывает
только `refreshUniformsCommon` и uniform не заполняет. Такие материалы (кольца pads, ауры, health
bars, burst-rings) остаются на `scene.environment` и пробу не гасят — они и не проектировались под
неё, и гасить их нечем.

## Визуальные принципы
References показывают Warcraft III/Burbenog-подачу: angled top-down camera, читаемые lanes и chokepoints, заметные build slots, плотный combat, selection outline, health bars и компактный HUD.

- Это reference для gameplay readability, а не surface design для копирования.
- Предварительный visual north-star — stylized 3D diorama с собственными models, materials, palette и HUD.
- Мир должен занимать большую часть экрана; HUD — компактный и контекстный, а не копия панели Warcraft III.
- Первые placeholder-модели должны иметь ясные silhouettes и цветовые роли, а не быть случайными grey boxes.
- Эффекты не должны закрывать маршруты, selection и состояние башен.
- Финальные models, textures и animation заменяют placeholders по asset contract, не меняя gameplay.

## LLM-friendly QA

Каждый этап должен иметь машинно-проверяемый результат:

1. Детерминированный scenario seed.
2. Фиксированные camera, viewport и tick.
3. Structured state snapshot.
4. Pure unit check.
5. Playwright E2E smoke check.
6. Screenshot для композиции и визуальных регрессий.

Для WebGL сначала проверять availability и smoke behavior, затем сравнивать screenshots с допусками. Не делать pixel-perfect проверки основным критерием gameplay correctness.

## Multiplayer compatibility

Текущий product scope — solo. Multiplayer пока не реализуется, но границы sessions, protocol и mode rules сохраняются, чтобы будущий режим не потребовал переписывания presentation и content.

1. Offline session использует тот же core, что и online session.
2. Local/private rooms проверяются двумя Playwright browser contexts.
3. Cooperative mode определяет общие и раздельные ресурсы.
4. PvP использует отдельные match rules поверх общих primitives.
5. Client prediction добавляется только после профилирования задержки и input latency.
6. Accounts, matchmaking и persistence остаются внешними сервисными модулями.

## Не делать на старте

- Не создавать microservices.
- Не добавлять ECS без измеримой проблемы.
- Не выбирать WebGPU-only path.
- Не строить полноценный level editor до появления рабочего map contract.
- Не смешивать Wails IPC и realtime snapshots в один канал.
- Не хранить gameplay rules одновременно в клиенте и сервере.
