export interface LocalDateTimeParts {
  day: number;
  hour: number;
  minute: number;
  month: number;
  year: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timeZone);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  });
  formatters.set(timeZone, created);
  return created;
}

export function localParts(date: Date, timeZone: string): LocalDateTimeParts {
  const values = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    day: values.day ?? 0,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    month: values.month ?? 0,
    year: values.year ?? 0,
  };
}

export function localDateString(date: Date, timeZone: string): string {
  const parts = localParts(date, timeZone);
  return `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString()
    .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

export function addLocalDays(localDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(localDate);
  if (!match || !Number.isInteger(days)) throw new Error("invalid_local_date");
  const result = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days),
  );
  return result.toISOString().slice(0, 10);
}

export function zonedDateTimeToUtc(
  localDate: string,
  minuteOfDay: number,
  timeZone: string,
): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(localDate);
  if (
    !match ||
    !Number.isInteger(minuteOfDay) ||
    minuteOfDay < 0 ||
    minuteOfDay > 1439
  ) {
    throw new Error("invalid_local_datetime");
  }
  const desired = {
    day: Number(match[3]),
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
    month: Number(match[2]),
    year: Number(match[1]),
  };
  const desiredAsUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
  );
  let guess = desiredAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = localParts(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    guess += desiredAsUtc - actualAsUtc;
  }
  const result = new Date(guess);
  const resolved = localParts(result, timeZone);
  if (
    resolved.year !== desired.year ||
    resolved.month !== desired.month ||
    resolved.day !== desired.day ||
    resolved.hour !== desired.hour ||
    resolved.minute !== desired.minute
  ) {
    throw new Error("nonexistent_local_datetime");
  }
  return result;
}

export function digestContentWindow(
  sendLocalDate: string,
  timeZone: string,
): { end: Date; start: Date } {
  return {
    end: zonedDateTimeToUtc(sendLocalDate, 0, timeZone),
    start: zonedDateTimeToUtc(addLocalDays(sendLocalDate, -1), 0, timeZone),
  };
}

export function isInsideSendWindow(
  date: Date,
  timeZone: string,
  startMinute: number,
  windowMinutes: number,
): boolean {
  const parts = localParts(date, timeZone);
  const minute = parts.hour * 60 + parts.minute;
  return minute >= startMinute && minute < startMinute + windowMinutes;
}
