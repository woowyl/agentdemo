export const CONDITIONS = [
  "Sunny",
  "Partly cloudy",
  "Overcast",
  "Light rain",
  "Thunderstorm",
  "Snow",
] as const;

export type Condition = (typeof CONDITIONS)[number];

export interface CityProfile {
  city: string;
  aliases: string[];
  baseTempC: number;
  humidity: number;
}

export interface WeatherSnapshot {
  city: string;
  date: string;
  temperatureC: number;
  condition: Condition;
  humidityPercent: number;
  windKph: number;
}

const CITY_PROFILES: CityProfile[] = [
  { city: "Beijing", aliases: ["北京", "beijing"], baseTempC: 13, humidity: 45 },
  { city: "Shanghai", aliases: ["上海", "shanghai"], baseTempC: 18, humidity: 70 },
  { city: "Shenzhen", aliases: ["深圳", "shenzhen"], baseTempC: 24, humidity: 78 },
  { city: "Chengdu", aliases: ["成都", "chengdu"], baseTempC: 17, humidity: 75 },
  { city: "Tokyo", aliases: ["东京", "tokyo"], baseTempC: 17, humidity: 65 },
  { city: "Singapore", aliases: ["新加坡", "singapore"], baseTempC: 28, humidity: 84 },
  { city: "London", aliases: ["伦敦", "london"], baseTempC: 12, humidity: 72 },
  { city: "Berlin", aliases: ["柏林", "berlin"], baseTempC: 11, humidity: 68 },
  { city: "New York", aliases: ["纽约", "new york"], baseTempC: 14, humidity: 62 },
  { city: "San Francisco", aliases: ["旧金山", "san francisco"], baseTempC: 16, humidity: 70 },
];

export function listSupportedCities(): string[] {
  return CITY_PROFILES.map((profile) => profile.city);
}

export function findCityProfile(query: string): CityProfile | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return undefined;
  }
  return CITY_PROFILES.find(
    (profile) =>
      profile.city.toLowerCase() === needle ||
      profile.aliases.some((alias) => alias.toLowerCase() === needle),
  );
}

export function getCurrentWeather(city: string, at: Date = new Date()): WeatherSnapshot {
  return snapshot(city, at);
}

export function getForecast(
  city: string,
  days: number,
  at: Date = new Date(),
): WeatherSnapshot[] {
  const clamped = Math.min(Math.max(Math.trunc(days), 1), 7);
  return Array.from({ length: clamped }, (_, offset) => {
    const day = new Date(at);
    day.setDate(day.getDate() + offset);
    day.setHours(12, 0, 0, 0);
    return snapshot(city, day);
  });
}

function snapshot(city: string, at: Date): WeatherSnapshot {
  const profile = findCityProfile(city);
  const base = profile?.baseTempC ?? 15;
  const baseHumidity = profile?.humidity ?? 60;

  const date = formatDate(at);
  const hour = at.getHours();
  const month = at.getMonth();
  const seasonal = -10 * Math.cos((2 * Math.PI * month) / 12);
  const diurnal = 4 * Math.cos((2 * Math.PI * (hour - 14)) / 24);
  const jitter = (hash(`${city}|${date}`) % 500) / 100 - 2.5;

  const temperatureC = round1(base + seasonal + diurnal + jitter);
  const conditionIndex = hash(`${city}|${date}|${Math.floor(hour / 6)}`) % CONDITIONS.length;
  const condition = CONDITIONS[conditionIndex] ?? "Partly cloudy";
  const humidityPercent = Math.min(
    100,
    Math.max(10, Math.round(baseHumidity + (hash(`${city}|humidity|${date}`) % 21) - 10)),
  );
  const windKph = 2 + (hash(`${city}|wind|${date}|${hour}`) % 28);

  return {
    city: profile?.city ?? city,
    date: `${date} ${String(hour).padStart(2, "0")}:00`,
    temperatureC,
    condition,
    humidityPercent,
    windKph,
  };
}

export function toFahrenheit(temperatureC: number): number {
  return round1(temperatureC * 1.8 + 32);
}

function formatDate(at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function hash(input: string): number {
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value);
}
