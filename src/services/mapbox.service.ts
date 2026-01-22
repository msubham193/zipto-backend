import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

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

@Injectable()
export class MapboxService {
  private readonly logger = new Logger(MapboxService.name);
  private readonly accessToken: string;
  private readonly baseUrl = 'https://api.mapbox.com';

  constructor(private configService: ConfigService) {
    this.accessToken = this.configService.get<string>('externalServices.mapbox.accessToken') || '';
  }

  /**
   * Get distance and duration between two points using Mapbox Directions API
   */
  async getDistanceMatrix(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
  ): Promise<DistanceMatrixResult> {
    if (!this.accessToken) {
      this.logger.warn('Mapbox access token not configured, using fallback calculation');
      const mockDistance = this.calculateHaversineDistance(originLat, originLng, destLat, destLng);
      return {
        distance: mockDistance * 1000,
        duration: Math.ceil((mockDistance / 30) * 3600),
        status: 'OK_FALLBACK',
      };
    }

    try {
      // Mapbox Directions API uses format: longitude,latitude
      const coordinates = `${originLng},${originLat};${destLng},${destLat}`;

      const response = await axios.get(
        `${this.baseUrl}/directions/v5/mapbox/driving/${coordinates}`,
        {
          params: {
            access_token: this.accessToken,
            geometries: 'geojson',
            overview: 'simplified',
          },
        },
      );

      if (response.data.code !== 'Ok') {
        throw new Error(`Mapbox API error: ${response.data.code}`);
      }

      const route = response.data.routes[0];

      if (!route) {
        throw new Error('No route found');
      }

      return {
        distance: route.distance, // already in meters
        duration: route.duration, // already in seconds
        status: 'OK',
      };
    } catch (error: any) {
      this.logger.error(`Mapbox API error: ${error.message}`);
      const mockDistance = this.calculateHaversineDistance(originLat, originLng, destLat, destLng);
      return {
        distance: mockDistance * 1000,
        duration: Math.ceil((mockDistance / 30) * 3600),
        status: 'FALLBACK',
      };
    }
  }

  /**
   * Get route with full geometry (for displaying on map)
   */
  async getRoute(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
  ): Promise<{
    distance: number;
    duration: number;
    geometry: any;
    status: string;
  }> {
    if (!this.accessToken) {
      this.logger.warn('Mapbox access token not configured');
      return {
        distance: 0,
        duration: 0,
        geometry: null,
        status: 'NO_TOKEN',
      };
    }

    try {
      const coordinates = `${originLng},${originLat};${destLng},${destLat}`;

      const response = await axios.get(
        `${this.baseUrl}/directions/v5/mapbox/driving/${coordinates}`,
        {
          params: {
            access_token: this.accessToken,
            geometries: 'geojson',
            overview: 'full',
            steps: true,
          },
        },
      );

      if (response.data.code !== 'Ok' || !response.data.routes[0]) {
        throw new Error('No route found');
      }

      const route = response.data.routes[0];

      return {
        distance: route.distance,
        duration: route.duration,
        geometry: route.geometry,
        status: 'OK',
      };
    } catch (error: any) {
      this.logger.error(`Mapbox route error: ${error.message}`);
      return {
        distance: 0,
        duration: 0,
        geometry: null,
        status: 'ERROR',
      };
    }
  }

  /**
   * Geocode address to coordinates using Mapbox Geocoding API
   */
  async geocode(address: string): Promise<GeocodingResult | null> {
    if (!this.accessToken) {
      this.logger.warn('Mapbox access token not configured');
      return null;
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json`,
        {
          params: {
            access_token: this.accessToken,
            limit: 1,
            country: 'IN', // Restrict to India, remove for global
          },
        },
      );

      if (response.data.features && response.data.features.length > 0) {
        const feature = response.data.features[0];
        return {
          lng: feature.center[0],
          lat: feature.center[1],
          address: feature.place_name,
        };
      }

      return null;
    } catch (error: any) {
      this.logger.error(`Mapbox geocoding error: ${error.message}`);
      return null;
    }
  }

  /**
   * Reverse geocode coordinates to address
   */
  async reverseGeocode(lat: number, lng: number): Promise<string | null> {
    if (!this.accessToken) {
      this.logger.warn('Mapbox access token not configured');
      return null;
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/geocoding/v5/mapbox.places/${lng},${lat}.json`,
        {
          params: {
            access_token: this.accessToken,
            limit: 1,
          },
        },
      );

      if (response.data.features && response.data.features.length > 0) {
        return response.data.features[0].place_name;
      }

      return null;
    } catch (error: any) {
      this.logger.error(`Mapbox reverse geocoding error: ${error.message}`);
      return null;
    }
  }

  /**
   * Search for places (autocomplete)
   */
  async searchPlaces(
    query: string,
    proximity?: { lat: number; lng: number },
  ): Promise<Array<{ name: string; address: string; lat: number; lng: number }>> {
    if (!this.accessToken) {
      this.logger.warn('Mapbox access token not configured');
      return [];
    }

    try {
      const params: any = {
        access_token: this.accessToken,
        limit: 5,
        country: 'IN',
        types: 'address,poi,place',
      };

      if (proximity) {
        params.proximity = `${proximity.lng},${proximity.lat}`;
      }

      const response = await axios.get(
        `${this.baseUrl}/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`,
        { params },
      );

      if (response.data.features) {
        return response.data.features.map((feature: any) => ({
          name: feature.text,
          address: feature.place_name,
          lng: feature.center[0],
          lat: feature.center[1],
        }));
      }

      return [];
    } catch (error: any) {
      this.logger.error(`Mapbox place search error: ${error.message}`);
      return [];
    }
  }

  /**
   * Calculate distance using Haversine formula (fallback)
   */
  private calculateHaversineDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371; // Earth radius in km
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
