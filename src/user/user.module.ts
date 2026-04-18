import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersController } from './user.controller';
import { UsersService } from './user.service';
import { AuthModule } from 'src/auth/auth.module';
import { User } from './user.entity';
import { Type } from 'class-transformer';

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
  imports:[TypeOrmModule.forFeature([User])]

})
export class UsersModule {}
