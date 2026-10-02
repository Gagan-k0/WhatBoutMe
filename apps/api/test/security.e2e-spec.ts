import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { EnrollmentsService } from '../src/modules/enrollments/enrollments.service.js';

describe('Security and Concurrency (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let enrollmentsService: EnrollmentsService;
  
  let user1Token: string;
  let user1Id: string;
  let user2Token: string;
  let user2Id: string;
  let managerToken: string;
  let managerId: string;
  
  let user1InvoiceId: string;
  let user1CertId: string;
  let programId: string;
  let myBatchId: string;
  let otherBatchId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    prisma = app.get(PrismaService);
    enrollmentsService = app.get(EnrollmentsService);
    await app.init();
    
    // Setup users
    const [u1, u2, m1] = await Promise.all([
      prisma.user.create({ data: { email: 'u1@test.com', role: Role.USER } }),
      prisma.user.create({ data: { email: 'u2@test.com', role: Role.USER } }),
      prisma.user.create({ data: { email: 'm1@test.com', role: Role.MANAGER } })
    ]);
    user1Id = u1.id;
    user2Id = u2.id;
    managerId = m1.id;
    
    // Mock tokens
    const authService = app.get(AuthService);
    const t1 = await authService.createDeviceSession(u1.id, u1.role, 'hash1');
    const t2 = await authService.createDeviceSession(u2.id, u2.role, 'hash2');
    const tm = await authService.createDeviceSession(m1.id, m1.role, 'hash3');
    
    const jwt = app.get(JwtService);
    user1Token = jwt.sign({ sub: u1.id, email: u1.email, role: u1.role, sessionId: t1 });
    user2Token = jwt.sign({ sub: u2.id, email: u2.email, role: u2.role, sessionId: t2 });
    managerToken = jwt.sign({ sub: m1.id, email: m1.email, role: m1.role, sessionId: tm });
    
    // Setup data
    const p1 = await prisma.program.create({ data: { title: 'P1', slug: 'p1', price: 100 } });
    programId = p1.id;
    
    const b1 = await prisma.batch.create({ data: { name: 'B1', programId: p1.id, managerId: m1.id, capacity: 10, startDate: new Date() } });
    myBatchId = b1.id;
    
    const b2 = await prisma.batch.create({ data: { name: 'B2', programId: p1.id, capacity: 10, startDate: new Date() } });
    otherBatchId = b2.id;
    
    const e1 = await prisma.enrolment.create({ data: { userId: u1.id, batchId: b1.id, programId: p1.id, status: 'ACTIVE' } });
    
    const inv1 = await prisma.invoice.create({ data: { amount: 100, status: 'ISSUED', userId: u1.id, invoiceNumber: 'INV-1' } });
    user1InvoiceId = inv1.id;
    
    const cert1 = await prisma.certificate.create({ data: { code: 'CERT-1', enrolmentId: e1.id, issueDate: new Date(), pdfUrl: 'http' } });
    user1CertId = cert1.id;
  });

  afterAll(async () => {
    // Only remove what this suite created. These tests run against the
    // database in .env, and unscoped deleteMany() calls here once wiped every
    // account and programme in it.
    const userIds = [user1Id, user2Id, managerId].filter(Boolean);
    const mine = { OR: [{ userId: { in: userIds } }, { programId }] };
    await prisma.certificate.deleteMany({ where: { enrolment: mine } });
    if (user1InvoiceId) await prisma.invoice.deleteMany({ where: { id: user1InvoiceId } });
    await prisma.enrolment.deleteMany({ where: mine });
    await prisma.batch.deleteMany({ where: { programId } });
    await prisma.program.deleteMany({ where: { id: programId } });
    await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  it('user2 cannot access user1 invoice', async () => {
    const res = await request(app.getHttpServer())
      .get('/invoices')
      .set('Authorization', `Bearer ${user2Token}`);
    // Should only see their own (empty array)
    expect(res.body.length).toBe(0);
  });

  it('user2 cannot access user1 certificate via API', async () => {
    const res = await request(app.getHttpServer())
      .post('/certificates/request')
      .set('Authorization', `Bearer ${user2Token}`)
      .send({ batchId: myBatchId });
    // User2 is not enrolled in myBatchId
    expect(res.status).toBe(400);
  });

  it('manager cannot fetch a batch they do not manage', async () => {
    const res = await request(app.getHttpServer())
      .get(`/batches/${otherBatchId}`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(403);
    
    const res2 = await request(app.getHttpServer())
      .get(`/batches/${myBatchId}`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res2.status).toBe(200);
  });

  it('concurrency: simultaneous mockCheckout creates only 1 enrolment', async () => {
    // Both user2 calls mockCheckout at same time for same program
    const promises = [
      enrollmentsService.mockCheckout(user2Id, programId),
      enrollmentsService.mockCheckout(user2Id, programId),
    ];
    
    const results = await Promise.allSettled(promises);
    
    // Find how many succeeded
    const successes = results.filter(r => r.status === 'fulfilled');
    expect(successes.length).toBeGreaterThan(0);
    
    // Wait for DB write just in case
    await new Promise(r => setTimeout(r, 100));
    
    // Check db count
    const enrolments = await prisma.enrolment.findMany({ where: { userId: user2Id, programId: programId } });
    expect(enrolments.length).toBe(1);
  });
});
