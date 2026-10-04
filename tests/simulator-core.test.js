const test = require('node:test');
const assert = require('node:assert/strict');
const {
    calculateRotationHeadIndex,
    differenceInCalendarDays,
    formatLocalDate,
    getMonday,
    normalizeConfig,
    parseLocalDate,
    validateConfig
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
