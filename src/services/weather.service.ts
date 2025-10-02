import axios from "axios";
import type { AppSession } from "@mentra/sdk";
import * as geohash from "ngeohash";

export interface WeatherSummary {
  condition: string;
  tempC: number; // canonical
  tempF: number; // derived locally
}

type BucketKey = string;

export interface CacheEntry {
  bucketKey: BucketKey;
  lat: number;
  long: number;
  weatherSummary: WeatherSummary;
  fetchedAt: number;
  expiresAt: number;
}

const PROXIMITY_KM = 5;
const FRESH_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_SHARED_CACHE_ENTRIES = 1000;

export class WeatherService {
  private static _instance: WeatherService | null = null;
  static instance(): WeatherService {
    if (!this._instance) this._instance = new WeatherService();
    return this._instance;
  }

  private readonly apiKey = process.env.OPEN_WEATHER_API_KEY;

  // Single-entry per user cache: userId -> CacheEntry
  private perUserCache = new Map<string, CacheEntry>();

  // Shared cross-user proximity cache + simple LRU by bucketKey
  private sharedCache = new Map<BucketKey, CacheEntry>();
  private sharedLRU: BucketKey[] = [];

  private constructor() {}

  // Minimal API: returns WeatherSummary or null
  public async getWeather(
    session: AppSession,
    lat: number,
    long: number,
  ): Promise<WeatherSummary | null> {
    const logger = session.logger;
    const userId = session.userId;
    const currentTime = Date.now();

    // 1) Per-user cache
    const userEntry = this.perUserCache.get(session.userId);
    if (userEntry && userEntry.expiresAt > currentTime) {
      if (
        this.withinKm(
          { lat: userEntry.lat, lon: userEntry.long },
          { lat, lon: long },
          PROXIMITY_KM,
        )
      ) {
        logger.debug?.({ userId: session.userId }, "weather.cache.hit.user");
        return userEntry.weatherSummary;
      }
    }

    // 2) Shared cache (bucket-based)
    const bucketKey = this.computeBucketKey(lat, long);
    let sharedEntry = this.sharedCache.get(bucketKey);
    if (sharedEntry && sharedEntry.expiresAt > currentTime) {
      if (
        this.withinKm(
          { lat: sharedEntry.lat, lon: sharedEntry.long },
          { lat, lon: long },
          PROXIMITY_KM,
        )
      ) {
        logger.debug({ bucketKey, sharedEntry }, "weather.cache.hit.shared");
        // hydrate per-user cache (overwrite)
        this.perUserCache.set(session.userId, sharedEntry);
        return sharedEntry.weatherSummary;
      }
    }
    // Check neighbor buckets to reduce boundary misses
    for (const nb of geohash.neighbors(bucketKey)) {
      const e = this.sharedCache.get(nb);
      if (e && e.expiresAt > currentTime) {
        if (
          this.withinKm(
            { lat: e.lat, lon: e.long },
            { lat, lon: long },
            PROXIMITY_KM,
          )
        ) {
          logger.debug(
            { bucketKey: nb, sharedEntry: e },
            "weather.cache.hit.shared.neighbor",
          );
          this.perUserCache.set(session.userId, e);
          return e.weatherSummary;
        }
      }
    }

    // 3) Network fetch
    if (!this.apiKey) {
      logger.error("OPEN_WEATHER_API_KEY is not set in environment variables");
      return null;
    }

    const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${long}&exclude=minutely,hourly,daily,alerts&units=metric&appid=${this.apiKey}`;
    logger.debug({ lat, long, url }, "weather.request.sent");

    try {
      const resp = await axios.get(url);
      const data = resp.data;
      const condition = data?.current?.weather?.[0]?.main ?? "";
      const tempC = Math.round(data?.current?.temp ?? 0);
      const tempF = Math.round((tempC * 9) / 5 + 32);
      const summary: WeatherSummary = { condition, tempC, tempF };

      const entry: CacheEntry = {
        bucketKey,
        lat,
        long,
        weatherSummary: summary,
        fetchedAt: currentTime,
        expiresAt: currentTime + FRESH_TTL_MS,
      };

      // Upsert shared cache with LRU
      this.upsertSharedCache(entry);
      // Overwrite per-user cache
      this.perUserCache.set(session.userId, entry);

      return summary;
    } catch (err: any) {
      const _logger = session.logger.child({ errorMessage: err?.message });
      _logger.error?.(err, "weather.request.failed");
      return null;
    }
  }

  public clearUser(userId: string) {
    this.perUserCache.delete(userId);
  }

  // Test-only: reset caches for isolation
  public __resetForTests() {
    this.perUserCache.clear();
    this.sharedCache.clear();
    this.sharedLRU = [];
  }

  // Test-only: size of shared cache
  public __sharedCacheSize(): number {
    return this.sharedCache.size;
  }

  // Test-only: does shared cache have an entry for this coordinate's bucket?
  public __hasSharedFor(lat: number, long: number): boolean {
    const key = this.computeBucketKey(lat, long);
    return this.sharedCache.has(key);
  }

  // Internal: caching structures
  private upsertSharedCache(entry: CacheEntry) {
    this.sharedCache.set(entry.bucketKey, entry);
    const idx = this.sharedLRU.indexOf(entry.bucketKey);
    if (idx >= 0) this.sharedLRU.splice(idx, 1);
    this.sharedLRU.push(entry.bucketKey);
    while (this.sharedLRU.length > MAX_SHARED_CACHE_ENTRIES) {
      const evict = this.sharedLRU.shift()!;
      this.sharedCache.delete(evict);
    }
  }

  // Internal: bucket computations and proximity
  private computeBucketKey(lat: number, lon: number): BucketKey {
    return geohash.encode(lat, lon, 5);
  }

  private withinKm(
    a: { lat: number; lon: number },
    b: { lat: number; lon: number },
    maxKm: number,
  ): boolean {
    return this.haversineKm(a.lat, a.lon, b.lat, b.lon) <= maxKm;
  }

  private haversineKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const s1 = Math.sin(dLat / 2);
    const s2 = Math.sin(dLon / 2);
    const a = s1 * s1 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2;
    const c = 2 * Math.asin(Math.min(1, Math.sqrt(a)));
    return R * c;
  }
}

export const weatherService = WeatherService.instance();
