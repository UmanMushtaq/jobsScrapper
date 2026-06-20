import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import * as express from 'express';
import { initDatabase } from './database/database.service';

async function bootstrap() {
  try { await initDatabase(); } catch (err) {
    console.warn('[postgres] init failed:', (err as Error).message);
  }
  const app = await NestFactory.create(AppModule);
  app.use(express.urlencoded({ extended: true }));
  app.useGlobalPipes(new ValidationPipe({
    whitelist:true,       //this option will remove any properties that are not defined in the DTO
    forbidNonWhitelisted:true, //this option will throw an error if any properties that are not defined in the DTO are present in the request body
    transform:true         //this option will automatically transform payloads to be objects typed according to their DTO classes
  }))
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
