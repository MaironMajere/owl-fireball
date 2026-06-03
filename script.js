let currentTool = null;
let sceneMetadata = { walls: [], zones: {} };
const METADATA_KEY = "com.fireball.calculator/3d-map-data";

// Инициализация при готовности SDK
OBR.onReady(async () => {
    document.getElementById('status').innerText = "Плагин готов к работе.";
    await loadMapGeometry();
    
    // Привязываем каст фаербола
    document.getElementById('cast-btn').addEventListener('click', startFireballCast);
});

// Переключение режимов разметки
function setTool(toolName) {
    // Если нажали на ту же кнопку — выключаем инструмент
    currentTool = currentTool === toolName ? null : toolName;
    
    // Сбрасываем стили кнопок в HTML
    document.getElementById('tool-wall').classList.remove('active');
    document.getElementById('tool-zone').classList.remove('active');
    document.getElementById('zone-options').style.display = 'none';

    if (currentTool) {
        document.getElementById(`tool-${currentTool}`).classList.add('active');
        if (currentTool === 'zone') document.getElementById('zone-options').style.display = 'block';
        document.getElementById('status').innerText = `Режим [${toolName}] включен. Кликайте по клеткам.`;
        
        // Запускаем бесконечный цикл ловли кликов
        startClickLoop();
    } else {
        document.getElementById('status').innerText = "Режим разметки отключен.";
    }
}

// Цикл, который заставляет Оулбир принимать клики один за другим без падения API
async function startClickLoop() {
    while (currentTool !== null) {
        try {
            const target = await OBR.interaction.selectTarget({
                hint: `Разметка [${currentTool}]: выберите клетку на карте (Esc для отмены)`
            });
            
            if (!target) {
                setTool(null);
                break;
            }
            
            await handleGridSelection(target.position);
        } catch (error) {
            console.error("Ошибка выбора цели:", error);
            setTool(null);
            break;
        }
    }
}

// Преобразование абсолютных пикселей Совуха в индексы сетки
async function getGridCoords(pos) {
    const dpi = await OBR.scene.grid.getDpi();
    return {
        x: Math.floor(pos.x / dpi),
        y: Math.floor(pos.y / dpi)
    };
}

// Обработка клика по конкретной клетке сетки
async function handleGridSelection(absolutePos) {
    const grid = await getGridCoords(absolutePos);
    const cellKey = `${grid.x},${grid.y}`;

    if (currentTool === 'wall') {
        const index = sceneMetadata.walls.indexOf(cellKey);
        if (index > -1) {
            // Если стена уже была — удаляем маркер
            sceneMetadata.walls.splice(index, 1);
            await removeVisualMarker(cellKey);
        } else {
            // Если стены нет — добавляем
            sceneMetadata.walls.push(cellKey);
            await drawVisualMarker(grid.x, grid.y, cellKey, "#111111", "СТЕНА", 0.7);
        }
    } else if (currentTool === 'zone') {
        if (sceneMetadata.zones[cellKey]) {
            delete sceneMetadata.zones[cellKey];
            await removeVisualMarker(cellKey);
        } else {
            const ceil = parseInt(document.getElementById('geo-ceiling').value) || 10;
            const floor = parseInt(document.getElementById('geo-floor').value) || 0;
            sceneMetadata.zones[cellKey] = { ceiling: ceil, floor: floor };
            await drawVisualMarker(grid.x, grid.y, cellKey, "#0055ff", `H:${ceil}/-${floor}`, 0.4);
        }
    }

    // Сохраняем обновленные данные в метаданные сцены
    await OBR.scene.setMetadata({ [METADATA_KEY]: sceneMetadata });
}

// Рисование квадратов разметки для Мастера
async function drawVisualMarker(gx, gy, key, color, label, opacity) {
    const dpi = await OBR.scene.grid.getDpi();
    
    // Проверка на дубликаты
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
        fontSize: 10,
        fillColor: "#ffffff",
        position: { x: gx * dpi + 2, y: gy * dpi + (dpi / 2) - 5 },
        attachedTo: rect.id
    });
    text.metadata["com.fireball.calculator/marker-id"] = key;

    await OBR.scene.items.addItems([rect, text]);
}

// Удаление маркера разметки с карты
async function removeVisualMarker(key) {
    const allItems = await OBR.scene.items.getItems();
    const toDelete = allItems.filter(i => i.metadata["com.fireball.calculator/marker-id"] === key).map(i => i.id);
    if (toDelete.length > 0) await OBR.scene.items.deleteItems(toDelete);
}

// Загрузка геометрии при старте
async function loadMapGeometry() {
    const meta = await OBR.scene.getMetadata();
    if (meta && meta[METADATA_KEY]) {
        sceneMetadata = meta[METADATA_KEY];
        if (!sceneMetadata.walls) sceneMetadata.walls = [];
        if (!sceneMetadata.zones) sceneMetadata.zones = {};
    }
}

// Логика каста огненного шара
async function startFireballCast() {
    // Отключаем активные инструменты разметки, если они были включены
    currentTool = null;
    document.getElementById('tool-wall').classList.remove('active');
    document.getElementById('tool-zone').classList.remove('active');
    
    document.getElementById('status').innerText = "Выберите эпицентр взрыва...";
    
    const target = await OBR.interaction.selectTarget({ hint: "Кликните туда, где взорвется Фаербол" });
    if (!target) {
        document.getElementById('status').innerText = "Каст отменен.";
        return;
    }

    const startGrid = await getGridCoords(target.position);
    const castH = parseInt(document.getElementById('cast-height').value) || 5;

    document.getElementById('status').innerText = "Магия считает кубические футы...";
    
    const affectedCells = runAdnd3DFloodFill(startGrid, castH);
    await drawFireballExplosion(affectedCells);
    document.getElementById('status').innerText = `Бум! Задето клеток: ${affectedCells.length}`;
}

// 3D Flood Fill алгоритм (AD&D 2e)
function runAdnd3DFloodFill(startGrid, castHeight) {
    const TOTAL_VOLUME_BLOCKS = 268; // 33510 куб. футов / 125
    const cellSizeInFt = 5;
    let usedBlocks = 0;
    let queue = [];
    let visited = new Set();
    let final2DExplosion = new Set();

    const startKey = `${startGrid.x},${startGrid.y}`;
    let currentCeil = sceneMetadata.zones[startKey] ? sceneMetadata.zones[startKey].ceiling : 10;
    let currentFloor = sceneMetadata.zones[startKey] ? sceneMetadata.zones[startKey].floor : 0;

    let minZ = Math.floor(-currentFloor / cellSizeInFt);
    let maxZ = Math.ceil(currentCeil / cellSizeInFt);
    let startZ = Math.floor(castHeight / cellSizeInFt);

    queue.push({ x: startGrid.x, y: startGrid.y, z: startZ });
    visited.add(`${startGrid.x},${startGrid.y},${startZ}`);

    while (queue.length > 0 && usedBlocks < TOTAL_VOLUME_BLOCKS) {
        let current = queue.shift();
        usedBlocks++;
        final2DExplosion.add(`${current.x},${current.y}`);

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

            // Проверка на стену
            if (sceneMetadata.walls.includes(targetCellKey)) continue;

            // Проверка на кастомную высоту зоны
            let cellCeil = sceneMetadata.zones[targetCellKey] ? sceneMetadata.zones[targetCellKey].ceiling : 10;
            let cellFloor = sceneMetadata.zones[targetCellKey] ? sceneMetadata.zones[targetCellKey].floor : 0;
            let cellMinZ = Math.floor(-cellFloor / cellSizeInFt);
            let cellMaxZ = Math.ceil(cellCeil / cellSizeInFt);

            if (nZ < cellMinZ || nZ >= cellMaxZ) continue;

            if (!visited.has(target3DKey)) {
                visited.add(target3DKey);
                queue.push({ x: nX, y: nY, z: nZ });
            }
        }
    }
    return Array.from(final2DExplosion).map(s => {
        const [x, y] = s.split(',').map(Number);
        return { x, y };
    });
}

// Визуализация взрыва пламени
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

// Полная очистка сцены
async function clearAll() {
    const allItems = await OBR.scene.items.getItems();
    const toDelete = allItems.filter(i => 
        i.metadata["com.fireball.calculator/marker-id"] || 
        i.metadata["com.fireball.calculator/explosion-fire"]
    ).map(i => i.id);
    
    if (toDelete.length > 0) await OBR.scene.items.deleteItems(toDelete);
    
    sceneMetadata = { walls: [], zones: {} };
    await OBR.scene.setMetadata({ [METADATA_KEY]: sceneMetadata });
    document.getElementById('status').innerText = "Вся геометрия очищена.";
}
