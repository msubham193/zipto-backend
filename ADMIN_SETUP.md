# Admin User Setup Guide

## Local Setup (Already Completed ✅)

The admin user has been created on your local database with the following credentials:

- **Email:** `admin@skido.com`
- **Password:** `Admin@123`

## EC2 Deployment Instructions

### Step 1: Upload the Script to EC2

Upload the `create-admin-ec2.js` file to your EC2 instance:

```bash
# From your local machine
scp create-admin-ec2.js ubuntu@your-ec2-ip:/home/ubuntu/skido-backend/
```

Or commit it to git and pull on EC2:

```bash
# On local machine
git add create-admin-ec2.js
git commit -m "Add admin user creation script"
git push

# On EC2
cd /home/ubuntu/skido-backend
git pull
```

### Step 2: Run the Script on EC2

SSH into your EC2 instance and run:

```bash
# SSH to EC2
ssh ubuntu@your-ec2-ip

# Navigate to backend directory
cd /home/ubuntu/skido-backend

# Load environment variables (if using .env file)
source .env

# Or export them manually if needed:
# export DATABASE_HOST=localhost
# export DATABASE_PORT=5432
# export DATABASE_USERNAME=postgres
# export DATABASE_PASSWORD=your_password
# export DATABASE_NAME=skido_db

# Run the script
node create-admin-ec2.js
```

### Step 3: Verify Admin User

After running the script, you should see:

```
✅ Connected to database
✅ Admin user created successfully!

📋 Login Credentials:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Email:    admin@skido.com
Password: Admin@123
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔗 Login endpoint: POST /api/auth/admin/login
```

### Step 4: Test Admin Login on EC2

Test the admin login on your EC2 instance:

```bash
curl -X POST https://your-domain.com/api/auth/admin/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@skido.com",
    "password": "Admin@123"
  }'
```

Or if using HTTP (without SSL):

```bash
curl -X POST http://your-ec2-ip:3000/api/auth/admin/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@skido.com",
    "password": "Admin@123"
  }'
```

### Expected Response

```json
{
  "user": {
    "id": "...",
    "email": "admin@skido.com",
    "phone": "9999999999",
    "name": "Admin User",
    "role": "admin",
    "is_verified": true,
    "is_active": true
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

## Troubleshooting

### Database Connection Error

If you get `ECONNREFUSED`:

- Check if PostgreSQL is running: `sudo systemctl status postgresql`
- Verify database credentials in your `.env` file
- Ensure the database exists: `psql -U postgres -l`

### Table Does Not Exist

If you get error about `users` table not existing:

```bash
npm run migration:run
```

### Admin Already Exists

The script will automatically update the existing admin user with the correct password if one already exists.

## Security Notes

⚠️ **Important:** After deployment, consider:

1. Changing the default admin password
2. Using environment variables for sensitive credentials
3. Implementing password rotation policies
4. Enabling 2FA for admin accounts (future enhancement)

## Files

- `create-admin-ec2.js` - Production script for EC2
- `create-admin.js` - Local development script
