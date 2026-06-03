const METADATA_KEY = "com.fireball.calculator/3d-map-data";
let sceneMetadata = { walls: [], zones: {} };
let currentTool = null;

OBR.onReady(async () => {
    document.getElementById('status').innerText = "Плагин готов. Выберите режим.";
    await loadMapGeometry();

    document.getElementById('cast-btn').addEventListener('click', startFireballCast);
    document.getElementById('clear-btn').addEventListener('click', clearAll);
});

async function loadMapGeometry() {
    const meta = await OBR.scene.getMetadata();
    if (meta && meta[METADATA_KEY]) {
        sceneMetadata = meta[METADATA_KEY];
        if (!sceneMetadata.walls) sceneMetadata.walls = [];
        if (!sceneMetadata.zones) sceneMetadata.zones = {};
    }
}

function toggleTool(toolName) {
    if (currentTool === toolName) {
        currentTool = null;
    } else {
        currentTool = toolName;
    }

    // Обновляем визуальное состояние кнопок
    document.getElementById('btn-wall').classList.toggle('active', currentTool === 'wall');
    document.getElementById('btn-zone').classList.toggle('active', currentTool === 'zone');
    document.getElementById('zone-inputs').style.display = currentTool === 'zone' ? 'block' : 'none';

    if (currentTool) {
        document.getElementById('status').innerText = `Инструмент [${currentTool}] активен. Выделяйте область на карте.`;
        startCaptureLoop();
    } else {
        document.getElementById('status').innerText = "Режим разметки отключен.";
    }
}

// Зацикленный перехват прямоугольных областей с карты Совуха
async function startCaptureLoop() {
    while (currentTool !== null) {
        try {
            // Используем стандартный выбор области Совуха — это заменяет нам рисование кистью
            const area = await OBR.interaction.selectArea({
                hint: `Зажмите ЛКМ и протяните область, чтобы разметить [${currentTool}]`
            });

            if (!area || area.length < 2) {
                toggleTool(null);
                break;
            }

            await processAreaDraw(area[0], area[1]);
        } catch (e) {
            console.error(e);
            toggleTool(null);
            break;
        }
    }
}

async function getGridCoords(pos) {
    const dpi = await OBR.scene.grid.getDpi();
    return {
        x: Math.floor(pos.x / dpi),
        y: Math.floor(pos.y / dpi)
    };
}

// Просчет всех клеток внутри выделенной области (Drag-selection)
async function processAreaDraw(p1, p2) {
    const dpi = await OBR.scene.grid.getDpi();
    
    const minX = Math.min(p1.x, p2.x);
    const maxX = Math.max(p1.x, p2.x);
    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);

    const startGrid = { x: Math.floor(minX / dpi), y: Math.floor(minY / dpi) };
    const endGrid = { x: Math.floor(maxX / dpi), y: Math.floor(maxY / dpi) };

    for (let gx = startGrid.x; gx <= endGrid.x; gx++) {
        for (let gy = startGrid.y; gy <= endGrid.y; gy++) {
            const cellKey = `${gx},${gy}`;

            if (currentTool === 'wall') {
                if (!sceneMetadata.walls.includes(cellKey)) {
                    sceneMetadata.walls.push(cellKey);
                    await drawVisualMarker(gx, gy, cellKey, "#111111", "СТЕНА", 0.7);
                }
            } else if (currentTool === 'zone') {
                const ceil = parseInt(document.getElementById('geo-ceiling').value) || 10;
                const floor = parseInt(document.getElementById('geo-floor').value) || 0;
                
                sceneMetadata.zones[cellKey] = { ceiling: ceil, floor: floor };
                await drawVisualMarker(gx, gy, cellKey, "#0055ff", `П:${ceil}/Пл:${floor}`, 0.4);
            }
        }
    }
    await OBR.scene.setMetadata({ [METADATA_KEY]: sceneMetadata });
}

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
        position: { x: gx * dpi + 2, y: gy * dpi + (dpi / 2) - 4 },
        attachedTo: rect.id
    });
    text.metadata["com.fireball.calculator/marker-id"] = key;

    await OBR.scene.items.addItems([rect, text]);
}

// Запуск анимации взрыва
async function startFireballCast() {
    toggleTool(null);
    document.getElementById('status').innerText = "Выберите эпицентр взрыва фаербола...";
    
    const target = await OBR.interaction.selectTarget({ hint: "Кликните в точку детонации" });
    if (!target) {
        document.getElementById('status').innerText = "Каст отменен.";
        return;
    }

    const startGrid = await getGridCoords(target.position);
    const castH = parseInt(document.getElementById('cast-height').value) || 5;

    document.getElementById('status').innerText = "Расчет объема фаербола...";
    const animationSteps = run3DFloodFillLayers(startGrid, castH);
    await animateExplosion(animationSteps);
}

function run3DFloodFillLayers(startGrid, castHeight) {
    const TOTAL_VOLUME_BLOCKS = 268; // 33510 куб. футов / 125 футов объем куба
    const cellSizeInFt = 5;
    let usedBlocks = 0;
    
    let queue = [];
    let visited = new Set();
    let steps = [];

    const startKey = `${startGrid.x},${startGrid.y}`;
    let currentCeil = sceneMetadata.zones[startKey] ? sceneMetadata.zones[startKey].ceiling : 10;
    let currentFloor = sceneMetadata.zones[startKey] ? sceneMetadata.zones[startKey].floor : 0;
    let startZ = Math.floor(castHeight / cellSizeInFt);

    queue.push({ x: startGrid.x, y: startGrid.y, z: startZ, depth: 0 });
    visited.add(`${startGrid.x},${startGrid.y},${startZ}`);

    while (queue.length > 0 && usedBlocks < TOTAL_VOLUME_BLOCKS) {
        let current = queue.shift();
        usedBlocks++;

        if (!steps[current.depth]) steps[current.depth] = [];
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
    return steps.filter(s => s && s.length > 0);
}

async function animateExplosion(steps) {
    const dpi = await OBR.scene.grid.getDpi();
    let totalCells = 0;

    for (let i = 0; i < steps.length; i++) {
        const itemsToCreate = [];
        for (let cell of steps[i]) {
            const rect = OBR.item.createShape({
                shapeType: "RECTANGLE",
                width: dpi,
                height: dpi,
                fillColor: "#ff3300",
                fillOpacity: 0.5,
                strokeColor: "#ffaa00",
                strokeWidth: 1,
                position: { x: cell.x * dpi, y: cell.y * dpi }
            });
            rect.metadata["com.fireball.calculator/explosion-fire"] = true;
            itemsToCreate.push(rect);
            totalCells++;
        }
        if (itemsToCreate.length > 0) await OBR.scene.items.addItems(itemsToCreate);
        await new Promise(r => setTimeout(r, 60)); // Скорость волны анимации распространения огня
    }
    document.getElementById('status').innerText = `Взрыв завершен! Покрыто уникальных клеток: ${totalCells}`;
}

async function clearAll() {
    toggleTool(null);
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
