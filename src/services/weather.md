# Weather service plan (simplified, authoritative spec)

Scope: replace `dashboard-modules/WeatherModule.ts` with `src/services/weather.service.ts` using a minimal design focused on avoiding rate limits with simple caching. Anything not stated here is out of scope.

Goals:
- Avoid unnecessary network requests by caching for 10 minutes.
- Share cached weather results across users by proximity.
- Keep the design minimal: no SWR, no backoff, no request coalescing, no jitter.

Data types:
- WeatherSummary:
  - condition: string
  - tempC: number (canonical)
  - tempF: number (derived locally)
- CacheEntry (authoritative):
```/dev/null/types.ts#L1-12
interface CacheEntry {
  bucketKey: BucketKey;
  lat: number;
  long: number;
  weatherSummary: WeatherSummary;
  fetchedAt: number;
  expiresAt: number;
}
```

Caching model:
- Per-user cache:
  - Key: `session.userId`
  - Value: a single `CacheEntry` (the most recent for that user)
  - Behavior: overwrite on each successful fetch; if entry exists and is valid, reuse it.
- Shared location cache:
  - Key: `BucketKey` (see bucketing below)
  - Value: `CacheEntry`
  - Capacity: 1000 entries (simple LRU; evict oldest when over capacity)

TTL and validity:
- Fresh TTL: 10 minutes
- If `expiresAt > now`, the entry is valid
- If invalid/expired, treat as miss and fetch

Proximity and bucketing:
- Acceptance radius for cache reuse: within 5 km (haversine distance)
- Bucketing for fast lookup (approx 5 km grid):
  - LAT_GRID_DEG = 0.045 (≈5 km latitude)
  - lonStep = LAT_GRID_DEG / max(cos(latRadians), 0.01)
  - bucketLat = round(lat / LAT_GRID_DEG) * LAT_GRID_DEG
  - bucketLon = round(long / lonStep) * lonStep
  - bucketKey = `${bucketLat.toFixed(5)}:${bucketLon.toFixed(5)}`
- Use haversine distance to confirm within 3 km before claiming a cache hit

WeatherService minimal API:
- getWeather(session, userId, lat, long): Promise<WeatherSummary | null>
  - Step 1 (per-user): If user cache exists, not expired, and within 5 km of (lat,long), return its `weatherSummary`.
  - Step 2 (shared): Compute `bucketKey`, check shared cache entry for that bucket; if present and within 5 km and not expired:
    - Copy it into per-user cache (overwrite)
    - Return its `weatherSummary`
  - Step 3 (network fetch):
    - Request OpenWeather OneCall 3.0 using `units=metric`
    - Build `WeatherSummary` with canonical Celsius and derived Fahrenheit
    - Create `CacheEntry` with `fetchedAt=now`, `expiresAt=now+10min`
    - Upsert into shared cache (evict oldest if >1000), and per-user cache (overwrite)
    - Return `weatherSummary`
- clearUser(userId): optional helper to clear per-user single entry

Units handling:
- Always store Celsius in cache; derive Fahrenheit locally (no refetch on unit toggle)

Logging (minimal):
- Log cache hit/miss per-user and shared, and network fetch attempts
- Do not add counters/backoff/jitter complexity

Integration points (`src/index.ts`):
- Replace `WeatherModule` usage with `weatherService.getWeather(session, session.userId, lat, long)`
- Do not refetch when metric/imperial preference changes; re-render using cached Celsius, converting to Fahrenheit in presentation as needed
- Keep `dashboard-modules/WeatherModule.ts` file untouched

Non-requirements (explicitly not included):
- No stale-while-revalidate
- No rate-limit backoff
- No request coalescing
- No jitter
- Eliminates unnecessary network calls by adding strong caching and proximity-based reuse.
- Provides deterministic behavior under rate-limits and network instability.
- Simplifies `index.ts` call sites and avoids unit-change refetches.
- Adds observability so we can quantify request rates, cache hit rates, and rate-limit incidents.

Sections:
1) Current usage and pain points
2) Requirements and goals
3) Proposed API
4) Caching strategy
5) Location proximity and bucketing
6) Request coalescing and in-flight de-dup
7) Rate limiting and backoff
8) Unit handling (no refetch on unit toggle)
9) Observability (how we’ll know it works)
10) Integration points in `index.ts`
11) Configuration constants (tunable)
12) Testing plan
13) Future enhancements


1) Current usage and pain points

Where weather is fetched today:
- In `DashboardServer.handleLocationUpdate`:
  - Called for every location update from `session.location.subscribeToStream({ accuracy: "standard" }, ...)`
  - After setting `latestLocation`, it calls `await this.fetchWeatherData(session, sessionId, lat, lng)`.
- In `DashboardServer.setupSettingsHandlers` on metric system change:
  - Forces a refresh regardless of cache by calling `this.fetchWeatherData(..., true)`.
- In `DashboardServer.fetchWeatherData`:
  - Has a `shouldFetchWeather` check (1 hour TTL), but currently there’s a hardcoded `|| true` that forces network calls every time. This will hammer the upstream API and is likely the cause of rate limits.

Key problems:
- Every location update results in an API call because of the `|| true`.
- There’s no concept of proximity-based cache hits (nearby locations should reuse).
- Unit toggling forces refetch, but this should be a presentation concern.
- No deduplication for concurrent calls.
- No rate-limit backoff or “stale-while-revalidate” policy.
- Cache stores only a formatted string; we lose structured data and reusability.


2) Requirements and goals

- Cache weather per user and by location, with re-use if the new position is within 3 km of a cached result.
- Avoid re-fetching for unit changes; store canonical values and convert locally.
- Introduce a minimum refresh interval and a max freshness TTL with stale-while-revalidate.
- Deduplicate concurrent requests (coalescing).
- Back off on 429s with exponential strategy and Retry-After support.
- Provide clear metrics/logs to quantify:
  - How often we try to fetch.
  - Cache hit/miss ratios.
  - Rate-limit incidents and cool-down behavior.
- Keep integration changes in `index.ts` small and localized.


3) Proposed API

New service at `src/services/weather.service.ts` with an instance exported as a singleton. Core methods:

- getForecast(session, userId, latitude, longitude, options?)
  - Returns { summary, meta }, where:
    - summary: { condition: string; tempC: number; tempF: number }
    - meta: { source: "cache" | "stale-cache" | "network"; fetchedAt: number; location: { lat, lon } }
  - Decides whether to serve from cache, serve stale and refresh in background, or fetch.

- warmup(userId, latitude, longitude)
  - Optional: prefetch/background refresh.

- clearUser(userId)
  - Optional: drop cache for a specific user, e.g., on logout.

Internal helpers (implementation detail, not exported):
- findCacheHit(userId, lat, lon): returns a cache entry if within 3 km and not expired, else stale if within allowed stale window.
- upsertCache(userId, bucketKey, data, position, fetchedAt)
- distanceKm(a, b): haversine calculation.
- computeBucketKey(lat, lon): proximity bucket for fast lookup (see Section 5).
- shouldFetch(entry, now): respects min refresh interval, freshness TTL, and backoff state.


4) Caching strategy

Scope and keys:
- Scope cache per user: each user has independent weather cache to honor personalized policies and to isolate rate-limit backoff state.
- Within each user, entries are keyed by a location bucket + provider + product (e.g., "openweather:onecall3").
- Also maintain a small list or map of entries to allow proximity lookup (neighbor buckets) and exact distance check.

Freshness and staleness:
- FRESH_TTL: e.g., 30 minutes (tunable). Within this window, always serve cache.
- STALE_TTL: e.g., 2 hours (tunable). Beyond fresh but within stale, serve stale and trigger background refresh (SWr: stale-while-revalidate).
- Beyond STALE_TTL, treat as miss: attempt network fetch unless in backoff.

Minimum refresh interval:
- MIN_REFRESH_INTERVAL: e.g., 5 minutes. Even if user moves a small distance within 3 km, avoid immediate refetch storms. If the last fetch for the bucket is within this time, serve cache and skip network.

Eviction:
- Per-user LRU with max entries (e.g., 20). Drop least recently used when exceeding capacity. This prevents unbounded memory growth if the user travels broadly.

Data to store per cache entry:
- bucketKey, canonicalLocation { lat, lon }
- fetchedAt, expiresAt, staleUntil
- weatherSummary: { condition, tempC, tempF } where tempC is canonical and tempF derived on demand
- lastAccessed
- provider metadata (for debugging)
- lastError / lastStatus if applicable


5) Location proximity and bucketing

Proximity target: cache hits if new location is within 3 km of cached entry.

Two complementary mechanisms:
- Bucketing for fast lookup:
  - Simple approach: round latitude to grid of ~0.027° (≈3 km), and longitude to ~0.027° / cos(lat).
  - bucketLat = round(lat / 0.027) * 0.027
  - bucketLon = round(lon / (0.027 / cos(latRadians))) * (0.027 / cos(latRadians))
  - bucketKey = `${round(bucketLat, 5)}:${round(bucketLon, 5)}`
  - This approximates 3 km tiles; may vary with latitude, which is acceptable.
- Exact distance guard:
  - After selecting candidates by bucket (and optionally neighbor buckets for border cases), compute haversine distance between candidate entry’s canonicalLocation and current location to confirm <= 3 km before claiming a hit.

Why both?
- Bucketing narrows the candidate set to O(1).
- Haversine ensures correctness near tile boundaries and prevents false positives.

Distance function (haversine) principle:
- d = 2R * asin(sqrt(sin²((Δφ)/2) + cos φ1 cos φ2 sin²((Δλ)/2))), with R ≈ 6371 km
- We will implement this in the service for precise checks.


6) Request coalescing and in-flight de-dup

To avoid duplicate network calls for the same user+bucket while one is in progress:
- Maintain a map of in-flight Promises keyed by userId+bucketKey.
- If a second request arrives for the same key, return the same Promise.
- Clear the Promise from the map when completed (success or failure).
- This prevents spikes when multiple events trigger at once (e.g., rapid successive location updates, dashboard refresh plus unit change).


7) Rate limiting and backoff

When the upstream returns 429 or the client detects rate-limit conditions:
- Respect Retry-After if provided (seconds or HTTP date). Use that as a short-term cooldown for the userId or globally for the provider.
- Otherwise, exponential backoff per userId+provider:
  - Initial backoff: 60 seconds
  - Double up to max (e.g., 30 minutes)
  - Decay backoff after successful requests
- During backoff:
  - Serve fresh cache if available.
  - Serve stale cache if within STALE_TTL.
  - If no cache exists, return a graceful null or a sentinel value, and log at warn level with context. Do not hammer the API.

Jitter:
- Apply small random jitter (±10%) to TTLs and backoff windows to avoid synchronized thundering herds across users.

Error handling:
- For network errors/timeouts, treat similarly to rate-limit for cooldown but with a shorter backoff or capped retries, and log as retryable network issue vs. rate-limit.


8) Unit handling (no refetch on unit toggle)

Current behavior:
- Changing `metricSystemEnabled` forces a refetch. This is unnecessary.

New behavior:
- Always store canonical Celsius (tempC).
- Derive tempF on demand: tempF = round(tempC * 9/5 + 32)
- Store both in the cache entry to avoid recompute churn in hot paths.
- When the user toggles units:
  - Don’t refetch.
  - Re-render with the cached canonical values.

Upstream units:
- Configure OpenWeather request with `units=metric` (to get Celsius directly) and convert locally if needed. This also helps with consistency.


9) Observability (how we’ll know it works)

Add structured logs and counters via `session.logger`:
- weather.request.attempted: { userId, bucketKey }
- weather.request.sent: { provider, url, bucketKey }
- weather.request.skipped.minInterval: { reason, sinceLastMs }
- weather.cache.hit.fresh: { userId, bucketKey, ageMs }
- weather.cache.hit.stale: { userId, bucketKey, ageMs }
- weather.cache.miss: { userId, bucketKey }
- weather.rate_limited: { userId, retryAfterMs? }
- weather.error.network: { userId, message }
- weather.backoff.state: { userId, backoffMs }
- weather.distance.computed: { distanceKm, withinKm: 3 }

Additionally, emit summary counts periodically (e.g., per session every N minutes) to see rates over time:
- Requests made vs. cache hits ratio
- Rate-limit incidents


10) Integration points in `index.ts`

Replace direct usage of `WeatherModule` with `WeatherService`:
- In `fetchWeatherData`:
  - Remove hardcoded `|| true` fetch condition.
  - Call `WeatherService.getForecast(session, session.userId, lat, lng)`.
  - It will return { summary, meta }. Use `session.settings.getMentraosSetting("metricSystemEnabled")` to format the temperature unit for display, but do not refetch.
  - Update `sessionInfo.weatherCache` to store a more structured payload (not just a string), e.g.,
    - weather: summary
    - lastUpdated: meta.fetchedAt
    - lastLocation: meta.location
    - lastSource: meta.source
  - Then call `updateDashboardSections`.

- In `handleLocationUpdate`:
  - Keep the same call chain. The service will decide if a network fetch is needed based on distance/time/backoff.
  - Optionally, log the effective decision: from meta.source.

- In `setupSettingsHandlers` for metric change:
  - Remove the forced refresh; just call `updateDashboardSections` so it re-renders with the cached values in the new unit.

Backward compatibility:
- Keep the `WeatherSummary` shape consistent enough so that formatting logic in `index.ts` remains simple.

Note on session-vs-user scope:
- If multiple sessions per user are possible, cache should be keyed by userId globally (singleton service), so different sessions share results and reduce API load.


11) Configuration constants (tunable)

- PROXIMITY_KM = 3
- LAT_GRID_DEG = 0.027 (≈3 km latitude)
- FRESH_TTL_MS = 30 minutes
- STALE_TTL_MS = 2 hours
- MIN_REFRESH_INTERVAL_MS = 5 minutes
- MAX_USER_CACHE_ENTRIES = 20
- INITIAL_BACKOFF_MS = 60 seconds
- MAX_BACKOFF_MS = 30 minutes
- JITTER_RATIO = 0.1 (±10%)

These will be defined in the service and can be environment-overridden later if necessary.


12) Testing plan

Unit tests:
- distanceKm correctness against known pairs.
- Bucketing correctness across latitudes; ensure neighbor buckets + haversine verification catches boundary cases.
- Cache hit for same bucket within FRESH_TTL.
- Stale-while-revalidate returns stale and triggers background refresh.
- Min refresh interval prevents frequent refetch if moving within 3 km rapidly.
- Unit toggle does not trigger fetch and uses cached canonical values.
- Backoff progression on repeated 429s and respect for Retry-After.
- In-flight request coalescing (simulate concurrent getForecast calls).

Integration tests (manual/local):
- Simulate rapid location updates within a city block; ensure near-zero network calls after first fetch.
- Simulate driving across town with updates every few seconds; see bounded calls aligned with 3 km resolution.
- Toggle metric setting repeatedly; verify no additional network calls.
- Simulate 429 responses; verify backoff and stale serving behavior.
- Validate dashboard text updates with correct temp unit and condition.


13) Future enhancements

- Multi-provider failover (e.g., Open-Meteo, NWS): try other providers when rate-limited; standardize on canonical units.
- Hourly/daypart caching if we expand UI; prefetch next hour when serving current.
- Geohash-based bucketing (precision 5–6) for simpler neighbor searches; optional dependency.
- Persistent cache across process restarts (disk or KV) with short TTL.
- ETag/If-None-Match support if provider offers it (reduce payload/bandwidth).
- User-level caching policy knobs exposed via settings (advanced users/admin).

Summary of action items:
- Implement `WeatherService` with:
  - Proximity-aware cache per user (3 km radius).
  - Fresh/stale TTLs and min refresh interval.
  - Request coalescing.
  - Rate-limit backoff with Retry-After support.
  - Canonical Celsius storage; local Fahrenheit conversion.
  - Structured metrics/logs.
- Replace `WeatherModule` usage in `index.ts` with `WeatherService.getForecast`.
- Stop refetching on metric setting changes.
- Validate with metrics that request volume drops and cache hit rate rises, then tune constants as needed.

Addendum: shared cross-user proximity cache and 10-minute TTL
- Shared proximity cache across users:
  - Introduce a global proximity cache keyed by location buckets (see Section 5) that is shared across all users.
  - Lookup order for a user request:
    1) Check the per-user cache (fast path honoring per-user min-refresh and backoff state).
    2) If miss or stale beyond fresh window, check the shared cross-user proximity cache using bucket and neighbor buckets; confirm with haversine distance <= 3 km.
    3) If shared cache has a fresh entry, serve that immediately and hydrate the per-user cache with the same entry (copy-on-read) so subsequent calls by the same user are fast and retain per-user backoff/min-refresh behavior.
    4) If shared cache has only stale entry within STALE_TTL, serve stale while triggering a background refresh (coalesced).
    5) If no suitable shared entry, proceed to network fetch (subject to rate limit/backoff).
  - Rationale: Different users in the same vicinity benefit from shared results; the per-user layer preserves user-scoped policies (min refresh, backoff state).
- Fresh TTL is now 10 minutes:
  - FRESH_TTL_MS = 10 minutes (overrides the previous 30 minutes stated in Section 11).
  - Keep STALE_TTL_MS as before (e.g., 2 hours), and keep SWR behavior.
- Do not refetch on unit toggle:
  - Continue to store canonical Celsius and derive Fahrenheit locally; per-user display changes do not cause fetches.
- Note: Leave the legacy WeatherModule.ts in place; the new service will be integrated without deleting the old module.

Starter implementation outline for src/services/weather.service.ts
The following is a minimal scaffold that reflects the plan above (not yet wired into index.ts). It includes per-user cache, a shared cross-user proximity cache, 10-minute fresh TTL, SWR, request coalescing, and placeholders for rate-limit/backoff. This is for reference and will be implemented as a new file; the legacy module remains untouched.

```Dashboard/src/services/weather.service.ts#L1-200
import axios from "axios";

export interface WeatherSummary {
  condition: string;
  tempC: number;
  tempF: number;
}

export interface ForecastMeta {
  source: "cache" | "stale-cache" | "network";
  fetchedAt: number;
  location: { lat: number; lon: number };
}

export interface ForecastResult {
  summary: WeatherSummary | null;
  meta: ForecastMeta;
}

type BucketKey = string;

interface CacheEntry {
  bucketKey: BucketKey;
  canonicalLocation: { lat: number; lon: number };
  fetchedAt: number;
  expiresAt: number;     // fresh expiry
  staleUntil: number;    // stale-while-revalidate window
  summary: WeatherSummary | null;
  lastAccessed: number;
  provider?: string;
  lastError?: string;
}

const KM = 1000;
const PROXIMITY_KM = 3;
const LAT_GRID_DEG = 0.027; // ~3 km in latitude
const FRESH_TTL_MS = 10 * 60 * 1000; // 10 minutes
const STALE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_USER_CACHE_ENTRIES = 20;

const INITIAL_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const JITTER_RATIO = 0.1;

function now() { return Date.now(); }

export class WeatherService {
  private static _instance: WeatherService | null = null;
  static instance(): WeatherService {
    if (!this._instance) this._instance = new WeatherService();
    return this._instance;
  }

  private readonly baseUrl = "https://api.openweathermap.org";
  private readonly apiKey = process.env.OPEN_WEATHER_API_KEY;

  // Per-user caches and policies
  private perUserCache = new Map<string, Map<BucketKey, CacheEntry>>();
  private perUserLRU = new Map<string, BucketKey[]>(); // track order to enforce MAX_USER_CACHE_ENTRIES

  // Shared cross-user proximity cache
  private sharedCache = new Map<BucketKey, CacheEntry>();

  // In-flight requests to coalesce duplicate fetches
  private inflight = new Map<string, Promise<ForecastResult>>(); // key: userId|bucketKey

  // Per-user backoff state (simplified placeholder)
  private backoffByUser = new Map<string, { until: number; ms: number }>();

  private constructor() {}

  public async getForecast(
    session: any,
    userId: string,
    lat: number,
    lon: number
  ): Promise<ForecastResult> {
    const logger = session?.logger ?? console;
    const bk = this.computeBucketKey(lat, lon);
    const n = now();

    // 1) Per-user cache lookup
    const userMap = this.perUserCache.get(userId);
    const userEntry = userMap?.get(bk);
    const distanceGuard = (entry?: CacheEntry) =>
      entry ? this.withinKm(entry.canonicalLocation, { lat, lon }, PROXIMITY_KM) : false;

    // Respect min refresh when userEntry exists and is fresh or recently fetched
    if (userEntry) {
      userEntry.lastAccessed = n;
      if (userEntry.expiresAt > n) {
        logger.debug?.({ userId, bk }, "weather.cache.hit.fresh (user)");
        return {
          summary: userEntry.summary,
          meta: { source: "cache", fetchedAt: userEntry.fetchedAt, location: userEntry.canonicalLocation }
        };
      }
      // Stale but within SWR
      if (userEntry.staleUntil > n) {
        logger.debug?.({ userId, bk }, "weather.cache.hit.stale (user)");
        this.revalidateInBackground(session, userId, lat, lon, bk, n).catch(() => {});
        return {
          summary: userEntry.summary,
          meta: { source: "stale-cache", fetchedAt: userEntry.fetchedAt, location: userEntry.canonicalLocation }
        };
      }
    }

    // 2) Shared cache lookup (proximity)
    const sharedEntry = this.sharedCache.get(bk);
    if (sharedEntry && distanceGuard(sharedEntry)) {
      sharedEntry.lastAccessed = n;
      // Hydrate per-user cache (copy-on-read)
      this.upsertUserCache(userId, { ...sharedEntry });

      if (sharedEntry.expiresAt > n) {
        logger.debug?.({ userId, bk }, "weather.cache.hit.fresh (shared)");
        return {
          summary: sharedEntry.summary,
          meta: { source: "cache", fetchedAt: sharedEntry.fetchedAt, location: sharedEntry.canonicalLocation }
        };
      }
      if (sharedEntry.staleUntil > n) {
        logger.debug?.({ userId, bk }, "weather.cache.hit.stale (shared)");
        this.revalidateInBackground(session, userId, lat, lon, bk, n).catch(() => {});
        return {
          summary: sharedEntry.summary,
          meta: { source: "stale-cache", fetchedAt: sharedEntry.fetchedAt, location: sharedEntry.canonicalLocation }
        };
      }
    }

    // 3) Coalesce in-flight
    const inflightKey = `${userId}|${bk}`;
    const existing = this.inflight.get(inflightKey);
    if (existing) return existing;

    const p = this.fetchAndCache(session, userId, lat, lon, bk, n)
      .finally(() => this.inflight.delete(inflightKey));
    this.inflight.set(inflightKey, p);
    return p;
  }

  private async fetchAndCache(
    session: any,
    userId: string,
    lat: number,
    lon: number,
    bucketKey: BucketKey,
    n: number
  ): Promise<ForecastResult> {
    const logger = session?.logger ?? console;

    if (!this.apiKey) {
      const summary = null;
      const ce = this.buildEntry(bucketKey, lat, lon, summary, n);
      this.upsertUserCache(userId, ce);
      this.upsertSharedCache(ce);
      return { summary, meta: { source: "cache", fetchedAt: ce.fetchedAt, location: ce.canonicalLocation } };
    }

    try {
      logger.debug?.({ lat, lon }, "weather.request.sent");
      // Prefer metric; convert locally
      const url = `${this.baseUrl}/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=minutely,hourly,daily,alerts&units=metric&appid=${this.apiKey}`;
      const resp = await axios.get(url);
      const data = resp.data;
      const condition = data?.current?.weather?.[0]?.main ?? "Unknown";
      const tempC = Math.round(data?.current?.temp ?? 0);
      const tempF = Math.round(tempC * 9 / 5 + 32);
      const summary: WeatherSummary = { condition, tempC, tempF };

      const ce = this.buildEntry(bucketKey, lat, lon, summary, n);
      this.upsertUserCache(userId, ce);
      this.upsertSharedCache(ce);

      return { summary, meta: { source: "network", fetchedAt: ce.fetchedAt, location: ce.canonicalLocation } };
    } catch (err: any) {
      logger.warn?.({ err }, "weather.error.network or rate_limited");
      // TODO: inspect status 429, honor Retry-After, apply backoff
      const userMap = this.perUserCache.get(userId);
      const fallback = userMap?.get(bucketKey) ?? this.sharedCache.get(bucketKey);
      if (fallback && fallback.staleUntil > n) {
        return {
          summary: fallback.summary,
          meta: { source: "stale-cache", fetchedAt: fallback.fetchedAt, location: fallback.canonicalLocation }
        };
      }
      return {
        summary: null,
        meta: { source: "stale-cache", fetchedAt: 0, location: { lat, lon } }
      };
    }
  }

  private revalidateInBackground(session: any, userId: string, lat: number, lon: number, bk: BucketKey, n: number) {
    // Respect min refresh interval
    const latest = this.perUserCache.get(userId)?.get(bk) ?? this.sharedCache.get(bk);
    if (latest && n - latest.fetchedAt < MIN_REFRESH_INTERVAL_MS) {
      session?.logger?.debug?.({ bk }, "weather.request.skipped.minInterval");
      return Promise.resolve();
    }
    return this.fetchAndCache(session, userId, lat, lon, bk, n);
  }

  private upsertUserCache(userId: string, entry: CacheEntry) {
    let m = this.perUserCache.get(userId);
    if (!m) {
      m = new Map();
      this.perUserCache.set(userId, m);
      this.perUserLRU.set(userId, []);
    }
    m.set(entry.bucketKey, entry);
    const lru = this.perUserLRU.get(userId)!;
    const idx = lru.indexOf(entry.bucketKey);
    if (idx >= 0) lru.splice(idx, 1);
    lru.push(entry.bucketKey);
    while (lru.length > MAX_USER_CACHE_ENTRIES) {
      const evict = lru.shift()!;
      m.delete(evict);
    }
  }

  private upsertSharedCache(entry: CacheEntry) {
    this.sharedCache.set(entry.bucketKey, entry);
  }

  private buildEntry(bucketKey: BucketKey, lat: number, lon: number, summary: WeatherSummary | null, n: number): CacheEntry {
    const fetchedAt = n;
    const expiresAt = n + FRESH_TTL_MS;
    const staleUntil = n + STALE_TTL_MS;
    return {
      bucketKey,
      canonicalLocation: { lat, lon },
      fetchedAt,
      expiresAt,
      staleUntil,
      summary,
      lastAccessed: n,
      provider: "openweather:onecall3"
    };
  }

  private computeBucketKey(lat: number, lon: number): BucketKey {
    const latRad = lat * Math.PI / 180;
    const lonStep = LAT_GRID_DEG / Math.max(Math.cos(latRad), 0.01);
    const bLat = Math.round(lat / LAT_GRID_DEG) * LAT_GRID_DEG;
    const bLon = Math.round(lon / lonStep) * lonStep;
    return `${bLat.toFixed(5)}:${bLon.toFixed(5)}`;
  }

  private withinKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }, maxKm: number): boolean {
    return this.haversineKm(a.lat, a.lon, b.lat, b.lon) <= maxKm;
  }

  private haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const s1 = Math.sin(dLat / 2);
    const s2 = Math.sin(dLon / 2);
    const a = s1 * s1 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * s2 * s2;
    const c = 2 * Math.asin(Math.min(1, Math.sqrt(a)));
    return R * c;
  }
}

export const weatherService = WeatherService.instance();
```

Next steps to integrate (will be done separately from this doc):
- Replace `WeatherModule` usage in `src/index.ts` with `weatherService.getForecast(...)` while keeping `WeatherModule.ts` intact.
- Remove forced refetch on metric system changes; re-render with cached values instead.
- Add structured logs around decisions (cache vs network) and include cache source in the dashboard update for visibility.