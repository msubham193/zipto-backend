import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

interface DistanceMatrixResult {
  distance: number; // in meters
  duration: number; // in seconds
  status: string;
}

@Injectable()
export class GoogleMapsService {
  private readonly logger = new Logger(GoogleMapsService.name);
  private readonly apiKey: string;
  private readonly baseUrl = 'https://maps.googleapis.com/maps/api';

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('externalServices.googleMaps.apiKey') || '';
  }

  /**
   * Get distance and duration between two points using Google Maps Distance Matrix API
   */
  async getDistanceMatrix(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
  ): Promise<DistanceMatrixResult> {
    if (!this.apiKey) {
      this.logger.warn('Google Maps API key not configured, using mock data');
      // Return mock data if API key not configured
      const mockDistance = this.calculateMockDistance(originLat, originLng, destLat, destLng);
      return {
        distance: mockDistance * 1000, // convert km to meters
        duration: Math.ceil((mockDistance / 30) * 3600), // assume 30 km/h average speed
        status: 'OK_MOCK',
      };
    }

    try {
      const response = await axios.get(`${this.baseUrl}/distancematrix/json`, {
        params: {
          origins: `${originLat},${originLng}`,
          destinations: `${destLat},${destLng}`,
          key: this.apiKey,
          mode: 'driving',
        },
      });

      if (response.data.status !== 'OK') {
        throw new Error(`Google Maps API error: ${response.data.status}`);
      }

      const element = response.data.rows[0]?.elements[0];
      
      if (element.status !== 'OK') {
        throw new Error(`Route not found: ${element.status}`);
      }

      return {
        distance: element.distance.value,
        duration: element.duration.value,
        status: 'OK',
      };
    } catch (error: any) {
      this.logger.error(`Google Maps API error: ${error.message}`);
      // Fallback to mock calculation
      const mockDistance = this.calculateMockDistance(originLat, originLng, destLat, destLng);
      return {
        distance: mockDistance * 1000,
        duration: Math.ceil((mockDistance / 30) * 3600),
        status: 'FALLBACK',
      };
    }
  }

  /**
   * Calculate approximate distance using Haversine formula (fallback)
   */
  private calculateMockDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
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

  /**
   * Geocode address to coordinates
   */
  async geocode(address: string): Promise<{ lat: number; lng: number } | null> {
    if (!this.apiKey) {
      this.logger.warn('Google Maps API key not configured');
      return null;
    }

    try {
      const response = await axios.get(`${this.baseUrl}/geocode/json`, {
        params: {
          address,
          key: this.apiKey,
        },
      });

      if (response.data.status === 'OK' && response.data.results.length > 0) {
        const location = response.data.results[0].geometry.location;
        return {
          lat: location.lat,
          lng: location.lng,
        };
      }

      return null;
    } catch (error: any) {
      this.logger.error(`Geocoding error: ${error.message}`);
      return null;
    }
  }
}
