# SkiDO Backend - EC2 Single Server Deployment

A cost-effective deployment where PostgreSQL, Redis, and the application run on a single EC2 Ubuntu instance.

**Estimated Cost: ~$15-30/month** (t3.small to t3.medium)

---

## Prerequisites

1. AWS Account with EC2 access
2. Domain name (optional, for SSL)
3. All your API keys ready (Razorpay, Mapbox, SMS, FCM, AWS S3)

---

## STEP 1: Launch EC2 Instance

### 1.1 Go to AWS Console > EC2 > Launch Instance

| Setting | Value |
|---------|-------|
| **Name** | skido-backend |
| **AMI** | Ubuntu 22.04 LTS (64-bit x86) |
| **Instance Type** | t3.small (2 vCPU, 2GB RAM) or t3.medium (2 vCPU, 4GB RAM) |
| **Key Pair** | Create new or use existing (.pem file) |
| **Storage** | 30 GB gp3 |

### 1.2 Security Group Rules

Create a new security group with these rules:

| Type | Port | Source | Description |
|------|------|--------|-------------|
| SSH | 22 | My IP | SSH access |
| HTTP | 80 | 0.0.0.0/0 | Web traffic |
| HTTPS | 443 | 0.0.0.0/0 | Secure web traffic |

### 1.3 Launch and Note Down
- **Public IPv4 address**: _____________
- **Key pair file location**: _____________

---

## STEP 2: Connect to EC2

```bash
# From your terminal (replace with your values)
ssh -i "your-key.pem" ubuntu@your-ec2-public-ip

# Example:
ssh -i "skido-key.pem" ubuntu@13.235.xx.xxx
```

**Windows Users**: Use PowerShell or Git Bash, or use PuTTY.

---

## STEP 3: Initial Server Setup

Run these commands after connecting:

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential tools
sudo apt install -y curl wget git build-essential software-properties-common unzip
```

---

## STEP 4: Install Node.js 20.x

```bash
# Install Node.js 20.x LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v20.x.x
npm --version   # Should show 10.x.x

# Install PM2 globally
sudo npm install -g pm2
```

---

## STEP 5: Install PostgreSQL 14 with PostGIS

```bash
# Add PostgreSQL repository
sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo apt-key add -
sudo apt update

# Install PostgreSQL 14 and PostGIS
sudo apt install -y postgresql-14 postgresql-contrib-14 postgis postgresql-14-postgis-3

# Start PostgreSQL
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

### 5.1 Configure Database

```bash
# Switch to postgres user
sudo -i -u postgres

# Open PostgreSQL shell
psql
```

**Run these SQL commands (CHANGE THE PASSWORD!):**

```sql
-- Create database
CREATE DATABASE skido_db;

-- Create user (CHANGE 'YourStrongPassword123!' to a secure password)
CREATE USER skido_user WITH ENCRYPTED PASSWORD 'YourStrongPassword123!';

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE skido_db TO skido_user;

-- Connect to the database
\c skido_db

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Grant schema permissions
GRANT ALL ON SCHEMA public TO skido_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO skido_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO skido_user;

-- Exit PostgreSQL shell
\q
```

```bash
# Exit postgres user
exit
```

### 5.2 Configure PostgreSQL Authentication

```bash
# Edit pg_hba.conf
sudo nano /etc/postgresql/14/main/pg_hba.conf
```

Find these lines and change `peer` to `md5`:

```
# Change FROM:
local   all             all                                     peer
# Change TO:
local   all             all                                     md5
```

Also ensure this line exists:
```
host    all             all             127.0.0.1/32            md5
```

Save and exit (Ctrl+X, Y, Enter), then restart PostgreSQL:

```bash
sudo systemctl restart postgresql

# Test connection
psql -U skido_user -h localhost -d skido_db
# Enter your password when prompted
# Type \q to exit
```

---

## STEP 6: Install Redis

```bash
# Install Redis
sudo apt install -y redis-server

# Configure Redis
sudo nano /etc/redis/redis.conf
```

Find and update these lines:

```conf
# Bind to localhost only (find and update)
bind 127.0.0.1 ::1

# Set supervised to systemd (find and update)
supervised systemd

# Set a password (find "requirepass" and uncomment/add - CHANGE THE PASSWORD!)
requirepass YourRedisPassword123!

# Set max memory (add these lines at the end)
maxmemory 256mb
maxmemory-policy allkeys-lru
```

Save and restart Redis:

```bash
sudo systemctl restart redis-server
sudo systemctl enable redis-server

# Test Redis
redis-cli -a YourRedisPassword123! ping
# Should return: PONG
```

---

## STEP 7: Install Nginx

```bash
sudo apt install -y nginx

# Start and enable
sudo systemctl start nginx
sudo systemctl enable nginx
```

---

## STEP 8: Create Application Directory

```bash
sudo mkdir -p /var/www/skido-backend
sudo chown -R ubuntu:ubuntu /var/www/skido-backend
cd /var/www/skido-backend
```

---

## STEP 9: Upload Your Code

### Option A: Using Git (Recommended)

```bash
cd /var/www/skido-backend
git clone https://github.com/YOUR_USERNAME/skido-backend.git .
```

### Option B: Using SCP (from your local Windows machine)

Open a **new** PowerShell/terminal on your local machine:

```powershell
# Navigate to your project folder
cd C:\Users\subha\Desktop\skido-backend

# Create a zip file (exclude node_modules)
tar -czvf skido-backend.tar.gz --exclude='node_modules' --exclude='.git' --exclude='dist' .

# Upload to EC2
scp -i "your-key.pem" skido-backend.tar.gz ubuntu@your-ec2-ip:/var/www/skido-backend/
```

Then on EC2:

```bash
cd /var/www/skido-backend
tar -xzvf skido-backend.tar.gz
rm skido-backend.tar.gz
```

---

## STEP 10: Install Dependencies

```bash
cd /var/www/skido-backend
npm install
```

---

## STEP 11: Create Production Environment File

```bash
nano /var/www/skido-backend/.env
```

Paste and update with your actual values:

```env
# Application
NODE_ENV=production
PORT=3000
API_PREFIX=api
APP_NAME=SkiDO

# Database (update password!)
DATABASE_TYPE=postgres
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USERNAME=skido_user
DATABASE_PASSWORD=YourStrongPassword123!
DATABASE_NAME=skido_db
DATABASE_SYNCHRONIZE=false
DATABASE_LOGGING=false

# Redis (update password!)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=YourRedisPassword123!
REDIS_DB=0

# JWT (generate strong random strings - minimum 32 characters!)
JWT_SECRET=change-this-to-a-very-long-random-string-at-least-32-chars
JWT_REFRESH_SECRET=change-this-to-another-very-long-random-string-32-chars
JWT_EXPIRATION=15m
JWT_REFRESH_EXPIRATION=7d

# AWS S3
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=your-aws-access-key
AWS_SECRET_ACCESS_KEY=your-aws-secret-key
AWS_S3_BUCKET=zipto-storage

# Mapbox
MAPBOX_ACCESS_TOKEN=your-mapbox-token

# Razorpay
RAZORPAY_KEY_ID=your-razorpay-key-id
RAZORPAY_KEY_SECRET=your-razorpay-key-secret

# SMS Gateway
SMS_PROVIDER=msg91
SMS_API_KEY=your-sms-api-key
SMS_SENDER_ID=SKIDO
SMS_ROUTE=4

# FCM (Firebase Cloud Messaging)
FCM_SERVER_KEY=your-fcm-server-key

# OTP
OTP_LENGTH=6
OTP_EXPIRY_MINUTES=10

# Rate Limiting
THROTTLE_TTL=60
THROTTLE_LIMIT=100

# Logging
LOG_LEVEL=info
```

Save the file (Ctrl+X, Y, Enter).

---

## STEP 12: Build Application

```bash
cd /var/www/skido-backend
npm run build
```

---

## STEP 13: Create PM2 Ecosystem File

```bash
nano /var/www/skido-backend/ecosystem.config.js
```

Paste this:

```javascript
module.exports = {
  apps: [
    {
      name: 'skido-backend',
      script: 'dist/main.js',
      cwd: '/var/www/skido-backend',
      instances: 'max',
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      error_file: '/var/www/skido-backend/logs/error.log',
      out_file: '/var/www/skido-backend/logs/output.log',
      log_file: '/var/www/skido-backend/logs/combined.log',
      time: true
    }
  ]
};
```

Create logs directory:

```bash
mkdir -p /var/www/skido-backend/logs
```

---

## STEP 14: Start Application with PM2

```bash
cd /var/www/skido-backend

# Start the app
pm2 start ecosystem.config.js

# Check status
pm2 status

# View logs
pm2 logs skido-backend

# Save PM2 configuration
pm2 save

# Setup auto-start on reboot
pm2 startup systemd -u ubuntu --hp /home/ubuntu
# Copy and run the command it shows you!
```

---

## STEP 15: Configure Nginx Reverse Proxy

```bash
sudo nano /etc/nginx/sites-available/skido-backend
```

Paste this (replace `your-domain.com` with your domain or use `_` for IP-based access):

```nginx
server {
    listen 80;
    server_name your-domain.com;  # Or use: server_name _;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    # Max upload size
    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 90;
        proxy_connect_timeout 90;
    }
}
```

Enable the site:

```bash
# Remove default site
sudo rm /etc/nginx/sites-enabled/default

# Enable our site
sudo ln -s /etc/nginx/sites-available/skido-backend /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx
```

---

## STEP 16: Setup Firewall (UFW)

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

---

## STEP 17: Test Your Deployment

Open in browser:
- **API Base**: `http://your-ec2-ip/api`
- **Swagger Docs**: `http://your-ec2-ip/api/docs`
- **Health Check**: `http://your-ec2-ip/api/health` (if you have this endpoint)

---

## STEP 18: Setup SSL with Let's Encrypt (Optional but Recommended)

**Prerequisites**: You need a domain name pointing to your EC2 IP.

```bash
# Install Certbot
sudo apt install -y certbot python3-certbot-nginx

# Get SSL certificate (replace with your domain)
sudo certbot --nginx -d your-domain.com -d www.your-domain.com

# Follow the prompts

# Test auto-renewal
sudo certbot renew --dry-run
```

After SSL setup, your API will be accessible at `https://your-domain.com/api`

---

## Common Commands Reference

### Application Management

```bash
# View app status
pm2 status

# View logs
pm2 logs skido-backend

# Restart app
pm2 restart skido-backend

# Stop app
pm2 stop skido-backend

# Real-time monitoring
pm2 monit
```

### Update Application

```bash
cd /var/www/skido-backend

# Pull latest code (if using git)
git pull origin main

# Install new dependencies
npm install

# Rebuild
npm run build

# Restart
pm2 restart skido-backend

# Check logs
pm2 logs skido-backend --lines 50
```

### Database Commands

```bash
# Connect to database
psql -U skido_user -h localhost -d skido_db

# Backup database
pg_dump -U skido_user -h localhost skido_db > backup_$(date +%Y%m%d).sql

# Restore database
psql -U skido_user -h localhost skido_db < backup_20240101.sql
```

### Service Management

```bash
# PostgreSQL
sudo systemctl status postgresql
sudo systemctl restart postgresql

# Redis
sudo systemctl status redis-server
sudo systemctl restart redis-server

# Nginx
sudo systemctl status nginx
sudo systemctl restart nginx
sudo nginx -t  # Test config
```

---

## Troubleshooting

### App won't start

```bash
# Check PM2 logs
pm2 logs skido-backend --lines 100

# Check if port 3000 is in use
sudo lsof -i :3000

# Check environment file
cat /var/www/skido-backend/.env
```

### Database connection failed

```bash
# Test PostgreSQL connection
psql -U skido_user -h localhost -d skido_db

# Check PostgreSQL is running
sudo systemctl status postgresql

# Check PostgreSQL logs
sudo tail -50 /var/log/postgresql/postgresql-14-main.log
```

### Redis connection failed

```bash
# Test Redis
redis-cli -a YourRedisPassword123! ping

# Check Redis status
sudo systemctl status redis-server
```

### 502 Bad Gateway (Nginx)

```bash
# Check if app is running
pm2 status

# Check Nginx error logs
sudo tail -50 /var/log/nginx/error.log

# Restart everything
pm2 restart skido-backend
sudo systemctl restart nginx
```

---

## Security Checklist

- [ ] Changed PostgreSQL password from default
- [ ] Changed Redis password from default
- [ ] Generated strong JWT secrets (32+ characters)
- [ ] UFW firewall enabled
- [ ] SSH key authentication only (disable password auth)
- [ ] SSL/HTTPS enabled
- [ ] Keep packages updated: `sudo apt update && sudo apt upgrade`

---

## Cost Summary

| Instance Type | vCPU | RAM | Monthly Cost |
|--------------|------|-----|--------------|
| t3.micro | 2 | 1 GB | ~$8 |
| t3.small | 2 | 2 GB | ~$15 |
| t3.medium | 2 | 4 GB | ~$30 |

**Recommendation**: Start with `t3.small` and scale up if needed.

---

## Done!

Your SkiDO backend is now deployed on EC2 Ubuntu. Access your API at:

- **HTTP**: `http://your-ec2-ip/api`
- **HTTPS**: `https://your-domain.com/api` (after SSL setup)
- **Swagger**: `http://your-ec2-ip/api/docs`
