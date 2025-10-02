import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import axios from "axios";

// Ensure API key exists before importing the service for the first time
process.env.OPEN_WEATHER_API_KEY =
  process.env.OPEN_WEATHER_API_KEY || "test-key";

type AxiosGet = typeof axios.get;
let originalAxiosGet: AxiosGet;
let callCount = 0;

// Simple stubbed logger for session
const sessionU1 = {
  userId: "u1",
  logger: {
    debug: (_?: any, __?: any) => {},
    error: (_?: any, __?: any) => {},
    warn: (_?: any, __?: any) => {},
    info: (_?: any, __?: any) => {},
  },
};
const sessionU2 = {
  userId: "u2",
  logger: {
    debug: (_?: any, __?: any) => {},
    error: (_?: any, __?: any) => {},
    warn: (_?: any, __?: any) => {},
    info: (_?: any, __?: any) => {},
  },
};

const makeAxiosStub = (tempsC: number[], conditions: string[] = []) => {
  callCount = 0;
  (axios as any).get = async (_url: string) => {
    const idx = Math.min(callCount, tempsC.length - 1);
    const tempC = tempsC[idx];
    const condition = conditions[idx] ?? "Clear";
    callCount += 1;
    return {
      data: {
        current: {
          temp: tempC,
          weather: [{ main: condition }],
        },
      },
    };
  };
};

let originalDateNow = Date.now;

beforeEach(() => {
  // Save originals
  originalAxiosGet = axios.get.bind(axios);
  makeAxiosStub([20, 25, 30], ["Clouds", "Rain", "Snow"]); // default stub per test
  // Reset Date.now
  Date.now = originalDateNow;
});

afterEach(() => {
  // Restore axios.get
  (axios as any).get = originalAxiosGet;
  // Restore Date.now
  Date.now = originalDateNow;
});

describe("weather.service minimal caching behavior", () => {
  test("fetches from network on first call and populates per-user and shared caches", async () => {
    const { weatherService } = await import("../weather.service");
    weatherService.__resetForTests();

    const lat = 37.7749;
    const long = -122.4194;
    const result = await weatherService.getWeather(sessionU1 as any, lat, long);

    expect(result).not.toBeNull();
    expect(result?.tempC).toBe(20);
    expect(result?.tempF).toBe(Math.round((20 * 9) / 5 + 32));
    expect(result?.condition).toBe("Clouds");

    // axios called once
    expect(callCount).toBe(1);

    // Shared cache should now have 1 entry
    expect(weatherService.__sharedCacheSize()).toBe(1);
    expect(weatherService.__hasSharedFor(lat, long)).toBe(true);
  });

  test("reuses per-user cache within 5km and TTL without extra network calls", async () => {
    const { weatherService } = await import("../weather.service");
    weatherService.__resetForTests();

    const lat = 37.7749;
    const long = -122.4194;

    // First call populates caches (network)
    const first = await weatherService.getWeather(sessionU1 as any, lat, long);
    expect(first?.tempC).toBe(20);
    expect(callCount).toBe(1);

    // Move ~3.3km north (0.03 degrees latitude ~ 3.3 km); within 5km
    const latNear = lat + 0.03;
    const second = await weatherService.getWeather(
      sessionU1 as any,
      latNear,
      long,
    );
    expect(second?.tempC).toBe(20);

    // Should still be only 1 network call due to per-user cache reuse
    expect(callCount).toBe(1);
  });

  test("reuses shared cache for another user within 5km and TTL", async () => {
    const { weatherService } = await import("../weather.service");
    weatherService.__resetForTests();

    const lat = 37.7749;
    const long = -122.4194;

    // User 1 triggers network fetch and populates shared cache
    const first = await weatherService.getWeather(sessionU1 as any, lat, long);
    expect(first?.tempC).toBe(20);
    expect(callCount).toBe(1);

    // Another user nearby within 5km (small delta; may fall in same or neighbor bucket; service checks neighbors)
    const latNearby = lat + 0.002;
    const second = await weatherService.getWeather(
      sessionU2 as any,
      latNearby,
      long,
    );
    expect(second?.tempC).toBe(20);

    // Should not increase network calls (shared cache hit + per-user hydration)
    expect(callCount).toBe(1);
  });

  test("expires after 10 minutes and refetches from network", async () => {
    const { weatherService } = await import("../weather.service");
    weatherService.__resetForTests();

    const lat = 37.7749;
    const long = -122.4194;

    // Base time
    const t0 = Date.now();
    Date.now = () => t0;

    // First call (network)
    const first = await weatherService.getWeather(sessionU1 as any, lat, long);
    expect(first?.tempC).toBe(20);
    expect(callCount).toBe(1);

    // Advance just past TTL (10 minutes + 1 ms)
    const TEN_MIN = 10 * 60 * 1000;
    Date.now = () => t0 + TEN_MIN + 1;

    // Second call should refetch
    const second = await weatherService.getWeather(sessionU1 as any, lat, long);
    expect(second?.tempC).toBe(25); // from our stub's second response
    expect(callCount).toBe(2);
  });

  test("per-user cache ignored when outside 5km; triggers refetch", async () => {
    const { weatherService } = await import("../weather.service");
    weatherService.__resetForTests();

    const lat = 37.7749;
    const long = -122.4194;

    // First call (network)
    const first = await weatherService.getWeather(sessionU1 as any, lat, long);
    expect(first?.tempC).toBe(20);
    expect(callCount).toBe(1);

    // Move ~6.7km north (0.06 degrees latitude ~ 6.7 km); outside 5km
    const latFar = lat + 0.06;
    const second = await weatherService.getWeather(
      sessionU1 as any,
      latFar,
      long,
    );
    expect(second?.tempC).toBe(25); // second network response
    expect(callCount).toBe(2);
  });

  test("does not reuse shared cache for another user when outside 5km; triggers refetch", async () => {
    const { weatherService } = await import("../weather.service");
    weatherService.__resetForTests();

    const lat = 37.7749;
    const long = -122.4194;

    // User 1 triggers network fetch and populates shared cache
    const first = await weatherService.getWeather(sessionU1 as any, lat, long);
    expect(first?.tempC).toBe(20);
    expect(callCount).toBe(1);

    // Another user more than 5km away (about 0.06° latitude ~ 6.7 km)
    const latFar = lat + 0.06;
    const second = await weatherService.getWeather(
      sessionU2 as any,
      latFar,
      long,
    );

    // Should not use shared cache; should refetch (second network call -> stub returns 25C)
    expect(second?.tempC).toBe(25);
    expect(callCount).toBe(2);
  });
});
