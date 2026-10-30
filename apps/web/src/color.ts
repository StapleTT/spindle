export type Hsl = [number, number, number];
export const isHexColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value);

export function hexToHsl(hex: string): Hsl {
  if (!isHexColor(hex))
    throw new Error('Use a six-digit hex color, such as #3e56c2.');
  const [r = 0, g = 0, b = 0] =
    hex
      .slice(1)
      .match(/../g)
      ?.map((part) => Number.parseInt(part, 16) / 255) ?? [];
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min,
    lightness = (max + min) / 2;
  if (!delta) return [0, 0, lightness * 100];
  const hue =
    max === r
      ? ((g - b) / delta) % 6
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
  return [
    (hue * 60 + 360) % 360,
    (delta / (1 - Math.abs(2 * lightness - 1))) * 100,
    lightness * 100,
  ];
}

export function hslToHex([hue, saturation, lightness]: Hsl) {
  const s = saturation / 100,
    l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s,
    x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1)),
    m = l - chroma / 2;
  const rgb =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return `#${rgb
    .map((value) =>
      Math.round((value + m) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
