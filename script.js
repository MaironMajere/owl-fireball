const METADATA_KEY = "com.fireball.calculator/3d-map-data";
const TOOL_ID_WALL = "com.fireball.calculator/tool-wall";
const TOOL_ID_ZONE = "com.fireball.calculator/tool-zone";

let sceneMetadata = { walls: [], zones: {} };
let isDrawing = false;

OBR.onReady(async () => {
    document.getElementById('status').innerText = "Плагин запущен. Инструменты добавлены в панель.";
    await loadMapGeometry();

    // Регистрируем инструмент Кисти для стен в левую панель совы
    await OBR.tool.create({
        id: TOOL_ID_WALL,
        icons: [
            {
                icon: "https://maironmajere.github.io/owl-fireball/icon.svg",
                label: "Стена (Кисть)",
                sides: ["GM"]
            }
        ],
        async onPointerDown(context, event) {
            isDrawing = true;
            await handleWallDraw(event.pointerPosition);
        },
        async onPointerMove(context, event) {
            if (isDrawing) {
                await handleWallDraw(event.pointerPosition);
            }
        },
        onPointerUp() {
            isDrawing = false;
        }
    });

    // Регистрируем инструмент Зон (Пол / Потолок) в левую панель совы
    await OBR.tool.create({
        id: TOOL_ID_ZONE,
        icons: [
            {
                icon: "https://maironmajere.github.io/owl-fireball/icon.svg",
                label: "Зона (Пол/Потолок)",
                sides: ["GM"]
            }
        ],
        async onPointerDown(context, event) {
            await handleZoneDraw(event.pointerPosition);
        }
    });

    // Назначаем события на кнопки поповера
    document.getElementById('cast-btn').addEventListener('click', startFireballCast);
    document.getElementById('clear-btn').addEventListener('click', clearAll);
});

// Загрузка геометрии из метаданных сцены
async function loadMapGeometry() {
    const meta = await OBR.scene.getMetadata();
    if (meta && meta[METADATA_KEY]) {
        sceneMetadata = meta[METADATA_KEY];
        if (!sceneMetadata.walls) sceneMetadata.walls = [];
        if (!sceneMetadata.zones) sceneMetadata.zones = {};
    }
}

// Преобразование координат клика в индексы сетки
async function getGridCoords(pos) {
    const dpi = await OBR.scene.grid.getDpi();
    return {
        x: Math.floor(pos.x / dpi),
        y: Math.floor(pos.y / dpi)
    };
}

// Рисование стен кистью (срабатывает при движении мыши)
async function handleWallDraw(pos) {
    const grid = await getGridCoords(pos);
    const cellKey = `${grid.x},${grid.y}`;

    if (!sceneMetadata.walls.includes(cellKey)) {
        sceneMetadata.walls.push(cellKey);
        await drawVisualMarker(grid.x, grid.y, cellKey, "#111111", "СТЕНА", 0.8);
        await OBR.scene.setMetadata({ [METADATA_KEY]: sceneMetadata });
    }
}

// Рисование зон (Полы, Потолки, Ямы)
async function handleZoneDraw(pos) {
    const grid = await getGridCoords(pos);
    const cellKey = `${grid.x},${grid.y}`;

    const ceil = parseInt(document.getElementById('geo-ceiling').value) || 10;
    const floor = parseInt(document.getElementById('geo-floor').value) || 0;

    // Если кликнули по существующей кастомной зоне — удаляем её
    if (sceneMetadata.zones[cellKey]) {
        delete sceneMetadata.zones[cellKey];
        await removeVisualMarker(cellKey);
    } else {
        sceneMetadata.zones[cellKey] = { ceiling: ceil, floor: floor };
        let label = `П:${ceil}/Пл:${floor}`;
        if (floor < 0) label = `ЯМА:${floor}`;
        await drawVisualMarker(grid.x, grid.y, cellKey, "#0055ff", label, 0.4);
    }

    await OBR.scene.setMetadata({ [METADATA_KEY]: sceneMetadata });
}

// Отрисовка служебных маркеров для ГМа
async function drawVisualMarker(gx, gy, key, color, label, opacity) {
    const dpi = await OBR.scene.grid.getDpi();
    const allItems = await OBR.scene.items.getItems();
    if (allItems.some(i => i.metadata["com.fireball.calculator/marker-id"] === key)) return;

    const rect = OBR.item.createShape({
        shapeType: "RECTANGLE",
        width: dpi,
        height: dpi,
        fillColor: color,
        fillOpacity: opacity,
        strokeColor: "#ffffff",
        strokeWidth: 1,
        position: { x: gx * dpi, y: gy * dpi },
        attachedTo: "",
        locked: true
    });
    rect.metadata["com.fireball.calculator/marker-id"] = key;

    const text = OBR.item.createText({
        text: label,
        fontSize: 9,
        fillColor: "#ffffff",
        position: { x: gx * dpi + 2, y: gy * dpi + (dpi / 2) - 5 },
        attachedTo: rect.id
    });
    text.metadata["com.fireball.calculator/marker-id"] = key;

    await OBR.scene.items.addItems([rect, text]);
}

// Удаление маркера с карты
async function removeVisualMarker(key) {
    const allItems = await OBR.scene.items.getItems();
    const toDelete = allItems.filter(i => i.metadata["com.fireball.calculator/marker-id"] === key).map(i => i.id);
    if (toDelete.length > 0) await OBR.scene.items.deleteItems(toDelete);
}

// Инициализация каста фаербола
async function startFireballCast() {
    document.getElementById('status').innerText = "Выберите точку взрыва на карте...";
    
    const target = await OBR.interaction.selectTarget({ hint: "Кликните на клетку-эпицентр фаербола" });
    if (!target) {
        document.getElementById('status').innerText = "Каст отменен.";
        return;
    }

    const startGrid = await getGridCoords(target.position);
    const castH = parseInt(document.getElementById('cast-height').value) || 5;

    document.getElementById('status').innerText = "Расчет траектории расширения газа...";
    
    // Получаем пошаговые слои для анимации распространения
    const animationSteps = run3DFloodFillLayers(startGrid, castH);
    await animateExplosion(animationSteps);
}

// 3D Flood Fill, возвращающий массив шагов (волн распространения)
function run3DFloodFillLayers(startGrid, castHeight) {
    const TOTAL_VOLUME_BLOCKS = 268; // 33510 куб. футов / 125 (объем куба 5х5х5)
    const cellSizeInFt = 5;
    let usedBlocks = 0;
    
    let queue = [];
    let visited = new Set();
    let steps = []; // Массив массивов координат для пошаговой анимации

    const startKey = `${startGrid.x},${startGrid.y}`;
    let currentCeil = sceneMetadata.zones[startKey] ? sceneMetadata.zones[startKey].ceiling : 10;
    let currentFloor = sceneMetadata.zones[startKey] ? sceneMetadata.zones[startKey].floor : 0;

    let startZ = Math.floor(castHeight / cellSizeInFt);

    queue.push({ x: startGrid.x, y: startGrid.y, z: startZ, depth: 0 });
    visited.add(`${startGrid.x},${startGrid.y},${startZ}`);

    while (queue.length > 0 && usedBlocks < TOTAL_VOLUME_BLOCKS) {
        let current = queue.shift();
        usedBlocks++;

        if (!steps[current.depth]) {
            steps[current.depth] = [];
        }
        steps[current.depth].push({ x: current.x, y: current.y });

        const directions = [
            { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
            { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
            { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }
        ];

        for (let d of directions) {
            let nX = current.x + d.x;
            let nY = current.y + d.y;
            let nZ = current.z + d.z;
            let targetCellKey = `${nX},${nY}`;
            let target3DKey = `${nX},${nY},${nZ}`;

            if (sceneMetadata.walls.includes(targetCellKey)) continue;

            let cellCeil = sceneMetadata.zones[targetCellKey] ? sceneMetadata.zones[targetCellKey].ceiling : 10;
            let cellFloor = sceneMetadata.zones[targetCellKey] ? sceneMetadata.zones[targetCellKey].floor : 0;
            let cellMinZ = Math.floor(-cellFloor / cellSizeInFt);
            let cellMaxZ = Math.ceil(cellCeil / cellSizeInFt);

            if (nZ < cellMinZ || nZ >= cellMaxZ) continue;

            if (!visited.has(target3DKey)) {
                visited.add(target3DKey);
                queue.push({ x: nX, y: nY, z: nZ, depth: current.depth + 1 });
            }
        }
    }
    return steps.filter(step => step && step.length > 0);
}

// Пошаговая плавная анимация взрыва пламени
async function animateExplosion(steps) {
    const dpi = await OBR.scene.grid.getDpi();
    let totalCellsRendered = 0;

    for (let i = 0; i < steps.length; i++) {
        const itemsToCreate = [];
        const layer = steps[i];

        for (let cell of layer) {
            const rect = OBR.item.createShape({
                shapeType: "RECTANGLE",
                width: dpi,
                height: dpi,
                fillColor: "#ff3300",
                fillOpacity: 0.5,
                strokeColor: "#ffcc00",
                strokeWidth: 1.5,
                position: { x: cell.x * dpi, y: cell.y * dpi },
                attachedTo: "",
                locked: false
            });
            rect.metadata["com.fireball.calculator/explosion-fire"] = true;
            itemsToCreate.push(rect);
            totalCellsRendered++;
        }

        if (itemsToCreate.length > 0) {
            await OBR.scene.items.addItems(itemsToCreate);
        }
        
        // Задержка между волнами расширения газа в миллисекундах
        await new Promise(resolve => setTimeout(resolve, 80));
    }

    document.getElementById('status').innerText = `Бум! Задето уникальных 2D клеток: ${totalCellsRendered}`;
}

// Полная очистка сцены от огня и разметки геометрии
async function clearAll() {
    const allItems = await OBR.scene.items.getItems();
    const toDelete = allItems.filter(i => 
        i.metadata["com.fireball.calculator/marker-id"] || 
        i.metadata["com.fireball.calculator/explosion-fire"]
    ).map(i => i.id);
    
    if (toDelete.length > 0) await OBR.scene.items.deleteItems(toDelete);
    
    sceneMetadata = { walls: [], zones: {} };
    await OBR.scene.setMetadata({ [METADATA_KEY]: sceneMetadata });
    document.getElementById('status').innerText = "Сцена полностью очищена.";
}
