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
  capacity_min: number;
  capacity_max: number;
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
  commission_percent: 30,
  city: DEFAULT_PRICING_CITY,
  is_active: true,
} as const;

export function getDefaultPricingRules(city: string = DEFAULT_PRICING_CITY): DefaultPricingRule[] {
  return [
    {
      ...COMMON_RULE_FIELDS,
      city,
      vehicle_type: VehicleType.BIKE,
      base_fare: 20,
      per_km_rate: 6,
      per_minute_rate: 0.5,
      minimum_fare: 20,
      capacity_min: 0,
      capacity_max: 8,
      best_for: 'Documents, food, medicines',
      multi_stop_fee: 20,
      helper_charge_per_person: 0,
    },
    {
      ...COMMON_RULE_FIELDS,
      city,
      vehicle_type: VehicleType.SCOOTY,
      base_fare: 20,
      per_km_rate: 7,
      per_minute_rate: 0.5,
      minimum_fare: 20,
      capacity_min: 0,
      capacity_max: 10,
      best_for: 'Small parcels, groceries',
      multi_stop_fee: 20,
      helper_charge_per_person: 0,
    },
    {
      ...COMMON_RULE_FIELDS,
      city,
      vehicle_type: VehicleType.AUTO,
      base_fare: 40,
      per_km_rate: 12,
      per_minute_rate: 1,
      minimum_fare: 40,
      capacity_min: 50,
      capacity_max: 150,
      best_for: 'Shop deliveries, bulk groceries',
      multi_stop_fee: 25,
      helper_charge_per_person: 200,
    },
    {
      ...COMMON_RULE_FIELDS,
      city,
      vehicle_type: VehicleType.PICKUP,
      base_fare: 70,
      per_km_rate: 16,
      per_minute_rate: 1.2,
      minimum_fare: 70,
      capacity_min: 300,
      capacity_max: 700,
      best_for: 'Furniture, appliances',
      multi_stop_fee: 30,
      helper_charge_per_person: 200,
    },
    {
      ...COMMON_RULE_FIELDS,
      city,
      vehicle_type: VehicleType.MINI_TRUCK,
      base_fare: 90,
      per_km_rate: 22,
      per_minute_rate: 1.5,
      minimum_fare: 90,
      capacity_min: 700,
      capacity_max: 1500,
      best_for: 'Warehouse to shop, heavy goods',
      multi_stop_fee: 30,
      helper_charge_per_person: 200,
    },
  ];
}

export function getVehicleTypeSortOrder(vehicleType: VehicleType): number {
  return PUBLIC_VEHICLE_TYPES.indexOf(vehicleType as (typeof PUBLIC_VEHICLE_TYPES)[number]);
}
