import { Controller, Get, INestApplication, UseGuards, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module';
import { CurrentUser } from '../src/auth/decorators/current-user.decorator';
import { Roles } from '../src/auth/decorators/roles.decorator';
import { JwtApplicationAuthGuard } from '../src/auth/guards/jwt-application-auth.guard';
import { JwtMasterAuthGuard } from '../src/auth/guards/jwt-master-auth.guard';
import { RolesGuard } from '../src/auth/guards/roles.guard';
import { AnyJwtPayload } from '../src/auth/interfaces/jwt-payload.interface';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { LoggerModule } from '../src/common/logger/logger.module';
import configuration from '../src/config/configuration';
import { validateEnv } from '../src/config/env.validation';
import { PasswordService } from '../src/auth/services/password.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Test-only controller demonstrating the guards protecting real routes,
 * without adding any permanent business endpoint to the application —
 * Phase 2 implements only authentication/authorization, not business
 * APIs, so this exists solely to exercise the guards end-to-end over
 * real HTTP.
 */
@Controller('test-protected')
class TestProtectedController {
  @Get('admin-only')
  @UseGuards(JwtApplicationAuthGuard, RolesGuard)
  @Roles('ADMIN')
  adminOnly(@CurrentUser() user: AnyJwtPayload) {
    return { ok: true, user };
  }

  @Get('employee-or-admin')
  @UseGuards(JwtApplicationAuthGuard, RolesGuard)
  @Roles('ADMIN', 'EMPLOYEE')
  employeeOrAdmin(@CurrentUser() user: AnyJwtPayload) {
    return { ok: true, user };
  }

  @Get('master-only')
  @UseGuards(JwtMasterAuthGuard)
  masterOnly(@CurrentUser() user: AnyJwtPayload) {
    return { ok: true, user };
  }
}

describe('Authentication & Authorization (e2e)', () => {
  let app: INestApplication;

  const adminRow = {
    id: 'admin-uuid',
    userId: 'ADM001',
    userType: 'APPLICATION_USER',
    role: 'ADMIN',
    name: 'Test Admin',
    email: 'admin@example.com',
    mobile: null,
    passwordHash: 'irrelevant-mocked',
    status: 'ACTIVE',
  };
  const employeeRow = {
    ...adminRow,
    id: 'employee-uuid',
    userId: 'EMP001',
    role: 'EMPLOYEE',
    name: 'Test Employee',
    email: 'employee@example.com',
  };
  const masterRow = {
    id: 'master-uuid',
    userId: 'MASTER001',
    userType: 'MASTER',
    role: null,
    name: 'Test Master',
    email: 'master@example.com',
    mobile: null,
    passwordHash: 'irrelevant-mocked',
    status: 'ACTIVE',
  };

  const prismaMock = {
    user: {
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };

  const passwordService = new PasswordService();
  // PasswordService.hash/verify run for real (real bcrypt) below, so login
  // goes through the real hashing algorithm end-to-end rather than mocking
  // it away.

  beforeAll(async () => {
    // Phase 1 production-readiness fix: env.validation.ts now fails
    // startup if JWT_ACCESS_SECRET === MASTER_JWT_ACCESS_SECRET. This
    // suite loads real environment values via ConfigModule.forRoot(),
    // which — like the application itself — reads the local developer
    // .env; that file's two JWT secrets are not guaranteed to differ
    // (they're independent, unrelated placeholder values a developer
    // sets locally). Override just the master secret here to a value
    // distinct from JWT_ACCESS_SECRET, so this suite exercises real,
    // valid configuration regardless of what the local .env currently
    // contains. Environment variables already set on process.env are
    // never overwritten by dotenv when ConfigModule loads the .env file,
    // so this override reliably takes precedence.
    process.env.MASTER_JWT_ACCESS_SECRET = 'e2e-test-master-secret-distinct-from-jwt-access';

    const adminPasswordHash = await passwordService.hash('admin-correct-password');
    const employeePasswordHash = await passwordService.hash('employee-correct-password');
    const masterPasswordHash = await passwordService.hash('master-correct-password');

    prismaMock.user.findFirst.mockImplementation(
      ({ where }: { where: { email: { equals: string }; userType: string } }) => {
        const email = where.email.equals;
        if (where.userType === 'APPLICATION_USER' && email === 'admin@example.com') {
          return Promise.resolve({ ...adminRow, passwordHash: adminPasswordHash });
        }
        if (where.userType === 'APPLICATION_USER' && email === 'employee@example.com') {
          return Promise.resolve({ ...employeeRow, passwordHash: employeePasswordHash });
        }
        if (where.userType === 'MASTER' && email === 'master@example.com') {
          return Promise.resolve({ ...masterRow, passwordHash: masterPasswordHash });
        }
        return Promise.resolve(null);
      },
    );

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate: validateEnv }),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }]), // generous: not testing rate limiting here
        PrismaModule, // @Global() — imported so overrideProvider below has
        // a real binding to replace, and the mock propagates to every
        // module (including AuthModule) exactly as the real global
        // binding would in production.
        LoggerModule, // AllExceptionsFilter depends on PinoLogger
        AuthModule,
      ],
      controllers: [TestProtectedController],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function loginApplication(email: string, password: string) {
    return request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
  }

  async function loginMaster(email: string, password: string) {
    return request(app.getHttpServer())
      .post('/api/v1/master-auth/login')
      .send({ email, password });
  }

  // 1. Valid ADMIN login
  it('logs in a valid ADMIN over real HTTP', async () => {
    const res = await loginApplication('admin@example.com', 'admin-correct-password');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.role).toBe('ADMIN');
    expect(res.body.data.accessToken).toEqual(expect.any(String));
  });

  // 2. Valid EMPLOYEE login
  it('logs in a valid EMPLOYEE over real HTTP', async () => {
    const res = await loginApplication('employee@example.com', 'employee-correct-password');
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('EMPLOYEE');
  });

  // 3 & 4. Invalid password / unknown user — both collapse to the same
  // generic response, per api-conventions.md's AUTH_INVALID_CREDENTIALS.
  it('rejects an invalid password with AUTH_INVALID_CREDENTIALS', async () => {
    const res = await loginApplication('admin@example.com', 'totally-wrong');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('rejects an unknown email with AUTH_INVALID_CREDENTIALS', async () => {
    const res = await loginApplication('nobody@example.com', 'whatever');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  // 7. Valid MASTER login
  it('logs in a valid MASTER over real HTTP', async () => {
    const res = await loginMaster('master@example.com', 'master-correct-password');
    expect(res.status).toBe(200);
    expect(res.body.data.tokenScope).toBe('MASTER');
  });

  // 8. CUSTOMER cannot login (no matching row for a customer via /auth/login)
  it('rejects a customer-shaped login attempt on /auth/login', async () => {
    const res = await loginApplication('customer@example.com', 'whatever');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  describe('authorization on protected routes', () => {
    let adminToken: string;
    let employeeToken: string;
    let masterToken: string;

    beforeAll(async () => {
      adminToken = (await loginApplication('admin@example.com', 'admin-correct-password')).body
        .data.accessToken;
      employeeToken = (await loginApplication('employee@example.com', 'employee-correct-password'))
        .body.data.accessToken;
      masterToken = (await loginMaster('master@example.com', 'master-correct-password')).body.data
        .accessToken;
    });

    // 11. ADMIN authorization
    it('allows ADMIN on an ADMIN-only route', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/test-protected/admin-only')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe('ADMIN');
    });

    it('rejects EMPLOYEE on an ADMIN-only route', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/test-protected/admin-only')
        .set('Authorization', `Bearer ${employeeToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    // 12. EMPLOYEE authorization
    it('allows EMPLOYEE on a route permitting ADMIN or EMPLOYEE', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/test-protected/employee-or-admin')
        .set('Authorization', `Bearer ${employeeToken}`);
      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe('EMPLOYEE');
    });

    // 13. MASTER authorization
    it('allows MASTER on a master-only route', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/test-protected/master-only')
        .set('Authorization', `Bearer ${masterToken}`);
      expect(res.status).toBe(200);
      expect(res.body.user.tokenType).toBe('MASTER');
    });

    // 14. Application token cannot access MASTER-only endpoint
    it('rejects an application (ADMIN) token on a master-only route', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/test-protected/master-only')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_MASTER_ACCESS_REQUIRED');
    });

    // 15. MASTER token cannot be treated as ADMIN/EMPLOYEE
    it('rejects a master token on an application-only (ADMIN) route', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/test-protected/admin-only')
        .set('Authorization', `Bearer ${masterToken}`);
      // Master token is signed with a different secret than the
      // application guard verifies against, so it's rejected as an
      // invalid application token before role is ever considered.
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });

    it('rejects a request with no token at all', async () => {
      const res = await request(app.getHttpServer()).get(
        '/api/v1/test-protected/employee-or-admin',
      );
      expect(res.status).toBe(401);
    });
  });
});
