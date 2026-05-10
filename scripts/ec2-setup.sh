#!/bin/bash
# Run this ONCE on a fresh Ubuntu 24.04 EC2 instance via SSH
# Usage: ssh into the server, then run: bash ec2-setup.sh
#
# What this does:
#   1. Installs Docker
#   2. Installs AWS CLI
#   3. Configures Docker to use ECR credentials via AWS CLI
#   4. Sets up Nginx as a reverse proxy (port 80 → 3000)
#   5. Installs Certbot for free HTTPS (optional)

set -e

echo "=== Updating system packages ==="
sudo apt-get update -y
sudo apt-get upgrade -y

echo "=== Installing Docker ==="
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker ubuntu
rm get-docker.sh

echo "=== Installing AWS CLI ==="
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
sudo apt-get install -y unzip
unzip awscliv2.zip
sudo ./aws/install
rm -rf awscliv2.zip aws/

echo "=== Installing Nginx (reverse proxy) ==="
sudo apt-get install -y nginx

echo "=== Configuring Nginx ==="
sudo tee /etc/nginx/sites-available/opus-one > /dev/null <<'NGINX'
server {
    listen 80;
    server_name _;

    # Increase timeouts for long-running Playwright searches (up to 3 min)
    proxy_read_timeout 300s;
    proxy_connect_timeout 10s;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/opus-one /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl restart nginx

echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "1. Configure AWS credentials: aws configure"
echo "   (Use the IAM user access key you created)"
echo "2. Your app will be accessible at http://YOUR_ELASTIC_IP"
echo "3. To add HTTPS (free): sudo apt install certbot python3-certbot-nginx"
echo "   Then: sudo certbot --nginx -d yourdomain.com"
echo ""
echo "IMPORTANT: Log out and log back in for Docker group to take effect"
