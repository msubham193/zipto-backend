# SkiDO Backend - AWS Deployment Guide (Without Docker)

## 📋 Prerequisites

- AWS Account with billing enabled
- Domain name (optional, but recommended)
- Local machine with AWS CLI installed
- SSH key pair for EC2 access

## 🚀 Deployment Architecture

```
Internet
    ↓
Route 53 (DNS)
    ↓
Application Load Balancer (ALB)
    ↓
EC2 Instance (Ubuntu 22.04)
    ├── Nginx (Reverse Proxy)
    ├── NestJS App (PM2)
    └── SSL Certificate (Let's Encrypt)
    ↓
RDS PostgreSQL
    ↓
ElastiCache Redis
    ↓
S3 (Document Storage)
```

## 🔧 Step-by-Step Deployment

### Phase 1: Setup RDS PostgreSQL Database

1. **Create RDS Instance**
   - Go to AWS Console → RDS → Create Database
   - Choose PostgreSQL 15.x
   - Template: Free tier (for testing) or Production
   - DB instance identifier: `skido-db`
   - Master username: `postgres`
   - Master password: (Generate strong password)
   - DB instance class: `db.t3.micro` (can upgrade later)
   - Storage: 20 GB (Auto-scaling enabled)
   - VPC: Default or create new
   - Public access: No (for security)
   - VPC security group: Create new `skido-db-sg`
   - Database name: `skido_db`

2. **Configure Security Group**
   - Edit `skido-db-sg`
   - Add Inbound Rule:
     - Type: PostgreSQL
     - Port: 5432
     - Source: EC2 security group (we'll create this next)

3. **Note the Endpoint**
   - Example: `skido-db.xxxxxx.ap-south-1.rds.amazonaws.com`

### Phase 2: Setup ElastiCache Redis (Optional)

1. **Create Redis Cluster**
   - Go to AWS Console → ElastiCache → Redis
   - Cluster mode: Disabled
   - Name: `skido-redis`
   - Node type: `cache.t3.micro`
   - Number of replicas: 0 (for testing)
   - Subnet group: Create new or use default
   - Security group: Create new `skido-redis-sg`

2. **Configure Security Group**
   - Edit `skido-redis-sg`
   - Add Inbound Rule:
     - Type: Custom TCP
     - Port: 6379
     - Source: EC2 security group

3. **Note the Endpoint**
   - Example: `skido-redis.xxxxx.cache.amazonaws.com`

### Phase 3: Setup S3 Bucket

1. **Create S3 Bucket**
   ```bash
   aws s3 mb s3://skido-documents --region ap-south-1
   ```

2. **Configure Bucket Policy**
   - Block all public access (keep documents private)
   - Enable versioning
   - Enable encryption

3. **Create IAM User for S3 Access**
   ```bash
   # Create IAM user
   aws iam create-user --user-name skido-s3-user
   
   # Attach S3 policy
   aws iam attach-user-policy \
     --user-name skido-s3-user \
     --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess
   
   # Create access keys
   aws iam create-access-key --user-name skido-s3-user
   ```

4. **Save Access Keys**
   - Access Key ID
   - Secret Access Key

### Phase 4: Launch EC2 Instance

1. **Launch Instance**
   - AMI: Ubuntu Server 22.04 LTS
   - Instance type: `t3.medium` (2 vCPU, 4 GB RAM)
   - Key pair: Create new or select existing
   - Network: Default VPC
   - Security group: Create new `skido-app-sg`
   - Storage: 20 GB gp3

2. **Configure Security Group** (`skido-app-sg`)
   ```
   Inbound Rules:
   - SSH (22) from Your IP
   - HTTP (80) from Anywhere (0.0.0.0/0)
   - HTTPS (443) from Anywhere (0.0.0.0/0)
   - Custom TCP (3000) from ALB security group (for health checks)
   ```

3. **Allocate Elastic IP**
   - Go to EC2 → Elastic IPs → Allocate
   - Associate with your EC2 instance
   - Note the Elastic IP address

### Phase 5: Configure EC2 Instance

1. **SSH into Instance**
   ```bash
   ssh -i your-key.pem ubuntu@<ELASTIC_IP>
   ```

2. **Update System**
   ```bash
   sudo apt update && sudo apt upgrade -y
   ```

3. **Install Node.js 18+**
   ```bash
   # Install nvm
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
   source ~/.bashrc
   
   # Install Node.js 18
   nvm install 18
   nvm use 18
   nvm alias default 18
   
   # Verify
   node -v
   npm -v
   ```

4. **Install PM2**
   ```bash
   npm install -g pm2
   pm2 startup systemd
   # Follow the command output to enable PM2 on system boot
   ```

5. **Install Nginx**
   ```bash
   sudo apt install nginx -y
   sudo systemctl start nginx
   sudo systemctl enable nginx
   ```

6. **Install PostgreSQL Client (for testing)**
   ```bash
   sudo apt install postgresql-client -y
   ```

7. **Install Git**
   ```bash
   sudo apt install git -y
   ```

### Phase 6: Deploy Application

1. **Clone Repository**
   ```bash
   cd /home/ubuntu
   git clone <YOUR_REPOSITORY_URL> skido-backend
   cd skido-backend
   ```

2. **Install Dependencies**
   ```bash
   npm install --production
   ```

3. **Create Environment File**
   ```bash
   nano .env
   ```

   ```env
   # Application
   NODE_ENV=production
   PORT=3000
   API_PREFIX=api
   
   # Database (Use RDS endpoint)
   DATABASE_HOST=skido-db.xxxxxx.ap-south-1.rds.amazonaws.com
   DATABASE_PORT=5432
   DATABASE_USER=postgres
   DATABASE_PASSWORD=your_rds_password
   DATABASE_NAME=skido_db
   DATABASE_SYNC=false
   
   # Redis (Use ElastiCache endpoint)
   REDIS_HOST=skido-redis.xxxxx.cache.amazonaws.com
   REDIS_PORT=6379
   
   # JWT
   JWT_SECRET=production-super-secret-key-change-this
   JWT_REFRESH_SECRET=production-refresh-secret-key-change-this
   JWT_EXPIRATION=15m
   JWT_REFRESH_EXPIRATION=7d
   
   # AWS S3
   AWS_REGION=ap-south-1
   AWS_ACCESS_KEY_ID=your_access_key
   AWS_SECRET_ACCESS_KEY=your_secret_key
   AWS_S3_BUCKET=skido-documents
   
   # Google Maps
   GOOGLE_MAPS_API_KEY=your_google_maps_key
   
   # Razorpay
   RAZORPAY_KEY_ID=your_razorpay_key
   RAZORPAY_KEY_SECRET=your_razorpay_secret
   
   # SMS Gateway
   SMS_PROVIDER=msg91
   SMS_API_KEY=your_sms_key
   SMS_SENDER_ID=SKIDO
   
   # FCM
   FCM_SERVER_KEY=your_fcm_key
   
   # CORS
   CORS_ORIGIN=https://yourdomain.com
   ```

4. **Build Application**
   ```bash
   npm run build
   ```

5. **Test Database Connection**
   ```bash
   psql -h skido-db.xxxxxx.ap-south-1.rds.amazonaws.com -U postgres -d skido_db
   # Enter password when prompted
   \q
   ```

6. **Run Database Migrations** (if you have migrations)
   ```bash
   npm run migration:run
   ```

7. **Test Application**
   ```bash
   npm run start:prod
   # Press Ctrl+C after verifying it starts correctly
   ```

### Phase 7: Setup PM2 Process Manager

1. **Create PM2 Ecosystem File**
   ```bash
   nano ecosystem.config.js
   ```

   ```javascript
   module.exports = {
     apps: [{
       name: 'skido-api',
       script: 'dist/main.js',
       instances: 2,
       exec_mode: 'cluster',
       watch: false,
       max_memory_restart: '1G',
       env: {
         NODE_ENV: 'production'
       },
       error_file: './logs/err.log',
       out_file: './logs/out.log',
       log_date_format: 'YYYY-MM-DD HH:mm Z',
       merge_logs: true
     }]
   };
   ```

2. **Create Logs Directory**
   ```bash
   mkdir logs
   ```

3. **Start Application with PM2**
   ```bash
   pm2 start ecosystem.config.js
   pm2 save
   pm2 startup
   ```

4. **Verify Application is Running**
   ```bash
   pm2 status
   pm2 logs skido-api
   curl http://localhost:3000/api
   ```

### Phase 8: Configure Nginx as Reverse Proxy

1. **Create Nginx Configuration**
   ```bash
   sudo nano /etc/nginx/sites-available/skido
   ```

   ```nginx
   server {
       listen 80;
       server_name your-domain.com www.your-domain.com;  # Replace with your domain
       
       client_max_body_size 10M;
       
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
           
           # WebSocket support
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
       }
       
       # Health check endpoint
       location /health {
           access_log off;
           return 200 "healthy\n";
           add_header Content-Type text/plain;
       }
   }
   ```

2. **Enable Site**
   ```bash
   sudo ln -s /etc/nginx/sites-available/skido /etc/nginx/sites-enabled/
   sudo rm /etc/nginx/sites-enabled/default
   sudo nginx -t
   sudo systemctl reload nginx
   ```

3. **Test**
   ```bash
   curl http://<ELASTIC_IP>/api
   ```

### Phase 9: Setup SSL Certificate (Let's Encrypt)

1. **Install Certbot**
   ```bash
   sudo apt install certbot python3-certbot-nginx -y
   ```

2. **Obtain SSL Certificate**
   ```bash
   sudo certbot --nginx -d your-domain.com -d www.your-domain.com
   ```

3. **Follow Prompts**
   - Enter email
   - Agree to terms
   - Choose redirect option (2)

4. **Verify Auto-Renewal**
   ```bash
   sudo certbot renew --dry-run
   ```

5. **Test HTTPS**
   ```bash
   curl https://your-domain.com/api
   ```

### Phase 10: Setup Application Load Balancer (Optional - for High Availability)

1. **Create Target Group**
   - Target type: Instances
   - Protocol: HTTP
   - Port: 3000
   - Health check path: `/api/health`

2. **Create Application Load Balancer**
   - Scheme: Internet-facing
   - IP address type: IPv4
   - Listeners: HTTP (80) and HTTPS (443)
   - Availability Zones: Select 2+ zones
   - Security group: Create new with HTTP/HTTPS access

3. **Configure SSL Certificate**
   - Upload certificate from Let's Encrypt or use ACM

4. **Register EC2 Instance**
   - Add EC2 instance to target group

5. **Update Route 53**
   - Point domain to ALB DNS name

### Phase 11: Setup CloudWatch Monitoring

1. **Install CloudWatch Agent**
   ```bash
   wget https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb
   sudo dpkg -i amazon-cloudwatch-agent.deb
   ```

2. **Configure CloudWatch**
   ```bash
   sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-config-wizard
   ```

3. **Start Agent**
   ```bash
   sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
     -a fetch-config \
     -m ec2 \
     -s \
     -c file:/opt/aws/amazon-cloudwatch-agent/bin/config.json
   ```

### Phase 12: Setup Automated Backups

1. **Database Backups** (RDS handles this automatically)
   - Retention period: 7 days
   - Backup window: 02:00-04:00 UTC

2. **Application Backups**
   ```bash
   # Create backup script
   nano ~/backup.sh
   ```

   ```bash
   #!/bin/bash
   DATE=$(date +%Y%m%d_%H%M%S)
   BACKUP_DIR="/home/ubuntu/backups"
   
   mkdir -p $BACKUP_DIR
   
   # Backup application
   tar -czf $BACKUP_DIR/skido-app-$DATE.tar.gz /home/ubuntu/skido-backend
   
   # Upload to S3
   aws s3 cp $BACKUP_DIR/skido-app-$DATE.tar.gz s3://skido-backups/
   
   # Delete local backup older than 7 days
   find $BACKUP_DIR -name "*.tar.gz" -mtime +7 -delete
   ```

   ```bash
   chmod +x ~/backup.sh
   
   # Add to crontab (runs daily at 3 AM)
   crontab -e
   0 3 * * * /home/ubuntu/backup.sh
   ```

## 🔄 Deployment Updates

### Zero-Downtime Deployment

1. **Pull Latest Code**
   ```bash
   cd /home/ubuntu/skido-backend
   git pull origin main
   ```

2. **Install Dependencies**
   ```bash
   npm install --production
   ```

3. **Build Application**
   ```bash
   npm run build
   ```

4. **Reload with PM2**
   ```bash
   pm2 reload ecosystem.config.js --update-env
   ```

## 📊 Monitoring Commands

```bash
# PM2 Status
pm2 status
pm2 logs skido-api
pm2 monit

# Nginx Status
sudo systemctl status nginx
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# Application Logs
tail -f /home/ubuntu/skido-backend/logs/out.log
tail -f /home/ubuntu/skido-backend/logs/err.log

# System Resources
htop
df -h
free -m
```

## 🔒 Security Checklist

- [ ] Changed default SSH port (optional)
- [ ] Disabled root login
- [ ] Setup UFW firewall
- [ ] Installed fail2ban
- [ ] SSL certificate configured
- [ ] Database not publicly accessible
- [ ] Strong database password
- [ ] S3 bucket not public
- [ ] Environment variables secured
- [ ] Regular security updates enabled
- [ ] CloudWatch alarms configured

## 💰 Cost Estimation

**Monthly costs (estimated):**
- EC2 t3.medium: ~$30
- RDS db.t3.micro: ~$15
- ElastiCache t3.micro: ~$12
- S3 Storage (10GB): ~$0.30
- Data Transfer: ~$10
- **Total: ~$67/month**

For production with ALB and multi-AZ:
- **Total: ~$200-250/month**

## 🚨 Troubleshooting

### Application won't start
```bash
pm2 logs skido-api --lines 100
# Check database connection
# Verify environment variables
```

### High memory usage
```bash
pm2 reload skido-api
# Consider upgrading to t3.large
```

### Database connection issues
```bash
# Test connection
psql -h <RDS_ENDPOINT> -U postgres -d skido_db
# Check security group rules
```

## 📝 Maintenance Tasks

**Daily:**
- Monitor PM2 logs
- Check application health

**Weekly:**
- Review CloudWatch metrics
- Check disk space
- Review error logs

**Monthly:**
- Update dependencies
- Review costs
- Security updates
- Backup testing

---

**Deployment Status**: Ready for Production
**Last Updated**: December 31, 2025
