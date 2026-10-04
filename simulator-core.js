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

    return {
        formatLocalDate,
        parseLocalDate,
        getMonday,
        differenceInCalendarDays,
        calculateRotationHeadIndex,
        validateConfig,
        normalizeConfig
    };
});
