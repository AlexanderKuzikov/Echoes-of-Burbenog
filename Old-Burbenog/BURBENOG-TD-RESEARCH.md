# Burbenog TD — исследовательский brief

**Дата сбора:** 2026-09-25
**Назначение:** исходный референс для оригинальной игры Echoes of Burbenog и будущего technical design/prototype.
**Границы:** документ описывает поведение и дизайн-принципы референса. Он не разрешает копировать Warcraft III/Burbenog assets, UI, map topology, silhouettes, аудио или другие защищённые материалы.

## 1. Уровень достоверности

Использовались обозначения:

- **[A]** — непосредственно извлечено из JASS, object data или метаданных карты.
- **[B]** — WTS, описание карты или changelog внутри карты.
- **[C]** — публичная страница, API или комментарий сообщества.
- **[U]** — требует runtime-проверки в Warcraft III или в воспроизведённой версии.

Числа, которые не удалось подтвердить статически, помечены как приблизительные или вынесены в раздел неизвестных. Версии карты нельзя смешивать: часть ранних инструкций и подсказок относится к другой ветке.

## 2. Идентификация игры

Burbenog TD — **Warcraft III: The Frozen Throne custom map**, написанная на JASS. Это не самостоятельная коммерческая игра и не проект Warcraft III: Reforged.

| Версия | Что это | Основное содержимое |
|---|---|---|
| **v2.32** | Финальная авторская версия Shvegait, 11.07.2005 | 10 governors, примерно 80 tower content, 40 основных волн; Hero/Hybrid governors удалены из активного выбора, но triggers и object data сохранены |
| **HIVE v2.33 Editor’s Version** | Редакторская загрузка Ralle, 04–08.11.2024 | Редакторская копия v2.32 с подтверждёнными внешними изменениями; не официальный v2.33 автора |
| **v4.0** | Отдельная авторская ветка Shvegait, JASS header 2006 | 12 governors, Hero/Hybrid governors восстановлены, bounty повышен |
| **v2.34e Legends** | Модификация Mad Mauler, изменения 2007–2009 | 15 governors, 120 towers, Shared Income, Blitz, Endless, Pro, Damage Test |
| **v2.42 Legends** | Поздняя загрузка Mad Mauler | Legends-контент с внедрённым JJ2197 cheat pack |
| **v2.43 Legends** | Поздний community fork | Изменены bounty, имена юнитов, leaderboard и random-governor; WTS частично заменён с Burbenog на Kerbenog |

HIVE v2.33 Editor’s Version — не чистый официальный релиз. В ответе Shvegait от 05.11.2024 указано, что его финальная авторская версия — v2.32; разрешение на редактирование и размещение изменённых версий не означает, что все изменения принадлежат автору оригинала.

Для чистого референса следует использовать:

```text
v2.32 author baseline
+ согласованные изменения v2.34e
```

HIVE v2.33 Editor’s Version и v2.33 Legends — разные ветки.

## 3. Формат карты и режим

### 3.1. Игроки и цель

- Поддерживаются 2 или 4 игрока.
- Игроки — союзные защитники одной общей базы.
- Пятый слот принадлежит нейтральному Attacker/Player 12.
- Все четыре игровых угла потенциально являются spawn-точками врагов.
- Цель — не допустить волны до центральной области.
- Жизни общие для всей команды, а не отдельные для каждого игрока.

### 3.2. Геометрия

- Размер карты: **96×96**.
- Игровая область: **84×84**.
- Четыре стартовых региона расположены по углам.
- Центральный регион имеет отдельный trigger потери жизни.
- В JASS создаются четыре массива маршрутов и отдельные массивы для siege-волн.
- У каждого siege-маршрута около 12 зон: внешние/внутренние участки и центральная зона.
- На карте присутствуют вода, возвышенности, cliff-участки и anti-stuck Outpost поражения.
- Fog modifier даёт игрокам видимость всей карты; карта воспринимается как общий командный лабиринт, а не как четыре изолированные линии.

### 3.3. Стартовые объекты

Каждый угол получает:

- Burbenog Outpost;
- Governor Chooser;
- стартовую позицию игрока.

В v2.32 и v2.34e при выборе governor’а создаются builder units. В v2.34e активно 15 governor’ов и 15 builder types.

## 4. Основной игровой цикл

Последовательность:

1. Инициализация карты.
2. Голосование за difficulty.
3. Подготовка в течение 30 секунд.
4. Создание волны.
5. Игроки строят, продают, передают и переключают башни.
6. Когда все четыре группы врагов уничтожены:
   - structures чинятся;
   - начисляется bounty за раунд;
   - выдаётся lumber каждый пятый раунд;
   - Gold Mine приносит доход;
   - запускается 20-секундная подготовка.
7. Последний уровень завершает карту.

В Easy v2.32 игра заканчивается после 40-го уровня. В Normal/Hard/Expert добавляется уровень 41.

### 4.1. Spawn и pathing

- Наземные юниты создаются группой в одной точке.
- Воздушные создаются поштучно в прямоугольнике spawn и получают случайные позиции.
- Все враги получают 3 секунды invulnerability в начале движения.
- Цвет юнита показывает направление атаки.
- Для невидимых юнитов отдельный trigger периодически возвращает их на маршрут.
- Для siege trigger выбирает доступные постройки и заставляет атакующих двигаться внутрь базы.

**Важная неопределённость:** код `New_Level` создаёт четыре группы врагов без проверки числа активных игроков. Поэтому поведение 2-player режима требует runtime-проверки: возможно, карта всё равно создаёт четыре волны, но игроки распределяют защиту по всем углам.

## 5. Сложность, жизни и завершение

| Difficulty | Lives | Финальный уровень v2.32 | Финальный уровень Legends |
|---|---:|---:|---:|
| Easy | 50 | 40 | 41, Damage Test |
| Normal | 25 | 41 | 42 |
| Hard | 1 | 41 | 42 |
| Pro | — | — | 10, 42 |
| Expert | 1 | 41 | 1, 42 |

В v2.32 сложность выбирается чатом: `easy`, `normal`, `hard`, `expert`. В Legends появляется dialog voting, включая Pro.

## 6. Экономика

### 6.1. Золото

Код инициализирует `bonus = 10`, затем перед каждой выплатой увеличивает его на 2. Поэтому фактическая последовательность выплат в реализации:

```text
12, 14, 16, ... за первый, второй, третий раунд
```

Если в дизайне ожидались выплаты `10, 12, 14...`, отличие требует отдельной проверки.

Источники золота:

- bounty за убитых врагов;
- бонус за завершение раунда;
- Gold Mine;
- переводы между игроками;
- Shared Income в Legends.

### 6.2. Gold Mine

Earth governor получает ultimate building:

```text
Gold Mine cost: 500 gold + 1 lumber
Income after round L: 2 * L gold
```

Внутренняя формула WTS:

```text
Net Profit = 2 * (sum of levels from purchase through 39) - 500
```

Gold Mine invulnerable и не является обычной атакуемой башней.

### 6.3. Lumber

- `+1 lumber` после каждого пятого завершённого раунда.
- Lumber используется для некоторых hybrid/technology/ultimate построек.
- В internal WTS v2.32 сказано, что дополнительные builders требуют lumber.
- В актуальном HIVE v2.33 есть пользовательский отчёт, что фактический старт карты даёт **20 lumber и 80 gold**, хотя JASS явно выставляет 30 gold. Это несоответствие не разрешено статически.

Для ремейка нельзя автоматически считать стартовые ресурсы равными `30 gold / 0 lumber`: конфигурацию нужно задать отдельно и проверить в игре.

### 6.4. Missed bounty

Если враг погибает без kill-кредита игрока:

```text
missedBounty += floor((level - 1) / 5) + 1
```

Для siege-уровней это значение добавляется дважды. В конце раунда missed bounty делится между активными игроками.

### 6.5. Продажа и передача

- Продажа возвращает 50% суммарной point value.
- Передача разрешена только полностью построенным и не повреждённым строениям.
- Governors, technology buildings, Hybrid base towers, Outposts и Transmuters нельзя продать или передать.
- Revert Hybrid towers в коде возвращает 75% стоимости; часть WTS-подсказок всё ещё говорит 90%, то есть tooltip устарел.
- В конце каждого раунда завершённые постройки полностью ремонтируются.

## 7. Governors и builders

### 7.1. Classic governors

| Governor | Основной элемент | Ultimate |
|---|---|---|
| Arthas | Human | Siege Tank |
| Jaina | Magic | Mind Ripper |
| Pyrus | Fire | Volcanic Fissure |
| Coldreaver | Ice | Cryogenics Lab |
| Thrall | Thunder | Power Plant |
| Arachne | Poison | Infection Intensifier |
| Tichondrius | Death | Enfeebler |
| Joranda | Holy | Guardian Angel |
| Furion | Earth | Gold Mine |
| Tyrande | Wind | Sky Dominator |

Каждый builder имеет примерно такую структуру:

```text
3 basic towers
1 technology building
2 advanced towers
2 mixed/high-tier towers
1 ultimate tower
```

Итого для 10 classic governors:

- 80 non-technology towers;
- 10 technology buildings;
- 90 buildable entries в active builder lists.

### 7.2. Legends governors

Добавлены:

| Governor | Элемент | Ultimate |
|---|---|---|
| Gazlowe | Goblin | Death Ray |
| Vol’jin | Voodoo | Voodoo Alter |
| Overmind | Zerg | Cerebrate |
| Rainer | Terran | Ghost |
| Tassadar | Protoss | Carrier |

У каждого — 8 towers и один technology building. В tooltips Rainer и Tassadar фокус прямо указан как `???`; это след незавершённого или неполного описания.

### 7.3. Classic tower roster

**Human:**

- Arrow Turret;
- Cannon Tower;
- SAM Battery;
- Ballista;
- Sheep Launcher;
- Poison Arrow Turret;
- Holy Hand Grenadier;
- Siege Tank.

**Magic:**

- Enchanted Arrow Turret;
- Stasis Tower;
- Sentry Tower;
- Magic Dampener;
- Phase Disruptor;
- Blizzard Caster;
- Infernal Caster;
- Mind Ripper.

**Fire:**

- Flaming Arrow Turret;
- Firebomb Tower;
- Flamethrower;
- Firestorm Caster;
- Dragon Roost;
- Temple of the Faerie Flame;
- Immolator;
- Volcanic Fissure.

**Ice:**

- Frost Arrow Turret;
- Chilling Tower;
- Ice Launcher;
- Squall Evoker;
- Nova Shocker;
- Seal Cannon;
- Permafrost Maker;
- Cryogenics Lab.

**Thunder:**

- Energy Pulse Emitter;
- Thunder Cloud Creator;
- Lightning Rod;
- Static Field Generator;
- Stormspire;
- Purging Tower;
- Heaven’s Wrath;
- Power Plant.

**Poison:**

- Venom Burrow;
- Corrupted Well;
- Assassin’s Den;
- Disease Wagon;
- Sludge Producer;
- Epidemic Catalyst;
- Acid Spitter;
- Infection Intensifier.

**Death:**

- Ziggurat;
- Unholy Exuder;
- Black Caster;
- Hexing Tower;
- Temple of Death;
- Nerubian Ziggurat;
- Magnetic Field Disruptor;
- Enfeebler.

**Holy:**

- Light Beacon;
- Purifier;
- Crystal Shrine;
- Altar of Heavens;
- Aura Generator;
- Celestial Winds;
- Book of the Gods;
- Guardian Angel.

**Earth:**

- Axe Tower;
- Rock Hurler;
- Quake Tower;
- Giant Cactus;
- Ancient of Lore;
- Giant Fungus;
- Charge Grounder;
- Gold Mine.

**Wind:**

- Needler;
- Blade Guardian;
- Gale Blaster;
- Aerial Shackler;
- Ancient of Wind;
- Cloud Cooler;
- Tempestuous Detonator;
- Sky Dominator.

### 7.4. Legends additions

**Goblin:**

- Goblin Potato Peeler;
- Machinegun Nest;
- Molotov Cocktail Thrower;
- Plasma Grenadier;
- Air Traffic Control Tower;
- Chicken Launcher;
- Tesla Coil;
- Death Ray.

**Voodoo:**

- Head Hunter;
- Toxic Dart Shooter;
- Berserker;
- Spirit Ward;
- Rain Dancer;
- Poison Spear Thrower;
- Bat Rider Nest;
- Voodoo Alter.

**Zerg:**

- Zergling;
- Hydralisk;
- Defiler;
- Spore Colony;
- Sunken Colony;
- Infested Terran Bunker;
- Scourge Nest;
- Cerebrate.

**Terran:**

- Marine;
- Goliath;
- Missile Turret;
- Marine Bunker;
- Arclight Siege Tank;
- Firebat Bunker;
- Dark Marine;
- Ghost.

**Protoss:**

- Templar;
- Dragoon;
- Archon;
- Dark Templar;
- Photon Cannon;
- Dark Archon;
- High Templar;
- Carrier.

Итого в Legends:

- 120 non-technology towers;
- 15 technology buildings;
- 135 active builder entries.

### 7.5. Техническая оговорка о массиве башен

Массив `udg_Towers` нельзя считать полным списком контента. В v2.32 он содержит 70 обычных towers и 10 technology buildings и в основном используется для upgrade/revert-логики. Ultimate towers доступны через builder `ubui`, но не все входят в этот массив.

## 8. Волны и враги

### 8.1. Fixed set Easy/Normal/Hard

`n` — количество юнитов на один угол. На карте одновременно создаются четыре такие группы.

| Level | Enemy | n/corner | Tags |
|---:|---|---:|---|
| 1 | Angry Puppies | 20 | Heavy |
| 2 | Footmen | 20 | Heavy |
| 3 | Skeleton Archers | 20 | Medium, Undead, Summoned |
| 4 | Ogre Warriors | 15 | Light |
| 5 | Murloc Tiderunners | 20 | Heavy |
| 6 | Harpy Scouts | 15 | Light, Air |
| 7 | Kobolds | 20 | Heavy |
| 8 | Spirit Pigs | 20 | Heavy, Summoned |
| 9 | Gnoll Brutes | 20 | Light |
| 10 | Mud Golems | 20 | Medium, Spell Immune |
| 11 | Blue Dragon Whelps | 20 | Light, Air |
| 12 | Huntresses | 20 | Heavy |
| 13 | Crypt Fiends | 15 | Medium, Undead |
| 14 | Red Dragon Whelps | 20 | Light, Air |
| 15 | Goblin Shredders | 15 | Fortified, Mechanical |
| 16 | Giant Rats | 20 | Heavy |
| 17 | Ghosts | 20 | Invisible, Medium, Undead |
| 18 | Gargoyles | 15 | Heavy, Air, Undead |
| 19 | Raiders | 15 | Siege, Light |
| 20 | Water Elementals | 20 | Heavy, Summoned |
| 21 | Bronze Dragon Whelps | 20 | Light, Air |
| 22 | Frost Revenants | 20 | Heavy, Undead |
| 23 | Shaman | 15 | Medium, Bloodlust |
| 24 | Wyverns | 15 | Air |
| 25 | Shadow Wolves | 20 | Invisible, Heavy, Summoned |
| 26 | Ice Troll High Priests | 20 | Medium, Frost Armor |
| 27 | Battle Golems | 15 | Siege, Spell Immune |
| 28 | Druids of the Claw | 15 | Light |
| 29 | Goblin Zeppelins | 15 | Air, Mechanical |
| 30 | Black Shadows | 20 | Invisible, Medium, Undead |
| 31 | Granite Golems | 15 | Fortified, Spell Immune |
| 32 | Rogue Wizards | 20 | Medium, Frost Armor |
| 33 | Dragon Hawks | 15 | Heavy, Air |
| 34 | Chaos Raiders | 15 | Siege |
| 35 | Satyr Hellcallers | 20 | Invisible, Heavy, Anti-Magic Shell |
| 36 | Frost Wyrms | 15 | Light, Air, Undead |
| 37 | Steam Tanks | 15 | Siege, Fortified, Mechanical |
| 38 | Doom Guards | 20 | Heavy, Summoned |
| 39 | Black Dragons | 15 | Light, Air, Spell Immune |
| 40 | Unknown | 10 | Heavy, Bloodlust |

Итого:

```text
705 units per corner
2820 units for all four corners
```

### 8.2. Expert/Pro randomization

В Expert и Legends Pro на каждом уровне выбирается один из трёх вариантов:

- default set: 20%;
- Set B: 40%;
- Set C: 40%.

Set B и Set C содержат полностью другие 40 типов врагов, но сохраняют ту же структуру count/armor/air/special. В WTS отдельно перечислены вероятности:

- magic immunity;
- anti-magic shell;
- bloodlust;
- frost armor;
- air;
- mechanical;
- summoned;
- undead;
- invisible;
- siege.

### 8.3. Siege

В v2.32 siege-уровни:

```text
19, 27, 34, 37, 41
```

В Legends 41-й уровень превращён в Damage Test, а финальным challenge становится 42-й Wrath of the Testers.

Особенности siege:

- атакуют только строения;
- выбирают доступную постройку на каждом участке пути;
- если построек на участке нет, продолжают двигаться к центру;
- становятся уязвимыми после выхода из spawn region;
- дают двойной bounty;
- сильнее всего требуют Holy/defensive/anti-slow построек;
- некоторые cliff positions становятся недоступны атакующим из-за pathing.

### 8.4. Скрытые типы и контрпики

- Invisible: 17, 25, 30, 35.
- Spell Immune: 10, 27, 31, 35, 39.
- Summoned: 3, 8, 20, 25, 38.
- Mechanical: 15, 29, 37.
- Undead: 3, 13, 17, 18, 22, 30, 36.
- Anti-magic shell: 35.
- Archmage может временно снимать spell immunity/anti-magic shell.
- Charge Grounder уничтожает Mechanical units.
- Temple of Death и Epidemic Catalyst не действуют на Mechanical.
- Ice slow не должен считаться полноценным контролем spell-immune целей.

## 9. Способности башен

Основные архетипы:

| Архетип | Примеры |
|---|---|
| Базовый DPS | Arrow Turret, Needler, Axe Tower |
| Anti-air | SAM Battery, Gale Blaster, Cloud Cooler, Sky Dominator |
| Splash | Firebomb Tower, Flamethrower, Sheep Launcher, Stormspire |
| Slow/chill | Frost Arrow, Chilling, Ice Launcher, Permafrost Maker |
| Stun/disable | Stasis Tower, Aerial Shackler, Cyclone Caster |
| Dispel/anti-buff | Purifier, Magic Dampener, Purging Tower, Holy Hand Grenadier |
| Anti-type | Charge Grounder, Guardian Angel, Temple of Faerie Flame |
| Current-health damage | Phase Disruptor |
| Execute | Temple of Death |
| Aura/support | Aura Generator, Giant Cactus, Unholy Exuder, Morale Booster |
| Экономика | Gold Mine |
| Random caster | Book of the Gods |
| Summoning | Dragon Roost, Crystal Shrine, Carrier |

Ключевые формулы:

```text
Temple of Death:
kill chance = (45 - current level)%

Phase Disruptor:
level <= 20: remove 50% current HP
level > 20: remove (90 - 2 * level)% current HP
```

Способности не являются декоративными: они закрывают конкретные классы волн — air, invisible, spell immune, mechanical, siege, summoned, undead.

## 10. Heroes, Hybrid и дополнительные системы

### 10.1. Classic Heroes

Десять героев:

- Sniper;
- Archmage;
- Warlock;
- Winter Witch;
- Samurai of Storms;
- Rotting Flesh;
- Death Knight;
- Priest of Quel’Thalas;
- Keeper of the Grove;
- Priestess of the Sky.

У героев есть пять тематических умений, рассчитанных на:

- перехват leaks;
- контроль толпы;
- снятие баффов;
- экономику/ману;
- защиту базы;
- добивание опасных целей.

Дополнительные элементы:

- Technology buildings могут тренировать героев.
- Altar of Nature/Energy/Destruction восстанавливают героев.
- Paladins’ Guild продаёт items.
- Fountain of Mana восстанавливает ману.
- Morale Booster усиливает героев.
- Gyrocopter, Storm Vulture, Owl Scout, Shades и другие units используются как True Sight/scout/support.

### 10.2. Hybrid

Hybrid governor:

- строит башни разных элементов;
- требует больше золота;
- не даёт обычных Hero/Ultimate buildings;
- использует Hybrid Base towers;
- Transmuter каждые 40 секунд случайно превращается в одну из 39 advanced towers;
- ultimate towers не входят в Transmuter pool.

Hybrid triggers сохранены даже в v2.32, но governor удалён из активного списка. В v4.0 Hybrid и Hero governors снова включены.

## 11. Legends-specific systems

### 11.1. Shared Income

В v2.34:

- 50% bounty остаётся killer’у;
- 50% попадает в общий pot;
- pot делится между активными игроками сразу после kill, а не в конце раунда.

Для четырёх активных игроков это даёт:

```text
62.5% собственного bounty
12.5% bounty каждого другого игрока
```

### 11.2. Blitz

Удваивает количество spawn’ов на обычных уровнях. В WTS прямо указано, что siege rounds тоже included.

### 11.3. Endless Spawn

- Нет 20-секундной паузы между уровнями.
- Каждый round имеет динамическую длину.
- Сначала спавнится половина wave.
- Затем юниты продолжают появляться парами.
- Интервалы и длительность растут с уровнем.
- Старые юниты могут пережить смену типа wave.
- Siege rounds отключены.

### 11.4. Damage Test

В Legends:

- Easy заканчивает игру на 41-м уровне.
- Normal/Hard/Pro/Expert проходят Damage Test на 41-м уровне.
- На 42-м уровне идёт Wrath of the Testers.
- Damage Test измеряет damage по каждому углу и выводит отдельный leaderboard.

## 12. Версии, которые нельзя смешивать

### 12.1. HIVE v2.33 Editor’s Version

В archive есть подтверждённые внешние изменения:

- `Crystal Shrine` переименован в `Light Crasher`;
- его cost/stats изменены;
- SAM Battery стоит 35 вместо оригинальных 60;
- Cannon Tower, Flamethrower, Thunder Cloud Creator и Lightning Rod также отличаются от cross-version baseline.

Поэтому для чистого дизайна нужно использовать v2.32 author baseline и согласованные изменения v2.34e, а не без проверки использовать HIVE v2.33 archive.

### 12.2. v4.0 High Bounty

v4.0 возвращает Hybrid/Hero и повышает bounty. В object data многие значения `ubba` увеличены вдвое. Это отдельная балансная ветка.

### 12.3. v2.42

В `war3map.j` обнаружены:

```text
activator = "wc3edit"
NewGenCommandHandler
No_CD
Fast_Upgrading
```

Есть команды изменения gold/lumber/food, teleport, fast building, no cooldown, kick, owner manipulation и другие. Это нельзя использовать как чистую референсную версию.

### 12.4. v2.43

v2.43 не является чистым продолжением Legends:

- около 63 unit object records отличаются от v2.34e;
- 42 unit names заменены;
- 20 bounty values изменены;
- `random` выдаёт дополнительные 10 gold;
- leaderboard kill count увеличивается на 7 вместо 1;
- Burbenog заменён на Kerbenog в части WTS;
- нет полноценного changelog v2.43.

Это выглядит как отдельная high-bounty/community fork, но официального подтверждения нет.

## 13. Рекомендуемая архитектура ремейка

### 13.1. Data-driven модель

Не переносить hundreds of JASS-обработчиков напрямую. Разделить данные:

```text
TowerDefinition
GovernorDefinition
WaveDefinition
DifficultyDefinition
GameModeDefinition
AbilityDefinition
HeroDefinition
ItemDefinition
```

Пример `TowerDefinition`:

```text
id
element
goldCost
lumberCost
buildTime
baseDamage
attackInterval
range
damageType
targets
abilities
upgradeLine
requirements
```

### 13.2. Runtime

Минимально:

- authoritative server;
- клиент отправляет только intent: build, sell, cede, toggle ability;
- сервер валидирует стоимость, cooldown, ownership и placement;
- seedable RNG для random waves и random spells;
- replay-compatible event log;
- path graph/flow field для волн;
- отдельный siege controller;
- event-driven status effects вместо polling every frame.

### 13.3. Fidelity tiers

**MVP:**

- 2/4 players;
- 4 corners;
- 10 governors;
- 40 waves;
- global lives;
- 10–20 tower types;
- slow, stun, splash, anti-air;
- Gold Mine;
- invisible и siege waves.

**Full original-style:**

- 15 governors;
- 120 towers;
- 10 classic heroes;
- Hybrid governor;
- Shared Income;
- Blitz;
- Endless;
- Damage Test;
- hero buildings и items.

### 13.4. Обязательные тесты

- economy invariants;
- 2-player behavior;
- all four corner paths;
- invisible-unit path recovery;
- siege target selection;
- shared bounty;
- player leave/disconnect;
- replay desync;
- tower ability stacking;
- performance with 4×40×20 units;
- server-side anti-cheat.

## 14. Что осталось неопределённым

1. Реальные starting lumber/gold в HIVE v2.33 runtime.
2. Нужно ли запускать все четыре spawn corners в 2-player режиме.
3. Точные effective stats ряда custom abilities, где часть полей наследуется от базового Warcraft III объекта.
4. Полный provenance v2.43.
5. Точное поведение скрытых governors Legends (`-xenomorph`, `-hominid`, `-psionic`).
6. Runtime-баланс HIVE v2.33 после внешних edits.
7. Лицензия на Warcraft III assets: разрешение автора на edits не означает разрешение использовать Blizzard art/audio в коммерческом ремейке.

## 15. Практический порядок воспроизведения

1. Зафиксировать baseline: v2.32 как основной референс, отдельные compatibility notes для Legends.
2. Описать чистую модель состояния: match, players, team lives, build pads, towers, enemies, waves, economy, RNG seed.
3. Реализовать deterministic fixed tick без DOM/Three.js/network transport.
4. Сначала воспроизвести один маршрут и один воздушный маршрут в изолированной сцене.
5. Добавить wave controller, spawn scheduler, path graph, damage/status pipeline и lives loss.
6. Проверить invisible recovery, spell immunity, anti-magic shell, mechanical interactions и siege targeting.
7. Добавить общую экономику, bounty, missed bounty, Gold Mine, sell/transfer и round-end repair.
8. Ввести одного governor’а и полный upgrade line, затем проверить стоимость/прибыль на фиксированных сценариях.
9. Расширить governors и tower roster только после стабилизации базовой simulation.
10. Добавить replay/event log, затем presentation/client и multiplayer seams.
11. Проверять каждое gameplay-изменение pure test/scenario, затем E2E и screenshots.

## 16. Источники

Основные публичные источники, найденные при исследовании:

- https://www.hiveworkshop.com/threads/burbenog-td-v2-33-editors-version.356467/
- https://www.hiveworkshop.com/threads/i-want-edit-burbenog-td-v2-34e.312890/
- https://wc3maps.com/map/263/Burbenog_TD_2.34E
- https://wc3maps.com/api/map/263
- https://wc3maps.com/map/652/Burbenog_TD_v4.0
- https://wc3maps.com/api/map/652
- https://wc3maps.com/map/251093/Burbenog_TD_v2.42_Legends
- https://wc3maps.com/api/map/251093
- https://wc3maps.com/map/414927/BurbenogTDv2.43Legends
- https://wc3maps.com/api/map/414927

Локальные артефакты, использованные для статического анализа:

```text
C:\Users\alexa\AppData\Local\Temp\opencode\burbenog-v233-editor\war3map.j
C:\Users\alexa\AppData\Local\Temp\opencode\burbenog-v233-editor\war3map.wts
C:\Users\alexa\AppData\Local\Temp\opencode\v233-units-objects.json
C:\Users\alexa\AppData\Local\Temp\opencode\burbenog-v234e\File00000003.xxx
C:\Users\alexa\AppData\Local\Temp\opencode\burbenog-v234e\File00000002.xxx
C:\Users\alexa\AppData\Local\Temp\opencode\v234e-units-objects.json
C:\Users\alexa\AppData\Local\Temp\opencode\burbenog-v40\war3map.j
C:\Users\alexa\AppData\Local\Temp\opencode\burbenog-v242\war3map.j
C:\Users\alexa\AppData\Local\Temp\opencode\burbenog-v243\Scripts\war3map.j
C:\Users\alexa\AppData\Local\Temp\opencode\catalog-v233.jsonl
```

SHA-1 скачанных архивов:

```text
v2.33 Editor: B484B0AD92650923EF6083F850502C75973E6619
v4.0:        0CB43A154EA8C7157987BC979756B3C4DE6E1127
v2.42:       C1B6A129A7584130D53E111AE1CAB05B449744F3
v2.43:       BB347E92458124ED5D496B1A6F69922AD3FE30ED
```

## 17. Итог для Echoes of Burbenog

Burbenog TD полезен как референс не из-за конкретных Warcraft III assets, а из-за системных принципов: несколько spawn-маршрутов, общая жизнь команды, governor-specific строительство, большой набор специализированных контрпиков, siege-отдельная логика, bounty-based economy, repair/sell/transfer и режимы, меняющие давление волн. Для оригинальной игры эти принципы следует переосмыслить в собственной карте, собственной visual language, solo-first simulation и data-driven content pipeline.
