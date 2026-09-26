<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-7.0.2-3178C6?logo=typescript&logoColor=white">
  <img alt="Three.js" src="https://img.shields.io/badge/Three.js-0.186.1-000000?logo=three.js&logoColor=white">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-8.3.1-646CFF?logo=vite&logoColor=white">
  <img alt="Playwright" src="https://img.shields.io/badge/Playwright-1.63.0-2EAD33?logo=playwright&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/License-TBD-lightgrey">
</p>

<h1 align="center">Echoes of Burbenog</h1>
<p align="center">LLM-first 3D Tower Defense с постепенным развитием</p>

## Описание

Игра вдохновлена атмосферой и масштабом Warcraft III Tower Defense, особенно референсом Burbenog. Проект строится с нуля: сначала создаётся компактный 3D-ready вертикальный срез, затем расширяются gameplay, графика, сетевые режимы и desktop-сборка.

Ключевая цель разработки — сделать цикл работы максимально удобным для LLM: короткий запуск, детерминированные сценарии, headless-проверки, автоматизированные screenshots и простые границы модулей.

- **3D-ready прототип** — сцена сразу использует XZ-координаты, даже если первый визуальный прототип плоский.
- **LLM-friendly tooling** — Vite, Playwright, structured state и deterministic scenarios.
- **Модульная архитектура** — gameplay, presentation, content и networking развиваются независимо.
- **Solo-first scope** — текущая разработка сфокусирована на одиночной игре; multiplayer остаётся совместимым будущим направлением.
- **Оригинальный visual identity** — собственные модели, арт, палитра и HUD; Burbenog/Warcraft III служат только референсами принципов, а не образцом для копирования.

## Быстрый старт

Репозиторий содержит первый вертикальный срез: 3D-ready сцена, schematic build pads, запуск волны, combat, pause/resume, replay по seed и HUD — всё поверх детерминированного pure core.

```bash
git clone https://github.com/AlexanderKuzikov/Echoes-of-Burbenog.git
cd Echoes-of-Burbenog
npm install
npm run dev
```

Отдельная проверка:

```bash
npx playwright install chromium
npm test
```

## Документация

- [`AGENTS.md`](AGENTS.md) — правила работы для AI-агентов.
- [`docs/CONTEXT.md`](docs/CONTEXT.md) — состояние проекта и открытые вопросы.
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — append-only архитектурные решения.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — целевая архитектура.
- [`docs/PLAN.md`](docs/PLAN.md) — поэтапный план разработки.

## Стек

| Слой | Технология | Статус |
|------|------------|--------|
| Client | TypeScript + Three.js | planned |
| Development | Vite | planned |
| Simulation | TypeScript core | verified |
| QA | Playwright + core check | verified |
| Server | Node.js, затем при необходимости Go | phased |
| Desktop | Wails + Go | deferred |
| Assets | glTF/GLB | planned |

## Статус

**v0.1.0-alpha** — browser bootstrap, pure deterministic core, snapshot projection, placement, combat presentation, pause/resume и seed replay реализованы и покрыты E2E; срез проходит полный игровой цикл в браузере. Далее — фаза 4: asset pipeline и 3D polish.

## Лицензия

Лицензия пока не выбрана. До решения нельзя копировать ассеты, модели, карты или другие материалы из Warcraft III и Burbenog; проект использует их только как дизайн-референс.
