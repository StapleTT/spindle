export function localTime(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function futureInstant(value: string) {
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    localTime(date) !== value ||
    date.getTime() <= Date.now()
  )
    throw new Error(
      'Choose a valid future time. Some local times do not exist during a daylight-saving change.',
    );
  return date.toISOString();
}

export function DateTimeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const date = new Date(value),
    valid = Number.isFinite(date.getTime()) && localTime(date) === value;
  return (
    <>
      <label>
        {label}
        <input
          type="datetime-local"
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <p className="account-status">
        Timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}.{' '}
        {valid && (
          <>
            {date.toLocaleString(undefined, { timeZoneName: 'short' })} (
            {date.toISOString()}).
          </>
        )}
      </p>
    </>
  );
}
