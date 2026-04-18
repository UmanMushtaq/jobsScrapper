import { Module } from '@nestjs/common';

/**
 * Minimal AppModule for IoT Job Search Bot
 * This module just keeps the NestJS server running
 * Actual job scanning runs via cron jobs via "npm run jobs:scan"
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AppModule {}
