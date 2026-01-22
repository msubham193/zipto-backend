# SkiDO Backend

**Smart Kinetics Delivery Odisha** - A comprehensive logistics and goods transportation backend API.

## 🚀 Tech Stack

- **Framework:** NestJS 10.x
- **Language:** TypeScript 5.x
- **Database:** PostgreSQL 14+ with PostGIS
- **ORM:** TypeORM
- **Authentication:** JWT with Passport.js
- **Documentation:** Swagger/OpenAPI
- **Caching:** Redis

## 📋 Prerequisites

- Node.js 18+ (LTS recommended)
- PostgreSQL 14+ with PostGIS extension
- Redis Server
- npm or yarn

## 🛠️ Installation

1. **Clone the repository**

   ```bash
   cd skido-backend
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Set up environment variables**

   ```bash
   cp .env.example .env
   ```

   Then edit `.env` with your configuration.

4. **Set up PostgreSQL Database**

   ```sql
   CREATE DATABASE skido_db;
   \c skido_db
   CREATE EXTENSION IF NOT EXISTS postgis;
   ```

5. **Start Redis** (if not already running)
   ```bash
   redis-server
   ```

## 🏃 Running the Application

**Development mode:**

```bash
npm run start:dev
```

**Production mode:**

```bash
npm run build
npm run start:prod
```

**Debug mode:**

```bash
npm run start:debug
```

## 📚 API Documentation

Once the server is running, access the Swagger documentation at:

```
http://localhost:3000/api/docs
```

## 🗂️ Project Structure

```
skido-backend/
├── src/
│   ├── config/           # Configuration modules
│   ├── common/           # Shared utilities, guards, decorators
│   ├── modules/          # Feature modules
│   │   ├── auth/         # Authentication
│   │   ├── customer/     # Customer management
│   │   ├── driver/       # Driver management
│   │   ├── vehicle/      # Vehicle management
│   │   ├── booking/      # Booking system
│   │   ├── payment/      # Payment processing
│   │   ├── rating/       # Rating system
│   │   ├── admin/        # Admin operations
│   │   └── analytics/    # Analytics
│   ├── app.module.ts     # Root module
│   └── main.ts           # Application entry
├── database/
│   ├── migrations/       # Database migrations
│   └── seeds/            # Seed data
└── test/                 # Tests

```

## 🔐 Environment Variables

See `.env.example` for all required environment variables. Key variables include:

- `DATABASE_*` - PostgreSQL connection details
- `JWT_SECRET` - JWT secret key
- `REDIS_*` - Redis configuration
- `GOOGLE_MAPS_API_KEY` - For distance calculation
- `RAZORPAY_*` - Payment gateway credentials
- `SMS_API_KEY` - For OTP delivery

## 🧪 Testing

```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Test coverage
npm run test:cov
```

## 📝 Available Scripts

```bash
npm run build          # Build for production
npm run start          # Start production server
npm run start:dev      # Start development server
npm run start:debug    # Start in debug mode
npm run lint           # Lint code
npm run format         # Format code with Prettier
npm run test           # Run unit tests
npm run test:e2e       # Run E2E tests
```

## 🌟 Features

- ✅ Phone-based authentication with OTP
- ✅ Role-based access control (Customer, Driver, Admin)
- ✅ Real-time location tracking
- ✅ Geospatial queries for nearby bookings
- ✅ Dynamic fare calculation
- ✅ Payment integration (Razorpay)
- ✅ Rating and feedback system
- ✅ Admin dashboard and analytics
- ✅ Comprehensive API documentation

## 📖 API Modules

### Authentication

- User registration and verification
- OTP-based login
- JWT token management
- Role-based authentication

### Customer Module

- Profile management
- Saved locations
- Booking history

### Driver Module

- Profile and document management
- Availability status
- Location updates
- Earnings tracking

### Booking Module

- Fare estimation
- Booking creation and management
- Trip lifecycle (pending → accepted → ongoing → completed)
- Nearby bookings search

### Payment Module

- Online payment processing
- Cash payment recording
- Payment history
- Invoice generation

### Admin Module

- User management
- Driver/vehicle verification
- Analytics and reports
- Pricing rule management

## 🔧 Development

**Current Status:** Phase 1 Complete

- ✅ Project setup and configuration
- ✅ Core infrastructure (guards, filters, interceptors)
- ✅ Authentication module

**Next Steps:**

- Phase 2: Customer, Driver, Vehicle modules
- Phase 3: Booking and Payment modules
- Phase 4: Rating, Admin, Analytics modules
- Phase 5: External service integrations and testing

## 📄 License

MIT

## 👥 Support

For issues and questions, please create an issue in the repository.

---

**Built with ❤️ for the Odisha logistics ecosystem**
