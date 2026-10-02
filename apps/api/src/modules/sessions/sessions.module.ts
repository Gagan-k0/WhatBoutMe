import { Module } from '@nestjs/common';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';
import { ZoomService } from './zoom.service.js';
import { AttendanceController } from './attendance.controller.js';
import { PrismaModule } from '../../prisma/prisma.module.js';

@Module({
  imports: [PrismaModule],
  controllers: [SessionsController, AttendanceController],
  providers: [SessionsService, ZoomService],
})
export class SessionsModule {}
