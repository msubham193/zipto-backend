import { VehicleType } from '../../vehicle/entities/vehicle.entity';

export const DEFAULT_PRICING_CITY = 'Bhubaneswar';

export const PUBLIC_VEHICLE_TYPES = [
  VehicleType.BIKE,
  VehicleType.SCOOTY,
  VehicleType.AUTO,
  VehicleType.PICKUP,
  VehicleType.MINI_TRUCK,
] as const;

export const LEGACY_VEHICLE_TYPES = [
  VehicleType.THREE_WHEELER,
  VehicleType.TATA_ACE,
  VehicleType.PICKUP_8FT,
  VehicleType.TATA_407,
] as const;

export type DefaultPricingRule = {
  vehicle_type: VehicleType;
  base_fare: number;
  base_distance_km: number;
  per_km_rate: number;
  per_minute_rate: number;
  minimum_fare: number;
  surge_multiplier: number;
  free_waiting_minutes: number;
  waiting_charge_per_minute: number;
  best_for: string;
  night_surcharge_percent: number;
  multi_stop_fee: number;
  helper_charge_per_person: number;
  commission_percent: number;
  city: string;
  is_active: boolean;
};

const COMMON_RULE_FIELDS = {
  base_distance_km: 2,
  surge_multiplier: 1,
  free_waiting_minutes: 70,
  waiting_charge_per_minute: 2,
  night_surcharge_percent: 15,
  city: DEFAULT_PRICING_CITY,
  is_active: true,
} as const;

export function getDefaultPricingRules(city: string = DEFAULT_PRICING_CITY): DefaultPricingRule[] {
  return [
    {
      ...COMMON_RULE_FIELDS,
      city,
      vehicle_type: VehicleType.BIKE,
      base_fare: 35,
      per_km_rate: 7,
      per_minute_rate: 0,
      minimum_fare: 40,
      best_for: 'Documents, food, medicines',
      multi_stop_fee: 20,
      helper_charge_per_person: 0,
      commission_percent: 20,
    },
    {
      ...COMMON_RULE_FIELDS,
      city,
      vehicle_type: VehicleType.SCOOTY,
      base_fare: 40,
      per_km_rate: 7,
      per_minute_rate: 0,
      minimum_fare: 45,
      best_for: 'Small parcels, groceries',
      multi_stop_fee: 20,
      helper_charge_per_person: 0,
      commission_percent: 20,
    },
    {
      ...COMMON_RULE_FIELDS,
      city,
      vehicle_type: VehicleType.AUTO,
      base_fare: 80,
      per_km_rate: 12,
      per_minute_rate: 0,
      minimum_fare: 80,
      best_for: 'Shop deliveries, bulk groceries',
      multi_stop_fee: 25,
      helper_charge_per_person: 200,
      commission_percent: 18,
    },
    {
      ...COMMON_RULE_FIELDS,
      city,
      vehicle_type: VehicleType.PICKUP,
      base_fare: 150,
      per_km_rate: 18,
      per_minute_rate: 0,
      minimum_fare: 120,
      best_for: 'Furniture, appliances',
      multi_stop_fee: 30,
      helper_charge_per_person: 200,
      commission_percent: 15,
    },
    {
      ...COMMON_RULE_FIELDS,
      city,
      vehicle_type: VehicleType.MINI_TRUCK,
      base_fare: 250,
      per_km_rate: 22,
      per_minute_rate: 0,
      minimum_fare: 150,
      best_for: 'Warehouse to shop, heavy goods',
      multi_stop_fee: 30,
      helper_charge_per_person: 200,
      commission_percent: 12,
    },
  ];
}

export function getVehicleTypeSortOrder(vehicleType: VehicleType): number {
  return PUBLIC_VEHICLE_TYPES.indexOf(vehicleType as (typeof PUBLIC_VEHICLE_TYPES)[number]);
}
