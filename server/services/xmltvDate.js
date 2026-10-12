function createValidatedCalendarDate(year, month, day, hour, minute, second) {
    if (
        month < 1 || month > 12 ||
        day < 1 || day > 31 ||
        hour < 0 || hour > 23 ||
        minute < 0 || minute > 59 ||
        second < 0 || second > 59
    ) {
        return null;
    }

    // setUTCFullYear avoids Date.UTC's special handling of years 0-99.
    const calendarDate = new Date(0);
    calendarDate.setUTCFullYear(year, month - 1, day);
    calendarDate.setUTCHours(hour, minute, second, 0);

    // Date normalizes impossible calendar values (for example February 30),
    // so compare every component before accepting it.
    if (
        calendarDate.getUTCFullYear() !== year ||
        calendarDate.getUTCMonth() !== month - 1 ||
        calendarDate.getUTCDate() !== day ||
        calendarDate.getUTCHours() !== hour ||
        calendarDate.getUTCMinutes() !== minute ||
        calendarDate.getUTCSeconds() !== second
    ) {
        return null;
    }

    return calendarDate;
}

function parseTimezoneOffset(timezone) {
    if (!timezone || timezone.toUpperCase() === 'Z') return 0;

    const normalized = timezone.replace(':', '');
    const offsetHours = Number(normalized.slice(1, 3));
    const offsetRemainder = Number(normalized.slice(3, 5));
    if (offsetHours > 23 || offsetRemainder > 59) return null;

    const total = (offsetHours * 60) + offsetRemainder;
    return normalized[0] === '-' ? -total : total;
}

/**
 * Parse an XMLTV date/time. XMLTV permits YYYYMMDDHHmmss or a shorter
 * initial precision (for example YYYYMMDDHHmm, YYYYMMDDHH, or YYYYMMDD).
 * Missing components use the earliest value in that precision and UTC is
 * assumed when no numeric offset is provided.
 * @param {string} dateStr - XMLTV format date string
 * @returns {Date|null}
 */
function parseXmltvDate(dateStr) {
    if (!dateStr) return null;

    const value = String(dateStr).trim();
    const match = value.match(/^(\d{4}(?:\d{2}){0,5})\s*(Z|[+-]\d{4})?$/i);
    if (!match) {
        // Preserve the existing compatibility fallback for explicit ISO 8601
        // timestamps without accepting arbitrary host-dependent date strings.
        const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/i);
        if (!isoMatch) return null;

        const [, year, month, day, hour, minute, second = '0', timezone] = isoMatch;
        if (!createValidatedCalendarDate(
            Number(year),
            Number(month),
            Number(day),
            Number(hour),
            Number(minute),
            Number(second)
        ) || parseTimezoneOffset(timezone) === null) return null;

        const isoDate = new Date(value);
        return Number.isNaN(isoDate.getTime()) ? null : isoDate;
    }

    const digits = match[1];
    const timezone = match[2]?.toUpperCase();
    const year = Number(digits.slice(0, 4));
    const month = digits.length >= 6 ? Number(digits.slice(4, 6)) : 1;
    const day = digits.length >= 8 ? Number(digits.slice(6, 8)) : 1;
    const hour = digits.length >= 10 ? Number(digits.slice(8, 10)) : 0;
    const minute = digits.length >= 12 ? Number(digits.slice(10, 12)) : 0;
    const second = digits.length >= 14 ? Number(digits.slice(12, 14)) : 0;

    const calendarDate = createValidatedCalendarDate(year, month, day, hour, minute, second);
    const offsetMinutes = parseTimezoneOffset(timezone);
    if (!calendarDate || offsetMinutes === null) return null;

    return new Date(calendarDate.getTime() - (offsetMinutes * 60 * 1000));
}

module.exports = { parseXmltvDate };
