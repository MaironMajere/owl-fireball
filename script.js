let OBR;
// Ждем инициализации SDK Совуха
window.onload = async () => {
    if (typeof window.OBR === 'undefined') {
        document.getElementById('output').innerText = "Ошибка: SDK не найден";
        return;
    }
    OBR = window.OBR;
    
    document.getElementById('calc-btn').addEventListener('click', startFireballCast);
};

async function startFireballCast() {
    document.getElementById('output').innerText = "Выберите точку детонации на карте...";
    
    // Заставляем пользователя кликнуть на карту для выбора центра
    const target = await OBR.interaction.selectTarget({
        hint: "Кликните на карту для взрыва Фаербола",
    });

    if (!target) {
        document.getElementById('output').innerText = "Отменено";
        return;
    }

    // Получаем настройки трехмерного пространства из интерфейса
    const ceilingMax = parseInt(document.getElementById('ceiling').value) || 10;
    const floorMax = parseInt(document.getElementById('floor').value) || 0;
    const epicenterH = parseInt(document.getElementById('epicenter-height').value) || 5;

    // Считаем сетку взрыва
    const affectedCells = calculate3DFloodFill(target.position, ceilingMax, floorMax, epicenterH);
    
    // Рисуем результат в Owlbear Rodeo
    await drawFireballOnMap(affectedCells, target.position);
    document.getElementById('output').innerText = `Взрыв обработан! Задето клеток: ${affectedCells.length}`;
}

// Алгоритм 3D Flood Fill под правила AD&D 2e
function calculate3DFloodFill(startPos, ceiling, floor, epicenterH) {
    const TOTAL_VOLUME_BLOCKS = 268; // 33510 / 125
    const cellSizeInFt = 5;
    
    // Считаем сколько слоев по 5 футов у нас есть вверх и вниз от условного "нуля" карты
    const minZ = Math.floor(-floor / cellSizeInFt);
    const maxZ = Math.ceil(ceiling / cellSizeInFt);
    const startZ = Math.floor(epicenterH / cellSizeInFt);

    let usedBlocks = 0;
    let queue = [];
    let visited = new Set();
    let result2DCells = []; // Клетки на плоскости карты, которые мы закрасим

    // Точка старта (координаты в клетках сетки относительно эпицентра)
    queue.push({x: 0, y: 0, z: startZ});
    visited.add(`0,0,${startZ}`);

    while (queue.length > 0 && usedBlocks < TOTAL_VOLUME_BLOCKS) {
        let current = queue.shift();
        usedBlocks++;

        // Сохраняем координату для отрисовки
        if (!result2DCells.some(c => c.x === current.x && c.y === current.y)) {
            result2DCells.push({x: current.x, y: current.y});
        }

        // Шесть направлений распространения газа/огня (3D)
        const directions = [
            {x: 1, y: 0, z: 0},  {x: -1, y: 0, z: 0},
            {x: 0, y: 1, z: 0},  {x: 0, y: -1, z: 0},
            {x: 0, y: 0, z: 1},  {x: 0, y: 0, z: -1}
        ];

        for (let d of directions) {
            let nextX = current.x + d.x;
            let nextY = current.y + d.y;
            let nextZ = current.z + d.z;
            let key = `${nextX},${nextY},${nextZ}`;

            // Проверяем физические границы потолка и пола
            if (nextZ < minZ || nextZ >= maxZ) continue; 

            if (!visited.has(key)) {
                visited.add(key);
                queue.push({x: nextX, y: nextY, z: nextZ});
            }
        }
    }
    return result2DCells;
}

// Функция отрисовки эффекта на самой игровой доске Owlbear Rodeo
async function drawFireballOnMap(cells, basePosition) {
    const scale = await OBR.scene.grid.getScale();
    const dpi = await OBR.scene.grid.getDpi();
    
    // Размер одной клетки в пикселях на экране
    const pixelsPerCell = dpi; 

    const itemsToCreate = [];

    // Рисуем полупрозрачные красные квадраты поверх задетых клеток
    for (let cell of cells) {
        const posX = basePosition.x + (cell.x * pixelsPerCell);
        const posY = basePosition.y + (cell.y * pixelsPerCell);

        const rect = OBR.item.createShape({
            shapeType: "RECTANGLE",
            width: pixelsPerCell,
            height: pixelsPerCell,
            fillColor: "#ff4500",
            fillOpacity: 0.4,
            strokeColor: "#ff0000",
            strokeWidth: 2,
            position: { x: posX, y: posY },
            attachedTo: "",
            locked: false,
        });
        
        // Помечаем кастомным тегом, чтобы потом можно было чистить эти элементы одним кликом
        rect.metadata["com.fireball.calculator/item"] = true;
        itemsToCreate.push(rect);
    }

    // Закидываем созданные полигоны в текущую сцену совуха
    await OBR.scene.items.addItems(itemsToCreate);
}
