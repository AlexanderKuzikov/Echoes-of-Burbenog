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

// Анатомия ноги хаска. Замерено по геометрии `husk.glb`: нога стоит вертикальным столбом из трёх
// частей, и стыки между ними — это готовые шарниры, а не выдуманные точки:
//
//   копыто  y 0.0000…0.0393   24 треугольника
//   балка   y 0.0449…0.0880   18 треугольников
//   верх    y 0.0880…0.1242   14 треугольников
//
// Между копытом и балкой уже есть зазор 0.0393…0.0449, между балкой и верхом — стык на 0.088.
// Поэтому поры здесь не нужны: режем по этим двум границам, и ступня, голень и бедро получаются
// настоящими частями, которые можно сгибать по-настоящему.
const FOOT_Y = 0.042;
const KNEE_Y = 0.088;
const LEG_Y = 0.126;
// Допуск вокруг оси ноги и по ширине грани. Модель не сварена вообще — 2424 вершины на 808
// треугольников, ни одной общей, — поэтому по связности не разделить и по высоте не хватает:
// грудь хаска опускается до 0.112 и в ноги по порогу попадала. Ось берём из копыт, они стоят
// квадратом и отстоят от груди, а широкую грань отсекаем по размаху.
const LEG_RX = 0.075;
const LEG_RZ = 0.055;
const LEG_TRI_W = 0.085;
const LEG_TRI_D = 0.070;

type Leg = 'frontLeft' | 'frontRight' | 'backLeft' | 'backRight';

const LEG_NAME: [string, number, number][] = [
  ['frontLeft', -1, 1], ['frontRight', 1, 1], ['backLeft', -1, -1], ['backRight', 1, -1],
];

// Фаза шага каждой ноги в долях цикла. Диагональные пары идут в такт: передняя левая и задняя
// правая в одной фазе, передняя правая и задняя левая в противофазе — половина цикла. Это рысь.
const LEG_PHASE: [Leg, number][] = [
  ['frontLeft', 0], ['backRight', 0],
  ['frontRight', 0.5], ['backLeft', 0.5],
];

type LegRig = { hip: THREE.Group; knee: THREE.Group; ankle: THREE.Group };
type LegParts = { rig: LegRig; axisX: number; axisZ: number; drop: number };

const splitLegs = (source: THREE.Mesh): { core: THREE.Mesh; legs: Map<Leg, THREE.Group>; rig: Map<Leg, LegParts> } => {
  const geo = source.geometry as THREE.BufferGeometry;
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex();
  const count = idx ? idx.count : pos.count;
  const triCount = Math.floor(count / 3);
  const vert = (t: number, k: number) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
  const midX = (t: number) => (pos.getX(vert(t, 0)) + pos.getX(vert(t, 1)) + pos.getX(vert(t, 2))) / 3;
  const midZ = (t: number) => (pos.getZ(vert(t, 0)) + pos.getZ(vert(t, 1)) + pos.getZ(vert(t, 2))) / 3;

  // Ось ноги — центр копыта. Копыто самая нижняя и самая узкая часть, стоит квадратом, и по нему
  // нога опознаётся однозначно: грудь сюда не попадает, а вот порог по высоте её впускал.
  const hoofTris = new Map<Leg, number[]>(LEG_NAME.map(([n]) => [n as Leg, []]));
  for (let t = 0; t < triCount; t += 1) {
    const a = vert(t, 0), b = vert(t, 1), c = vert(t, 2);
    if (pos.getY(a) > FOOT_Y || pos.getY(b) > FOOT_Y || pos.getY(c) > FOOT_Y) continue;
    const name = LEG_NAME.find(([, sx, sz]) => Math.sign(midX(t)) === sx && Math.sign(midZ(t)) === sz)?.[0];
    if (name) hoofTris.get(name as Leg)?.push(t);
  }

  const coreTris: number[] = [];
  const segTris = new Map<Leg, { foot: number[]; shin: number[]; thigh: number[] }>(
    LEG_NAME.map(([n]) => [n as Leg, { foot: [], shin: [], thigh: [] }]),
  );
  const legAxis = new Map<Leg, { x: number; z: number }>();

  for (const name of hoofTris.keys()) {
    const list = hoofTris.get(name) as number[];
    legAxis.set(name, {
      x: list.reduce((s, t) => s + midX(t), 0) / list.length,
      z: list.reduce((s, t) => s + midZ(t), 0) / list.length,
    });
  }

  for (let t = 0; t < triCount; t += 1) {
    const xs = [vert(t, 0), vert(t, 1), vert(t, 2)];
    const ys = xs.map((v) => pos.getY(v));
    // Грань берётся по самой высокой и самой низкой своей вершине, а не по центру. По центру
    // грань высотой в пол-бедра попадала сразу в два сегмента: бедро начиналось с y 0, то есть
    // с пола, и при повороте таза уезжало под землю, а колено со ступнёй переворачивались.
    const yLo = Math.min(...ys);
    const yHi = Math.max(...ys);
    if (yLo >= LEG_Y) { coreTris.push(t); continue; }
    const w = Math.max(...xs.map((v) => pos.getX(v))) - Math.min(...xs.map((v) => pos.getX(v)));
    const d = Math.max(...xs.map((v) => pos.getZ(v))) - Math.min(...xs.map((v) => pos.getZ(v)));
    let hit = false;
    for (const [name, axis] of legAxis) {
      if (Math.abs(midX(t) - axis.x) > LEG_RX || Math.abs(midZ(t) - axis.z) > LEG_RZ) continue;
      if (w > LEG_TRI_W || d > LEG_TRI_D) continue;
      const seg = segTris.get(name) as { foot: number[]; shin: number[]; thigh: number[] };
      // По верхней вершине: грань целиком ниже порога ступни — это ступня, целиком ниже
      // колена — балка, иначе верх ноги. Грань, пересекающая стык, уходит в корпус: так на
      // шарнире не появляется дыра, и стык при сгибе остаётся закрытым.
      if (yHi < FOOT_Y) seg.foot.push(t);
      else if (yHi < KNEE_Y) seg.shin.push(t);
      else if (yLo >= KNEE_Y) seg.thigh.push(t);
      else continue;
      hit = true;
      break;
    }
    if (!hit) coreTris.push(t);
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

// Часть ноги собирается в свой меш и вешается на узел шарнира. Здесь важно не перепутать два
// вектора, и в них путаница стоила двух замеров подряд:
//
//   joint — точка шарнира в координатах модели. Меш сдвигается на минус этот вектор, потому что
//   вершины геометрии лежат в координатах модели, и после сдвига шарнир оказывается в нуле.
//
//   node  — где стоит узел относительно родителя. Узел таза стоит в точке таза модели, а узел
//   колена — на разнице между точками таза и колени, то есть относительно родителя, а не модели.
//   Если задать узлу координату модели, он уедет вверх ещё на всю длину бедра.
const segment = (parent: THREE.Group, tris: number[], node: THREE.Vector3, joint: THREE.Vector3) => {
  const group = new THREE.Group();
  group.position.copy(node);
  const mesh = new THREE.Mesh(build(tris), mat());
  mesh.position.copy(joint).negate();
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  parent.add(group);
  return group;
};

  const coreMesh = new THREE.Mesh(build(coreTris), mat());
  coreMesh.castShadow = true;
  coreMesh.receiveShadow = true;

  const legs = new Map<Leg, THREE.Group>();
  const rig = new Map<Leg, LegParts>();

  for (const [name, seg] of segTris) {
    // Три шарнира на одной вертикали: таз у корпуса, колено на стыке балки и верха, голеностоп
    // над копытом. У хаска нога стоит вертикальным столбом, поэтому все три точки лежат на её оси,
    // и в покое нога собрана ровно в ту линию, какой вырезана из модели. Ноги стоят не под x=0,
    // а на своём квадрате, поэтому каждый шарнир несёт смещение по x и z: иначе вся нога уехала бы
    // к центру тела и перекрыла соседнюю.
    const axis = legAxis.get(name) as { x: number; z: number };
    const at = (y: number) => new THREE.Vector3(axis.x, y, axis.z);
    const outer = new THREE.Group();
    const hip = segment(outer, seg.thigh, at(LEG_Y), at(LEG_Y));
    const knee = segment(hip, seg.shin, new THREE.Vector3(0, KNEE_Y - LEG_Y, 0), at(KNEE_Y));
    const ankle = segment(knee, seg.foot, new THREE.Vector3(0, FOOT_Y - KNEE_Y, 0), at(FOOT_Y));
    // Посадка ноги — по её собственному копыту, а не по общей нижней точке зверя: у хаска
    // передние копыта ниже задних, и по общей точке задние висели бы в воздухе.
    let drop = Infinity;
    for (const t of seg.foot) for (let k = 0; k < 3; k += 1) drop = Math.min(drop, pos.getY(vert(t, k)));
    legs.set(name, outer);
    rig.set(name, { rig: { hip, knee, ankle }, axisX: axis.x, axisZ: axis.z, drop });
  }

  return { core: coreMesh, legs, rig };
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
// Посадка зверя на землю — по самой нижней точке модели. Но у хаска копыта стоят на разной
// высоте: передние опускаются ниже, задние сильно выше, и разница доходит до 0.05 клетки. Если
// сажать всех по общей нижней точке, задние копыта повиснут в воздухе, а зверь встанет на
// передние. Поэтому каждая нога сажается по своему копыту — см. `legDrop` в `splitLegs`.
const standOn = -wholeBox.min.y;

// прочие узлы зверя — кристалл и что ещё есть — едут вместе с корпусом
const extrasTemplate = new THREE.Group();
gltf.scene.traverse((o) => { if (o !== bodyMesh && o.parent !== bodyMesh && o instanceof THREE.Mesh) extrasTemplate.add(o); });
extrasTemplate.position.y = standOn;
extrasTemplate.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; } });

// Самая нижняя точка всех копыт относительно корня зверя. Считается по фактическим вершинам
// ступней в их текущих поворотах, поэтому учитывает и наклон корпуса, и сгиб ноги, и разницу
// длин ног — всё, что двигает копыто по высоте. Зверь сажается по этому замеру.
// Самая нижняя точка копыт относительно корня зверя. Считаются только ступни: бедро при сгибе
// таза уходит ниже копыта, и если мерить по всей ноге, зверь сажался бы по бедру и копыто тонуло
// в земле на 0.037 клетки.
//
// Возвращается `min` — самая нижняя точка из всех копыт. Чтобы ни одна ступня не ушла в грунт,
// зверь надо поднять ровно настолько, насколько самая низкая ступня утоплена, а не опустить до
// самой низкой. Это разные знаки, и перепутать их значит утопить ноги в дороге.
const hoofVertex = new THREE.Vector3();
const lowestHoof = (beast: Beast): { min: number; max: number } => {
  let min = Infinity;
  let max = -Infinity;
  for (const [name] of beast.rig) {
    beast.joint(name).ankle.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const pos = o.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i += 1) {
        hoofVertex.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (hoofVertex.y < min) min = hoofVertex.y;
        if (hoofVertex.y > max) max = hoofVertex.y;
      }
    });
  }
  const y = beast.root.position.y;
  return { min: min - y, max: max - y };
};

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
  rig: Map<Leg, LegRig>;
  joint: (name: Leg) => LegRig;
};

const makeBeast = (): Beast => {
  const parts = splitLegs(bodyMesh);
  const core = parts.core;
  core.position.y = standOn;
  const extras = extrasTemplate.clone(true);

  const torso = new THREE.Group();
  torso.add(core, extras);

  const legs = parts.legs;
  const rig = new Map<Leg, LegRig>();
  const drop = new Map<Leg, number>();
  for (const [name, outer] of legs) {
    const part = parts.rig.get(name) as LegParts;
    // Нога садится на землю по своему копыту: своя точка низа зверя у всех ног разная.
    outer.position.y = standOn - part.drop;
    drop.set(name, part.drop);
    rig.set(name, part.rig);
  }

  // Ноги — дети корпуса, а не соседи по сцене: иначе они не наследуют его наклон и поворот по
  // курсу, и стык расползается — ноги висели бы под корпусом отдельными деталями.
  // В системе координат корпуса нога и живёт, её шаг считается относительно корпуса.
  const root = new THREE.Group();
  torso.add(...legs.values());
  root.add(torso);
  scene.add(root);

  return {
    root,
    torso,
    legs,
    rig,
    joint: (name: Leg) => rig.get(name) as LegRig,
  };
};
const HEIGHT = wholeBox.max.y - wholeBox.min.y;

// Колонна: пять зверей друг за другом по полотну дороги. Все идут с одной скоростью и отстоят друг
// от друга на постоянном расстоянии, поэтому строй держитя сам: у колонны одна пройденная дистанция,
// а у каждого зверя своя точка на маршруте, сдвинутая на интервал назад.
//
// Интервал 1.6 клетки, а не 4.2: зверь длиной 0.78 клетки при промежутке 4.2 стоял в колонне как
// точки через четыре клетки друг от друга, и ног на нём не было видно вовсе — на кадре звери
// занимали крохотную часть экрана. Колонна читается как колонна, когда промежуток сопоставим с
// длиной зверя.
const BEASTS = num('beasts', 5);
const GAP = 1.6;

// ---------------------------------------------------------------------------------------------
// походка: длины и углы
// ---------------------------------------------------------------------------------------------
//
// Ноги настоящие, трёхзвенные: таз, колено, голеностоп, и походка считается фазой опоры и
// переноса, как у живого четвероногого. Раньше нога была одна цельная колонна, которую качали
// туда-сюда, и это читалось как маятник, а не как шаг: у ноги не было ни колена, ни фазы, в
// которую она оторвана от земли.
//
// Цикл ноги состоит из двух фаз:
//
//   ОПОРА (duty) — копыто стоит на земле, нога прямая, таз идёт от переднего положения к
//   заднему. Тело над этой ногой едет, и нога держит вес: это настоящая опора.
//   ПЕРЕНОС — копыто отрывается, таз идёт от заднего положения к переднему, колено при этом
//   сгибается и выносит ступню вперёд, голеностоп доворачивает копыто вниз к земле. Нога
//   собирается в три сгиба и встаёт заново.
//
// Шаг в клетках — это ровно длина дуги, которую нога проносит под корпусом за цикл. Он не
// задаётся числом: он выводится из длины ноги и угла шага. Иначе получается то, что было
// раньше: шаг 0.3 клетки при ноге длиной 0.126 — нога в 2.4 раза короче шага, она физически
// не могла донести копыто до земли, и зверь скользил, не касаясь пола ни в одной точке цикла.
//
// Ноги идут диагональными парами — передняя левая и задняя правая в такт, вторая пара в
// противофазе. Это рысь, и она единственная честно ложится на четыре ноги: опора распределена
// по диагонали, корпус не проваливается.
const LEG_LEN = LEG_Y;
const DUTY = 0.6;
// Угол шага: таз уходит от нейтрали на столько, на сколько нога может вынести копыто, не
// отрывая его от земли и не ломая угол в тазу. Таз не доводится до прямого угла в шарнире —
// тогда нога легла бы вдоль корпуса.
const HIP_ANGLE = 0.55;
const KNEE_ANGLE = 0.85;
// Шаг в клетках выводится из геометрии: дуга, которую копыто проходит под корпусом за цикл.
const STRIDE = LEG_LEN * (2 * HIP_ANGLE + KNEE_ANGLE * 0.35);

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
//
// Окно разворота обязано быть короче длины колонны. Длина колонны — GAP × (N − 1), и при
// промежутке 1.6 и пяти зверях это 6.4 клетки. Окно в 6 клеток шире колонны целиком, поэтому в
// момент разворота в зоне поворота оказывались все пять зверей сразу: вожак уже доворачивал,
// а задний ещё не дошёл до края, и строй изгибался петлёй вместо того, чтобы идти следом.
// Окно взято вчетверо короче колонны, чтобы разворот успевал пройти раньше, чем в него въедет
// второй зверь, и колонна входила в поворот и выходила из него строем.
const TURN_CELLS = Math.max(2, (GAP * (BEASTS - 1)) / 4);
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

let lastCorrection = 0;

const frame = () => {
  if (!paused) {
    elapsed += 1 / 60;
    // медленный проход: клетки в секунду, шаг масштабируется под скорость, чтобы ноги шли в такт
    walked += speed / 60;
  }

  // ---------------------------------------------------------------------------------------------
  // походка
  // ---------------------------------------------------------------------------------------------
  //
  // Длины и углы заданы выше, у карты: здесь только фаза. Частота такта считается от скорости,
  // поэтому длина шага в клетках и частота шагов остаются связанными: быстрее зверь — значит
  // чаще переступает, а не реже, и ноги не едут сквозь пол.
  const stepsPerSecond = speed / STRIDE;
  const gaitPhase = elapsed * stepsPerSecond;
  const leader = place(walked);

  for (let i = 0; i < herd.length; i += 1) {
    const beast = herd[i]!;
    const spot = i === 0 ? leader : place(walked - i * GAP);

    // Фаза каждой ноги: диагональные пары сдвинуты на полцикла. Ноги в одной паре идут в такт,
    // поэтому обе в одной фазе — сдвига 0 у второй пары нет, у неё ровно половина цикла.
    for (const [name, offset] of LEG_PHASE) {
      const j = beast.joint(name);
      const phase = (gaitPhase + offset) % 1;

      if (phase < DUTY) {
        // Опора. Копыто стоит на земле, а таз почти не качается: нога держит вес, и тело едет
        // над ней. Качать таз в опоре нельзя — копыто пойдёт по дуге и оторвётся от земли, то
        // есть зверь заскользит, а это ровно то, что было раньше. Небольшой наклон оставлен
        // для живости: на 0.05 рад копыто приподнимается на 0.0002 клетки, глазом не видно.
        j.hip.rotation.x = HIP_ANGLE * 0.09;
        j.knee.rotation.x = 0;
        // Голеностоп придерживает копыто плоским: ступня в опоре лежит плашмя, а не висит.
        j.ankle.rotation.x = -j.hip.rotation.x;
      } else {
        // Перенос. Нога отрывается и проходит цикл целиком: сначала отталкивается назад от
        // корпуса, потом сгибается и несёт ступню вперёд, потом выпрямляется и встаёт. Каждая
        // из трёх частей отрабатывает своё, поэтому нога собирается в три сгиба, а не качается
        // целиком. К концу переноса таз и колено возвращаются в ноль — нога готова к опоре.
        const u = (phase - DUTY) / (1 - DUTY);
        // Отталкивание назад и вынос вперёд: таз идёт по дуге назад в начале и возвращается
        // вперёд к концу переноса, поэтому ступня встаёт там же, где стояла.
        const push = Math.sin(Math.PI * Math.min(1, u * 1.35));
        j.hip.rotation.x = -HIP_ANGLE * push;
        // Колено гнётся в середине переноса и разгибается к концу: в начале нога ещё толкает
        // корпус, в конце уже выпрямляется под опору, и сгиб там только мешал бы.
        const fold = Math.sin(Math.PI * u) ** 0.85;
        j.knee.rotation.x = KNEE_ANGLE * fold;
        // Голеностоп держит копыто горизонтальным и в переносе: ступня не опрокидывается
        // вверх пяткой, а идёт вперёд плашмя и встаёт на землю.
        j.ankle.rotation.x = -j.hip.rotation.x - j.knee.rotation.x * 0.6;
      }
    }

    // Корпус идёт с наклоном вперёд и чуть переваливается на ходу. Подъём зверя от шага убран
    // совсем: раньше зверя целиком подбрасывало на копыте, потому что копыто не касалось земли
    // и нечего было опереться.
    beast.torso.rotation.z = Math.sin(gaitPhase * Math.PI * 2) * 0.045;
    beast.torso.rotation.x = 0.09;
    // Курс зверя — ровно курс маршрута, без бокового рыска. Рыск остался от одиночного зверя,
    // где он читался как жизнь, а в колонне из пяти звери вставали вразнобой: последний уходил
    // на 1.13 рад в сторону от соседей, и строй рассыпался на глазах.
    beast.torso.rotation.y = spot.heading;

    // Зверь садится по самой нижней копытной точке, а не по заранее посчитанной высоте. Разница
    // между копытами реальная: у хаска передние ниже задних, и наклон корпуса вперёд уводит зад
    // ещё ниже, поэтому по постоянной высоте задние копыта уходили в землю на 0.015 клетки.
    // Единственная честная посадка — та, что ищется по факту, каждый кадр, по самой нижней точке
    // всех четырёх копыт: зверь стоит на той ноге, которая ниже всех, и ни одна не проваливается.
    beast.root.position.set(spot.x, spot.y, spot.z);
    // Посадка на землю идёт в два прохода. Первый кладёт зверя на точку маршрута, второй сдвигает
    // по высоте так, чтобы самая низкая ступня встала на дорогу. Оба прохода обязаны кончиться
    // пересчётом матриц: считать замер по матрице, собранной до сдвига, — значит мерять
    // предыдущий кадр и получить ровно ту ошибку, которую ты чинишь.
    beast.root.updateWorldMatrix(true, true);
    const before = lowestHoof(beast);
    if (before.min < 0) beast.root.position.y -= before.min;
    beast.root.updateWorldMatrix(true, true);
    lastCorrection = lowestHoof(beast).min;
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
  THREE,
  gait: () => ({ stride: STRIDE, legLen: LEG_LEN, duty: DUTY, hip: HIP_ANGLE, knee: KNEE_ANGLE, speed }),
  lastCorrection: () => lastCorrection,
};

declare global { interface Window { __WALK__?: unknown } }
