import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  findCityProfile,
  getCurrentWeather,
  getForecast,
  listSupportedCities,
  toFahrenheit,
  type WeatherSnapshot,
} from "./data.js";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

const citySchema = z
  .string()
  .min(1)
  .describe("City name in English or Chinese, e.g. \"Beijing\" or \"北京\"");
const unitSchema = z
  .enum(["c", "f"])
  .optional()
  .describe("Temperature unit. Defaults to \"c\" (celsius).");

export function createWeatherServer(): McpServer {
  const server = new McpServer(
    { name: "@demo/weather", version: "0.1.0" },
    {
      instructions:
        "Simulated weather data for demo purposes. Deterministic, offline, and read-only.",
    },
  );

  server.registerTool(
    "list_supported_cities",
    {
      title: "List supported cities",
      description: "List the cities this weather server can answer for.",
      inputSchema: {},
      annotations: { ...READ_ONLY_ANNOTATIONS },
    },
    async () => textResult({ cities: listSupportedCities() }),
  );

  server.registerTool(
    "get_current_weather",
    {
      title: "Current weather",
      description: "Get the current simulated weather (temperature, condition, humidity, wind) for a city.",
      inputSchema: { city: citySchema, unit: unitSchema },
      annotations: { ...READ_ONLY_ANNOTATIONS },
    },
    async ({ city, unit }) => {
      if (!findCityProfile(city)) {
        return unknownCityResult(city);
      }
      return textResult(present(getCurrentWeather(city), unit));
    },
  );

  server.registerTool(
    "get_forecast",
    {
      title: "Daily forecast",
      description: "Get a simulated daily forecast (1-7 days, starting today at noon) for a city.",
      inputSchema: {
        city: citySchema,
        days: z
          .number()
          .int()
          .min(1)
          .max(7)
          .optional()
          .describe("Number of forecast days between 1 and 7. Defaults to 3."),
        unit: unitSchema,
      },
      annotations: { ...READ_ONLY_ANNOTATIONS },
    },
    async ({ city, days, unit }) => {
      if (!findCityProfile(city)) {
        return unknownCityResult(city);
      }
      const forecast = getForecast(city, days ?? 3).map((snapshot) => present(snapshot, unit));
      return textResult({ city: forecast[0]?.city ?? city, days: forecast });
    },
  );

  return server;
}

function present(snapshot: WeatherSnapshot, unit: "c" | "f" | undefined): Record<string, unknown> {
  const useFahrenheit = unit === "f";
  const temperature = useFahrenheit ? toFahrenheit(snapshot.temperatureC) : snapshot.temperatureC;
  return {
    city: snapshot.city,
    observedAt: snapshot.date,
    temperature: `${temperature}°${useFahrenheit ? "F" : "C"}`,
    temperatureC: snapshot.temperatureC,
    condition: snapshot.condition,
    humidityPercent: snapshot.humidityPercent,
    windKph: snapshot.windKph,
    source: "simulated data from @demo/weather",
  };
}

function textResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function unknownCityResult(city: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: "text",
        text: `Unknown city "${city}". Call list_supported_cities to see the available cities.`,
      },
    ],
    isError: true,
  };
}
