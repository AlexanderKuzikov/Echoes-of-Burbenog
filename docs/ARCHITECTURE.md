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
- `prefers-reduced-motion: reduce` отключает transient-эффекты и ambient-анимацию в canvas, сохраняя статичное читаемое состояние из snapshot.
- Command events потребляются в той же task, что и сам command, поэтому feedback и счётчики не отстают от ввода на кадр.
- Позднее источник snapshots заменяется на session, а projection остаётся прежней.
- `window.__ECHOES_DEBUG__` — QA seam для browser E2E: snapshot, rendered-счётчики, позиции, screen-координаты build pads, выбранный tower, feedback, `eventCounts` по типам, `recentEvents`, clock/replay state, `matchReports`, `motion`, asset status со списком загруженных моделей, `towerModels` (источник view, id модели, число mesh-узлов, узел crystal, его базовая Y, scale и emissive) и dispatch. Это не gameplay API.

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
- запрещены сжатие, внешние URI, `extensions`, `SkinnedMesh`, morph targets и animation clips;
- `manifest.json` — единственный источник ожиданий: `id`, `file`, `bytes`, `contentHash`, `triangles`, `emissiveNode`; `file` — имя файла без пути.

Performance budgets и отклонение несовместимого ассета остаются за `0010`.

### Asset Registry

Data-слой реестра (`src/asset-registry.ts`) отвечает за fail-fast парсинг манифеста, resolve tower id → запись, кэш загрузок по файлу и `assetStatus` (`loading` / `ready` / `error`). Он не импортирует Three.js и не знает про DOM или сцену: загрузчик GLB и инстанцирование view живут в client, а путь к файлу модели получается только через `resolveModelUrl`.

Отсутствие записи для tower id — нормальный ответ, а не ошибка: такой tower остаётся процедурным. Нарушение контракта (нет манифеста, нет файла, битый GLB, нет emissive-узла) — fail-fast: viewport получает `data-assets="error"`, причина читается в `scene-status`, сцена продолжает рендериться процедурными placeholder'ами.

Владение ресурсами: загруженная сцена — единственный владелец своей геометрии и исходных материалов. Tower view получает общую геометку и собственные копии материалов, потому что `emissiveIntensity` узла `crystal` — per-tower presentation state, и на общем материале вспышка одной башни зажигала бы все башни этого типа. `release()` view освобождает только то, чем view владеет, поэтому следующий view той же модели не получает disposed geometry.

Two-phase обновление: view, созданный до ответа реестра, остаётся процедурным; когда модель загрузилась, все существующие views этой башни заменяются на GLB на месте — entity, позиция, rotation и snapshot не меняются, поэтому момент появления модели не может сделать два replay визуально разными.

### Wails и Go

Wails — поздний desktop adapter: окно, fullscreen, settings, saves и упаковка web assets. Go не должен использоваться для высокочастотного gameplay channel. Dedicated server на Go появляется только после измерения Node.js или по решению владельца.

## 3D-ready rendering

- Первый renderer — Three.js WebGL2.
- Первая камера — OrthographicCamera.
- Мир — XZ plane с высотой по Y, даже когда визуальные объекты плоские.
- Grid — placement layer, а не система координат движения.
- Временные placeholder meshes заменяются GLB без изменения simulation contracts.
- PBR доводится IBL: `RoomEnvironment` + PMREM дают `scene.environment`. Проба — новый источник света, а сцена намеренно тёмная tactical read, поэтому её вклад ограничен `scene.environmentIntensity = 0.5`; lights, exposure и tone mapping не перенастраиваются.
- WebGPU и тяжёлые post-processing остаются последующими оптимизациями.

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
