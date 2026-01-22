# SkiDO API Testing Guide - Phase 1

## Testing Environment Setup

### Base URL
```
Development: http://localhost:3000/api
Production: https://api.skido.in/api
```

## Authentication Module Tests

### Test 1: Customer Registration
**Endpoint**: `POST /auth/register`

**Request**:
```json
{
  "phone": "9876543210",
  "name": "Test Customer",
  "role": "customer"
}
```

**Expected Response (200 OK)**:
```json
{
  "success": true,
  "message": "OTP sent successfully",
  "data": {
    "otpId": "550e8400-e29b-41d4-a716-446655440000",
    "expiresAt": "2025-01-01T10:05:00.000Z",
    "phone": "9876543210"
  },
  "timestamp": "2025-01-01T10:00:00.000Z"
}
```

**Notes**:
- OTP will be logged in console in development mode
- OTP expires in 5 minutes (300 seconds)
- Phone number must be unique

---

### Test 2: Verify Registration OTP
**Endpoint**: `POST /auth/verify-otp`

**Request**:
```json
{
  "phone": "9876543210",
  "otp": "123456"
}
```

**Expected Response (200 OK)**:
```json
{
  "success": true,
  "message": "Registration successful",
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "phone": "9876543210",
      "name": "Test Customer",
      "email": null,
      "role": "customer",
      "isVerified": true,
      "status": "active",
      "languagePreference": "en"
    }
  },
  "timestamp": "2025-01-01T10:00:00.000Z"
}
```

**Notes**:
- Save the `accessToken` for authenticated requests
- Save the `refreshToken` for token refresh
- User profile is automatically created

---

### Test 3: Customer Login
**Endpoint**: `POST /auth/login`

**Request**:
```json
{
  "phone": "9876543210",
  "role": "customer"
}
```

**Expected Response (200 OK)**:
```json
{
  "success": true,
  "message": "OTP sent successfully",
  "data": {
    "otpId": "550e8400-e29b-41d4-a716-446655440000",
    "expiresAt": "2025-01-01T10:05:00.000Z",
    "phone": "9876543210"
  },
  "timestamp": "2025-01-01T10:00:00.000Z"
}
```

---

### Test 4: Verify Login OTP
**Endpoint**: `POST /auth/verify-login-otp`

**Request**:
```json
{
  "phone": "9876543210",
  "otp": "123456"
}
```

**Expected Response (200 OK)**:
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "phone": "9876543210",
      "name": "Test Customer",
      "role": "customer"
    }
  },
  "timestamp": "2025-01-01T10:00:00.000Z"
}
```

---

### Test 5: Driver Registration
**Endpoint**: `POST /auth/register`

**Request**:
```json
{
  "phone": "8765432109",
  "name": "Test Driver",
  "role": "driver"
}
```

**Expected Response (200 OK)**:
Similar to customer registration

**Notes**:
- Driver profile will be created with verification_status: 'pending'

---

### Test 6: Resend OTP
**Endpoint**: `POST /auth/resend-otp`

**Request**:
```json
{
  "phone": "9876543210"
}
```

**Expected Response (200 OK)**:
```json
{
  "success": true,
  "message": "OTP resent successfully",
  "data": {
    "otpId": "550e8400-e29b-41d4-a716-446655440000",
    "expiresAt": "2025-01-01T10:05:00.000Z"
  },
  "timestamp": "2025-01-01T10:00:00.000Z"
}
```

---

### Test 7: Refresh Access Token
**Endpoint**: `POST /auth/refresh-token`

**Request**:
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Expected Response (200 OK)**:
```json
{
  "success": true,
  "message": "Token refreshed successfully",
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  },
  "timestamp": "2025-01-01T10:00:00.000Z"
}
```

---

### Test 8: Logout (Authenticated)
**Endpoint**: `POST /auth/logout`

**Headers**:
```
Authorization: Bearer <access_token>
```

**Request**: No body required

**Expected Response (200 OK)**:
```json
{
  "success": true,
  "message": "Logged out successfully",
  "data": null,
  "timestamp": "2025-01-01T10:00:00.000Z"
}
```

---

## Error Response Examples

### Invalid Phone Number
```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [
    {
      "field": "phone",
      "message": "phone must be a valid phone number"
    }
  ],
  "statusCode": 400,
  "timestamp": "2025-01-01T10:00:00.000Z"
}
```

### Invalid OTP
```json
{
  "success": false,
  "message": "Invalid or expired OTP",
  "statusCode": 400,
  "timestamp": "2025-01-01T10:00:00.000Z"
}
```

### User Already Exists
```json
{
  "success": false,
  "message": "User with this phone number already exists",
  "statusCode": 409,
  "timestamp": "2025-01-01T10:00:00.000Z"
}
```

### Unauthorized (Missing Token)
```json
{
  "success": false,
  "message": "Unauthorized",
  "statusCode": 401,
  "timestamp": "2025-01-01T10:00:00.000Z"
}
```

### Expired Token
```json
{
  "success": false,
  "message": "Token has expired",
  "statusCode": 401,
  "timestamp": "2025-01-01T10:00:00.000Z"
}
```

---

## Test Scenarios

### Scenario 1: Complete Customer Registration Flow
1. POST /auth/register (customer)
2. Check console for OTP
3. POST /auth/verify-otp
4. Save tokens
5. Test authenticated endpoint with token

### Scenario 2: Complete Driver Registration Flow
1. POST /auth/register (driver)
2. Verify OTP
3. Check if driver profile created with pending status

### Scenario 3: Login Flow
1. POST /auth/login
2. POST /auth/verify-login-otp
3. Verify tokens received

### Scenario 4: Token Refresh Flow
1. Wait for access token to expire (15 minutes)
2. POST /auth/refresh-token with refresh token
3. Verify new access token received

### Scenario 5: OTP Expiry Test
1. POST /auth/register
2. Wait 6 minutes (OTP expires in 5 min)
3. POST /auth/verify-otp
4. Verify error: "Invalid or expired OTP"

### Scenario 6: Resend OTP Flow
1. POST /auth/register
2. POST /auth/resend-otp
3. Verify new OTP sent

---

## cURL Commands for Quick Testing

### Register Customer
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "9876543210",
    "name": "Test Customer",
    "role": "customer"
  }'
```

### Verify OTP
```bash
curl -X POST http://localhost:3000/api/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "9876543210",
    "otp": "123456"
  }'
```

### Login
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "9876543210",
    "role": "customer"
  }'
```

### Logout (Replace TOKEN)
```bash
curl -X POST http://localhost:3000/api/auth/logout \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## Postman Collection Variables

Create these variables in Postman for easier testing:

- `baseUrl`: `http://localhost:3000/api`
- `customerPhone`: `9876543210`
- `driverPhone`: `8765432109`
- `customerAccessToken`: (auto-set from response)
- `customerRefreshToken`: (auto-set from response)
- `driverAccessToken`: (auto-set from response)

### Auto-save tokens in Postman

Add this script to Tests tab in verify-otp requests:

```javascript
if (pm.response.code === 200) {
    const response = pm.response.json();
    pm.environment.set("customerAccessToken", response.data.accessToken);
    pm.environment.set("customerRefreshToken", response.data.refreshToken);
}
```

---

## Database Verification Queries

### Check Users
```sql
SELECT id, phone, name, role, is_verified, user_status, created_at 
FROM users 
ORDER BY created_at DESC;
```

### Check OTPs
```sql
SELECT phone, otp, purpose, is_used, expires_at, created_at 
FROM otps 
ORDER BY created_at DESC 
LIMIT 10;
```

### Check Customer Profiles
```sql
SELECT cp.id, u.name, u.phone, cp.total_bookings, cp.average_rating 
FROM customer_profiles cp 
JOIN users u ON u.id = cp.user_id;
```

### Check Driver Profiles
```sql
SELECT dp.id, u.name, u.phone, dp.verification_status, dp.availability_status 
FROM driver_profiles dp 
JOIN users u ON u.id = dp.user_id;
```

---

## Performance Benchmarks

Expected response times (on local development):
- Register: < 100ms
- Verify OTP: < 150ms
- Login: < 100ms
- Refresh Token: < 50ms
- Logout: < 50ms

---

## Testing Checklist

- [ ] Customer registration works
- [ ] Driver registration works
- [ ] Admin registration works
- [ ] OTP generation works
- [ ] OTP verification works
- [ ] OTP expiry works correctly (5 min)
- [ ] Resend OTP works
- [ ] Login with OTP works
- [ ] JWT tokens are generated correctly
- [ ] Access token expires in 15 minutes
- [ ] Refresh token works
- [ ] Logout invalidates tokens
- [ ] Duplicate phone registration is prevented
- [ ] Invalid OTP is rejected
- [ ] Expired OTP is rejected
- [ ] Customer profile is auto-created
- [ ] Driver profile is auto-created with pending status
- [ ] Phone number validation works
- [ ] Role validation works
- [ ] Protected routes require authentication
- [ ] Error responses are consistent

---

**Testing Status**: Ready for Phase 1 Testing
**Last Updated**: December 31, 2025
