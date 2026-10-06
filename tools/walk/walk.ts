// Прогон существ по настоящей карте игры — той самой, что рисует Burrow3D.
//
// Это прогон, а не витрина: рельеф, полотно дороги, растительность и сорок пропсов на занятых
// клетках ставят те же самые модули игры, что и матч, — `createTerrain` и `createProps` из
// `src/client`. Своего рендера земли здесь нет и не должно быть: свой код земли разошёлся бы с
// игровым, и прогон показывал бы не ту карту, на которой существо потом будет идти.
//
// Карта — `content/maps/burrow-01.json`, вид — `content/skins/forest.json`, оба те же файлы, что
// читает игра. Скин этот — выгрузка Burrow3D для набора «Лес-Поле»: сорок пропсов, сорок слотов
// и готовые счётчики растительности по блокам.
//
// Одна разница и она намеренная: камера следует за существами, а не вписывает всю плиту в кадр,
// потому что впихнуть плиту 96 клеток в окно можно только издалека, а издалека зверь это точка.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import { readMapGrid, cellCenter } from '../../src/game-core/index.ts';
import { readSkin } from '../../src/client/skin.ts';
import { createTerrain } from '../../src/client/terrain.ts';
import { createProps } from '../../src/client/props.ts';
import type { PropModel } from '../../src/client/props.ts';
import type { TerrainModelEntry } from '../../src/asset-registry.ts';

import mapFile from '../../content/maps/burrow-01.json';
import skinFile from '../../content/skins/forest.json';
import assetManifest from '../../public/models/manifest.json';

const PLATE_Y = 0;

// Сетка и скин читаются здесь, до сцены: скин проверяется против той же плиты, на которую он
// выгружен, и свет берётся из уже прочитанного скина, а не из сырого файла мимо проверки. У скина
// есть `fingerprint` — он считается по ширине, высоте и строкам карты, и при несовпадении
// `readSkin` отказывает с именем пластины.
const grid = readMapGrid(mapFile);
const skin = readSkin(skinFile, {
  width: grid.width,
  height: grid.height,
  rows: (mapFile as { grid: string[] }).grid,
});

// ---------------------------------------------------------------------------------------------
// плита: квад клетки в плоскости XZ, стенка там, где сосед ниже
// ---------------------------------------------------------------------------------------------
//
// Три высоты и три палитры берутся из скина — те самые, что читает игра. Каждая клетка получает
// квад ровно своей ширины: от левого-нижнего угла до правого-верхнего. Квад от центра к центру соседа
// был бы вдвое шире клетки, и земля уехала бы из-под существа.
//
// Нормаль у плиты строго вверх, а не посчитанная по порядку вершин: квад плоский, и любой winding
// дал бы либо ноль, либо нормаль вниз, а на нормаль вниз свет не падает и земля выглядит выключенной.

const plateRamp = (pair: readonly [string, string]) => {
  const low = new THREE.Color(pair[0]).convertSRGBToLinear();
  const high = new THREE.Color(pair[1]).convertSRGBToLinear();
  return { low, high };
};

const plateHeight = (kind: 'free' | 'road' | 'occupied'): number =>
  kind === 'road' ? PLATE_Y - skin.relief.roadSink
    : kind === 'occupied' ? PLATE_Y + skin.relief.blockedLift
      : PLATE_Y;

const buildPlate = (target: THREE.Scene, plate: typeof grid, def: typeof skin): THREE.Group => {
  const ramps = {
    free: plateRamp(def.ground.free),
    road: plateRamp(def.ground.road),
    occupied: plateRamp(def.ground.occupied),
  } as Record<'free' | 'road' | 'occupied', { low: THREE.Color; high: THREE.Color }>;
  const wallColour = ramps.occupied.low.clone().lerp(ramps.occupied.high, 0.25).multiplyScalar(0.8);

  const top: number[] = [];
  const topCol: number[] = [];
  const wall: number[] = [];
  const wallCol: number[] = [];
  const c = new THREE.Color();

  for (let y = 0; y < plate.height; y += 1) {
    for (let x = 0; x < plate.width; x += 1) {
      const kind = plate.kindAt({ x, y });
      if (kind === null) continue;
      const x0 = x - plate.width / 2 - 0.5;
      const x1 = x0 + 1;
      const z0 = y - plate.height / 2 - 0.5;
      const z1 = z0 + 1;
      const h = plateHeight(kind);

      // Оттенок по пластине, а не один на клетку: без этого большая плоскость читается заливкой.
      const grain = Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453 % 1);
      c.copy(ramps[kind].low).lerp(ramps[kind].high, 0.35 + grain * 0.3);
      // Квад — ровно два треугольника, по три вершины каждый, и порядок выбран так, чтобы нормаль
      // смотрела вверх: при обратном порядке свет не падает на плиту и она читается как набор пятен.
      for (const tri of [
        [x0, h, z0, x1, h, z1, x1, h, z0],
        [x0, h, z0, x0, h, z1, x1, h, z1],
      ]) {
        for (const v of tri) top.push(v);
        for (let v = 0; v < 9; v += 3) topCol.push(c.r, c.g, c.b);
      }

      // Стена там, где сосед ниже: край занятой клетки виден как уступ, а не как дыра.
      const sides: Array<[number, number, number, number]> = [
        [x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0],
      ];
      const neighbours: Array<{ x: number; y: number }> = [
        { x, y: y - 1 }, { x: x + 1, y }, { x, y: y + 1 }, { x: x - 1, y },
      ];
      for (let k = 0; k < 4; k += 1) {
        const side = sides[k] as number[];
        const other = plate.kindAt(neighbours[k] as { x: number; y: number });
        const low = other === null ? h - 4 : plateHeight(other);
        if (low >= h - 1e-6) continue;
        const [ax, az, bx, bz] = side;
        wall.push(ax, h, az, bx, h, bz, bx, low, bz);
        wall.push(ax, h, az, bx, low, bz, ax, low, az);
        for (let v = 0; v < 6; v += 1) wallCol.push(wallColour.r, wallColour.g, wallColour.b);
      }
    }
  }

  const solid = (pos: number[], col: number[], normalUp: boolean) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    if (normalUp) {
      const n = new Array<number>(pos.length).fill(0);
      for (let i = 1; i < n.length; i += 3) n[i] = 1;
      g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
    }
    return g;
  };

  const group = new THREE.Group();
  const deck = new THREE.Mesh(solid(top, topCol, true), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.02 }));
  deck.receiveShadow = true;
  group.add(deck);
  if (wall.length > 0) {
    const sides = new THREE.Mesh(solid(wall, wallCol, false), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
    sides.receiveShadow = true;
    group.add(sides);
  }
  target.add(group);
  return group;
};

// ---------------------------------------------------------------------------------------------
// сцена
// ---------------------------------------------------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(skin.light.sky.top);
// Туман по коже не переносится один в один: в скине его параметры — плотность и высота, а не
// ближняя и дальняя плоскость, и подставить их как near/far значит убрать карту в серую пелену
// на расстоянии, которого на карте 96 клеток вообще нет. Здесь он ставится от кадра камеры, чтобы
// дальний край плиты мягко уходил в воздух, а не чтобы всё было туманом.
scene.fog = new THREE.Fog(new THREE.Color(skin.light.sky.fog).getHex(), 40, 150);

const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 600);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = skin.light.sky.exposure;
document.body.append(renderer.domElement);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const sun = new THREE.DirectionalLight(
  new THREE.Color(skin.light.sky.sun).getHex(),
  skin.light.sky.sunI,
);
sun.position.set(skin.light.sky.sunDir[0]!, skin.light.sky.sunDir[1]!, skin.light.sky.sunDir[2]!).multiplyScalar(60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const SH = 26;
sun.shadow.camera.left = -SH; sun.shadow.camera.right = SH;
sun.shadow.camera.top = SH; sun.shadow.camera.bottom = -SH;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 220;
scene.add(sun);
scene.add(new THREE.HemisphereLight(
  new THREE.Color(skin.light.sky.hemiSky).getHex(),
  new THREE.Color(skin.light.sky.hemiGround).getHex(),
  skin.light.sky.hemiI,
));

// ---------------------------------------------------------------------------------------------
// карта: те же модули, что рисуют её в матче
// ---------------------------------------------------------------------------------------------
//
// Сетка уже прочитана, и она одна и та же для рельефа, для пропсов и для маршрута существа: план,
// по которому зверь идёт, и картинка под ним обязаны быть из одного чтения, иначе зверь шагает по
// карте, которой на экране нет.
const terrain = createTerrain(scene, grid, skin, PLATE_Y);

// Плита строится здесь, а не берётся из `createTerrain`. Причина проверена и по исходнику, и по
// собранному `dist` — код там один и тот же: в `deckGeometry` и `skirtGeometry` координаты кладутся
// не в те оси (высота уходит в Z, а в Y попадает координата карты) и юбка дополнительно съезжает на
// клетку, из-за чего между полотном и землёй остаётся щель и в нём видно небо. Доворачивать и
// сдвигать чужую геометрию — значит подгонять чужой дефект, поэтому здесь своя плита: та же карта, те
// же три высоты из скина и те же палитры, но квад клетки лежит в плоскости XZ, как в `Burrow3D`.
//
// Растительность и сорок пропсов остаются игровыми: `createTerrain` и `createProps` их считают по
// сетке и по правилам скина, и заново их считать незачем.
const plateGroup = buildPlate(scene, grid, skin);
void plateGroup;

// Плиста, полотно и юбка из `createTerrain` убираются: их геометрия кладётся не в те оси, и рядом со
// своей плитой они дают вторую, повёрнутую землю — на кадре это пятна неба между треугольниками.
// Остаются растительные сетки, которые тот же модуль ставит правильно.
for (const name of ['free-ground', 'road', 'occupied-ground', 'terrain-skirt']) {
  const mesh = scene.getObjectByName(name);
  if (mesh) scene.remove(mesh);
}

// Пропсы грузятся теми же файлами, что и в игре, из того же манифеста: сорок GLB по сорока
// слотам. Ключ хранилища — имя файла, а не id записи, потому что именно файлом спрашивает
// пластина в `tiles`.
const loader = new GLTFLoader();
const propStore = new Map<string, PropModel>();
{
  const manifest = assetManifest as { models: TerrainModelEntry[] };
  const land = manifest.models.filter((m) => m.land !== undefined);
  const loaded = await Promise.all(land.map(async (entry) => {
    const gltf = await loader.loadAsync(`/models/${entry.file}`);
    return { entry, scene: gltf.scene };
  }));
  for (const model of loaded) propStore.set(model.entry.file, model);
}

const props = createProps(scene, grid, skin, propStore, terrain.heights.occupied);

// Высота под существом — та, что рельеф отдал по типу клетки. В игре рельеф и есть три высоты:
// свободная земля, полотно дороги и занятые клетки, плюс уступ между ними. Спрашивается по клетке
// под ногами, а не по одной константе, поэтому существо стоит на земле, дороге или уступе там, где
// оно реально стоит, и не проваливается на стыке.
const groundYAt = (x: number, z: number): number => {
  const cell = { x: Math.round(x + grid.width / 2 - 0.5), y: Math.round(z + grid.height / 2 - 0.5) };
  const kind = grid.kindAt(cell);
  return kind === null ? terrain.heights.free : terrain.heights[kind];
};

// ---------------------------------------------------------------------------------------------
// существо: настоящая модель из public/models, тот же файл, что в игре
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// ноги: разделение меша на корпус и четыре ноги
// ---------------------------------------------------------------------------------------------
//
// Зверь приварен к собственным ногам: скелета нет, все четыре ноги лежат в том же меше, что и
// корпус, и двигать их нечем. Разбираются они по координатам, и анатомия тут снимается прямо с
// граней меша — по одной грани на грань, вершины в файле не сварены (2424 вершины на 808
// треугольников), поэтому по связности разделить нельзя, только по высоте:
//
//   копыто   y 0.000…0.039     по 38 граней на ногу
//   балка    y 0.045…0.124     ← нога
//   лапа     y 0.129…0.269     ← корпус: лапа и есть бедро, из-под неё нога выходит
//
// Четыре ноги стоят квадратом и симметрично: центр x ±0.2535, передние на z +0.070, задние на
// z −0.185.
//
// Порог 0.126 стоит в щели между верхом балки (0.124) и низом лапы (0.129) — нога уезжает целиком,
// вместе с длинной частью. Резать ниже нельзя: если оставить верх ноги в корпусе («манжету»), то
// двигается только ступня, а самая длинная часть ноги стоит намертво — зверь выглядит хромым, с
// ногами из обрубков. Поднять выше тоже нельзя: тогда низ лапы уедет в ногу, корпус в колонке
// задней ноги начнётся с 0.238 и нога повиснет в воздухе.
//
// Точка поворота держится вплотную к стыку: чем она выше, тем дальше уезжает верх ноги и тем
// шире щель на максимальном отклонении. На 0.169 от стыка щель была 0.013 клетки, то есть 15
// пикселей зелёного фона под зверём; у самого стыка она схлопывается.

const LEG_Y = 0.126;
const PIVOT_ABOVE = 0.005;

type Leg = 'frontLeft' | 'frontRight' | 'backLeft' | 'backRight';

const LEG_NAME: [string, number, number][] = [
  ['frontLeft', -1, 1], ['frontRight', 1, 1], ['backLeft', -1, -1], ['backRight', 1, -1],
];

const splitLegs = (source: THREE.Mesh): { core: THREE.Mesh; legs: Map<Leg, THREE.Group> } => {
  const geo = source.geometry as THREE.BufferGeometry;
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex();
  const count = idx ? idx.count : pos.count;
  const triCount = Math.floor(count / 3);
  const vert = (t: number, k: number) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);

  const coreTris: number[] = [];
  const legTris = new Map<Leg, number[]>(LEG_NAME.map(([n]) => [n as Leg, []]));
  for (let t = 0; t < triCount; t += 1) {
    const a = vert(t, 0), b = vert(t, 1), c = vert(t, 2);
    const low = pos.getY(a) < LEG_Y && pos.getY(b) < LEG_Y && pos.getY(c) < LEG_Y;
    // грань, пересекающая границу, остаётся в корпусе: так на стыке не появляется дыра
    if (!low) { coreTris.push(t); continue; }
    const mx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const mz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const name = LEG_NAME.find(([, sx, sz]) => Math.sign(mx) === sx && Math.sign(mz) === sz)?.[0];
    if (name) legTris.get(name as Leg)?.push(t);
    else coreTris.push(t);
  }

  const build = (tris: number[]) => {
    const used = new Set<number>();
    for (const t of tris) for (let k = 0; k < 3; k += 1) used.add(vert(t, k));
    const order = [...used].sort((a, b) => a - b);
    const remap = new Map<number, number>();
    const out = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geo.attributes)) {
      const size = attribute.itemSize;
      const arr = new Float32Array(order.length * size);
      for (let k = 0; k < order.length; k += 1) {
        const v = order[k] as number;
        remap.set(v, k);
        for (let s = 0; s < size; s += 1) arr[k * size + s] = attribute.array[v * size + s] as number;
      }
      out.setAttribute(name, new THREE.BufferAttribute(arr, size));
    }
    const list: number[] = [];
    for (const t of tris) for (let k = 0; k < 3; k += 1) list.push(remap.get(vert(t, k)) as number);
    out.setIndex(list);
    return out;
  };

  const mat = (): THREE.Material => (source.material as THREE.Material).clone();
  const coreMesh = new THREE.Mesh(build(coreTris), mat());
  coreMesh.castShadow = true;
  coreMesh.receiveShadow = true;

  const legs = new Map<Leg, THREE.Group>();

  // Точка качания — это стык ноги с корпусом, а не центр ноги. Ставить её в центр нельзя: у хаска
  // стык смещён от центра на 0.042 вперёд у передних ног и на 0.049 вбок у задних, и при качании
  // вокруг центра верх ноги выскакивал из-под корпуса, а ноги выглядели подвешенными. Стык ищется
  // как середина ближайшей пары вершин ноги и корпуса — работает на любой модели, где ноги
  // стоят квадратом, и не требует знать анатомию заранее.
  const jointFor = (tris: number[]): THREE.Vector3 => {
    const own = new Set<number>();
    for (const t of tris) for (let k = 0; k < 3; k += 1) own.add(vert(t, k));
    let bi = -1, bj = -1, bd = Infinity;
    for (const i of own) {
      const ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
      for (let j = 0; j < pos.count; j += 1) {
        if (pos.getY(j) < LEG_Y) continue;
        const dx = ax - pos.getX(j), dy = ay - pos.getY(j), dz = az - pos.getZ(j);
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    }
    if (bi < 0) return new THREE.Vector3(0, LEG_Y, 0);
    return new THREE.Vector3(
      (pos.getX(bi) + pos.getX(bj)) / 2,
      (pos.getY(bi) + pos.getY(bj)) / 2 + PIVOT_ABOVE,
      (pos.getZ(bi) + pos.getZ(bj)) / 2,
    );
  };

  for (const name of legTris.keys()) {
    const tris = legTris.get(name) as number[];
    const g = build(tris);
    const at = jointFor(tris);
    const pivot = new THREE.Group();
    pivot.position.copy(at);
    const mesh = new THREE.Mesh(g, mat());
    mesh.position.copy(at).negate();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    pivot.add(mesh);
    // внешняя группа держит посадку на землю, внутренняя — точку качания: иначе посадка
    // затирает точку поворота и нога вращается вокруг нуля
    const outer = new THREE.Group();
    outer.add(pivot);
    legs.set(name, outer);
  }

  return { core: coreMesh, legs };
};
const HUSK = 'husk';
const query = new URLSearchParams(location.search);
const num = (key: string, fallback: number) => {
  const raw = query.get(key);
  const v = raw === null ? NaN : Number(raw);
  return Number.isFinite(v) ? v : fallback;
};
const KIND = query.get('kind') ?? HUSK;
const gltf = await loader.loadAsync(`/models/${KIND}.glb`);

// Корпус и ноги берутся из меша зверя и разделяются. У хаска тело и ноги сварены в один меш, и
// «body» — имя единственного меша, поэтому ищем его по имени, а если не нашли — берём первый
// меш сцены: зверь всегда сделан так, что тело — крупнейший меш.
const bodyMesh = (() => {
  const meshes: THREE.Mesh[] = [];
  gltf.scene.traverse((o) => { if (o instanceof THREE.Mesh) meshes.push(o); });
  const byName = meshes.find((m) => m.name.includes('body'));
  const bySize = [...meshes].sort((a, b) => {
    const va = a.geometry.getAttribute('position').count;
    const vb = b.geometry.getAttribute('position').count;
    return vb - va;
  })[0];
  const mesh = byName ?? bySize;
  if (!mesh) throw new Error('в модели зверя нет ни одного меша');
  return mesh;
})();

const wholeBox = new THREE.Box3().setFromObject(gltf.scene);
const standOn = -wholeBox.min.y;

// прочие узлы зверя — кристалл и что ещё есть — едут вместе с корпусом
const extrasTemplate = new THREE.Group();
gltf.scene.traverse((o) => { if (o !== bodyMesh && o.parent !== bodyMesh && o instanceof THREE.Mesh) extrasTemplate.add(o); });
extrasTemplate.position.y = standOn;
extrasTemplate.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; } });

// ---------------------------------------------------------------------------------------------
// существо: собирается из того же меша сколько угодно раз
// ---------------------------------------------------------------------------------------------
//
// Модель грузится один раз, а `splitLegs` каждый раз собирает свои геометрии заново, читая
// координаты из исходного меша. Поэтому второй зверь не грузит файл второй раз и не делит буферы с
// первым: оба читают один чертёж, но каждый получает свою геометрию и свой материал — иначе
// поворот ноги у первого зверя дёрнул бы второго.

type Beast = {
  root: THREE.Group;
  torso: THREE.Group;
  legs: Map<Leg, THREE.Group>;
  leg: (name: Leg) => THREE.Group;
};

const makeBeast = (): Beast => {
  const parts = splitLegs(bodyMesh);
  const core = parts.core;
  core.position.y = standOn;
  const extras = extrasTemplate.clone(true);

  const torso = new THREE.Group();
  torso.add(core, extras);

  const legs = parts.legs;
  for (const outer of legs.values()) outer.position.y = standOn;

  // Ноги — дети корпуса, а не соседи по сцене: иначе они не наследуют его наклон и поворот по
  // курсу, и стык расползается на 0.08 клетки — ноги висели бы под корпусом отдельными деталями.
  // В системе координат корпуса нога и живёт, её шаг считается относительно корпуса.
  const root = new THREE.Group();
  torso.add(...legs.values());
  root.add(torso);
  scene.add(root);

  return {
    root,
    torso,
    legs,
    leg: (name: Leg) => (legs.get(name) as THREE.Group).children[0] as THREE.Group,
  };
};

const LOOKS: Record<string, { bob: number; bobRate: number; sway: number; swayRate: number; yaw: number; yawRate: number }> = {
  // те же значения, что в таблице видов игры, чтобы качание было тем же самым
  husk: { bob: 0.016, bobRate: 1.5, sway: 0.045, swayRate: 1.5, yaw: 0.1, yawRate: 0.35 },
  runner: { bob: 0.028, bobRate: 5, sway: 0.075, swayRate: 2.8, yaw: 0.06, yawRate: 0.6 },
  wisp: { bob: 0.045, bobRate: 1, sway: 0, swayRate: 1, yaw: 0.5, yawRate: 0.45 },
  swarmling: { bob: 0.022, bobRate: 9, sway: 0.05, swayRate: 6, yaw: 0.16, yawRate: 3.2 },
  carapace: { bob: 0.008, bobRate: 0.55, sway: 0.022, swayRate: 0.42, yaw: 0.05, yawRate: 0.24 },
  mote: { bob: 0.03, bobRate: 1.7, sway: 0.09, swayRate: 1.1, yaw: 0.22, yawRate: 0.9 },
  maw: { bob: 0.026, bobRate: 0.8, sway: 0.038, swayRate: 0.6, yaw: 0.12, yawRate: 0.3 },
};
const HEIGHT = wholeBox.max.y - wholeBox.min.y;

// Колонна: пять зверей друг за другом по полотну дороги. Все идут с одной скоростью и отстоят друг
// от друга на постоянном расстоянии, поэтому строй держится сам: у колонны одна пройденная дистанция,
// а у каждого зверя своя точка на маршруте, сдвинутая на интервал назад.
const BEASTS = num('beasts', 5);
const GAP = 4.2;

// ---------------------------------------------------------------------------------------------
// маршрут: полотно дороги, взятое из сети карты
// ---------------------------------------------------------------------------------------------
//
// Звери идут по настоящему полотну, а не по произвольной прямой через луга: маршрут берётся из
// сети дороги карты, поэтому строй стоит там, где дорога реально выровнена под полотно.
//
// Ходьба туда-обратно, а не по кругу: в сети владельца концы отрезков упираются в край плиты и в
// край базы, то есть колец на земле нет — есть лучи от краёв к базе. При развороте у края колонна
// переходит на обратный отсчёт задом наперёд, и так обход замыкается сам.
// Маршрут берётся по карте и только по дороге: самый длинный непрерывный участок полотна на всей
// плите, найденный тем же проходом, каким сама игра ищет дорожные полосы. Задавать координаты
// вручную нельзя — в ряду 48 дорога идёт участками [14…17], [22…73], [78…81], и коридор от 8 до 88
// вылезал с полотна на свободную землю (вожак стоял на клетке `free`, а не на дороге).
//
// Идти по клеткам дороги — значит идти по рельефу само собой: полотно положено на свою высоту, а
// пропс на дороге невозможен по типам клеток, и это проверяется чеком, а не держится на глаз.
//
// Ходьба туда-обратно: у сети владельца концы упираются в край плиты и в край базы, то есть колец
// на земле нет. При развороте у края колонна переходит на обратный отсчёт задом наперёд, и так
// обход замыкается сам.
const LOOK = LOOKS[KIND] ?? LOOKS.husk;

const routeRun = (() => {
  let best = { row: -1, from: 0, to: 0, length: 0 };
  for (let y = 0; y < grid.height; y += 1) {
    let x = 0;
    while (x < grid.width) {
      if (grid.kindAt({ x, y }) !== 'road') { x += 1; continue; }
      let end = x + 1;
      while (end < grid.width && grid.kindAt({ x: end, y }) === 'road') end += 1;
      if (end - x > best.length) best = { row: y, from: x, to: end - 1, length: end - x };
      x = end;
    }
  }
  return best;
})();

const routeCells = { row: routeRun.row, from: routeRun.from, to: routeRun.to };

// Клетка — одна мировая единица: `cellBounds` в игре отдаёт углы клетки как ±0.5 от её центра,
// поэтому карта 96 клеток и есть 96 единиц, а существо высотой 0.47 стоит в тех же единицах, что
// и в матче. Никакого пересчёта масштаба здесь не нужно, иначе зверь разойдётся с игрой.
const routeLen = routeRun.length;
const routeFrom = cellCenter(grid, { x: routeCells.from, y: routeCells.row });
const routeDirX = 1;
const routeDirZ = 0;

let speed = num('speed', 1);

// Панель и подпись разведены намеренно: подпись перезаписывается каждый кадр, а ползунок рядом с
// ней — нет, и если бы он лежал внутри текста, то исчезал бы на первом же кадре.
const panel = document.createElement('div');
Object.assign(panel.style, {
  position: 'fixed', left: '12px', top: '10px', zIndex: '10',
  padding: '8px 12px', borderRadius: '6px', background: 'rgba(4,12,18,.86)',
  color: '#cfe6e2', font: '13px/1.5 system-ui, sans-serif', maxWidth: '760px',
});
const caption = document.createElement('div');
panel.append(caption);
document.body.append(panel);

// ---------------------------------------------------------------------------------------------
// регулятор скорости
// ---------------------------------------------------------------------------------------------
//
// Скорость берётся ползунком прямо в прогоне, а не только вопросом к адресу: походку смотрят на
// медленной скорости, и перезагружать страницу под каждую проверку неудобно. Шкала 0…2, и единица
// стоит в её середине — на клетку в секунду существо проходит две клетки в минуту, шаг при этом
// получается медленным и читаемым, а крайние значения остаются на обоих концах шкалы. Ползунок
// меняет ходьбу на ходу, а частота шага считается от той же скорости, поэтому длина переступания и
// число шагов остаются связанными: на быстрой скорости зверь шагает чаще и короче, а не просто едет
// быстрее. Ноль — зверь стоит на месте.
//
// События камеры висят на window, а панель лежит поверх полотна, поэтому события, начатые на самой
// панели, камере не достаются: без этой проверки перетаскивание ползунка вращало бы вид.
const speedInput = document.createElement('input');
Object.assign(speedInput, { type: 'range', min: '0', max: '2', step: '0.05', value: String(speed) });
speedInput.setAttribute('aria-label', 'скорость существа');
Object.assign(speedInput.style, { flex: '1', maxWidth: '220px', accentColor: '#7fd6c2' });

const speedValue = document.createElement('span');
const speedRow = document.createElement('div');
Object.assign(speedRow.style, { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' });
speedRow.append(document.createTextNode('скорость'), speedInput, speedValue);
panel.append(speedRow);

const showSpeed = () => { speedValue.textContent = `${speed.toFixed(1)} кл/с`; };
speedInput.addEventListener('input', () => { speed = Number(speedInput.value); showSpeed(); });
showSpeed();

const onPanel = (target: EventTarget | null): boolean => target instanceof Node && panel.contains(target);

// ---------------------------------------------------------------------------------------------
// ходьба: колонна по полотну
// ---------------------------------------------------------------------------------------------

const herd = Array.from({ length: BEASTS }, () => makeBeast());

let walked = 0;
let elapsed = 0;

// Точка маршрута по пройденному пути: туда, потом обратно.
//
// Разворот считается как доля `turn` от 0 до 1 — «смотрю по ходу» или «смотрю назад», — и курс
// получается умножением её на π. Считать курс знаком направления нельзя: у края знак меняется, а
// `turn` там нулевой, и получалось три разворота подряд — полный оборот вместо разворота. А у
// начала цикла обе ветки давали `base ± π`, то есть один и тот же угол, и разворота не было там
// вовсе. Теперь разворот распределён на TURN_CELLS клеток у обоих концов, и зверь доворачивает
// один раз за конец пути.
const TURN_CELLS = 6;
const smoothstep = (u: number): number => {
  const t = u < 0 ? 0 : u > 1 ? 1 : u;
  return t * t * (3 - 2 * t);
};

const place = (distance: number) => {
  const cycle = routeLen * 2;
  const s = ((distance % cycle) + cycle) % cycle;
  const back = s > routeLen;
  // Концом считается последняя клетка участка, а не та точка за ним: участок длиной 90 занимает
  // клетки 0…89, и без ограничения зверь на развороте вставал на клетку 90 — она уже не дорога, то
  // есть на свободную землю и на полметра выше полотна.
  const t = Math.min(back ? cycle - s : s, routeLen - 1);
  const x = routeFrom.x + routeDirX * t;
  const z = routeFrom.z + routeDirZ * t;

  // 0 — по ходу, 1 — назад. Ровно в двух окнах по краям отрезка, а в середине постоянен, поэтому
  // ровно один разворот у конца и один у начала, а не два на одном краю.
  let turn: number;
  if (s < TURN_CELLS / 2) turn = 1 - smoothstep((s + TURN_CELLS / 2) / TURN_CELLS);
  else if (s <= routeLen - TURN_CELLS / 2) turn = 0;
  else if (s <= routeLen + TURN_CELLS / 2) turn = smoothstep((s - routeLen + TURN_CELLS / 2) / TURN_CELLS);
  else if (s <= cycle - TURN_CELLS / 2) turn = 1;
  else turn = 1 - smoothstep((s - cycle + TURN_CELLS / 2) / TURN_CELLS);

  return {
    x,
    z,
    y: groundYAt(x, z),
    heading: Math.atan2(routeDirX, routeDirZ) + Math.PI * turn,
    back,
  };
};

const resize = () => {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
};
addEventListener('resize', resize);
resize();

const frame = () => {
  if (!paused) {
    elapsed += 1 / 60;
    // медленный проход: клетки в секунду, шаг масштабируется под скорость, чтобы ноги шли в такт
    walked += speed / 60;
  }

  // ---------------------------------------------------------------------------------------------
  // шаг
  // ---------------------------------------------------------------------------------------------
  //
  // Шаг собран из настоящих ног и корпуса. Зверь четвероногий, идут ноги диагональными парами:
  // передняя левая и задняя правая идут в такт друг другу, вторая пара — в противофазе. Это рысь,
  // и на медленной скорости она читается как переступание, а на быстрой как бег. Корпус переваливается
  // с пары на пару и идёт с наклоном вперёд, частота такта считается от скорости: шаг занимает
  // примерно треть клетки, поэтому медленно зверь переступает, а быстро шагает часто и коротко.
  const STEP_CELLS = 0.3;
  const stepsPerSecond = speed / STEP_CELLS;
  const stepPhase = elapsed * stepsPerSecond * Math.PI * 2;
  const swing = Math.sin(stepPhase);
  const liftStep = Math.abs(Math.sin(stepPhase));

  // Углы небольшие: ноги короткие, большой наклон уводил бы копыто сквозь землю, а это читается
  // хуже, чем короткий шаг. Подъём копыта при переносе делает подъёмом всего зверя.
  const LEG_SWING = 0.35;
  const leader = place(walked);

  for (let i = 0; i < herd.length; i += 1) {
    const beast = herd[i]!;
    const spot = i === 0 ? leader : place(walked - i * GAP);

    beast.leg('frontLeft').rotation.x = swing * LEG_SWING;
    beast.leg('backRight').rotation.x = swing * LEG_SWING;
    beast.leg('frontRight').rotation.x = -swing * LEG_SWING;
    beast.leg('backLeft').rotation.x = -swing * LEG_SWING;

    beast.root.position.set(spot.x, spot.y + liftStep * HEIGHT * 0.035, spot.z);
    beast.torso.rotation.z = swing * 0.05;
    beast.torso.rotation.x = 0.11;
    beast.torso.position.y = liftStep * HEIGHT * 0.02;
    beast.torso.rotation.y = spot.heading + Math.sin(elapsed * LOOK.yawRate + i) * LOOK.yaw;
  }

// Камера смотрит на середину колонны, а не на вожака: вожак — это конец строя длиной в
// GAP × (N − 1), и если целиться в него, камера встаёт между зверями и половина колонны уходит за
// спину. Средняя точка строя и камера сзади видят его целиком.
  const p = leader;
  const centre = new THREE.Vector3();
  for (const beast of herd) centre.add(beast.root.position);
  centre.multiplyScalar(1 / Math.max(1, herd.length));
  const target = new THREE.Vector3(centre.x + pan.x, centre.y + HEIGHT * 0.5, centre.z + pan.z);
  const horiz = Math.cos(camPitch) * camDist;
  camera.position.set(
    target.x + Math.sin(camYaw) * horiz,
    target.y + Math.sin(camPitch) * camDist,
    target.z + Math.cos(camYaw) * horiz,
  );
  // Камера не ныряет под пол: положительный наклон держит её над землёй, отрицательный — тоже
  // иначе, с пола вверх, потому что единственное, что должно быть видно, — зверь на земле.
  if (camera.position.y < target.y - camDist * 0.35) {
    camera.position.y = target.y - camDist * 0.35;
  }
  camera.lookAt(target);

  // WASD ведёт смещение, пока клавиша зажата
  for (const code of seenKeys) {
    if (code === 'KeyW' || code === 'KeyS' || code === 'KeyA' || code === 'KeyD') panKey(code);
  }

  const cellX = Math.round(p.x + grid.width / 2 - 0.5);
  const cellY = Math.round(p.z + grid.height / 2 - 0.5);
  caption.textContent =
    `${BEASTS} × ${KIND} идут колонной по карте burrow-01, коридор дороги в ряду ${routeCells.row} · `
    + `вожак в клетке ${cellX}, ${cellY} (${grid.kindAt({ x: cellX, y: cellY }) ?? '—'}) на высоте ${p.y.toFixed(2)} · `
    + `тело ${HEIGHT.toFixed(2)} клетки · скорость ${speed.toFixed(1)} кл/с`
    + ` · обход ${walked.toFixed(1)} из ${(routeLen * 2).toFixed(1)} клеток`
    + ` · пропсов ${props.readings.slots.length}, правил растительности ${skin.scatter.rules.length}`
    + (p.back ? ' · разворот у края' : '')
    + (paused ? ' · ПАУЗА' : '')
    + '  |  ЛКМ — вращение, ПКМ или СКМ — сдвиг, колесо — зум, пробел — пауза, R — вид на зверя, WASD — вести точку взгляда, ползунок — скорость.';

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
};

// ---------------------------------------------------------------------------------------------
// свободная камера: орбита вокруг точки взгляда, зверь держит её в центре
// ---------------------------------------------------------------------------------------------
//
// Точка взгляда — это зверь, а не отдельная точка, которую надо вести вручную: иначе «рассмотреть
// движение» превращается в два предмета управления — зверь и точка, — и зверь всё равно уходит из
// кадра. Ручное ведение остаётся (WASD и сдвиг), но оно сдвигает смещение, а не саму цель.

let paused = false;
// Дистанция по умолчанию — под длину колонны, иначе пять зверей в кадр не помещаются и строй
// виден только вожак. Зум остаётся свободным: к ногам можно подойти вплотную.
let camYaw = num('yaw', Math.PI);
let camPitch = num('pitch', 0.42);
let camDist = num('dist', GAP * BEASTS * 0.85);
const herdDist = () => Math.max(2.5, GAP * (BEASTS - 1) * 0.62);
const pan = new THREE.Vector3(0, 0, 0);

let drag: null | { x: number; y: number; move: boolean } = null;
const seenKeys = new Set<string>();

addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') return;
  if (onPanel(e.target)) return;
  drag = { x: e.clientX, y: e.clientY, move: e.button !== 0 || seenKeys.has('Space') };
});
addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.move) {
    // Сдвиг только в плоскости земли: вертикальный сдвиг уводил камеру под пол, и картинка
    // становилась пустой без всякой ошибки в консоли — самый дорогой вид отказа.
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    right.y = 0; right.normalize();
    const fwd = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), right).normalize();
    const k = camDist * 0.0018;
    pan.addScaledVector(right, -dx * k).addScaledVector(fwd, dy * k);
  } else {
    camYaw -= dx * 0.006;
    camPitch = Math.max(-0.2, Math.min(1.4, camPitch + dy * 0.005));
  }
});
addEventListener('pointerup', () => { drag = null; });

addEventListener('wheel', (e) => {
  if (onPanel(e.target)) return;
  camDist = Math.max(0.6, Math.min(120, camDist * (1 + Math.sign(e.deltaY) * 0.12)));
  e.preventDefault();
}, { passive: false });

addEventListener('keydown', (e) => {
  if (e.code === 'Space') { seenKeys.add('Space'); if (!e.repeat) paused = !paused; e.preventDefault(); return; }
  if (e.code === 'KeyR') {
    pan.set(0, 0, 0);
    // вид сзади по курсу дороги: за вожаком, а не по мировой оси, иначе колонна встаёт боком
    camYaw = Math.atan2(routeDirX, routeDirZ) + Math.PI;
    camPitch = 0.3;
    camDist = herdDist();
    return;
  }
  seenKeys.add(e.code);
});
addEventListener('keyup', (e) => seenKeys.delete(e.code));
addEventListener('blur', () => { seenKeys.clear(); drag = null; });

const panKey = (code: string) => {
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  right.y = 0; right.normalize();
  const fwd = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), right).normalize();
  const k = camDist * 0.06;
  if (code === 'KeyW') pan.addScaledVector(fwd, k);
  if (code === 'KeyS') pan.addScaledVector(fwd, -k);
  if (code === 'KeyA') pan.addScaledVector(right, -k);
  if (code === 'KeyD') pan.addScaledVector(right, k);
};

resize();
frame();


// Сцена выставлена наружу для отладки: без неё проверка геометрии идёт по картинке, а картинка
// врала четыре раза подряд — земля уезжала, и это было видно только глазами.
window.__WALK__ = {
  get walked() { return walked; },
  get routeLen() { return routeLen; },
  paused: () => paused,
  kind: KIND,
  scene,
  camera,
  renderer,
  herd,
  grid,
  routeCells,
  terrain,
  props,
  groundYAt,
};

declare global { interface Window { __WALK__?: unknown } }
