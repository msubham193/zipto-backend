# SkiDO Backend API - Testing Guide (Phase 1)

## 🎯 Phase 1 Testing Scope

Phase 1 includes testing of:
- ✅ Authentication Module (Registration, Login, OTP verification)
- ✅ Customer Module (Profile management, Saved locations)
- ✅ Driver Module (Profile, Documents, Availability, Location)
- ✅ Vehicle Module (Registration, Management)
- ✅ Admin Module (User management, Verification, Dashboard basics)

---

## 🛠️ Testing Tools Required

1. **API Testing Client** (Choose one):
   - Thunder Client (VS Code Extension) - **Recommended**
   - Postman
   - Insomnia
   - REST Client (VS Code Extension)
   - cURL

2. **Database Client**:
   - pgAdmin 4
   - DBeaver
   - TablePlus

3. **Redis Client** (Optional):
   - Redis Commander
   - RedisInsight

---

## 🚀 Setup Instructions

### 1. Initial Setup

```bash
# Clone and navigate to project
cd skido-backend

# Run setup script
chmod +x setup.sh
./setup.sh

# Or manual setup:
npm install
cp .env.example .env
# Update .env with your configuration
npm run migration:run
```

### 2. Start the Server

```bash
# Development mode with hot reload
npm run start:dev

# Production mode
npm run build
npm run start:prod
```

### 3. Verify Server is Running

Open browser: `http://localhost:3000/api/docs`

You should see the Swagger API documentation.

---

## 📋 Pre-Testing Checklist

- [ ] PostgreSQL is running
- [ ] Redis is running (optional for Phase 1)
- [ ] Database migrations completed successfully
- [ ] `.env` file configured properly
- [ ] Server started without errors
- [ ] Swagger docs accessible

---

## 🧪 Testing Workflow

### **Test Sequence for Complete Flow:**

1. **Authentication Flow**
   - Register Customer → Verify OTP → Login → Logout
   - Register Driver → Verify OTP → Login

2. **Customer Flow**
   - View Profile → Update Profile → Add Saved Location → Delete Location

3. **Driver Flow**
   - View Profile → Update Profile → Upload Documents → 
     Toggle Availability → Update Location → View Earnings

4. **Vehicle Flow**
   - Register Vehicle → View Vehicle → Update Vehicle

5. **Admin Flow** (Create admin user first)
   - View All Users → Verify Driver → Verify Vehicle → Block User

---

## 📝 Detailed Test Cases

### **1. Authentication Module**

#### Test Case 1.1: Customer Registration
**Endpoint:** `POST /api/auth/register`

**Request:**
```json
{
  "phone": "9876543210",
  "name": "Test Customer",
  "role": "customer"
}
```

**Expected Response (200 OK):**
```json
{
  "success": true,
  "message": "OTP sent successfully",
  "data": {
    "message": "OTP sent to 9876543210",
    "expiresIn": "5 minutes"
  }
}
```

**Validation Points:**
- ✅ OTP generated and stored in database
- ✅ OTP expires in 5 minutes
- ✅ User created with is_verified = false
- ✅ Response time < 2 seconds

**Database Check:**
```sql
SELECT * FROM users WHERE phone = '9876543210';
SELECT * FROM otps WHERE phone = '9876543210' ORDER BY created_at DESC LIMIT 1;
```

---

#### Test Case 1.2: Verify OTP
**Endpoint:** `POST /api/auth/verify-otp`

**Request:**
```json
{
  "phone": "9876543210",
  "otp": "123456"
}
```

**Expected Response (200 OK):**
```json
{
  "success": true,
  "message": "Registration successful",
  "data": {
    "user": {
      "id": "uuid-here",
      "phone": "9876543210",
      "name": "Test Customer",
      "role": "customer",
      "is_verified": true
    },
    "accessToken": "jwt-access-token",
    "refreshToken": "jwt-refresh-token"
  }
}
```

**Validation Points:**
- ✅ User is_verified updated to true
- ✅ Access token is valid JWT
- ✅ Refresh token is valid JWT
- ✅ Customer profile created automatically

**Test Invalid OTP:**
```json
{
  "phone": "9876543210",
  "otp": "000000"
}
```

**Expected Error (400 Bad Request):**
```json
{
  "success": false,
  "message": "Invalid or expired OTP"
}
```

---

#### Test Case 1.3: Login Flow
**Endpoint:** `POST /api/auth/login`

**Request:**
```json
{
  "phone": "9876543210"
}
```

**Expected Response (200 OK):**
```json
{
  "success": true,
  "message": "OTP sent successfully",
  "data": {
    "message": "OTP sent to 9876543210"
  }
}
```

**Then verify with:**
`POST /api/auth/verify-login-otp`

---

### **2. Customer Module**

#### Test Case 2.1: Get Customer Profile
**Endpoint:** `GET /api/customer/profile`
**Headers:** `Authorization: Bearer {accessToken}`

**Expected Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "phone": "9876543210",
    "name": "Test Customer",
    "email": null,
    "role": "customer",
    "language_preference": "english",
    "profile": {
      "address": null,
      "saved_locations": []
    }
  }
}
```

---

#### Test Case 2.2: Update Customer Profile
**Endpoint:** `PUT /api/customer/profile`
**Headers:** `Authorization: Bearer {accessToken}`

**Request:**
```json
{
  "name": "Updated Customer",
  "email": "customer@example.com",
  "language_preference": "odia"
}
```

**Expected Response (200 OK):**
```json
{
  "success": true,
  "message": "Profile updated successfully",
  "data": {
    "id": "uuid",
    "name": "Updated Customer",
    "email": "customer@example.com",
    "language_preference": "odia"
  }
}
```

---

#### Test Case 2.3: Add Saved Location
**Endpoint:** `POST /api/customer/saved-locations`

**Request:**
```json
{
  "label": "Home",
  "address": "Bhubaneswar, Odisha",
  "latitude": 20.2961,
  "longitude": 85.8245
}
```

**Expected Response (201 Created):**
```json
{
  "success": true,
  "message": "Location saved successfully",
  "data": {
    "id": "uuid",
    "label": "Home",
    "address": "Bhubaneswar, Odisha",
    "coordinates": {
      "latitude": 20.2961,
      "longitude": 85.8245
    }
  }
}
```

---

### **3. Driver Module**

#### Test Case 3.1: Register Driver
First complete registration as driver (role: "driver")

**Then update driver profile:**
**Endpoint:** `PUT /api/driver/profile`

**Request:**
```json
{
  "license_number": "OD-12-2024-1234567",
  "license_expiry": "2030-12-31",
  "aadhar_number": "123456789012"
}
```

---

#### Test Case 3.2: Toggle Driver Availability
**Endpoint:** `PUT /api/driver/availability`

**Request:**
```json
{
  "status": "available"
}
```

**Expected Response (200 OK):**
```json
{
  "success": true,
  "message": "Availability status updated",
  "data": {
    "availability_status": "available"
  }
}
```

**Validation Points:**
- ✅ Status updated in database
- ✅ Only valid statuses accepted: "available", "busy", "offline"

---

#### Test Case 3.3: Update Driver Location
**Endpoint:** `PUT /api/driver/location`

**Request:**
```json
{
  "latitude": 20.2961,
  "longitude": 85.8245
}
```

**Expected Response (200 OK):**
```json
{
  "success": true,
  "message": "Location updated successfully"
}
```

**Database Check:**
```sql
SELECT current_latitude, current_longitude 
FROM driver_profiles 
WHERE user_id = 'driver-user-id';
```

---

### **4. Vehicle Module**

#### Test Case 4.1: Get Vehicle Types
**Endpoint:** `GET /api/vehicle/types`

**Expected Response (200 OK):**
```json
{
  "success": true,
  "data": [
    {
      "type": "bike",
      "name": "Bike",
      "capacity": "Up to 20kg",
      "base_fare": 50
    },
    {
      "type": "tata_ace",
      "name": "Tata Ace",
      "capacity": "Up to 750kg",
      "base_fare": 150
    },
    {
      "type": "pickup_van",
      "name": "Pickup Van",
      "capacity": "Up to 1000kg",
      "base_fare": 200
    },
    {
      "type": "mini_truck",
      "name": "Mini Truck",
      "capacity": "Up to 2000kg",
      "base_fare": 300
    }
  ]
}
```

---

#### Test Case 4.2: Register Vehicle (Driver Only)
**Endpoint:** `POST /api/vehicle/register`
**Headers:** `Authorization: Bearer {driverAccessToken}`

**Request:**
```json
{
  "vehicle_type": "tata_ace",
  "registration_number": "OD-02-AB-1234",
  "vehicle_model": "Tata Ace Gold",
  "capacity": "750kg",
  "insurance_expiry": "2025-12-31"
}
```

**Expected Response (201 Created):**
```json
{
  "success": true,
  "message": "Vehicle registered successfully",
  "data": {
    "id": "uuid",
    "vehicle_type": "tata_ace",
    "registration_number": "OD-02-AB-1234",
    "verification_status": "pending"
  }
}
```

**Validation Points:**
- ✅ Only drivers can register vehicles
- ✅ Registration number must be unique
- ✅ Vehicle created with verification_status = "pending"

---

### **5. Admin Module**

#### Test Case 5.1: Create Admin User
First create an admin user manually in database:

```sql
INSERT INTO users (phone, name, role, is_verified, is_active, password_hash)
VALUES ('9999999999', 'Admin User', 'admin', true, true, NULL);
```

Then login as admin to get access token.

---

#### Test Case 5.2: Get All Users
**Endpoint:** `GET /api/admin/users?page=1&limit=10&role=customer`
**Headers:** `Authorization: Bearer {adminAccessToken}`

**Expected Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "users": [
      {
        "id": "uuid",
        "phone": "9876543210",
        "name": "Test Customer",
        "role": "customer",
        "is_verified": true,
        "is_active": true,
        "created_at": "2025-01-01T10:00:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 1,
      "pages": 1
    }
  }
}
```

---

#### Test Case 5.3: Verify Driver
**Endpoint:** `PUT /api/admin/drivers/{driverId}/verify`

**Request:**
```json
{
  "verification_status": "approved",
  "remarks": "All documents verified"
}
```

**Expected Response (200 OK):**
```json
{
  "success": true,
  "message": "Driver verification updated",
  "data": {
    "driver_id": "uuid",
    "verification_status": "approved"
  }
}
```

---

## 🔍 Manual Testing Checklist

### Authentication (✅ Complete these first)
- [ ] Register customer with OTP
- [ ] Verify OTP successfully
- [ ] Test invalid OTP
- [ ] Test expired OTP
- [ ] Login existing user
- [ ] Resend OTP
- [ ] Refresh access token
- [ ] Logout user
- [ ] Register driver

### Customer Module
- [ ] Get customer profile
- [ ] Update customer profile
- [ ] Add saved location
- [ ] Get all saved locations
- [ ] Delete saved location

### Driver Module
- [ ] Get driver profile
- [ ] Update driver profile with license details
- [ ] Toggle availability (available/busy/offline)
- [ ] Update current location
- [ ] View earnings (should be 0 initially)
- [ ] View trip history (should be empty)

### Vehicle Module
- [ ] Get all vehicle types
- [ ] Register vehicle as driver
- [ ] Get vehicle details
- [ ] Update vehicle information
- [ ] Test registration number uniqueness

### Admin Module
- [ ] Login as admin
- [ ] Get all users with pagination
- [ ] Filter users by role
- [ ] Get pending driver verifications
- [ ] Approve driver
- [ ] Reject driver
- [ ] Get pending vehicle verifications
- [ ] Approve vehicle
- [ ] Block/unblock user

---

## 🐛 Common Issues & Solutions

### Issue 1: "Cannot connect to database"
**Solution:**
- Check if PostgreSQL is running: `sudo service postgresql status`
- Verify database credentials in `.env`
- Ensure database exists: `psql -U postgres -c "\l"`

### Issue 2: "JWT token invalid"
**Solution:**
- Token might be expired (15 minutes validity)
- Use refresh token endpoint to get new access token
- Re-login to get fresh tokens

### Issue 3: "OTP not received"
**Solution:**
- Check if SMS gateway is configured in `.env`
- For testing, check the database directly:
```sql
SELECT otp FROM otps WHERE phone = 'your-phone' ORDER BY created_at DESC LIMIT 1;
```

### Issue 4: "Migration failed"
**Solution:**
```bash
# Revert and re-run migration
npm run migration:revert
npm run migration:run
```

---

## 📊 Performance Benchmarks

Expected response times for Phase 1:
- Authentication endpoints: < 2 seconds
- Profile GET requests: < 500ms
- Profile UPDATE requests: < 1 second
- Admin list requests: < 1 second

---

## ✅ Phase 1 Completion Criteria

Phase 1 is complete when:
- [ ] All authentication flows work correctly
- [ ] Customer can register, login, and manage profile
- [ ] Driver can register, login, and manage profile
- [ ] Driver can register and manage vehicles
- [ ] Admin can view and verify drivers/vehicles
- [ ] All database relationships work correctly
- [ ] API documentation is complete
- [ ] All endpoints return proper error messages

---

## 📞 Support

For issues or questions:
- Check the `README.md` file
- Review API documentation at `/api/docs`
- Examine logs in the `logs/` directory

---

## 🎉 Next Steps After Phase 1

Once Phase 1 testing is complete, we'll move to:
- **Phase 2:** Booking module, Pricing engine, Payment integration
- **Phase 3:** Real-time tracking, WebSockets, Chat functionality
- **Phase 4:** Admin analytics, Driver earnings, Support system
- **Phase 5:** Complete testing and optimization
- **Phase 6:** AWS deployment

---

**Happy Testing! 🚀**
