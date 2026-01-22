# SkiDO API Testing Guide - Phase 1

This document provides comprehensive API testing examples for all Phase 1 endpoints.

## Prerequisites
- Server running on `http://localhost:3000`
- PostgreSQL database configured and running
- Tools: curl, Postman, or any HTTP client

---

## 1. Authentication Flow

### 1.1 Register Customer
**Request:**
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+919876543210",
    "role": "customer",
    "name": "Raj Kumar",
    "languagePreference": "en"
  }'
```

**Expected Response:**
```json
{
  "message": "OTP sent successfully",
  "phone": "+919876543210",
  "expiresAt": "2024-01-15T10:35:00.000Z"
}
```

**Console Output:**
```
OTP for +919876543210: 123456
```

### 1.2 Verify OTP
**Request:**
```bash
curl -X POST http://localhost:3000/api/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+919876543210",
    "otp": "123456"
  }'
```

**Expected Response:**
```json
{
  "message": "Phone verified successfully",
  "user": {
    "id": "uuid-here",
    "phone": "+919876543210",
    "name": "Raj Kumar",
    "role": "customer",
    "isVerified": true,
    "isActive": true,
    "languagePreference": "en"
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### 1.3 Register Driver
**Request:**
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+919876543211",
    "role": "driver",
    "name": "Suresh Panda"
  }'
```

### 1.4 Login (Existing User)
**Request:**
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+919876543210"
  }'
```

**Expected Response:**
```json
{
  "message": "OTP sent successfully",
  "phone": "+919876543210",
  "expiresAt": "2024-01-15T10:40:00.000Z"
}
```

### 1.5 Resend OTP
**Request:**
```bash
curl -X POST http://localhost:3000/api/auth/resend-otp \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+919876543210"
  }'
```

### 1.6 Refresh Token
**Request:**
```bash
curl -X POST http://localhost:3000/api/auth/refresh-token \
  -H "Content-Type: application/json" \
  -d '{
    "refreshToken": "YOUR_REFRESH_TOKEN_HERE"
  }'
```

**Expected Response:**
```json
{
  "accessToken": "new_access_token",
  "refreshToken": "new_refresh_token",
  "user": {
    "id": "uuid",
    "phone": "+919876543210",
    "name": "Raj Kumar",
    "role": "customer"
  }
}
```

### 1.7 Logout
**Request:**
```bash
curl -X POST http://localhost:3000/api/auth/logout \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json"
```

**Expected Response:**
```json
{
  "message": "Logged out successfully"
}
```

---

## 2. Customer APIs (Requires Authentication)

**Note:** Replace `YOUR_ACCESS_TOKEN` with the actual token received from login/verify-otp.

### 2.1 Get Customer Profile
**Request:**
```bash
curl -X GET http://localhost:3000/api/customer/profile \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

**Expected Response:**
```json
{
  "id": "uuid",
  "phone": "+919876543210",
  "name": "Raj Kumar",
  "email": null,
  "languagePreference": "en",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "profile": {
    "id": "profile-uuid",
    "userId": "user-uuid",
    "address": null,
    "savedLocations": [],
    "totalBookings": 0,
    "averageRating": "0.00"
  }
}
```

### 2.2 Update Customer Profile
**Request:**
```bash
curl -X PUT http://localhost:3000/api/customer/profile \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Raj Kumar Singh",
    "address": "Bhubaneswar, Odisha, India"
  }'
```

### 2.3 Get Saved Locations
**Request:**
```bash
curl -X GET http://localhost:3000/api/customer/saved-locations \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

**Expected Response:**
```json
{
  "savedLocations": []
}
```

### 2.4 Add Saved Location
**Request:**
```bash
curl -X POST http://localhost:3000/api/customer/saved-locations \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "location": {
      "label": "Home",
      "address": "Plot 123, Patia, Bhubaneswar",
      "latitude": 20.2961,
      "longitude": 85.8245
    }
  }'
```

**Expected Response:**
```json
{
  "message": "Location saved successfully",
  "location": {
    "id": "location-uuid",
    "label": "Home",
    "address": "Plot 123, Patia, Bhubaneswar",
    "latitude": 20.2961,
    "longitude": 85.8245
  }
}
```

### 2.5 Delete Saved Location
**Request:**
```bash
curl -X DELETE http://localhost:3000/api/customer/saved-locations/LOCATION_ID \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

**Expected Response:**
```json
{
  "message": "Location deleted successfully"
}
```

---

## 3. Driver APIs (Requires Driver Authentication)

**Note:** Use driver's access token obtained after driver registration.

### 3.1 Get Driver Profile
**Request:**
```bash
curl -X GET http://localhost:3000/api/driver/profile \
  -H "Authorization: Bearer DRIVER_ACCESS_TOKEN"
```

**Expected Response:**
```json
{
  "id": "uuid",
  "phone": "+919876543211",
  "name": "Suresh Panda",
  "email": null,
  "languagePreference": "en",
  "createdAt": "2024-01-15T10:35:00.000Z",
  "profile": {
    "id": "profile-uuid",
    "userId": "user-uuid",
    "licenseNumber": null,
    "verificationStatus": "pending",
    "availabilityStatus": "offline",
    "walletBalance": "0.00",
    "totalTrips": 0,
    "averageRating": "0.00",
    "vehicles": []
  }
}
```

### 3.2 Update Driver Profile
**Request:**
```bash
curl -X PUT http://localhost:3000/api/driver/profile \
  -H "Authorization: Bearer DRIVER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Suresh Kumar Panda",
    "licenseNumber": "OD123456789012",
    "licenseExpiry": "2030-12-31",
    "aadhaarNumber": "123456789012",
    "panNumber": "ABCDE1234F"
  }'
```

### 3.3 Update Availability Status
**Request:**
```bash
curl -X PUT http://localhost:3000/api/driver/availability \
  -H "Authorization: Bearer DRIVER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "online"
  }'
```

**Expected Response:**
```json
{
  "message": "Availability updated successfully",
  "status": "online"
}
```

**Note:** Driver must be verified to change availability status. Otherwise, you'll get:
```json
{
  "statusCode": 400,
  "message": "Driver must be verified to change availability"
}
```

### 3.4 Update Location
**Request:**
```bash
curl -X PUT http://localhost:3000/api/driver/location \
  -H "Authorization: Bearer DRIVER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "latitude": 20.2961,
    "longitude": 85.8245
  }'
```

**Expected Response:**
```json
{
  "message": "Location updated successfully"
}
```

### 3.5 Get Earnings Dashboard
**Request:**
```bash
curl -X GET http://localhost:3000/api/driver/earnings \
  -H "Authorization: Bearer DRIVER_ACCESS_TOKEN"
```

**Expected Response:**
```json
{
  "totalEarnings": 0,
  "todayEarnings": 0,
  "weekEarnings": 0,
  "monthEarnings": 0,
  "pendingPayouts": 0
}
```

### 3.6 Get Trip History
**Request:**
```bash
curl -X GET http://localhost:3000/api/driver/trips \
  -H "Authorization: Bearer DRIVER_ACCESS_TOKEN"
```

**Expected Response:**
```json
{
  "trips": [],
  "totalTrips": 0
}
```

---

## 4. Vehicle APIs

### 4.1 Get Vehicle Types (Public - No Auth Required)
**Request:**
```bash
curl -X GET http://localhost:3000/api/vehicle/types
```

**Expected Response:**
```json
{
  "types": [
    {
      "type": "bike",
      "name": "Bike",
      "description": "Two-wheeler for small packages",
      "capacity": "20 kg",
      "icon": "🏍️"
    },
    {
      "type": "tata_ace",
      "name": "Tata Ace",
      "description": "Compact goods carrier",
      "capacity": "750 kg",
      "icon": "🚙"
    },
    {
      "type": "pickup_van",
      "name": "Pickup Van",
      "description": "Medium-sized goods vehicle",
      "capacity": "1.5 tons",
      "icon": "🚐"
    },
    {
      "type": "mini_truck",
      "name": "Mini Truck",
      "description": "Large goods carrier",
      "capacity": "3 tons",
      "icon": "🚚"
    }
  ]
}
```

### 4.2 Register Vehicle (Driver Only)
**Request:**
```bash
curl -X POST http://localhost:3000/api/vehicle/register \
  -H "Authorization: Bearer DRIVER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "vehicleType": "bike",
    "registrationNumber": "OD02AB1234",
    "vehicleModel": "Activa 6G",
    "vehicleMake": "Honda",
    "manufacturingYear": 2022,
    "capacity": 150,
    "insuranceExpiry": "2025-12-31"
  }'
```

**Expected Response:**
```json
{
  "message": "Vehicle registered successfully. Pending verification.",
  "vehicle": {
    "id": "vehicle-uuid",
    "driverId": "driver-profile-id",
    "vehicleType": "bike",
    "registrationNumber": "OD02AB1234",
    "vehicleModel": "Activa 6G",
    "vehicleMake": "Honda",
    "manufacturingYear": 2022,
    "capacity": "150.00",
    "verificationStatus": "pending",
    "isActive": true
  }
}
```

### 4.3 Get Vehicle Details
**Request:**
```bash
curl -X GET http://localhost:3000/api/vehicle/VEHICLE_ID \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### 4.4 Update Vehicle
**Request:**
```bash
curl -X PUT http://localhost:3000/api/vehicle/VEHICLE_ID \
  -H "Authorization: Bearer DRIVER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "vehicleModel": "Activa 125",
    "capacity": 180
  }'
```

### 4.5 Get Driver's Vehicles
**Request:**
```bash
curl -X GET http://localhost:3000/api/vehicle/driver/my-vehicles \
  -H "Authorization: Bearer DRIVER_ACCESS_TOKEN"
```

**Expected Response:**
```json
{
  "vehicles": [
    {
      "id": "vehicle-uuid",
      "vehicleType": "bike",
      "registrationNumber": "OD02AB1234",
      "vehicleModel": "Activa 6G",
      "verificationStatus": "pending",
      "isActive": true
    }
  ]
}
```

---

## Common Error Responses

### 401 Unauthorized
```json
{
  "statusCode": 401,
  "message": "Unauthorized access"
}
```

### 403 Forbidden (Wrong Role)
```json
{
  "statusCode": 403,
  "message": "You do not have permission to access this resource"
}
```

### 400 Bad Request (Validation Error)
```json
{
  "statusCode": 400,
  "message": [
    "phone must be a valid phone number"
  ],
  "error": "Bad Request"
}
```

### 404 Not Found
```json
{
  "statusCode": 404,
  "message": "User not found"
}
```

### 409 Conflict
```json
{
  "statusCode": 409,
  "message": "User with this phone number already exists"
}
```

---

## Testing with Swagger

Access the interactive API documentation at:
```
http://localhost:3000/api/docs
```

1. Click on any endpoint to expand
2. Click "Try it out"
3. Fill in the parameters
4. Click "Execute"
5. View the response

For authenticated endpoints:
1. First, register and verify OTP to get access token
2. Click "Authorize" button at the top
3. Enter: `Bearer YOUR_ACCESS_TOKEN`
4. Click "Authorize"
5. Now you can test authenticated endpoints

---

## Testing Workflow Example

### Complete Customer Flow:
1. Register customer → Get OTP in console
2. Verify OTP → Get access token
3. Get profile
4. Update profile
5. Add saved location
6. Get saved locations
7. Delete saved location
8. Logout

### Complete Driver Flow:
1. Register driver → Get OTP in console
2. Verify OTP → Get access token
3. Get profile
4. Update profile (add license, aadhaar, pan)
5. Register vehicle
6. Get my vehicles
7. Update location
8. Try to change availability (will fail - not verified yet)
9. Get earnings
10. Get trip history

---

## Next Phase Testing

In Phase 2, we'll test:
- Booking creation
- Fare estimation
- Payment processing
- Driver assignment
- Real-time tracking

---

**Happy Testing! 🚀**
