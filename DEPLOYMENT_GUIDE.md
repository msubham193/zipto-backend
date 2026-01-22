# SkiDO Backend - AWS Deployment Guide

## 🎯 Overview

This guide covers deploying SkiDO backend to AWS without Docker containers, using traditional EC2 instances with PM2 process manager.

---

## 📋 AWS Services Architecture

```
┌─────────────────────────────────────────────────┐
│                  Route 53 (DNS)                  │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│          Application Load Balancer              │
│              (SSL Termination)                  │
└────────────────────┬────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        │                         │
┌───────▼──────┐          ┌──────▼───────┐
│   EC2        │          │   EC2        │
│  (Primary)   │          │  (Standby)   │
│  + PM2       │          │  + PM2       │
└───────┬──────┘          └──────┬───────┘
        │                         │
        └────────────┬────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
┌───────▼──────┐  ┌─▼────┐  ┌───▼──────┐
│     RDS      │  │  S3  │  │ElastiCache│
│  PostgreSQL  │  │      │  │  (Redis)  │
└──────────────┘  └──────┘  └───────────┘
```

---

## 🚀 Phase-wise Deployment Strategy

### Phase 1: Development Environment (Current)
- **Infrastructure:** Local development
- **Database:** PostgreSQL on localhost
- **Cost:** $0

### Phase 2: Staging Environment
- **Infrastructure:**
  - EC2 t3.medium (1 instance)
  - RDS db.t3.micro
  - ElastiCache t3.micro
  - S3 bucket
- **Estimated Cost:** ~$72/month

### Phase 3: Production Environment
- **Infrastructure:**
  - EC2 t3.large (2 instances with ALB)
  - RDS db.t3.small (Multi-AZ)
  - ElastiCache t3.small
  - S3 + CloudFront
  - Auto Scaling Group
- **Estimated Cost:** ~$230/month

---

## 📝 AWS Resource Specifications

### 1. EC2 Instance Configuration

**Development/Staging:**
```
Instance Type: t3.medium
vCPUs: 2
RAM: 4 GB
Storage: 30 GB SSD (gp3)
OS: Ubuntu 22.04 LTS
```

**Production:**
```
Instance Type: t3.large
vCPUs: 2
RAM: 8 GB
Storage: 50 GB SSD (gp3)
OS: Ubuntu 22.04 LTS
```

### 2. RDS PostgreSQL Configuration

**Development/Staging:**
```
Instance Class: db.t3.micro
Engine: PostgreSQL 15
Storage: 20 GB SSD (gp3)
Multi-AZ: No
Backup Retention: 7 days
```

**Production:**
```
Instance Class: db.t3.small
Engine: PostgreSQL 15
Storage: 50 GB SSD (gp3)
Multi-AZ: Yes
Backup Retention: 30 days
Automated Backups: Enabled
```

### 3. ElastiCache Redis Configuration

**Development/Staging:**
```
Node Type: cache.t3.micro
Engine: Redis 7.x
Nodes: 1
```

**Production:**
```
Node Type: cache.t3.small
Engine: Redis 7.x
Nodes: 2 (Primary + Replica)
```

### 4. S3 Configuration

```
Bucket Name: skido-documents-{environment}
Region: ap-south-1 (Mumbai)
Versioning: Enabled
Encryption: AES-256
Lifecycle Rules:
  - Delete old versions after 90 days
  - Transition to Glacier after 180 days
Access: Private (with signed URLs)
```

---

## 🔧 Deployment Steps

### Step 1: AWS Account Setup

1. Create AWS account
2. Set up billing alerts
3. Create IAM user with required permissions
4. Generate access keys

**Required IAM Permissions:**
- EC2FullAccess
- RDSFullAccess
- ElastiCacheFullAccess
- S3FullAccess
- CloudWatchFullAccess
- Route53 (if using custom domain)

---

### Step 2: Network Configuration

1. **Create VPC**
```
VPC CIDR: 10.0.0.0/16
Region: ap-south-1 (Mumbai)
```

2. **Create Subnets**
```
Public Subnet 1: 10.0.1.0/24 (ap-south-1a)
Public Subnet 2: 10.0.2.0/24 (ap-south-1b)
Private Subnet 1: 10.0.11.0/24 (ap-south-1a)
Private Subnet 2: 10.0.12.0/24 (ap-south-1b)
```

3. **Create Internet Gateway** and attach to VPC

4. **Create Route Tables**
   - Public route table (with IGW route)
   - Private route table

5. **Create Security Groups**

**Application Security Group (EC2):**
```
Inbound Rules:
- SSH (22): Your IP only
- HTTP (80): 0.0.0.0/0
- HTTPS (443): 0.0.0.0/0
- Custom (3000): Load Balancer SG only

Outbound Rules:
- All traffic: 0.0.0.0/0
```

**Database Security Group (RDS):**
```
Inbound Rules:
- PostgreSQL (5432): Application SG only

Outbound Rules:
- None needed
```

**Cache Security Group (ElastiCache):**
```
Inbound Rules:
- Redis (6379): Application SG only

Outbound Rules:
- None needed
```

---

### Step 3: Launch RDS PostgreSQL

1. Go to RDS Console
2. Create database
3. Select PostgreSQL 15
4. Choose configuration (based on environment)
5. Set master username and password
6. Choose VPC and security group
7. Enable automated backups
8. Create database

**Save these details:**
- Endpoint URL
- Port (5432)
- Master username
- Master password
- Database name

---

### Step 4: Launch ElastiCache Redis

1. Go to ElastiCache Console
2. Create Redis cluster
3. Choose configuration
4. Select VPC and security group
5. Create cluster

**Save these details:**
- Primary endpoint
- Port (6379)

---

### Step 5: Create S3 Bucket

1. Go to S3 Console
2. Create bucket: `skido-documents-{environment}`
3. Enable versioning
4. Enable encryption
5. Block all public access
6. Create folder structure:
   ```
   /driver-documents
   /vehicle-documents
   /invoices
   ```

---

### Step 6: Launch EC2 Instance

1. Go to EC2 Console
2. Launch instance:
   - AMI: Ubuntu 22.04 LTS
   - Instance type: t3.medium (staging) or t3.large (production)
   - VPC: Select your VPC
   - Subnet: Public subnet
   - Auto-assign public IP: Enable
   - Storage: 30-50 GB gp3
   - Security group: Application SG
   - Key pair: Create new or use existing

3. Allocate Elastic IP and associate with instance

---

### Step 7: Configure EC2 Instance

**SSH into instance:**
```bash
ssh -i your-key.pem ubuntu@your-elastic-ip
```

**Update system:**
```bash
sudo apt update
sudo apt upgrade -y
```

**Install Node.js:**
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
node --version  # Verify installation
```

**Install PM2:**
```bash
sudo npm install -g pm2
```

**Install Nginx:**
```bash
sudo apt install -y nginx
```

**Install Git:**
```bash
sudo apt install -y git
```

**Configure Nginx as reverse proxy:**
```bash
sudo nano /etc/nginx/sites-available/skido-api
```

```nginx
server {
    listen 80;
    server_name your-domain.com;  # or use IP

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

**Enable site:**
```bash
sudo ln -s /etc/nginx/sites-available/skido-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

---

### Step 8: Deploy Application

**Clone repository:**
```bash
cd /home/ubuntu
git clone your-repository-url skido-backend
cd skido-backend
```

**Install dependencies:**
```bash
npm install
```

**Create .env file:**
```bash
nano .env
```

```env
NODE_ENV=production
PORT=3000
API_PREFIX=api

DATABASE_HOST=your-rds-endpoint.ap-south-1.rds.amazonaws.com
DATABASE_PORT=5432
DATABASE_USER=postgres
DATABASE_PASSWORD=your-password
DATABASE_NAME=skido_db

REDIS_HOST=your-elasticache-endpoint.cache.amazonaws.com
REDIS_PORT=6379

JWT_SECRET=your-production-jwt-secret
JWT_REFRESH_SECRET=your-production-refresh-secret
JWT_EXPIRATION=15m
JWT_REFRESH_EXPIRATION=7d

AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=your-aws-access-key
AWS_SECRET_ACCESS_KEY=your-aws-secret-key
AWS_S3_BUCKET=skido-documents-production

GOOGLE_MAPS_API_KEY=your-google-maps-key
RAZORPAY_KEY_ID=your-razorpay-key
RAZORPAY_KEY_SECRET=your-razorpay-secret
SMS_API_KEY=your-sms-api-key

CORS_ORIGIN=https://your-frontend-domain.com
```

**Build application:**
```bash
npm run build
```

**Run database migrations:**
```bash
npm run migration:run
```

**Create PM2 ecosystem file:**
```bash
nano ecosystem.config.js
```

```javascript
module.exports = {
  apps: [{
    name: 'skido-api',
    script: 'dist/main.js',
    instances: 2,  // Use 1 for staging
    exec_mode: 'cluster',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
    },
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
```

**Start application with PM2:**
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # Follow instructions to enable startup script
```

**Check application status:**
```bash
pm2 status
pm2 logs skido-api
```

---

### Step 9: SSL Certificate (Production Only)

**Install Certbot:**
```bash
sudo apt install -y certbot python3-certbot-nginx
```

**Obtain SSL certificate:**
```bash
sudo certbot --nginx -d your-domain.com
```

**Auto-renewal is set up automatically**

---

### Step 10: Setup Monitoring

**CloudWatch Agent:**
```bash
wget https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb
sudo dpkg -i -E ./amazon-cloudwatch-agent.deb
```

**Configure CloudWatch:**
```bash
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-config-wizard
```

**PM2 Monitoring:**
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

---

### Step 11: Setup Automated Backups

**Database Snapshots:** Already configured in RDS

**Application Code Backup:**
```bash
# Add to crontab
crontab -e

# Daily backup at 2 AM
0 2 * * * cd /home/ubuntu/skido-backend && tar -czf /home/ubuntu/backups/backup-$(date +\%Y\%m\%d).tar.gz .
```

---

## 🔄 Deployment Workflow

### For Code Updates:

```bash
# SSH into EC2
ssh -i your-key.pem ubuntu@your-elastic-ip

# Navigate to project
cd /home/ubuntu/skido-backend

# Pull latest code
git pull origin main

# Install new dependencies (if any)
npm install

# Run new migrations (if any)
npm run migration:run

# Build application
npm run build

# Restart application
pm2 restart skido-api

# Check logs
pm2 logs skido-api --lines 50
```

---

## 📊 Cost Breakdown

### Staging Environment (~$72/month):
- EC2 t3.medium: $30
- RDS db.t3.micro: $15
- ElastiCache t3.micro: $12
- S3 Storage (100GB): $5
- Data Transfer: $10

### Production Environment (~$230/month):
- EC2 t3.large (2 instances): $120
- Application Load Balancer: $20
- RDS db.t3.small: $30
- ElastiCache t3.small: $25
- S3 + CloudFront: $20
- Backups & Misc: $15

---

## 🔒 Security Best Practices

1. **Never commit secrets to Git**
2. **Use IAM roles for EC2** instead of access keys when possible
3. **Enable MFA** on AWS root account
4. **Regular security updates** on EC2 instances
5. **Use AWS Systems Manager Parameter Store** for secrets
6. **Enable CloudTrail** for audit logging
7. **Regular security audits** using AWS Security Hub

---

## 📈 Scaling Strategy

When to scale:
- CPU usage > 70% for sustained periods
- Response times > 2 seconds
- Active connections > 1000

How to scale:
1. Vertical scaling: Upgrade EC2 instance type
2. Horizontal scaling: Add more EC2 instances with load balancer
3. Database: Upgrade RDS instance or add read replicas
4. Cache: Increase Redis cluster size

---

## 🐛 Troubleshooting

### Application won't start:
```bash
pm2 logs skido-api --lines 100
cat logs/error-*.log
```

### Database connection issues:
```bash
# Test database connection
nc -zv your-rds-endpoint.ap-south-1.rds.amazonaws.com 5432

# Check security groups
# Verify RDS is in private subnet
# Confirm EC2 can reach RDS
```

### Redis connection issues:
```bash
# Test Redis connection
redis-cli -h your-elasticache-endpoint.cache.amazonaws.com ping
```

### High memory usage:
```bash
pm2 monit
free -h
top
```

---

## 📞 Support Resources

- AWS Documentation: https://docs.aws.amazon.com/
- AWS Support (paid plans)
- PM2 Documentation: https://pm2.keymetrics.io/
- NestJS Deployment: https://docs.nestjs.com/

---

## ✅ Post-Deployment Checklist

- [ ] Application accessible via public IP/domain
- [ ] Database connection working
- [ ] Redis connection working
- [ ] S3 file uploads working
- [ ] SSL certificate installed (production)
- [ ] CloudWatch monitoring configured
- [ ] Automated backups configured
- [ ] PM2 startup script enabled
- [ ] API documentation accessible
- [ ] Load balancer health checks passing (production)
- [ ] All environment variables set correctly
- [ ] Logs rotating properly

---

**Note:** This guide will be updated in Phase 6 with actual deployment commands and screenshots.
