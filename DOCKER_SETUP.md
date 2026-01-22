# SkiDO Backend - Docker Database Setup Guide

## 🐳 Quick Start

### 1. Start Docker Containers

```bash
docker-compose up -d
```

This will start:

- **PostgreSQL 14 with PostGIS** on port `5433` (avoiding conflict with existing PostgreSQL on 5432)
- **Redis 7** on port `6379`

### 2. Create .env File

Copy the environment template:

```bash
copy .env.example .env
```

Or manually create `.env` with these settings:

```env
# Application
NODE_ENV=development
PORT=3000

# Database (Docker PostgreSQL with PostGIS)
DB_HOST=localhost
DB_PORT=5433
DB_USERNAME=postgres
DB_PASSWORD=postgres
DB_DATABASE=skido_db

# JWT
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRES_IN=1h
JWT_REFRESH_SECRET=your-super-secret-refresh-jwt-key-change-this
JWT_REFRESH_EXPIRES_IN=7d

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# OTP Configuration
OTP_LENGTH=6
OTP_EXPIRY_MINUTES=10
OTP_MAX_ATTEMPTS=3

# Rate Limiting
RATE_LIMIT_TTL=60
RATE_LIMIT_MAX=100

# Leave these empty to use mock modes (no API keys required for testing)
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=ap-south-1
AWS_BUCKET_NAME=
GOOGLE_MAPS_API_KEY=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
SMS_PROVIDER=msg91
SMS_API_KEY=
SMS_SENDER_ID=SKIDO
SMS_ROUTE=4
FCM_SERVER_KEY=
```

### 3. Verify Database Connection

```bash
# Check containers are running
docker ps

# Connect to PostgreSQL
docker exec -it skido-postgres psql -U postgres -d skido_db

# Inside PostgreSQL shell:
\l                    # List databases
\dt                   # List tables (after app starts)
\dx                   # Check PostGIS extension is enabled
\q                    # Exit
```

### 4. Start Application

```bash
npm run start:dev
```

The app will automatically create all tables on first run!

## 📊 Database Management

### View Logs

```bash
docker logs skido-postgres -f
docker logs skido-redis -f
```

### Stop Containers

```bash
docker-compose down
```

### Stop and Remove Data

```bash
docker-compose down -v
```

### Restart Containers

```bash
docker-compose restart
```

## 🔧 Troubleshooting

### Port Already in Use

If you get "port already allocated" error:

- PostgreSQL: Change `5433:5432` in docker-compose.yml
- Redis: Change `6379:6379` in docker-compose.yml

### Database Connection Failed

1. Check containers are running: `docker ps`
2. Verify credentials in `.env` match docker-compose.yml
3. Check DB_PORT is `5433` in `.env`

### Reset Database

```bash
docker-compose down -v
docker-compose up -d
npm run start:dev
```

## 📝 Important Notes

1. **Port 5433**: Using 5433 instead of 5432 to avoid conflict with your existing PostgreSQL
2. **Mock Modes**: All external services work in mock mode without API keys
3. **Auto-Creation**: Database tables are created automatically by TypeORM
4. **PostGIS**: PostGIS extension is pre-installed in the container

## 🎯 Next Steps

1. ✅ Containers running
2. ✅ .env file created
3. ✅ Start application
4. ✅ Test with Postman collection

Happy coding! 🚀
