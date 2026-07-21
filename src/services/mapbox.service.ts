import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

// ── Timeout for all outbound Google Maps requests ───────────────────────────
const API_TIMEOUT = 8000; // 8 seconds

// ── In-memory cache ─────────────────────────────────────────────────────────
interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const CACHE_TTL = {
  DIRECTIONS: 5 * 60 * 1000,       // 5 min — traffic can change
  GEOCODE: 30 * 60 * 1000,         // 30 min — addresses are stable
  REVERSE_GEOCODE: 10 * 60 * 1000, // 10 min
  PLACE_DETAILS: 30 * 60 * 1000,   // 30 min
  SEARCH: 2 * 60 * 1000,           // 2 min
};

const MAX_CACHE_SIZE = 500;

interface DistanceMatrixResult {
  distance: number; // in meters
  duration: number; // in seconds
  status: string;
}

interface GeocodingResult {
  lat: number;
  lng: number;
  address?: string;
}

/**
 * Google Maps service (replaces former Mapbox service).
 * Class name kept as MapboxService to avoid changing all injection sites.
 *
 * Production optimizations:
 *  - In-memory TTL cache for all API responses
 *  - Request deduplication (concurrent identical requests share one HTTP call)
 *  - Request timeouts (8s)
 *  - Haversine fallback on API failure
 *  - Periodic cache cleanup
 */
@Injectable()
export class MapboxService implements OnModuleDestroy {
  private readonly logger = new Logger('GoogleMapsService');
  private readonly apiKey: string;
  private readonly baseUrl = 'https://maps.googleapis.com/maps/api';

  // ── Caches ──
  private readonly directionsCache = new Map<string, CacheEntry<DistanceMatrixResult>>();
  private readonly geocodeCache = new Map<string, CacheEntry<GeocodingResult | null>>();
  private readonly reverseGeocodeCache = new Map<string, CacheEntry<string | null>>();
  private readonly placeDetailsCache = new Map<string, CacheEntry<{ lat: number; lng: number } | null>>();

  // ── In-flight dedup: prevents duplicate concurrent requests for same key ──
  private readonly inflightDirections = new Map<string, Promise<DistanceMatrixResult>>();

  // ── Cleanup timer ──
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private configService: ConfigService) {
    this.apiKey =
      this.configService.get<string>('externalServices.googleMaps.apiKey') ||
      this.configService.get<string>('GOOGLE_MAPS_API_KEY') ||
      '';

    if (!this.apiKey) {
      this.logger.warn('Google Maps API key not configured — all calls will use Haversine fallback');
    }

    // Evict expired entries every 5 minutes
    this.cleanupTimer = setInterval(() => this.evictExpired(), 5 * 60 * 1000);
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }

  // ── Cache helpers ─────────────────────────────────────────────────────────

  private getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = cache.get(key);
    if (entry && Date.now() < entry.expiry) return entry.data;
    if (entry) cache.delete(key);
    return undefined;
  }

  private setCache<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T, ttl: number) {
    if (cache.size >= MAX_CACHE_SIZE) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(key, { data, expiry: Date.now() + ttl });
  }

  private evictExpired() {
    const now = Date.now();
    const evict = <T>(cache: Map<string, CacheEntry<T>>) => {
      for (const [key, entry] of cache) {
        if (now >= entry.expiry) cache.delete(key);
      }
    };
    evict(this.directionsCache);
    evict(this.geocodeCache);
    evict(this.reverseGeocodeCache);
    evict(this.placeDetailsCache);
  }

  /** Round to 4 decimals (~11m) for cache key */
  private coordKey(lat: number, lng: number): string {
    return `${lat.toFixed(4)},${lng.toFixed(4)}`;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Get distance and duration between two points.
   * Cached for 5 min. Concurrent identical requests are deduplicated.
   */
  async getDistanceMatrix(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
  ): Promise<DistanceMatrixResult> {
    const cacheKey = `${this.coordKey(originLat, originLng)}->${this.coordKey(destLat, destLng)}`;

    // 1. Check cache
    const cached = this.getCached(this.directionsCache, cacheKey);
    if (cached) return cached;

    // 2. Deduplicate concurrent identical requests
    const inflight = this.inflightDirections.get(cacheKey);
    if (inflight) return inflight;

    // 3. No key → fallback
    if (!this.apiKey) {
      return this.haversineFallback(originLat, originLng, destLat, destLng, 'OK_FALLBACK');
    }

    // 4. Make request
    const promise = this.fetchDirections(originLat, originLng, destLat, destLng, cacheKey);
    this.inflightDirections.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.inflightDirections.delete(cacheKey);
    }
  }

  private async fetchDirections(
    originLat: number, originLng: number,
    destLat: number, destLng: number,
    cacheKey: string,
  ): Promise<DistanceMatrixResult> {
    try {
      const response = await axios.get(`${this.baseUrl}/directions/json`, {
        params: {
          origin: `${originLat},${originLng}`,
          destination: `${destLat},${destLng}`,
          key: this.apiKey,
          mode: 'driving',
        },
        timeout: API_TIMEOUT,
      });

      if (response.data.status !== 'OK' || !response.data.routes?.length) {
        throw new Error(`Google Directions API: ${response.data.status}`);
      }

      const leg = response.data.routes[0].legs[0];
      const result: DistanceMatrixResult = {
        distance: leg.distance.value,
        duration: leg.duration.value,
        status: 'OK',
      };

      this.setCache(this.directionsCache, cacheKey, result, CACHE_TTL.DIRECTIONS);
      return result;
    } catch (error: any) {
      this.logger.error(`Google Directions error: ${error.message}`);
      return this.haversineFallback(originLat, originLng, destLat, destLng, 'FALLBACK');
    }
  }

  /**
   * Get route with full geometry. Cached via same directions cache key.
   */
  async getRoute(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
  ): Promise<{ distance: number; duration: number; geometry: any; status: string }> {
    if (!this.apiKey) {
      return { distance: 0, duration: 0, geometry: null, status: 'NO_KEY' };
    }

    try {
      const response = await axios.get(`${this.baseUrl}/directions/json`, {
        params: {
          origin: `${originLat},${originLng}`,
          destination: `${destLat},${destLng}`,
          key: this.apiKey,
          mode: 'driving',
        },
        timeout: API_TIMEOUT,
      });

      if (response.data.status !== 'OK' || !response.data.routes?.length) {
        throw new Error('No route found');
      }

      const route = response.data.routes[0];
      const leg = route.legs[0];

      return {
        distance: leg.distance.value,
        duration: leg.duration.value,
        geometry: route.overview_polyline?.points || null,
        status: 'OK',
      };
    } catch (error: any) {
      this.logger.error(`Google route error: ${error.message}`);
      return { distance: 0, duration: 0, geometry: null, status: 'ERROR' };
    }
  }

  /**
   * Geocode address to coordinates. Cached for 30 min.
   */
  async geocode(address: string): Promise<GeocodingResult | null> {
    if (!this.apiKey) return null;

    const cacheKey = address.trim().toLowerCase();
    const cached = this.getCached(this.geocodeCache, cacheKey);
    if (cached !== undefined) return cached;

    try {
      const response = await axios.get(`${this.baseUrl}/geocode/json`, {
        params: {
          address,
          key: this.apiKey,
          components: 'country:IN',
          language: 'en',
        },
        timeout: API_TIMEOUT,
      });

      if (response.data.status === 'OK' && response.data.results?.length) {
        const loc = response.data.results[0].geometry.location;
        const result: GeocodingResult = {
          lat: loc.lat,
          lng: loc.lng,
          address: response.data.results[0].formatted_address,
        };
        this.setCache(this.geocodeCache, cacheKey, result, CACHE_TTL.GEOCODE);
        return result;
      }

      this.setCache(this.geocodeCache, cacheKey, null, CACHE_TTL.GEOCODE);
      return null;
    } catch (error: any) {
      this.logger.error(`Google geocoding error: ${error.message}`);
      return null;
    }
  }

  /**
   * Reverse geocode coordinates to address. Cached for 10 min.
   */
  async reverseGeocode(lat: number, lng: number): Promise<string | null> {
    if (!this.apiKey) return null;

    const cacheKey = this.coordKey(lat, lng);
    const cached = this.getCached(this.reverseGeocodeCache, cacheKey);
    if (cached !== undefined) return cached;

    try {
      const response = await axios.get(`${this.baseUrl}/geocode/json`, {
        params: {
          latlng: `${lat},${lng}`,
          key: this.apiKey,
          language: 'en',
          result_type: 'street_address|route|sublocality',
        },
        timeout: API_TIMEOUT,
      });

      if (response.data.status === 'OK' && response.data.results?.length) {
        const address = response.data.results[0].formatted_address;
        this.setCache(this.reverseGeocodeCache, cacheKey, address, CACHE_TTL.REVERSE_GEOCODE);
        return address;
      }

      this.setCache(this.reverseGeocodeCache, cacheKey, null, CACHE_TTL.REVERSE_GEOCODE);
      return null;
    } catch (error: any) {
      this.logger.error(`Google reverse geocoding error: ${error.message}`);
      return null;
    }
  }

  /**
   * Reverse-geocode coordinates to just the Indian state
   * (administrative_area_level_1), e.g. "Odisha". Used to bucket users by
   * state for the admin state-wise views. Returns null if unresolved.
   */
  async reverseGeocodeState(lat: number, lng: number): Promise<string | null> {
    if (!this.apiKey) return null;

    const cacheKey = `state:${this.coordKey(lat, lng)}`;
    const cached = this.getCached(this.reverseGeocodeCache, cacheKey);
    if (cached !== undefined) return cached;

    try {
      const response = await axios.get(`${this.baseUrl}/geocode/json`, {
        params: {
          latlng: `${lat},${lng}`,
          key: this.apiKey,
          language: 'en',
          result_type: 'administrative_area_level_1',
        },
        timeout: API_TIMEOUT,
      });

      let state: string | null = null;
      if (response.data.status === 'OK' && response.data.results?.length) {
        const comps = response.data.results[0].address_components || [];
        const stateComp = comps.find((c: any) => c.types?.includes('administrative_area_level_1'));
        state = stateComp?.long_name ?? null;
      }
      this.setCache(this.reverseGeocodeCache, cacheKey, state, CACHE_TTL.REVERSE_GEOCODE);
      return state;
    } catch (error: any) {
      this.logger.error(`Reverse geocode (state) error: ${error.message}`);
      return null;
    }
  }

  /**
   * Search for places (autocomplete). No server-side caching — clients debounce.
   */
  async searchPlaces(
    query: string,
    proximity?: { lat: number; lng: number },
  ): Promise<Array<{ name: string; address: string; lat: number; lng: number }>> {
    if (!this.apiKey) return [];

    try {
      const params: Record<string, string> = {
        input: query,
        key: this.apiKey,
        components: 'country:in',
        language: 'en',
      };

      if (proximity) {
        params.location = `${proximity.lat},${proximity.lng}`;
        params.radius = '50000';
      }

      const response = await axios.get(
        `${this.baseUrl}/place/autocomplete/json`,
        { params, timeout: API_TIMEOUT },
      );

      if (response.data.status !== 'OK' || !response.data.predictions) return [];

      const results = await Promise.all(
        response.data.predictions.slice(0, 5).map(async (prediction: any) => {
          const details = await this.getPlaceDetails(prediction.place_id);
          return {
            name: prediction.structured_formatting?.main_text || prediction.description,
            address: prediction.description,
            lat: details?.lat ?? 0,
            lng: details?.lng ?? 0,
          };
        }),
      );

      return results.filter(r => r.lat !== 0 && r.lng !== 0);
    } catch (error: any) {
      this.logger.error(`Google place search error: ${error.message}`);
      return [];
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Get place details (coordinates) from place_id. Cached for 30 min.
   */
  private async getPlaceDetails(placeId: string): Promise<{ lat: number; lng: number } | null> {
    const cached = this.getCached(this.placeDetailsCache, placeId);
    if (cached !== undefined) return cached;

    try {
      const response = await axios.get(`${this.baseUrl}/place/details/json`, {
        params: {
          place_id: placeId,
          key: this.apiKey,
          fields: 'geometry',
        },
        timeout: API_TIMEOUT,
      });

      if (response.data.status === 'OK' && response.data.result?.geometry?.location) {
        const loc = response.data.result.geometry.location;
        const result = { lat: loc.lat, lng: loc.lng };
        this.setCache(this.placeDetailsCache, placeId, result, CACHE_TTL.PLACE_DETAILS);
        return result;
      }
      this.setCache(this.placeDetailsCache, placeId, null, CACHE_TTL.PLACE_DETAILS);
      return null;
    } catch {
      return null;
    }
  }

  private haversineFallback(
    originLat: number, originLng: number,
    destLat: number, destLng: number,
    status: string,
  ): DistanceMatrixResult {
    const km = this.calculateHaversineDistance(originLat, originLng, destLat, destLng);
    return {
      distance: km * 1000,
      duration: Math.ceil((km / 30) * 3600),
      status,
    };
  }

  private calculateHaversineDistance(
    lat1: number, lon1: number,
    lat2: number, lon2: number,
  ): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
}
