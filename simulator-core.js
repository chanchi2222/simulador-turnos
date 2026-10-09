(function (root, factory) {
    const core = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = core;
    } else {
        root.SimulatorCore = core;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const formatLocalDate = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    const parseLocalDate = (value) => {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
        const [year, month, day] = value.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
        date.setHours(0, 0, 0, 0);
        return date;
    };

    const getMonday = (date) => {
        const monday = new Date(date);
        const day = monday.getDay();
        monday.setDate(monday.getDate() - day + (day === 0 ? -6 : 1));
        monday.setHours(0, 0, 0, 0);
        return monday;
    };

    const differenceInCalendarDays = (startDate, endDate) => {
        const startUtc = Date.UTC(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
        const endUtc = Date.UTC(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
        return Math.round((endUtc - startUtc) / 86400000);
    };

    const getInclusivePeriodEndDate = (startDateString, periodDays) => {
        const startDate = parseLocalDate(startDateString);
        if (!startDate || !Number.isInteger(periodDays) || periodDays < 1) return null;
        startDate.setDate(startDate.getDate() + periodDays - 1);
        return formatLocalDate(startDate);
    };

    const getVerdeSchedule = (verde, targetDate, currentCenter) => {
        const target = new Date(targetDate);
        target.setHours(0, 0, 0, 0);
        const startDate = parseLocalDate(verde.startDate);
        const endDate = verde.endDate ? parseLocalDate(verde.endDate) : null;
        if (!startDate || (verde.endDate && !endDate) || target < startDate || (endDate && target > endDate)) return null;

        const startMonday = getMonday(startDate);
        const targetMonday = getMonday(target);
        const weeksPassed = Math.round(differenceInCalendarDays(startMonday, targetMonday) / 7);
        const baseCycle = Number(verde.startCycleIndex ?? verde.offset ?? 0);
        if (!Number.isInteger(baseCycle) || baseCycle < 0 || baseCycle > 2) return null;
        const patterns = [
            { guardia: [1, 4], madruga: [3, 6] },
            { guardia: [2, 5], madruga: [1, 4] },
            { guardia: [3, 6], madruga: [2, 5] }
        ];
        const pattern = patterns[((baseCycle + weeksPassed) % patterns.length + patterns.length) % patterns.length];
        const startCenter = verde.startCenter || (verde.centerMode === 'CORTIJOS' ? 'CORTIJOS' : 'CEHORPA');
        const otherCenter = startCenter === 'CORTIJOS' ? 'CEHORPA' : 'CORTIJOS';
        const rotationMode = verde.rotationMode || (verde.rotatesCenter ? 'SEMANAL' : 'FIJO');
        let effectiveCenter = startCenter;

        if (rotationMode === 'SEMANAL') {
            effectiveCenter = weeksPassed % 2 === 0 ? startCenter : otherCenter;
        } else if (rotationMode === 'DIARIO') {
            const daysPassed = differenceInCalendarDays(startDate, target);
            effectiveCenter = daysPassed % 2 === 0 ? startCenter : otherCenter;
        } else if (rotationMode === 'SEGUN_GRUPO') {
            effectiveCenter = currentCenter;
        }

        const dayOfWeek = target.getDay();
        const role = pattern.guardia.includes(dayOfWeek)
            ? 'GUARDIA'
            : pattern.madruga.includes(dayOfWeek)
                ? 'MADRUGA'
                : null;

        return { effectiveCenter, role, assigned: Boolean(role && effectiveCenter === currentCenter) };
    };

    const assignLabelsToNormals = (peopleList, labelsQueue) => {
        let labelIndex = 0;
        return peopleList.map((person) => {
            if (person.isVerde) return person;
            if (labelIndex < labelsQueue.length) {
                const assignedLabel = labelsQueue[labelIndex];
                labelIndex++;
                return { ...person, specialLabel: assignedLabel };
            }
            return person;
        });
    };

    const countWeekdaysBetween = (startDate, endDate) => {
        const startUtc = Date.UTC(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
        const days = differenceInCalendarDays(startDate, endDate);
        if (days <= 0) return 0;

        let weekdays = Math.floor(days / 7) * 6;
        const remainder = days % 7;
        const cursor = new Date(startDate);
        for (let offset = days - remainder + 1; offset <= days; offset++) {
            cursor.setTime(startUtc + offset * 86400000);
            if (cursor.getUTCDay() !== 0) weekdays++;
        }
        return weekdays;
    };

    const toDateSerial = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
    const fromDateSerial = (serial) => {
        const utcDate = new Date(serial * 86400000);
        return new Date(utcDate.getUTCFullYear(), utcDate.getUTCMonth(), utcDate.getUTCDate());
    };

    const calculateRotationHeadIndex = ({ referenceDate, targetDate, names, firstGuardName, absences }) => {
        if (!names.length) return -1;
        const reference = new Date(referenceDate);
        const target = new Date(targetDate);
        reference.setHours(0, 0, 0, 0);
        target.setHours(0, 0, 0, 0);

        const startIndex = names.indexOf(firstGuardName);
        const initialIndex = startIndex < 0 ? 0 : startIndex;
        if (reference.getTime() === target.getTime()) return initialIndex;
        const direction = target >= reference ? 1 : -1;
        const referenceSerial = toDateSerial(reference);
        const targetSerial = toDateSerial(target);
        const stepLow = direction > 0 ? referenceSerial + 1 : targetSerial;
        const stepHigh = direction > 0 ? targetSerial : referenceSerial - 1;
        const affectedIntervals = [];
        for (const absence of absences || []) {
            if (absence.shiftsRotation === false || !absence.start) continue;
            const absenceStart = parseLocalDate(absence.start);
            const absenceEnd = absence.end ? parseLocalDate(absence.end) : null;
            if (!absenceStart || (absence.end && !absenceEnd)) continue;
            const start = Math.max(toDateSerial(absenceStart), stepLow);
            const end = Math.min(absenceEnd ? toDateSerial(absenceEnd) : stepHigh, stepHigh);
            if (start <= end) affectedIntervals.push({ start, end });
        }
        affectedIntervals.sort((a, b) => a.start - b.start);

        const mergedIntervals = [];
        for (const interval of affectedIntervals) {
            const previous = mergedIntervals[mergedIntervals.length - 1];
            if (previous && interval.start <= previous.end + 1) {
                previous.end = Math.max(previous.end, interval.end);
            } else {
                mergedIntervals.push({ ...interval });
            }
        }
        if (direction < 0) mergedIntervals.reverse();

        const isAbsent = (name, dateString) => (absences || []).find((absence) =>
            absence.name === name &&
            absence.start <= dateString &&
            (absence.end || '9999-12-31') >= dateString
        );

        let currentIndex = initialIndex;
        let currentSerial = referenceSerial;

        const advanceWithoutChangingAbsences = (destinationSerial) => {
            const currentDate = fromDateSerial(currentSerial);
            const destinationDate = fromDateSerial(destinationSerial);
            let weekdays;
            if (direction > 0) {
                weekdays = countWeekdaysBetween(currentDate, destinationDate);
            } else {
                const start = fromDateSerial(destinationSerial - 1);
                const end = fromDateSerial(currentSerial - 1);
                weekdays = countWeekdaysBetween(start, end);
            }
            currentIndex = ((currentIndex + direction * weekdays) % names.length + names.length) % names.length;
            currentSerial = destinationSerial;
        };

        const advanceWithAbsences = (destinationSerial) => {
            while (currentSerial !== destinationSerial) {
                currentSerial += direction;
                const date = fromDateSerial(currentSerial);
                if (date.getDay() !== 0) {
                    const dateString = formatLocalDate(date);
                    for (let offset = 1; offset < names.length * 2; offset++) {
                        const candidateIndex = (currentIndex + direction * offset + names.length * 2) % names.length;
                        const absence = isAbsent(names[candidateIndex], dateString);
                        if (!absence || absence.shiftsRotation === false) {
                            currentIndex = candidateIndex;
                            break;
                        }
                    }
                }
            }
        };

        for (const interval of mergedIntervals) {
            if (direction > 0) {
                if (currentSerial + 1 < interval.start) {
                    advanceWithoutChangingAbsences(interval.start - 1);
                }
                advanceWithAbsences(interval.end);
            } else {
                if (currentSerial - 1 > interval.end) {
                    advanceWithoutChangingAbsences(interval.end + 1);
                }
                advanceWithAbsences(interval.start);
            }
        }
        if (currentSerial !== targetSerial) {
            advanceWithoutChangingAbsences(targetSerial);
        }
        return currentIndex;
    };

    const validateConfig = (config) => {
        const errors = [];
        const checkCount = (value, label, allowZero = true) => {
            if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 500) {
                errors.push(`${label}: introduce un número entero entre ${allowZero ? 0 : 1} y 500.`);
            }
        };
        const checkTime = (value, label) => {
            if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
                errors.push(`${label}: selecciona una hora válida.`);
            }
        };

        if (!config || !config.cehorpa || !config.cortijos) {
            return ['La configuración de turnos está incompleta.'];
        }

        checkCount(config.cehorpa.guardias, 'Guardias de Cehorpa');
        checkCount(config.cehorpa.madrugan, 'Madrugadores de Cehorpa');
        checkTime(config.cehorpa.horaGuardia, 'Hora de guardia de Cehorpa');
        checkTime(config.cehorpa.horaMadruga, 'Hora de madrugar en Cehorpa');
        checkTime(config.cehorpa.horaResto, 'Hora del resto en Cehorpa');
        checkCount(config.cortijos.capacidad, 'Capacidad de Cortijos', false);
        checkCount(config.cortijos.guardias, 'Guardias de Cortijos');
        checkCount(config.cortijos.intermedios, 'Intermedios de Cortijos');
        checkCount(config.cortijos.madrugan, 'Madrugadores de Cortijos');
        if (
            Number.isInteger(config.cortijos.capacidad) &&
            Number.isInteger(config.cortijos.guardias) &&
            Number.isInteger(config.cortijos.intermedios) &&
            Number.isInteger(config.cortijos.madrugan) &&
            config.cortijos.guardias + config.cortijos.intermedios + config.cortijos.madrugan !== config.cortijos.capacidad
        ) {
            errors.push('Guardias, intermedios y madrugadores de Cortijos deben sumar la capacidad del centro.');
        }
        checkTime(config.cortijos.horaGuardia, 'Hora de guardia de Cortijos');
        checkTime(config.cortijos.horaIntermedia, 'Hora de intermedios');
        checkTime(config.cortijos.horaMadruga, 'Hora de madrugar en Cortijos');
        checkTime(config.cortijos.horaRestoCehorpa, 'Hora de apoyo a Cehorpa');
        return errors;
    };

    const normalizeConfig = (loadedConfig, defaultConfig) => {
        const config = {
            cehorpa: { ...defaultConfig.cehorpa, ...(loadedConfig && loadedConfig.cehorpa) },
            cortijos: { ...defaultConfig.cortijos, ...(loadedConfig && loadedConfig.cortijos) }
        };
        let adjustedIntermedios = false;
        const { capacidad, guardias, madrugan, intermedios } = config.cortijos;
        const expectedIntermedios = capacidad - guardias - madrugan;
        if (
            Number.isInteger(capacidad) &&
            Number.isInteger(guardias) &&
            Number.isInteger(madrugan) &&
            Number.isInteger(intermedios) &&
            expectedIntermedios >= 0 &&
            expectedIntermedios <= 500 &&
            intermedios !== expectedIntermedios
        ) {
            config.cortijos.intermedios = expectedIntermedios;
            adjustedIntermedios = true;
        }
        const errors = validateConfig(config);
        return { config: errors.length ? defaultConfig : config, errors, adjustedIntermedios };
    };

    const validateDataIntegrity = (collasData, config, options = {}) => {
        const problems = [];
        const collaNames = options.collaNames || { '1': 'Colla 1', '2': 'Colla 2' };
        const addProblem = (severity, scope, message) => problems.push({ severity, scope, message });
        const normalizeName = (value) => String(value || '').trim().toLocaleUpperCase('es-ES');
        const isPlaceholderName = (value) => /^PERSONA\s+\d+$/i.test(String(value || '').trim());
        const isValidCenter = (value) => ['CORTIJOS', 'CEHORPA'].includes(value);
        const isValidRotationMode = (value) => ['SEMANAL', 'DIARIO', 'FIJO', 'SEGUN_GRUPO'].includes(value);

        validateConfig(config).forEach((message) => addProblem('error', 'Configuración', message));

        const globalNames = new Map();

        ['1', '2'].forEach((collaId) => {
            const label = collaNames[collaId] || `Colla ${collaId}`;
            const colla = collasData && collasData[collaId];
            if (!colla) {
                addProblem('error', label, 'No hay datos guardados para esta colla.');
                return;
            }

            const names = Array.isArray(colla.names) ? colla.names : [];
            const verdes = Array.isArray(colla.verdes) ? colla.verdes : [];
            const absences = Array.isArray(colla.absences) ? colla.absences : [];
            const refData = colla.refData || {};
            const localNames = new Map();
            const knownNames = new Set();

            if (!names.length) addProblem('warning', label, 'La colla no tiene personal normal configurado.');

            const registerName = (name, kind, index) => {
                const normalized = normalizeName(name);
                if (!normalized) {
                    addProblem('error', label, `Hay ${kind === 'verde' ? 'un verde' : 'una persona'} sin nombre en la posición ${index + 1}.`);
                    return;
                }
                const previousKind = localNames.get(normalized);
                if (previousKind) {
                    const duplicateDescription = previousKind === kind
                        ? `${name} aparece duplicado dentro de la colla.`
                        : `${name} aparece como personal normal y como verde.`;
                    addProblem('error', label, duplicateDescription);
                } else {
                    localNames.set(normalized, kind);
                }
                knownNames.add(normalized);

                if (!isPlaceholderName(name)) {
                    const previousColla = globalNames.get(normalized);
                    if (previousColla && previousColla.id !== collaId) {
                        addProblem('warning', label, `${name} también aparece en ${previousColla.label}.`);
                    } else if (!previousColla) {
                        globalNames.set(normalized, { id: collaId, label });
                    }
                }
            };

            names.forEach((name, index) => {
                registerName(name, 'normal', index);
            });

            if (!parseLocalDate(refData.dateString)) {
                addProblem('error', label, 'La fecha del punto de partida no es válida.');
            }
            if (names.length && !names.includes(refData.firstGuardName)) {
                addProblem('error', label, 'El primer guardia del punto de partida no existe en la colla.');
            }
            if (!isValidCenter(refData.center)) {
                addProblem('error', label, 'El centro del punto de partida debe ser Cortijos o Cehorpa.');
            }

            verdes.forEach((verde, index) => {
                const verdeLabel = verde && verde.name ? verde.name : `Verde ${index + 1}`;
                registerName(verde && verde.name, 'verde', index);

                const startDate = parseLocalDate(verde && verde.startDate);
                const endDate = verde && verde.endDate ? parseLocalDate(verde.endDate) : null;
                if (!startDate) addProblem('error', label, `${verdeLabel}: la fecha de inicio no es válida.`);
                if (verde && verde.endDate && !endDate) addProblem('error', label, `${verdeLabel}: la fecha de fin no es válida.`);
                if (startDate && endDate && endDate < startDate) addProblem('error', label, `${verdeLabel}: la fecha de fin es anterior al inicio.`);

                const cycleIndex = Number(verde && (verde.startCycleIndex ?? verde.offset ?? 0));
                if (!Number.isInteger(cycleIndex) || cycleIndex < 0 || cycleIndex > 2) {
                    addProblem('error', label, `${verdeLabel}: el patrón inicial debe estar entre 0 y 2.`);
                }
                const startCenter = verde && (verde.startCenter || (verde.centerMode === 'CORTIJOS' ? 'CORTIJOS' : 'CEHORPA'));
                const rotationMode = verde && (verde.rotationMode || (verde.rotatesCenter ? 'SEMANAL' : 'FIJO'));
                if (!isValidCenter(startCenter)) addProblem('error', label, `${verdeLabel}: el centro inicial no es válido.`);
                if (!isValidRotationMode(rotationMode)) addProblem('error', label, `${verdeLabel}: el modo de rotación no es válido.`);
            });

            const absencesByName = new Map();
            absences.forEach((absence, index) => {
                const absenceLabel = absence && absence.name ? absence.name : `Ausencia ${index + 1}`;
                const normalizedAbsenceName = normalizeName(absence && absence.name);
                if (!absence || !knownNames.has(normalizedAbsenceName)) {
                    addProblem('error', label, `${absenceLabel}: la ausencia apunta a una persona que no existe.`);
                }
                if (!absence || !['BAJA', 'VACACIONES'].includes(absence.type)) {
                    addProblem('error', label, `${absenceLabel}: el tipo de ausencia no es válido.`);
                }
                const startDate = parseLocalDate(absence && absence.start);
                const endDate = absence && absence.end ? parseLocalDate(absence.end) : null;
                if (!startDate) addProblem('error', label, `${absenceLabel}: la fecha de inicio de ausencia no es válida.`);
                if (absence && absence.end && !endDate) addProblem('error', label, `${absenceLabel}: la fecha final de ausencia no es válida.`);
                if (startDate && endDate && endDate < startDate) addProblem('error', label, `${absenceLabel}: la ausencia termina antes de empezar.`);

                if (absence && normalizedAbsenceName && startDate && (!absence.end || endDate)) {
                    const list = absencesByName.get(normalizedAbsenceName) || [];
                    list.push({
                        start: formatLocalDate(startDate),
                        end: endDate ? formatLocalDate(endDate) : '9999-12-31',
                        label: absenceLabel
                    });
                    absencesByName.set(normalizedAbsenceName, list);
                }
            });

            absencesByName.forEach((items, name) => {
                items.sort((a, b) => a.start.localeCompare(b.start));
                for (let index = 1; index < items.length; index++) {
                    if (items[index].start <= items[index - 1].end) {
                        addProblem('error', label, `${name} tiene ausencias solapadas.`);
                        break;
                    }
                }
            });
        });

        return problems;
    };

    const getDataSnapshot = (content) => ({
        collas: content && content.collas ? content.collas : {},
        config: content && content.config ? content.config : {}
    });

    const stableStringify = (value) => {
        if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
        if (value && typeof value === 'object') {
            return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
        }
        return JSON.stringify(value);
    };

    const describeDataChanges = (before, after, collaNames = {}) => {
        const changes = [];
        const addNames = (scope, beforeNames, afterNames, kind) => {
            const previous = Array.isArray(beforeNames) ? beforeNames : [];
            const next = Array.isArray(afterNames) ? afterNames : [];
            const previousCounts = new Map();
            const nextCounts = new Map();
            previous.forEach(name => previousCounts.set(name, (previousCounts.get(name) || 0) + 1));
            next.forEach(name => nextCounts.set(name, (nextCounts.get(name) || 0) + 1));
            nextCounts.forEach((count, name) => {
                const added = count - (previousCounts.get(name) || 0);
                if (added > 0) changes.push(`${scope}: se ${kind} ${name}`);
            });
            previousCounts.forEach((count, name) => {
                const removed = count - (nextCounts.get(name) || 0);
                if (removed > 0) changes.push(`${scope}: se eliminó ${name}`);
            });
            if (!changes.some(change => change.startsWith(`${scope}:`)) &&
                stableStringify(previous) !== stableStringify(next)) {
                changes.push(`${scope}: se reordenó el personal`);
            }
        };

        ['1', '2'].forEach(collaId => {
            const scope = collaNames[collaId] || `Colla ${collaId}`;
            const previous = before.collas && before.collas[collaId] || {};
            const next = after.collas && after.collas[collaId] || {};
            addNames(scope, previous.names, next.names, 'añadió');

            const describeCollection = (previousItems, nextItems, collectionLabel, getIdentity) => {
                const oldItems = Array.isArray(previousItems) ? previousItems : [];
                const newItems = Array.isArray(nextItems) ? nextItems : [];
                const oldById = new Map(oldItems.map((item, index) => [getIdentity(item, index), item]));
                const newById = new Map(newItems.map((item, index) => [getIdentity(item, index), item]));
                newById.forEach((item, id) => {
                    const oldItem = oldById.get(id);
                    if (!oldItem) changes.push(`${scope}: se añadió ${collectionLabel} ${item.name || ''}`.trim());
                    else if (stableStringify(oldItem) !== stableStringify(item)) changes.push(`${scope}: se modificó ${collectionLabel} ${item.name || ''}`.trim());
                });
                oldById.forEach((item, id) => {
                    if (!newById.has(id)) changes.push(`${scope}: se eliminó ${collectionLabel} ${item.name || ''}`.trim());
                });
            };

            describeCollection(previous.verdes, next.verdes, 'verde', (item, index) => item && (item.id ?? item.name) || index);
            describeCollection(previous.absences, next.absences, 'ausencia', (item, index) => item && (item.id ?? `${item.name}|${item.start}`) || index);
            if (stableStringify(previous.refData || {}) !== stableStringify(next.refData || {})) {
                changes.push(`${scope}: se modificó el punto de partida`);
            }
        });

        if (stableStringify(before.config || {}) !== stableStringify(after.config || {})) {
            changes.push('Se modificó la configuración de turnos');
        }
        return changes;
    };

    const recordDataChange = (previousContent, nextData, options = {}) => {
        const before = getDataSnapshot(previousContent);
        const after = getDataSnapshot(nextData);
        const history = Array.isArray(previousContent && previousContent.changeHistory)
            ? previousContent.changeHistory
            : [];
        const undoStack = Array.isArray(previousContent && previousContent.undoStack)
            ? previousContent.undoStack
            : [];
        const changes = describeDataChanges(before, after, options.collaNames);
        if (!changes.length) {
            return {
                ...nextData,
                revision: previousContent && previousContent.revision || options.id || '',
                changeHistory: history,
                undoStack
            };
        }

        const id = options.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const at = options.at || new Date().toISOString();
        const entry = {
            id,
            at,
            summary: changes.slice(0, 8).join('; '),
            actor: 'Sin identificar'
        };
        return {
            ...nextData,
            revision: id,
            changeHistory: [...history, entry].slice(-30),
            undoStack: [...undoStack, { ...entry, before, after }].slice(-10)
        };
    };

    const undoLastDataChange = (currentContent, expectedChangeId, options = {}) => {
        const undoStack = Array.isArray(currentContent && currentContent.undoStack)
            ? currentContent.undoStack
            : [];
        const latestChange = undoStack[undoStack.length - 1];
        if (!latestChange) return { ok: false, reason: 'No hay cambios disponibles para deshacer.' };
        if (latestChange.id !== expectedChangeId) {
            return { ok: false, reason: 'Otra persona guardó cambios después. Actualiza los datos y revisa el historial antes de deshacer.' };
        }
        if (stableStringify(getDataSnapshot(currentContent)) !== stableStringify(latestChange.after)) {
            return { ok: false, reason: 'Los datos compartidos ya no coinciden con el último cambio. No se deshizo nada para proteger los cambios recientes.' };
        }

        const id = options.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const undoEvent = {
            id,
            at: options.at || new Date().toISOString(),
            summary: `Se deshizo: ${latestChange.summary}`,
            actor: 'Sin identificar',
            type: 'undo'
        };
        return {
            ok: true,
            content: {
                ...latestChange.before,
                revision: id,
                changeHistory: [...(Array.isArray(currentContent.changeHistory) ? currentContent.changeHistory : []), undoEvent].slice(-30),
                undoStack: undoStack.slice(0, -1)
            }
        };
    };

    const calculateSimulation = (targetDate, targetCollaId, collasData, config, defaults = {}) => {
        const cData = collasData[targetCollaId];
        if (!cData || !cData.names || cData.names.length === 0) return null;

        const cNames = cData.names;
        const cVerdes = cData.verdes || [];
        const fallbackRefData = defaults[targetCollaId] || defaults.defaultRefData || {
            dateString: '2025-12-06',
            firstGuardName: cNames[0],
            center: targetCollaId === '1' ? 'CORTIJOS' : 'CEHORPA'
        };
        const cRefData = cData.refData || fallbackRefData;
        const cAbsencesList = cData.absences || [];
        const safeTargetDate = new Date(targetDate);
        safeTargetDate.setHours(0, 0, 0, 0);
        const dateStr = formatLocalDate(safeTargetDate);

        const isAbsent = (pName, dStr) => cAbsencesList.find((absence) => {
            if (absence.name !== pName) return false;
            const activeStart = absence.start;
            const activeEnd = absence.end ? absence.end : '9999-12-31';
            return dStr >= activeStart && dStr <= activeEnd;
        });

        const dayOfWeek = safeTargetDate.getDay();
        if (dayOfWeek === 0) return { isSunday: true, date: targetDate };

        const refDateObj = parseLocalDate(cRefData.dateString || '2025-12-06')
            || parseLocalDate('2025-12-06');
        const refMonday = getMonday(refDateObj);
        const targetMonday = getMonday(safeTargetDate);
        const weeksPassed = Math.round(differenceInCalendarDays(refMonday, targetMonday) / 7);
        const CENTERS = ['CORTIJOS', 'CEHORPA'];
        const refCenterIndex = cRefData.center === 'CORTIJOS' ? 0 : 1;
        const refDayOfWeekIndex = (refDateObj.getDay() + 6) % 7;
        const refWeekParity = ((refCenterIndex - refDayOfWeekIndex) % 2 + 2) % 2;
        const targetWeekParity = ((refWeekParity + weeksPassed) % 2 + 2) % 2;
        const targetDayIndex = (dayOfWeek + 6) % 7;
        const targetCenterIndex = (targetWeekParity + targetDayIndex) % 2;
        const currentCenter = CENTERS[targetCenterIndex];

        const headStartIndex = calculateRotationHeadIndex({
            referenceDate: refDateObj,
            targetDate: safeTargetDate,
            names: cNames,
            firstGuardName: cRefData.firstGuardName,
            absences: cAbsencesList
        });

        const absentPeople = [];
        const activePeople = [];
        for (let i = 0; i < cNames.length; i++) {
            const name = cNames[(headStartIndex + i) % cNames.length];
            const absence = isAbsent(name, dateStr);
            if (absence) {
                absentPeople.push({ name, status: absence.type, isVerde: false });
            } else {
                activePeople.push({ name, isVerde: false });
            }
        }

        let libraName = 'N/A';
        if (activePeople.length > 0) {
            const libraPerson = activePeople.pop();
            libraName = libraPerson.name;
        }

        let cortijosList;
        let cehorpaList;
        if (currentCenter === 'CORTIJOS') {
            cortijosList = activePeople.slice(0, config.cortijos.capacidad);
            cehorpaList = activePeople.slice(config.cortijos.capacidad);
        } else {
            cortijosList = [];
            cehorpaList = activePeople;
        }

        const activeVerdesGuardia = [];
        const activeVerdesMadruga = [];
        const remainingVerdesList = [];

        cVerdes.forEach((verde) => {
            const schedule = getVerdeSchedule(
                { ...verde, startDate: verde.startDate || formatLocalDate(refDateObj) },
                safeTargetDate,
                currentCenter
            );
            if (!schedule) return;
            const { effectiveCenter } = schedule;

            const absence = isAbsent(verde.name, dateStr);
            if (absence) {
                absentPeople.push({ name: verde.name, status: absence.type, isVerde: true });
                return;
            }

            const centerOk = effectiveCenter === currentCenter;
            const assigned = schedule.assigned;
            if (schedule.role === 'GUARDIA' && centerOk) {
                activeVerdesGuardia.push({ ...verde, effectiveCenter });
            } else if (schedule.role === 'MADRUGA' && centerOk) {
                if (!activeVerdesGuardia.find((guardia) => guardia.name === verde.name)) {
                    activeVerdesMadruga.push({ ...verde, effectiveCenter });
                }
            }

            if (!assigned) {
                remainingVerdesList.push({ ...verde, effectiveCenter });
            }
        });

        let gNormals = cortijosList.slice(0, config.cortijos.guardias);
        const remaining = cortijosList.slice(config.cortijos.guardias);
        let mNormals = [];
        let iNormals = [];

        if (currentCenter === 'CORTIJOS') {
            const madrugaCount = config.cortijos.madrugan;
            if (remaining.length >= madrugaCount) {
                mNormals = remaining.slice(remaining.length - madrugaCount);
                iNormals = remaining.slice(0, config.cortijos.intermedios);
            } else {
                mNormals = remaining;
                iNormals = [];
            }
        } else {
            iNormals = remaining;
        }

        activeVerdesGuardia.forEach((verde) => {
            if (currentCenter !== 'CEHORPA') {
                gNormals.splice(2, 0, { name: verde.name, isVerde: true, roleOverride: 'GUARDIA' });
                while (gNormals.length > config.cortijos.guardias) {
                    let displacedIndex = -1;
                    for (let k = gNormals.length - 1; k >= 0; k--) {
                        if (!gNormals[k].isVerde) {
                            displacedIndex = k;
                            break;
                        }
                    }
                    if (displacedIndex !== -1) {
                        const displaced = gNormals.splice(displacedIndex, 1)[0];
                        iNormals.unshift(displaced);
                    } else {
                        const displaced = gNormals.pop();
                        iNormals.unshift(displaced);
                    }
                }
            }
        });

        activeVerdesMadruga.forEach((verde) => {
            if (currentCenter !== 'CEHORPA') {
                mNormals.unshift({ name: verde.name, isVerde: true, roleOverride: 'MADRUGA' });
                while (mNormals.length > config.cortijos.madrugan) {
                    let displaced = null;
                    for (let k = 0; k < mNormals.length; k++) {
                        if (!mNormals[k].isVerde) {
                            displaced = mNormals.splice(k, 1)[0];
                            break;
                        }
                    }
                    if (displaced) iNormals.push(displaced);
                }
            }
        });

        remainingVerdesList.forEach((verde) => {
            if (verde.effectiveCenter === 'CORTIJOS' && currentCenter === 'CORTIJOS') {
                iNormals.push({ name: verde.name, isVerde: true, roleOverride: 'INTERMEDIO' });
            }
        });

        const injectVerdeLegacy = (targetList, verdeName, index, role) => {
            const item = { name: verdeName, isVerde: true, roleOverride: role };
            if (index > targetList.length) targetList.push(item);
            else targetList.splice(index, 0, item);
        };

        if (currentCenter === 'CEHORPA') {
            activeVerdesGuardia.forEach((verde) => injectVerdeLegacy(cehorpaList, verde.name, 2, 'GUARDIA'));
            activeVerdesMadruga.forEach((verde, idx) => injectVerdeLegacy(cehorpaList, verde.name, config.cehorpa.guardias + idx, 'MADRUGA'));
            remainingVerdesList.forEach((verde) => {
                if (verde.effectiveCenter === 'CEHORPA') injectVerdeLegacy(cehorpaList, verde.name, cehorpaList.length, 'RESTO');
            });
        }

        const personStatus = {};
        cNames.forEach((name) => { personStatus[name] = { status: 'LIBRE', time: 'L' }; });
        cVerdes.forEach((verde) => { personStatus[verde.name] = { status: 'LIBRE', time: 'L' }; });
        absentPeople.forEach((person) => {
            personStatus[person.name] = { status: person.status, name: person.name, isVerde: person.isVerde };
        });

        if (libraName !== 'N/A') personStatus[libraName] = { status: 'LIBRE', time: 'L' };

        const processPerson = (person, role, time, center, rank, special, isFlejador) => {
            let display = time.split(':')[0].replace(/^0/, '');
            if (rank) display += `.${rank}`;
            personStatus[person.name] = {
                status: 'WORK',
                display,
                ...person,
                center,
                isFlejador,
                special,
                role,
                rank,
                time
            };
            return { ...person, time, role, realCenter: center, rank, isFlejador, special, status: 'WORK' };
        };

        if (currentCenter === 'CEHORPA') {
            remainingVerdesList.forEach((verde) => {
                if (verde.effectiveCenter === 'CORTIJOS') {
                    processPerson({ name: verde.name, isVerde: true }, 'INTERMEDIO', config.cortijos.horaIntermedia, 'CORTIJOS');
                }
            });
        }

        const LABELS_CEHORPA_MADRUGA = ['AYUDA TRASPALETA', 'GUITAOR', 'REPONEDOR PALET'];
        let groups = [];
        if (currentCenter === 'CEHORPA') {
            const { guardias, madrugan, horaResto } = config.cehorpa;
            const g1 = cehorpaList
                .slice(0, guardias)
                .map((person, index, list) => processPerson(person, 'GUARDIA', config.cehorpa.horaGuardia, 'CEHORPA', index + 1, false, index === list.length - 1));
            const rawG2 = cehorpaList.slice(guardias, guardias + madrugan);
            const labeledG2 = assignLabelsToNormals(rawG2, LABELS_CEHORPA_MADRUGA);
            const g2 = labeledG2.map((person, index) => {
                const processed = processPerson(person, 'MADRUGA', config.cehorpa.horaMadruga, 'CEHORPA', index + 1);
                if (person.specialLabel) processed.specialLabel = person.specialLabel;
                return processed;
            });
            const g3 = cehorpaList
                .slice(guardias + madrugan)
                .map((person) => processPerson(person, 'RESTO', horaResto, 'CEHORPA'));
            groups = [
                { title: 'GUARDIA', color: 'bg-emerald-600 text-white', items: g1 },
                { title: 'MADRUGAR', color: 'bg-orange-500 text-white', items: g2 },
                { title: 'RESTO', color: 'bg-blue-500 text-white', items: g3 }
            ];
        } else {
            const cG1 = gNormals.map((person, index, list) => processPerson(person, 'GUARDIA', config.cortijos.horaGuardia, 'CORTIJOS', index + 1, false, index === list.length - 1));
            const cG2 = iNormals.map((person, index) => processPerson(person, 'INTERMEDIO', config.cortijos.horaIntermedia, 'CORTIJOS', index + 1));
            let lastNormalIndex = -1;
            for (let k = mNormals.length - 1; k >= 0; k--) {
                if (!mNormals[k].isVerde) {
                    lastNormalIndex = k;
                    break;
                }
            }

            const cG3 = mNormals.map((person, index) => {
                const processed = processPerson(person, 'MADRUGA', config.cortijos.horaMadruga, 'CORTIJOS', index + 1);
                if (index === lastNormalIndex) processed.specialLabel = 'PUNTO';
                return processed;
            });
            const apoyo = cehorpaList.map((person) => processPerson(person, 'APOYO', config.cortijos.horaRestoCehorpa, 'CEHORPA'));

            groups = [
                { title: 'CORTIJOS - GUARDIA', color: 'bg-emerald-600 text-white', items: cG1 },
                { title: 'CORTIJOS - INTERMEDIOS', color: 'bg-yellow-500 text-white', items: cG2 },
                { title: 'CORTIJOS - MADRUGAR', color: 'bg-orange-500 text-white', items: cG3 },
                { title: 'APOYO A CEHORPA', color: 'bg-blue-500 text-white', items: apoyo }
            ];
        }

        if (absentPeople.length > 0) {
            groups.push({ title: 'AUSENCIAS / BAJAS', color: 'bg-red-500 text-white', items: absentPeople });
        }

        return {
            isSunday: false,
            date: targetDate,
            center: currentCenter,
            libra: libraName,
            libraStatus: 'LIBRE',
            groups,
            personStatus
        };
    };

    return {
        formatLocalDate,
        parseLocalDate,
        getMonday,
        differenceInCalendarDays,
        getInclusivePeriodEndDate,
        getVerdeSchedule,
        assignLabelsToNormals,
        calculateRotationHeadIndex,
        calculateSimulation,
        validateConfig,
        validateDataIntegrity,
        describeDataChanges,
        recordDataChange,
        undoLastDataChange,
        normalizeConfig
    };
});
