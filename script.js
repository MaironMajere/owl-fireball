let currentTool = null;
let sceneMetadata = { walls: [], zones: {} };
let isDrawing = false; // Флаг: зажата ли мышь прямо сейчас
const METADATA_KEY = "com.fireball.calculator/3d-map-data";

OBR.onReady(async () => {
    document.getElementById('status').innerText = "Совух готов. Выберите кисть.";
    
    await loadMapGeometry();

    document.getElementById('cast-btn').addEventListener('click', startFireballCast);

    // 1. Нажали кнопку мыши на карте — включаем режим рисования
    OBR.interaction.onPointerDown(async (info) => {
        if (!currentTool) return;
        isDrawing = true;
        await handleMapDraw(info.position);
    });

    // 2. Ведем мышью с зажатой кнопкой — красим все клетки на пути
    OBR.interaction.onPointerMove(async (info) => {
        if (!currentTool || !isDrawing) return;
        await handleMapDraw(info.position);
    });

    // 3. Отпустили мышь или увели с карты — стопаем рисование
    OBR.interaction.onPointerUp(() => {
        isDrawing = false;
    });
});

function setTool(toolName) {
    currentTool = currentTool === toolName ? null : toolName;
    isDrawing = false;
    
    document.getElementById('tool-wall').classList.remove('active');
    document.getElementById('tool-zone').classList.remove('active');
    document.getElementById('zone-options').style.display = 'none';

    if (currentTool) {
        document.getElementById(`tool-${currentTool}`).classList.add('active');
        if (currentTool === 'zone') document.getElementById('zone-options').style.display = 'block';
        document.getElementById('status').innerText = `Кисть [${toolName}] активна. Зажмите ЛКМ и рисуйте на карте.`;
    } else {
        document.getElementById('status').innerText = "Режим рисования отключен.";
    }
}

async function getGridCoords(pos) {
    const dpi = await OBR.scene.grid.getDpi();
    return {
        x: Math.floor(pos.x / dpi),
        y: Math.floor(pos.y / dpi)
    };
}

// Основная функция рисования кистью
async function handleMapDraw(absolutePos) {
    const grid = await getGridCoords(absolutePos);
    const cellKey = `${grid.x},${grid.y}`;

    if (currentTool === 'wall') {
        // Если этой клетки еще нет в стенах — красим её
        if (!sceneMetadata.walls.includes(cellKey)) {
            sceneMetadata.walls.push(cellKey);
            await drawVisualMarker(grid.x, grid.y, cellKey, "#111111", "СТЕНА", 0.8);
            await saveMetadata();
        }
    } else if (currentTool === 'zone') {
        // Если клетка еще не размечена под эту высоту — красим
        if (!sceneMetadata.zones[cellKey]) {
            const ceil = parseInt(document.getElementById('geo-ceiling').value) || 10;
            const floor = parseInt(document.getElementById('geo-floor').value) || 0;
            
            sceneMetadata.zones[cellKey] = { ceiling: ceil, floor: floor };
            await drawVisualMarker(grid.x, grid.y, cellKey, "#0055ff", `H:${ceil}/-${floor}`, 0.4);
            await saveMetadata();
        }
    }
}

async function saveMetadata() {
    await OBR.scene.setMetadata({ [METADATA_KEY]: sceneMetadata });
}

async function drawVisualMarker(gx, gy, key, color, label, opacity) {
    const dpi = await OBR.scene.grid.getDpi();
    
    // Проверяем, нет ли уже маркера на этой клетке, чтобы не плодить дубликаты при движении мыши
    const allItems = await OBR.scene.items.getItems();
    const exists = allItems.some(i => i.metadata["com.fireball.calculator/marker-id"] === key);
    if (exists) return;

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

async function loadMapGeometry() {
    const meta = await OBR.scene.getMetadata();
    if (meta && meta[METADATA_KEY]) {
        sceneMetadata = meta[METADATA_KEY];
        if (!sceneMetadata.walls) sceneMetadata.walls = [];
        if (!sceneMetadata.zones) sceneMetadata.zones = {};
    }
}

// Каст Фаербола
async function startFireballCast() {
    setTool(null); 
    document.getElementById('status').innerText = "Кликните на карту для взрыва...";
    
    const target = await OBR.interaction.selectTarget({ hint: "Выберите эпицентр фаербола" });
    if (!target) {
        document.getElementById('status').innerText = "Каст отменен.";
        return;
    }

    const startGrid = await getGridCoords(target.position);
    const castH = parseInt(document.getElementById('cast-height').value) || 5;

    document.getElementById('status').innerText = "Просчет объема взрыва...";
    
    const affectedCells = runAdnd3DFloodFill(startGrid, castH);
    await drawFireballExplosion(affectedCells);
    document.getElementById('status').innerText = `Бум! Задето клеток: ${affectedCells.length}`;
}

function runAdnd3DFloodFill(startGrid, castHeight) {
    const TOTAL_VOLUME_BLOCKS = 268; 
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

    queue.push({x: startGrid.x, y: startGrid.y, z: startZ});
    visited.add(`${startGrid.x},${startGrid.y},${startZ}`);

    while (queue.length > 0 && usedBlocks < TOTAL_VOLUME_BLOCKS) {
        let current = queue.shift();
        usedBlocks++;

        final2DExplosion.add(`${current.x},${current.y}`);

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

            if (sceneMetadata.walls.includes(targetCellKey)) continue;

            let cellCeil = sceneMetadata.zones[targetCellKey] ? sceneMetadata.zones[targetCellKey].ceiling : 10;
            let cellFloor = sceneMetadata.zones[targetCellKey] ? sceneMetadata.zones[targetCellKey].floor : 0;
            
            let cellMinZ = Math.floor(-cellFloor / cellSizeInFt);
            let cellMaxZ = Math.ceil(cellCeil / cellSizeInFt);

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
    await saveMetadata();
    document.getElementById('status').innerText = "Карта очищена.";
}
