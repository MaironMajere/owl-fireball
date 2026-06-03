let currentTool = null;
let sceneMetadata = { walls: [], zones: {} };
const METADATA_KEY = "com.fireball.calculator/3d-map-data";

// Исправляем падение SDK: стартуем строго после готовности Оулбира
OBR.onReady(async () => {
    document.getElementById('status').innerText = "Совух готов к разметке.";
    
    // Подгружаем старую геометрию, если она уже была размечена на этой карте
    await loadMapGeometry();

    // Вешаем событие на кнопку каста
    document.getElementById('cast-btn').addEventListener('click', startFireballCast);

    // Вешаем слушатель кликов по карте для разметки геометрии
    OBR.interaction.onPointerClick(async (info) => {
        if (!currentTool) return;
        await handleMapClick(info.position);
    });
});

function setTool(toolName) {
    currentTool = currentTool === toolName ? null : toolName;
    
    // Сбрасываем подсветку кнопок
    document.getElementById('tool-wall').classList.remove('active');
    document.getElementById('tool-zone').classList.remove('active');
    document.getElementById('zone-options').style.display = 'none';

    if (currentTool) {
        document.getElementById(`tool-${currentTool}`).classList.add('active');
        if (currentTool === 'zone') document.getElementById('zone-options').style.display = 'block';
        document.getElementById('status').innerText = `Инструмент [${toolName}] активен. Кликайте по клеткам карты.`;
    } else {
        document.getElementById('status').innerText = "Режим рисования отключен.";
    }
}

// Перевод экранных координат клика в координаты сетки (индексы клеток)
async function getGridCoords(pos) {
    const dpi = await OBR.scene.grid.getDpi();
    return {
        x: Math.floor(pos.x / dpi),
        y: Math.floor(pos.y / dpi)
    };
}

// Обработка клика при разметке стен и потолков
async function handleMapClick(absolutePos) {
    const grid = await getGridCoords(absolutePos);
    const cellKey = `${grid.x},${grid.y}`;
    const dpi = await OBR.scene.grid.getDpi();

    if (currentTool === 'wall') {
        // Если стена уже есть — убираем, если нет — добавляем (тогл)
        const index = sceneMetadata.walls.indexOf(cellKey);
        if (index > -1) {
            sceneMetadata.walls.splice(index, 1);
            await removeVisualMarker(cellKey);
        } else {
            sceneMetadata.walls.push(cellKey);
            await drawVisualMarker(grid.x, grid.y, cellKey, "#111111", "СТЕНА", 0.8);
        }
    } else if (currentTool === 'zone') {
        const ceil = parseInt(document.getElementById('geo-ceiling').value) || 10;
        const floor = parseInt(document.getElementById('geo-floor').value) || 0;
        
        if (sceneMetadata.zones[cellKey]) {
            delete sceneMetadata.zones[cellKey];
            await removeVisualMarker(cellKey);
        } else {
            sceneMetadata.zones[cellKey] = { ceiling: ceil, floor: floor };
            await drawVisualMarker(grid.x, grid.y, cellKey, "#0055ff", `H:${ceil}/-${floor}`, 0.4);
        }
    }

    // Сохраняем разметку в сцену Совуха, чтобы она не пропала при перезагрузке
    await OBR.scene.setMetadata({ [METADATA_KEY]: sceneMetadata });
}

// Отрисовка служебных маркеров для мастера (стены и зоны высоты)
async function drawVisualMarker(gx, gy, key, color, label, opacity) {
    const dpi = await OBR.scene.grid.getDpi();
    const item = OBR.item.createShape({
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
    item.metadata["com.fireball.calculator/marker-id"] = key;
    
    // Добавляем текстовую плашку для мастера
    const text = OBR.item.createText({
        text: label,
        fontSize: 10,
        fillColor: "#ffffff",
        position: { x: gx * dpi + 2, y: gy * dpi + (dpi/2) - 5 },
        attachedTo: item.id
    });
    text.metadata["com.fireball.calculator/marker-id"] = key;

    await OBR.scene.items.addItems([item, text]);
}

async function removeVisualMarker(key) {
    const allItems = await OBR.scene.items.getItems();
    const toDelete = allItems.filter(i => i.metadata["com.fireball.calculator/marker-id"] === key).map(i => i.id);
    if (toDelete.length > 0) await OBR.scene.items.deleteItems(toDelete);
}

async function loadMapGeometry() {
    const meta = await OBR.scene.getMetadata();
    if (meta && meta[METADATA_KEY]) {
        sceneMetadata = meta[METADATA_KEY];
        if (!sceneMetadata.walls) sceneMetadata.walls = [];
        if (!sceneMetadata.zones) sceneMetadata.zones = {};
    }
}

// Финальный расчет взрыва с учетом созданной геометрии
async function startFireballCast() {
    setTool(null); // Отключаем режимы рисования
    document.getElementById('status').innerText = "Кликните на карту туда, где взрывается фаербол...";
    
    const target = await OBR.interaction.selectTarget({ hint: "Выберите эпицентр фаербола" });
    if (!target) {
        document.getElementById('status').innerText = "Каст отменен.";
        return;
    }

    const startGrid = await getGridCoords(target.position);
    const castH = parseInt(document.getElementById('cast-height').value) || 5;

    document.getElementById('status').innerText = "Магия вычисляет объём...";
    
    // Запускаем симуляцию газа/пламени
    const affectedCells = runAdnd3DFloodFill(startGrid, castH);
    
    // Отрезаем маркеры разметки от финального рисунка пламени и рендерим огонь
    await drawFireballExplosion(affectedCells);
    document.getElementById('status').innerText = `Бум! Заполнено клеток: ${affectedCells.length}`;
}

function runAdnd3DFloodFill(startGrid, castHeight) {
    const TOTAL_VOLUME_BLOCKS = 268; // 33510 кубических футов / 125 футов на блок 5x5x5
    const cellSizeInFt = 5;

    let usedBlocks = 0;
    let queue = [];
    let visited = new Set();
    let final2DExplosion = new Set();

    // Определяем параметры высоты в стартовой точке взрыва
    const startKey = `${startGrid.x},${startGrid.y}`;
    let currentCeil = sceneMetadata.zones[startKey] ? sceneMetadata.zones[startKey].ceiling : 10;
    let currentFloor = sceneMetadata.zones[startKey] ? sceneMetadata.zones[startKey].floor : 0;

    let minZ = Math.floor(-currentFloor / cellSizeInFt);
    let maxZ = Math.ceil(currentCeil / cellSizeInFt);
    let startZ = Math.floor(castHeight / cellSizeInFt);

    queue.push({x: startGrid.x, y: startGrid.y, z: startZ});
    visited.add(`${startGrid.x},${startGrid.y},${startZ}`);

    while (queue.length > 0 && usedBlocks < TOTAL_VOLUME_BLOCKS) {
        let current = queue.shift();
        usedBlocks++;

        final2DExplosion.add(`${current.x},${current.y}`);

        // 6 направлений движения расширяющегося огня
        const directions = [
            {x: 1, y: 0, z: 0}, {x: -1, y: 0, z: 0},
            {x: 0, y: 1, z: 0}, {x: 0, y: -1, z: 0},
            {x: 0, y: 0, z: 1}, {x: 0, y: 0, z: -1}
        ];

        for (let d of directions) {
            let nX = current.x + d.x;
            let nY = current.y + d.y;
            let nZ = current.z + d.z;
            let targetCellKey = `${nX},${nY}`;
            let target3DKey = `${nX},${nY},${nZ}`;

            // Проверка 1: Уперлись в нарисованную стену? Огонь туда не идет.
            if (sceneMetadata.walls.includes(targetCellKey)) continue;

            // Динамически считываем параметры высоты потолка/пола для текущей клетки, куда переливается пламя
            let cellCeil = sceneMetadata.zones[targetCellKey] ? sceneMetadata.zones[targetCellKey].ceiling : 10;
            let cellFloor = sceneMetadata.zones[targetCellKey] ? sceneMetadata.zones[targetCellKey].floor : 0;
            
            let cellMinZ = Math.floor(-cellFloor / cellSizeInFt);
            let cellMaxZ = Math.ceil(cellCeil / cellSizeInFt);

            // Проверка 2: Физические границы потолка и пола конкретно в этой клетке
            if (nZ < cellMinZ || nZ >= cellMaxZ) continue;

            if (!visited.has(target3DKey)) {
                visited.add(target3DKey);
                queue.push({x: nX, y: nY, z: nZ});
            }
        }
    }
    return Array.from(final2DExplosion).map(s => {
        const [x, y] = s.split(',').map(Number);
        return {x, y};
    });
}

async function drawFireballExplosion(cells) {
    const dpi = await OBR.scene.grid.getDpi();
    const itemsToCreate = [];

    for (let cell of cells) {
        const rect = OBR.item.createShape({
            shapeType: "RECTANGLE",
            width: dpi,
            height: dpi,
            fillColor: "#ff2200",
            fillOpacity: 0.5,
            strokeColor: "#ffaa00",
            strokeWidth: 2,
            position: { x: cell.x * dpi, y: cell.y * dpi },
            attachedTo: "",
            locked: false
        });
        rect.metadata["com.fireball.calculator/explosion-fire"] = true;
        itemsToCreate.push(rect);
    }
    await OBR.scene.items.addItems(itemsToCreate);
}

async function clearAll() {
    const allItems = await OBR.scene.items.getItems();
    const toDelete = allItems.filter(i => 
        i.metadata["com.fireball.calculator/marker-id"] || 
        i.metadata["com.fireball.calculator/explosion-fire"]
    ).map(i => i.id);
    
    if (toDelete.length > 0) await OBR.scene.items.deleteItems(toDelete);
    
    sceneMetadata = { walls: [], zones: {} };
    await OBR.scene.setMetadata({ [METADATA_KEY]: sceneMetadata });
    document.getElementById('status').innerText = "Карта полностью очищена.";
}
