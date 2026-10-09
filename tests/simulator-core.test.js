const test = require('node:test');
const assert = require('node:assert/strict');
const {
    calculateSimulation,
    calculateRotationHeadIndex,
    differenceInCalendarDays,
    formatLocalDate,
    getInclusivePeriodEndDate,
    getMonday,
    getVerdeSchedule,
    normalizeConfig,
    parseLocalDate,
    recordDataChange,
    undoLastDataChange,
    validateConfig,
    validateDataIntegrity
} = require('../simulator-core');

const config = {
    cehorpa: { guardias: 6, madrugan: 4, horaGuardia: '10:00', horaMadruga: '07:00', horaResto: '09:00' },
    cortijos: {
        capacidad: 8, guardias: 4, intermedios: 2, madrugan: 2,
        horaGuardia: '10:00', horaIntermedia: '08:00', horaMadruga: '07:00', horaRestoCehorpa: '09:00'
    }
};

test('local date parsing validates dates and round-trips without UTC conversion', () => {
    const date = parseLocalDate('2026-10-04');
    assert.ok(date);
    assert.equal(formatLocalDate(date), '2026-10-04');
    assert.equal(parseLocalDate('2026-02-30'), null);
    assert.equal(parseLocalDate('04/10/2026'), null);
});

test('Monday calculation remains on the local calendar', () => {
    assert.equal(formatLocalDate(getMonday(parseLocalDate('2026-10-04'))), '2026-09-28');
    assert.equal(formatLocalDate(getMonday(parseLocalDate('2026-10-05'))), '2026-10-05');
});

test('calendar day differences are stable across daylight-saving transitions', () => {
    assert.equal(differenceInCalendarDays(parseLocalDate('2026-03-28'), parseLocalDate('2026-03-30')), 2);
});

test('inclusive green periods cover exactly seven calendar days across daylight-saving changes', () => {
    assert.equal(getInclusivePeriodEndDate('2026-03-28', 7), '2026-04-03');
    assert.equal(getInclusivePeriodEndDate('2026-10-04', 7), '2026-10-10');
    assert.equal(getInclusivePeriodEndDate('invalid', 7), null);
});

test('green scheduling respects the selected start and inclusive end dates', () => {
    const verde = {
        startDate: '2026-10-05',
        endDate: '2026-10-11',
        startCycleIndex: 0,
        startCenter: 'CORTIJOS',
        rotationMode: 'FIJO'
    };
    assert.equal(getVerdeSchedule(verde, parseLocalDate('2026-10-04'), 'CORTIJOS'), null);
    assert.deepEqual(getVerdeSchedule(verde, parseLocalDate('2026-10-05'), 'CORTIJOS'), {
        effectiveCenter: 'CORTIJOS',
        role: 'GUARDIA',
        assigned: true
    });
    assert.deepEqual(getVerdeSchedule(verde, parseLocalDate('2026-10-07'), 'CORTIJOS'), {
        effectiveCenter: 'CORTIJOS',
        role: 'MADRUGA',
        assigned: true
    });
    assert.equal(getVerdeSchedule(verde, parseLocalDate('2026-10-12'), 'CORTIJOS'), null);
});

test('green patterns and weekly center rotation advance from the selected start week', () => {
    const verde = {
        startDate: '2026-10-05',
        startCycleIndex: 0,
        startCenter: 'CORTIJOS',
        rotationMode: 'SEMANAL'
    };
    assert.deepEqual(getVerdeSchedule(verde, parseLocalDate('2026-10-13'), 'CEHORPA'), {
        effectiveCenter: 'CEHORPA',
        role: 'GUARDIA',
        assigned: true
    });
    assert.deepEqual(getVerdeSchedule(verde, parseLocalDate('2026-10-12'), 'CEHORPA'), {
        effectiveCenter: 'CEHORPA',
        role: 'MADRUGA',
        assigned: true
    });
});

test('rotation skips Sundays and supports dates beyond the old 10,000-day limit', () => {
    const names = ['A', 'B', 'C'];
    const index = calculateRotationHeadIndex({
        referenceDate: parseLocalDate('2000-01-01'),
        targetDate: parseLocalDate('2050-01-01'),
        names,
        firstGuardName: 'A',
        absences: []
    });
    let expected = 0;
    const cursor = parseLocalDate('2000-01-01');
    const end = parseLocalDate('2050-01-01');
    while (cursor < end) {
        cursor.setDate(cursor.getDate() + 1);
        if (cursor.getDay() !== 0) expected = (expected + 1) % names.length;
    }
    assert.equal(index, expected);
});

test('reverse rotation counts the reference date only as the starting point', () => {
    const index = calculateRotationHeadIndex({
        referenceDate: parseLocalDate('2026-10-05'),
        targetDate: parseLocalDate('2026-10-02'),
        names: ['A', 'B', 'C'],
        firstGuardName: 'A',
        absences: []
    });
    assert.equal(index, 1);
});

test('rotation fast-forwards unaffected periods around isolated rotation-shifting absences', () => {
    const names = ['A', 'B', 'C', 'D'];
    const absences = [
        { name: 'B', start: '2001-01-01', end: '2001-01-01', shiftsRotation: true },
        { name: 'C', start: '2049-12-31', end: '2049-12-31', shiftsRotation: true }
    ];
    const index = calculateRotationHeadIndex({
        referenceDate: parseLocalDate('2000-01-01'),
        targetDate: parseLocalDate('2050-01-01'),
        names,
        firstGuardName: 'A',
        absences
    });
    let expected = 0;
    const cursor = parseLocalDate('2000-01-01');
    const end = parseLocalDate('2050-01-01');
    while (cursor < end) {
        cursor.setDate(cursor.getDate() + 1);
        if (cursor.getDay() === 0) continue;
        for (let offset = 1; offset < names.length * 2; offset++) {
            const candidateIndex = (expected + offset) % names.length;
            const absence = absences.find(item =>
                item.name === names[candidateIndex] &&
                item.start <= formatLocalDate(cursor) &&
                item.end >= formatLocalDate(cursor)
            );
            if (!absence || absence.shiftsRotation === false) {
                expected = candidateIndex;
                break;
            }
        }
    }
    assert.equal(index, expected);
});

test('rotation respects absences that shift the turn and ignores non-shifting absences', () => {
    const parameters = {
        referenceDate: parseLocalDate('2026-10-02'),
        targetDate: parseLocalDate('2026-10-05'),
        names: ['A', 'B', 'C'],
        firstGuardName: 'A'
    };
    const shifting = calculateRotationHeadIndex({
        ...parameters,
        absences: [{ name: 'B', start: '2026-10-03', end: '2026-10-03', shiftsRotation: true }]
    });
    const notShifting = calculateRotationHeadIndex({
        ...parameters,
        absences: [{ name: 'B', start: '2026-10-03', end: '2026-10-03', shiftsRotation: false }]
    });
    assert.equal(shifting, 0);
    assert.equal(notShifting, 2);
});

test('reverse rotation also respects absences on dates in the traversed range', () => {
    const parameters = {
        referenceDate: parseLocalDate('2026-10-05'),
        targetDate: parseLocalDate('2026-10-03'),
        names: ['A', 'B', 'C'],
        firstGuardName: 'A'
    };
    assert.equal(calculateRotationHeadIndex({
        ...parameters,
        absences: [{ name: 'C', start: '2026-10-03', end: '2026-10-03', shiftsRotation: true }]
    }), 1);
    assert.equal(calculateRotationHeadIndex({
        ...parameters,
        absences: [{ name: 'C', start: '2026-10-03', end: '2026-10-03', shiftsRotation: false }]
    }), 2);
});

test('configuration validation rejects empty, invalid, and malformed settings', () => {
    assert.deepEqual(validateConfig(config), []);
    assert.ok(validateConfig({
        ...config,
        cortijos: { ...config.cortijos, capacidad: 0, horaGuardia: '25:90' }
    }).length > 0);
    assert.ok(validateConfig({
        ...config,
        cehorpa: { ...config.cehorpa, madrugan: NaN }
    }).length > 0);
    assert.ok(validateConfig({
        ...config,
        cortijos: { ...config.cortijos, intermedios: 1 }
    }).some(error => error.includes('deben sumar la capacidad')));
});

test('legacy configurations derive intermediate slots to preserve Cortijos capacity', () => {
    const legacy = {
        ...config,
        cortijos: { ...config.cortijos, capacidad: 10, intermedios: 2 }
    };
    const normalized = normalizeConfig(legacy, config);
    assert.equal(normalized.config.cortijos.intermedios, 4);
    assert.equal(normalized.adjustedIntermedios, true);
    assert.deepEqual(normalized.errors, []);
});

test('simulation returns the expected Cortijos groups and person status', () => {
    const collas = {
        1: {
            names: ['A', 'B', 'C', 'D', 'E', 'F'],
            verdes: [],
            refData: { dateString: '2025-12-06', firstGuardName: 'A', center: 'CORTIJOS' },
            absences: []
        }
    };
    const result = calculateSimulation(parseLocalDate('2025-12-06'), '1', collas, config);

    assert.equal(result.center, 'CORTIJOS');
    assert.equal(result.libra, 'F');
    assert.deepEqual(result.groups.map(group => group.title), [
        'CORTIJOS - GUARDIA',
        'CORTIJOS - INTERMEDIOS',
        'CORTIJOS - MADRUGAR',
        'APOYO A CEHORPA'
    ]);
    assert.equal(result.personStatus.A.role, 'GUARDIA');
    assert.equal(result.personStatus.A.display, '10.1');
    assert.equal(result.personStatus.F.status, 'LIBRE');
});

test('simulation marks Sundays without assigning shifts', () => {
    const collas = {
        1: {
            names: ['A', 'B', 'C'],
            verdes: [],
            refData: { dateString: '2025-12-06', firstGuardName: 'A', center: 'CORTIJOS' },
            absences: []
        }
    };
    const result = calculateSimulation(parseLocalDate('2025-12-07'), '1', collas, config);

    assert.equal(result.isSunday, true);
    assert.equal(result.groups, undefined);
});

test('simulation includes active absences in the status map and absence group', () => {
    const collas = {
        1: {
            names: ['A', 'B', 'C', 'D', 'E', 'F'],
            verdes: [],
            refData: { dateString: '2025-12-06', firstGuardName: 'A', center: 'CORTIJOS' },
            absences: [{ id: 'absence-1', name: 'B', type: 'BAJA', start: '2025-12-06', end: '', shiftsRotation: true }]
        }
    };
    const result = calculateSimulation(parseLocalDate('2025-12-06'), '1', collas, config);
    const absenceGroup = result.groups.find(group => group.title === 'AUSENCIAS / BAJAS');

    assert.equal(result.personStatus.B.status, 'BAJA');
    assert.ok(absenceGroup);
    assert.deepEqual(absenceGroup.items, [{ name: 'B', status: 'BAJA', isVerde: false }]);
});

test('simulation can place the active team in Cehorpa', () => {
    const collas = {
        2: {
            names: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'],
            verdes: [],
            refData: { dateString: '2025-12-06', firstGuardName: 'A', center: 'CEHORPA' },
            absences: []
        }
    };
    const result = calculateSimulation(parseLocalDate('2025-12-06'), '2', collas, config);

    assert.equal(result.center, 'CEHORPA');
    assert.deepEqual(result.groups.map(group => group.title), ['GUARDIA', 'MADRUGAR', 'RESTO']);
    assert.equal(result.personStatus.A.role, 'GUARDIA');
    assert.equal(result.personStatus.G.role, 'MADRUGA');
});

test('data integrity validation accepts coherent app data', () => {
    const collas = {
        1: {
            names: ['A', 'B', 'C'],
            verdes: [{ name: 'V1', startDate: '2026-10-05', endDate: '2026-10-11', startCycleIndex: 0, startCenter: 'CORTIJOS', rotationMode: 'SEMANAL' }],
            refData: { dateString: '2026-10-05', firstGuardName: 'A', center: 'CORTIJOS' },
            absences: [{ name: 'B', type: 'BAJA', start: '2026-10-06', end: '2026-10-07', shiftsRotation: true }]
        },
        2: {
            names: ['D', 'E', 'F'],
            verdes: [],
            refData: { dateString: '2026-10-05', firstGuardName: 'D', center: 'CEHORPA' },
            absences: []
        }
    };

    assert.deepEqual(validateDataIntegrity(collas, config), []);
});

test('data integrity validation detects duplicated names, invalid references, and overlapping absences', () => {
    const collas = {
        1: {
            names: ['A', 'A', 'B'],
            verdes: [{ name: 'B', startDate: '2026-10-10', endDate: '2026-10-01', startCycleIndex: 5, startCenter: 'NORTE', rotationMode: 'RARO' }],
            refData: { dateString: 'bad-date', firstGuardName: 'Z', center: 'OTRO' },
            absences: [
                { name: 'A', type: 'BAJA', start: '2026-10-01', end: '2026-10-05', shiftsRotation: true },
                { name: 'A', type: 'VACACIONES', start: '2026-10-04', end: '2026-10-06', shiftsRotation: true },
                { name: 'NO EXISTE', type: 'OTRA', start: 'bad-date', end: '', shiftsRotation: true }
            ]
        },
        2: {
            names: ['C'],
            verdes: [{ name: 'B', startDate: '2026-10-05', endDate: '', startCycleIndex: 0, startCenter: 'CORTIJOS', rotationMode: 'FIJO' }],
            refData: { dateString: '2026-10-05', firstGuardName: 'C', center: 'CEHORPA' },
            absences: []
        }
    };
    const problems = validateDataIntegrity(collas, {
        ...config,
        cortijos: { ...config.cortijos, intermedios: 1 }
    });
    const messages = problems.map(problem => problem.message);

    assert.ok(messages.some(message => message.includes('duplicado')));
    assert.ok(messages.some(message => message.includes('primer guardia')));
    assert.ok(messages.some(message => message.includes('fecha de fin es anterior')));
    assert.ok(messages.some(message => message.includes('patrón inicial')));
    assert.ok(messages.some(message => message.includes('persona que no existe')));
    assert.ok(messages.some(message => message.includes('ausencias solapadas')));
    assert.ok(messages.some(message => message.includes('deben sumar la capacidad')));
    assert.ok(problems.some(problem => problem.severity === 'warning' && problem.message.includes('también aparece en')));
});

test('integrity validation matches absence references and overlaps case-insensitively', () => {
    const collas = {
        1: {
            names: ['Álvaro'],
            verdes: [],
            refData: { dateString: '2026-10-05', firstGuardName: 'Álvaro', center: 'CORTIJOS' },
            absences: [
                { name: ' álvaro ', type: 'BAJA', start: '2026-10-01', end: '2026-10-05' },
                { name: 'ÁLVARO', type: 'VACACIONES', start: '2026-10-05', end: '2026-10-06' }
            ]
        },
        2: {
            names: ['C'],
            verdes: [],
            refData: { dateString: '2026-10-05', firstGuardName: 'C', center: 'CEHORPA' },
            absences: []
        }
    };
    const messages = validateDataIntegrity(collas, config).map(problem => problem.message);

    assert.ok(messages.some(message => message.includes('ausencias solapadas')));
    assert.ok(!messages.some(message => message.includes('persona que no existe')));
});

test('change history summarizes edits and retains a reversible snapshot', () => {
    const previous = {
        collas: {
            1: { names: ['ANA'], verdes: [], absences: [], refData: { firstGuardName: 'ANA' } },
            2: { names: [], verdes: [], absences: [], refData: {} }
        },
        config
    };
    const next = {
        collas: {
            ...previous.collas,
            1: { ...previous.collas[1], names: ['ANA', 'LUIS'] }
        },
        config
    };
    const recorded = recordDataChange(previous, next, {
        collaNames: { 1: 'RAYO', 2: 'MIGUEL SEXI' },
        id: 'change-1',
        at: '2026-10-09T07:00:00.000Z'
    });

    assert.equal(recorded.changeHistory.at(-1).summary, 'RAYO: se añadió LUIS');
    assert.equal(recorded.changeHistory.at(-1).actor, 'Sin identificar');
    assert.equal(recorded.undoStack.at(-1).id, 'change-1');
    assert.deepEqual(recorded.undoStack.at(-1).before, previous);
    assert.equal(recorded.revision, 'change-1');
});

test('undo restores the last shared snapshot and records the undo action', () => {
    const previous = {
        collas: {
            1: { names: ['ANA'], verdes: [], absences: [], refData: { firstGuardName: 'ANA' } },
            2: { names: ['LUIS'], verdes: [], absences: [], refData: { firstGuardName: 'LUIS' } }
        },
        config
    };
    const next = {
        collas: {
            ...previous.collas,
            1: { ...previous.collas[1], names: ['ANA', 'MAR'] }
        },
        config
    };
    const changed = recordDataChange(previous, next, { id: 'change-2' });
    const result = undoLastDataChange(changed, 'change-2', {
        id: 'undo-2',
        at: '2026-10-09T07:10:00.000Z'
    });

    assert.equal(result.ok, true);
    assert.deepEqual({ collas: result.content.collas, config: result.content.config }, previous);
    assert.equal(result.content.revision, 'undo-2');
    assert.equal(result.content.undoStack.length, 0);
    assert.equal(result.content.changeHistory.at(-1).summary, 'Se deshizo: Colla 1: se añadió MAR');
});

test('undo refuses to overwrite a later shared change or a changed snapshot', () => {
    const previous = {
        collas: {
            1: { names: ['ANA'], verdes: [], absences: [], refData: {} },
            2: { names: [], verdes: [], absences: [], refData: {} }
        },
        config
    };
    const first = recordDataChange(previous, {
        ...previous,
        collas: { ...previous.collas, 1: { ...previous.collas[1], names: ['ANA', 'MAR'] } }
    }, { id: 'first' });
    const later = recordDataChange(first, {
        collas: { ...first.collas, 1: { ...first.collas[1], names: ['ANA', 'MAR', 'LUIS'] } },
        config
    }, { id: 'later' });

    const laterResult = undoLastDataChange(later, 'first');
    assert.equal(laterResult.ok, false);
    assert.match(laterResult.reason, /Otra persona guardó cambios/);

    const tamperedRemote = { ...first, collas: previous.collas };
    const mismatchResult = undoLastDataChange(tamperedRemote, 'first');
    assert.equal(mismatchResult.ok, false);
    assert.match(mismatchResult.reason, /ya no coinciden/);
});

test('undo compares snapshots independent of JSON object key order', () => {
    const before = {
        collas: {
            1: { names: ['ANA'], verdes: [], absences: [], refData: { firstGuardName: 'ANA', center: 'CORTIJOS' } },
            2: { names: [], verdes: [], absences: [], refData: {} }
        },
        config: { cehorpa: config.cehorpa, cortijos: config.cortijos }
    };
    const after = {
        collas: {
            1: { names: ['ANA', 'MAR'], verdes: [], absences: [], refData: { firstGuardName: 'ANA', center: 'CORTIJOS' } },
            2: before.collas[2]
        },
        config
    };
    const recorded = recordDataChange(before, after, { id: 'ordered-change' });
    const databaseOrderedContent = JSON.parse(JSON.stringify(recorded), (key, value) => {
        if (!value || Array.isArray(value) || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => right.localeCompare(left)));
    });

    const result = undoLastDataChange(databaseOrderedContent, 'ordered-change');
    assert.equal(result.ok, true);
    assert.deepEqual(result.content.collas['1'].names, ['ANA']);
});
