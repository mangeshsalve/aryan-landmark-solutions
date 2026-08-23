# Deployment Architecture

Flutter -> HTTPS -> API/Load Balancer -> NestJS -> PostgreSQL
                                             -> Cloudinary

Production requires:
- HTTPS
- managed PostgreSQL
- automated backups
- secrets management
- logs/monitoring
- health checks
- CI/CD
- staging environment

No production secrets inside source code or Docker images.
