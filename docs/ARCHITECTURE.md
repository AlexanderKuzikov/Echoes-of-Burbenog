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

Snapshot restore и command-log replay сознательно отложены до решения перед session layer.

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

Asset contract должен задавать:

- единицы и масштаб;
- root pivot и forward axis;
- naming;
- ожидаемые animation states;
- допустимые material/texture requirements;
- минимальные performance budgets.

### Wails и Go

Wails — поздний desktop adapter: окно, fullscreen, settings, saves и упаковка web assets. Go не должен использоваться для высокочастотного gameplay channel. Dedicated server на Go появляется только после измерения Node.js или по решению владельца.

## 3D-ready rendering

- Первый renderer — Three.js WebGL2.
- Первая камера — OrthographicCamera.
- Мир — XZ plane с высотой по Y, даже когда визуальные объекты плоские.
- Grid — placement layer, а не система координат движения.
- Временные placeholder meshes заменяются GLB без изменения simulation contracts.
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
